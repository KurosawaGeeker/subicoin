package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gorilla/websocket"
	"github.com/tidwall/gjson"
)

const (
	defaultAddr              = "0.0.0.0:18080"
	defaultRequestTimeout    = 10 * time.Minute
	defaultMaxRequestBodyLen = 256 << 20
)

var agentUpgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

type gatewayConfig struct {
	Addr                  string
	BuyerAPIKey           string
	SellerNodeToken       string
	SessionContextEnabled bool
	SessionMaxTurns       int
	SessionMaxChars       int
	SessionStore          *service.SubiSessionStore
}

func main() {
	cfg := loadConfig()
	if err := validateConfig(cfg); err != nil {
		log.Fatalf("subi-gateway config error: %v", err)
	}
	cfg.SessionStore = service.NewSubiSessionStore(cfg.SessionMaxTurns, cfg.SessionMaxChars)

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	mux.HandleFunc("/api/v1/subi/seller/agent/ws", func(w http.ResponseWriter, r *http.Request) {
		handleSellerAgentWS(w, r, cfg)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		handleBuyerRequest(w, r, cfg)
	})

	server := &http.Server{
		Addr:              cfg.Addr,
		Handler:           mux,
		ReadHeaderTimeout: 30 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
	}()

	log.Printf("subi-gateway listening on %s", cfg.Addr)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("subi-gateway stopped: %v", err)
	}
}

func loadConfig() gatewayConfig {
	return gatewayConfig{
		Addr:                  envOrDefault("SUBI_GATEWAY_ADDR", defaultAddr),
		BuyerAPIKey:           strings.TrimSpace(os.Getenv("SUBI_BUYER_API_KEY")),
		SellerNodeToken:       strings.TrimSpace(os.Getenv("SUBI_SELLER_NODE_TOKEN")),
		SessionContextEnabled: envBool("SUBI_SESSION_CONTEXT_ENABLED"),
		SessionMaxTurns:       envInt("SUBI_SESSION_MAX_TURNS", service.DefaultSubiSessionMaxTurns),
		SessionMaxChars:       envInt("SUBI_SESSION_MAX_CHARS", service.DefaultSubiSessionMaxChars),
	}
}

func validateConfig(cfg gatewayConfig) error {
	if strings.TrimSpace(cfg.Addr) == "" {
		return errors.New("SUBI_GATEWAY_ADDR is required")
	}
	if strings.TrimSpace(cfg.BuyerAPIKey) == "" {
		return errors.New("SUBI_BUYER_API_KEY is required")
	}
	if strings.TrimSpace(cfg.SellerNodeToken) == "" {
		return errors.New("SUBI_SELLER_NODE_TOKEN is required")
	}
	return nil
}

func handleSellerAgentWS(w http.ResponseWriter, r *http.Request, cfg gatewayConfig) {
	if bearerToken(r) != cfg.SellerNodeToken && strings.TrimSpace(r.URL.Query().Get("token")) != cfg.SellerNodeToken {
		writeJSONError(w, r, http.StatusUnauthorized, "authentication_error", "invalid seller node token")
		return
	}

	conn, err := agentUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	if err := service.DefaultSubiSellerNodeRegistry.ServeAgent(r.Context(), conn); err != nil {
		log.Printf("seller agent disconnected: %v", err)
	}
}

func handleBuyerRequest(w http.ResponseWriter, r *http.Request, cfg gatewayConfig) {
	startedAt := time.Now()
	requestID := service.NewSubiP2PRequestID()
	path := ""
	if r.URL != nil {
		path = r.URL.RequestURI()
	}
	status := 0
	sellerNode := ""
	upstreamMode := ""
	errorMessage := ""
	stream := false
	buyerKeyHash := buyerCredentialHash(r)
	sessionID := ""
	previousSellerNode := ""
	sessionMigrated := false
	historyTurnsInjected := 0
	timeToFirstChunkMs := int64(-1)
	bytesOut := int64(0)
	w.Header().Set("X-Subi-Request-ID", requestID)
	defer func() {
		logGatewayAccess(gatewayAccessLog{
			RequestID:            requestID,
			BuyerKeyHash:         buyerKeyHash,
			SessionID:            sessionID,
			Path:                 path,
			Status:               status,
			SellerNode:           sellerNode,
			PreviousSellerNode:   previousSellerNode,
			SessionMigrated:      sessionMigrated,
			HistoryTurnsInjected: historyTurnsInjected,
			UpstreamMode:         upstreamMode,
			Duration:             time.Since(startedAt),
			TimeToFirstChunkMs:   timeToFirstChunkMs,
			BytesOut:             bytesOut,
			Error:                errorMessage,
			Stream:               stream,
		})
	}()

	fail := func(code int, errType, message string) {
		status = code
		errorMessage = message
		writeJSONError(w, r, code, errType, message)
	}

	if !isForwardablePath(r.URL.Path) {
		fail(http.StatusNotFound, "not_found_error", "endpoint not found")
		return
	}
	if r.Method != http.MethodPost {
		fail(http.StatusMethodNotAllowed, "invalid_request_error", "method not allowed")
		return
	}
	if bearerToken(r) != cfg.BuyerAPIKey && strings.TrimSpace(r.Header.Get("x-api-key")) != cfg.BuyerAPIKey {
		fail(http.StatusUnauthorized, "authentication_error", "invalid buyer API key")
		return
	}

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, defaultMaxRequestBodyLen))
	if err != nil {
		fail(http.StatusBadRequest, "invalid_request_error", "failed to read request body")
		return
	}
	if len(body) == 0 {
		fail(http.StatusBadRequest, "invalid_request_error", "request body is empty")
		return
	}

	stream = gjson.GetBytes(body, "stream").Bool()
	sessionID = service.ExtractSubiSessionID(r.Header, body, buyerKeyHash)
	sessionHashValue := sessionHash(r, body)
	userText := ""
	sessionSnapshot := service.SubiSessionState{}
	if cfg.SessionContextEnabled {
		w.Header().Set("X-Subi-Session-ID", sessionID)
		sessionHashValue = service.SubiSessionHash(sessionID)
		sessionSnapshot = cfg.SessionStore.Snapshot(sessionID, buyerKeyHash)
		previousSellerNode = sessionSnapshot.LastSellerNode
		if extracted, ok := service.ExtractSubiUserText(body, r.URL.Path); ok {
			userText = extracted
			rewrittenBody, injected, rewritten, err := service.BuildSubiContextualRequestBody(body, r.URL.Path, sessionSnapshot.Turns, userText)
			if err != nil {
				log.Printf("subi session context rewrite failed: request_id=%s session_id=%q error=%v", requestID, sessionID, err)
			} else if rewritten {
				body = rewrittenBody
				historyTurnsInjected = injected
			}
		}
	}
	dispatch, err := service.DefaultSubiSellerNodeRegistry.Dispatch(r.Context(), service.SubiP2PRequest{
		RequestID:          requestID,
		Method:             r.Method,
		Path:               r.URL.RequestURI(),
		Headers:            forwardHeaders(r.Header),
		Body:               body,
		Stream:             stream,
		SessionID:          sessionID,
		SessionHash:        sessionHashValue,
		PreviousSellerNode: previousSellerNode,
		Timeout:            defaultRequestTimeout,
	})
	if err != nil {
		switch {
		case errors.Is(err, service.ErrSubiP2PAgentBusy):
			fail(http.StatusServiceUnavailable, "api_error", "seller node is busy, please retry later")
		default:
			fail(http.StatusServiceUnavailable, "api_error", "no available seller node")
		}
		return
	}
	defer dispatch.Done()
	sellerNode = dispatch.NodeID
	if previousSellerNode == "" {
		previousSellerNode = dispatch.PreviousSellerNode
	}
	sessionMigrated = dispatch.SessionMigrated
	if cfg.SessionContextEnabled {
		w.Header().Set("X-Subi-Session-Migrated", fmt.Sprintf("%t", sessionMigrated))
	}

	flusher, _ := w.(http.Flusher)
	responseStarted := false
	responseContentType := ""
	var responseBody bytes.Buffer
	sessionSaved := false
	saveSession := func() {
		if sessionSaved || !cfg.SessionContextEnabled || status < 200 || status >= 400 {
			return
		}
		sessionSaved = true
		assistantText := service.ExtractSubiAssistantText(responseBody.Bytes(), responseContentType)
		cfg.SessionStore.AppendExchange(sessionID, buyerKeyHash, requestID, userText, assistantText, sellerNode)
	}
	for ev := range dispatch.Events {
		switch ev.Type {
		case service.SubiEnvelopeResponseStart:
			responseStarted = true
			copyResponseHeaders(w.Header(), ev.Headers)
			w.Header().Set("X-Subi-Seller-Node", dispatch.NodeID)
			if cfg.SessionContextEnabled {
				w.Header().Set("X-Subi-Session-ID", sessionID)
				w.Header().Set("X-Subi-Session-Migrated", fmt.Sprintf("%t", sessionMigrated))
			}
			upstreamMode = strings.TrimSpace(ev.Headers.Get("X-Subi-Upstream-Mode"))
			if upstreamMode != "" {
				w.Header().Set("X-Subi-Upstream-Mode", upstreamMode)
			}
			responseContentType = strings.TrimSpace(ev.Headers.Get("Content-Type"))
			responseStatus := ev.StatusCode
			if responseStatus <= 0 {
				responseStatus = http.StatusOK
			}
			status = responseStatus
			w.WriteHeader(status)
			flush(flusher)
		case service.SubiEnvelopeResponseChunk:
			if !responseStarted {
				responseStarted = true
				w.Header().Set("Content-Type", "text/event-stream")
				w.Header().Set("Cache-Control", "no-cache")
				w.Header().Set("X-Accel-Buffering", "no")
				w.Header().Set("X-Subi-Seller-Node", dispatch.NodeID)
				status = http.StatusOK
				w.WriteHeader(status)
			}
			if len(ev.Data) > 0 {
				if timeToFirstChunkMs < 0 {
					timeToFirstChunkMs = time.Since(startedAt).Milliseconds()
				}
				bytesOut += int64(len(ev.Data))
				if cfg.SessionContextEnabled {
					_, _ = responseBody.Write(ev.Data)
				}
				if _, err := w.Write(ev.Data); err != nil {
					errorMessage = err.Error()
					return
				}
				flush(flusher)
			}
		case service.SubiEnvelopeResponseError:
			errorMessage = ev.Error
			if responseStarted {
				if status == 0 {
					status = http.StatusOK
				}
				writeSSEError(w, ev.Error)
				flush(flusher)
				return
			}
			fail(http.StatusBadGateway, "api_error", ev.Error)
			return
		case service.SubiEnvelopeResponseEnd:
			if status == 0 {
				status = http.StatusOK
			}
			saveSession()
			return
		}
	}
	errorMessage = "seller agent response stream closed"
	if !responseStarted {
		fail(http.StatusBadGateway, "api_error", errorMessage)
		return
	}
}

type gatewayAccessLog struct {
	RequestID            string
	BuyerKeyHash         string
	SessionID            string
	Path                 string
	Status               int
	SellerNode           string
	PreviousSellerNode   string
	SessionMigrated      bool
	HistoryTurnsInjected int
	UpstreamMode         string
	Duration             time.Duration
	TimeToFirstChunkMs   int64
	BytesOut             int64
	Error                string
	Stream               bool
}

func logGatewayAccess(entry gatewayAccessLog) {
	log.Printf(
		"subi_gateway_access request_id=%s buyer_key_hash=%q session_id=%q path=%q status=%d seller_node=%q previous_seller_node=%q session_migrated=%t history_turns_injected=%d upstream_mode=%q duration_ms=%d time_to_first_chunk_ms=%d bytes_out=%d error=%q stream=%t",
		entry.RequestID,
		entry.BuyerKeyHash,
		entry.SessionID,
		entry.Path,
		entry.Status,
		entry.SellerNode,
		entry.PreviousSellerNode,
		entry.SessionMigrated,
		entry.HistoryTurnsInjected,
		entry.UpstreamMode,
		entry.Duration.Milliseconds(),
		entry.TimeToFirstChunkMs,
		entry.BytesOut,
		entry.Error,
		entry.Stream,
	)
}

func buyerCredentialHash(r *http.Request) string {
	value := bearerToken(r)
	if value == "" && r != nil {
		value = strings.TrimSpace(r.Header.Get("x-api-key"))
	}
	if value == "" {
		return ""
	}
	return sha256Hex(value)[:16]
}

func isForwardablePath(path string) bool {
	switch {
	case path == "/v1/messages":
		return true
	case path == "/v1/responses" || strings.HasPrefix(path, "/v1/responses/"):
		return true
	case path == "/responses" || strings.HasPrefix(path, "/responses/"):
		return true
	case path == "/backend-api/codex/responses" || strings.HasPrefix(path, "/backend-api/codex/responses/"):
		return true
	case path == "/v1/chat/completions" || path == "/chat/completions":
		return true
	default:
		return false
	}
}

func bearerToken(r *http.Request) string {
	auth := strings.TrimSpace(r.Header.Get("Authorization"))
	parts := strings.SplitN(auth, " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return ""
	}
	return strings.TrimSpace(parts[1])
}

func forwardHeaders(src http.Header) http.Header {
	dst := make(http.Header, len(src))
	for key, values := range src {
		switch strings.ToLower(strings.TrimSpace(key)) {
		case "authorization", "x-api-key", "x-goog-api-key", "cookie", "host", "content-length", "connection":
			continue
		}
		for _, value := range values {
			dst.Add(key, value)
		}
	}
	return dst
}

func copyResponseHeaders(dst, src http.Header) {
	for key, values := range src {
		switch strings.ToLower(strings.TrimSpace(key)) {
		case "content-length", "connection", "transfer-encoding":
			continue
		}
		for _, value := range values {
			dst.Add(key, value)
		}
	}
}

func sessionHash(r *http.Request, body []byte) string {
	candidates := []string{
		strings.TrimSpace(r.Header.Get("session_id")),
		strings.TrimSpace(r.Header.Get("x-session-id")),
		strings.TrimSpace(r.Header.Get("x-stainless-session-id")),
		strings.TrimSpace(gjson.GetBytes(body, "metadata.user_id").String()),
		strings.TrimSpace(gjson.GetBytes(body, "metadata.session_id").String()),
		strings.TrimSpace(gjson.GetBytes(body, "prompt_cache_key").String()),
		strings.TrimSpace(gjson.GetBytes(body, "conversation_id").String()),
		strings.TrimSpace(gjson.GetBytes(body, "previous_response_id").String()),
	}
	for _, candidate := range candidates {
		if candidate != "" {
			return sha256Hex(candidate)
		}
	}
	return "buyer-key-" + sha256Hex(bearerToken(r))
}

func writeJSONError(w http.ResponseWriter, r *http.Request, status int, errType, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if isOpenAIPath(r.URL.Path) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error": map[string]any{
				"type":    errType,
				"message": message,
			},
		})
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]any{
		"type": "error",
		"error": map[string]any{
			"type":    errType,
			"message": message,
		},
	})
}

func writeSSEError(w http.ResponseWriter, message string) {
	payload, _ := json.Marshal(map[string]any{
		"type": "error",
		"error": map[string]any{
			"type":    "api_error",
			"message": message,
		},
	})
	_, _ = fmt.Fprintf(w, "event: error\ndata: %s\n\n", payload)
}

func isOpenAIPath(path string) bool {
	return strings.Contains(path, "/responses") ||
		strings.Contains(path, "/chat/completions") ||
		strings.Contains(path, "/backend-api/codex")
}

func flush(flusher http.Flusher) {
	if flusher != nil {
		flusher.Flush()
	}
}

func sha256Hex(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func envOrDefault(key, fallback string) string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	return value
}

func envBool(key string) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(key))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func envInt(key string, fallback int) int {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}
