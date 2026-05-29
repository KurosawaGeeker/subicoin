package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	_ "embed"
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
	"github.com/Wei-Shaw/sub2api/internal/store"

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

//go:embed assets/install-seller.sh
var sellerInstallScript string

type gatewayConfig struct {
	Addr                  string
	BuyerAPIKey           string
	SellerNodeToken       string
	DBPath                string
	DevStaticKeys         bool
	PublicGatewayWSURL    string
	SessionCookieName     string
	Store                 *store.Store
	SessionContextEnabled bool
	SessionMaxTurns       int
	SessionMaxChars       int
	SessionStore          *service.SubiSessionStore
}

func main() {
	cfg := loadConfig()
	if cfg.DBPath != "" {
		store, err := store.Open(cfg.DBPath)
		if err != nil {
			log.Fatalf("open subi db: %v", err)
		}
		defer store.Close()
		cfg.Store = store
		log.Printf("subi-gateway account store enabled: path=%s", cfg.DBPath)
	}
	if err := validateConfig(cfg); err != nil {
		log.Fatalf("subi-gateway config error: %v", err)
	}
	cfg.SessionStore = service.NewSubiSessionStore(cfg.SessionMaxTurns, cfg.SessionMaxChars)

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	mux.HandleFunc("/api/web/auth/", func(w http.ResponseWriter, r *http.Request) {
		handleWebAuth(w, r, cfg)
	})
	mux.HandleFunc("/api/web/buyer/", func(w http.ResponseWriter, r *http.Request) {
		handleWebBuyer(w, r, cfg)
	})
	mux.HandleFunc("/api/web/seller/", func(w http.ResponseWriter, r *http.Request) {
		handleWebSeller(w, r, cfg)
	})
	mux.HandleFunc("/api/v1/subi/seller/setup", func(w http.ResponseWriter, r *http.Request) {
		handleSellerSetup(w, r, cfg)
	})
	mux.HandleFunc("/api/v1/subi/seller/install.sh", func(w http.ResponseWriter, r *http.Request) {
		handleSellerInstallScript(w, r)
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
		DBPath:                strings.TrimSpace(os.Getenv("SUBI_DB_PATH")),
		DevStaticKeys:         envBool("SUBI_DEV_STATIC_KEYS"),
		PublicGatewayWSURL:    strings.TrimSpace(os.Getenv("SUBI_PUBLIC_GATEWAY_WS_URL")),
		SessionCookieName:     envOrDefault("SUBI_SESSION_COOKIE_NAME", "subi_session"),
		SessionContextEnabled: envBool("SUBI_SESSION_CONTEXT_ENABLED"),
		SessionMaxTurns:       envInt("SUBI_SESSION_MAX_TURNS", service.DefaultSubiSessionMaxTurns),
		SessionMaxChars:       envInt("SUBI_SESSION_MAX_CHARS", service.DefaultSubiSessionMaxChars),
	}
}

func validateConfig(cfg gatewayConfig) error {
	if strings.TrimSpace(cfg.Addr) == "" {
		return errors.New("SUBI_GATEWAY_ADDR is required")
	}
	if cfg.Store != nil && !cfg.DevStaticKeys {
		return nil
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
	token := sellerNodeBearerToken(r)
	if cfg.Store == nil || staticSellerTokenAllowed(cfg, token) {
		if token != cfg.SellerNodeToken {
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
		return
	}

	if token == "" {
		writeJSONError(w, r, http.StatusUnauthorized, "authentication_error", "invalid seller node token")
		return
	}

	conn, err := agentUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	hooks := service.SubiSellerNodeHooks{
		AuthNode: func(ctx context.Context, nodeID string) error {
			_, err := cfg.Store.AuthenticateSellerNode(ctx, nodeID, token)
			return err
		},
		OnNodeHeartbeat: func(ctx context.Context, nodeID string) {
			if err := cfg.Store.MarkSellerNodeHeartbeat(ctx, nodeID); err != nil {
				log.Printf("seller heartbeat update failed: node=%s error=%v", nodeID, err)
			}
		},
		OnNodeDisconnected: func(ctx context.Context, nodeID string) {
			if err := cfg.Store.MarkSellerNodeOffline(ctx, nodeID); err != nil {
				log.Printf("seller offline update failed: node=%s error=%v", nodeID, err)
			}
		},
	}
	if err := service.DefaultSubiSellerNodeRegistry.ServeAgentWithHooks(r.Context(), conn, hooks); err != nil {
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
	buyerSecret := buyerCredential(r)
	if !authenticateBuyerRequest(r.Context(), cfg, buyerSecret) {
		fail(http.StatusUnauthorized, "authentication_error", "invalid buyer API key")
		return
	}
	if cfg.Store != nil && !staticBuyerKeyAllowed(cfg, buyerSecret) {
		buyerKeyHash = store.HashSecret(buyerSecret)[:16]
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

func handleWebAuth(w http.ResponseWriter, r *http.Request, cfg gatewayConfig) {
	if cfg.Store == nil {
		writeAPIError(w, http.StatusServiceUnavailable, "account store is not enabled")
		return
	}
	switch {
	case r.Method == http.MethodPost && r.URL.Path == "/api/web/auth/register":
		var req struct {
			Email    string `json:"email"`
			Password string `json:"password"`
		}
		if !decodeJSONBody(w, r, &req) {
			return
		}
		user, err := cfg.Store.RegisterUser(r.Context(), req.Email, req.Password)
		if err != nil {
			writeStoreError(w, err, "register failed")
			return
		}
		session, expiresAt, err := cfg.Store.CreateWebSession(r.Context(), user.ID, 7*24*time.Hour)
		if err != nil {
			writeAPIError(w, http.StatusInternalServerError, "create session failed")
			return
		}
		setSessionCookie(w, r, cfg, session, expiresAt)
		writeJSON(w, http.StatusCreated, map[string]any{"user": user, "roles": []string{"buyer", "seller"}})
	case r.Method == http.MethodPost && r.URL.Path == "/api/web/auth/login":
		var req struct {
			Email    string `json:"email"`
			Password string `json:"password"`
		}
		if !decodeJSONBody(w, r, &req) {
			return
		}
		user, err := cfg.Store.AuthenticateUser(r.Context(), req.Email, req.Password)
		if err != nil {
			writeAPIError(w, http.StatusUnauthorized, "invalid email or password")
			return
		}
		session, expiresAt, err := cfg.Store.CreateWebSession(r.Context(), user.ID, 7*24*time.Hour)
		if err != nil {
			writeAPIError(w, http.StatusInternalServerError, "create session failed")
			return
		}
		setSessionCookie(w, r, cfg, session, expiresAt)
		writeJSON(w, http.StatusOK, map[string]any{"user": user, "roles": []string{"buyer", "seller"}})
	case r.Method == http.MethodPost && r.URL.Path == "/api/web/auth/logout":
		if cookie, err := r.Cookie(cfg.SessionCookieName); err == nil {
			_ = cfg.Store.DeleteWebSession(r.Context(), cookie.Value)
		}
		clearSessionCookie(w, cfg)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	case r.Method == http.MethodGet && r.URL.Path == "/api/web/auth/me":
		user, ok := requireWebUser(w, r, cfg)
		if !ok {
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"user": user, "roles": []string{"buyer", "seller"}})
	default:
		writeAPIError(w, http.StatusNotFound, "endpoint not found")
	}
}

func handleWebBuyer(w http.ResponseWriter, r *http.Request, cfg gatewayConfig) {
	if cfg.Store == nil {
		writeAPIError(w, http.StatusServiceUnavailable, "account store is not enabled")
		return
	}
	user, ok := requireWebUser(w, r, cfg)
	if !ok {
		return
	}
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/api/web/buyer/me":
		writeJSON(w, http.StatusOK, map[string]any{"buyer": map[string]any{"user_id": user.ID, "email": user.Email}})
	case r.Method == http.MethodGet && r.URL.Path == "/api/web/buyer/api-keys":
		keys, err := cfg.Store.ListBuyerAPIKeys(r.Context(), user.ID)
		if err != nil {
			writeAPIError(w, http.StatusInternalServerError, "list api keys failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"api_keys": keys})
	case r.Method == http.MethodPost && r.URL.Path == "/api/web/buyer/api-keys":
		var req struct {
			Name string `json:"name"`
		}
		if !decodeJSONBody(w, r, &req) {
			return
		}
		key, err := cfg.Store.CreateBuyerAPIKey(r.Context(), user.ID, req.Name)
		if err != nil {
			writeStoreError(w, err, "create api key failed")
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{"api_key": key.BuyerAPIKey, "secret": key.Secret})
	case r.Method == http.MethodPost && strings.HasPrefix(r.URL.Path, "/api/web/buyer/api-keys/") && strings.HasSuffix(r.URL.Path, "/revoke"):
		keyID := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/web/buyer/api-keys/"), "/revoke")
		if keyID == "" {
			writeAPIError(w, http.StatusNotFound, "endpoint not found")
			return
		}
		if err := cfg.Store.RevokeBuyerAPIKey(r.Context(), user.ID, keyID); err != nil {
			writeStoreError(w, err, "revoke api key failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	default:
		writeAPIError(w, http.StatusNotFound, "endpoint not found")
	}
}

func handleWebSeller(w http.ResponseWriter, r *http.Request, cfg gatewayConfig) {
	if cfg.Store == nil {
		writeAPIError(w, http.StatusServiceUnavailable, "account store is not enabled")
		return
	}
	user, ok := requireWebUser(w, r, cfg)
	if !ok {
		return
	}
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/api/web/seller/me":
		writeJSON(w, http.StatusOK, map[string]any{"seller": map[string]any{"user_id": user.ID, "email": user.Email}})
	case r.Method == http.MethodGet && r.URL.Path == "/api/web/seller/nodes":
		nodes, err := cfg.Store.ListSellerNodes(r.Context(), user.ID)
		if err != nil {
			writeAPIError(w, http.StatusInternalServerError, "list seller nodes failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"nodes": nodes})
	case r.Method == http.MethodPost && r.URL.Path == "/api/web/seller/nodes":
		var req struct {
			NodeID         string `json:"node_id"`
			Provider       string `json:"provider"`
			MaxConcurrency int    `json:"max_concurrency"`
		}
		if !decodeJSONBody(w, r, &req) {
			return
		}
		node, err := cfg.Store.CreateSellerNode(r.Context(), user.ID, req.NodeID, req.Provider, req.MaxConcurrency)
		if err != nil {
			writeStoreError(w, err, "create seller node failed")
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{"node": node})
	case r.Method == http.MethodPost && strings.HasPrefix(r.URL.Path, "/api/web/seller/nodes/") && strings.HasSuffix(r.URL.Path, "/setup-token"):
		nodeID := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/web/seller/nodes/"), "/setup-token")
		if nodeID == "" {
			writeAPIError(w, http.StatusNotFound, "endpoint not found")
			return
		}
		setup, err := cfg.Store.CreateSellerSetupToken(r.Context(), user.ID, nodeID, 30*time.Minute)
		if err != nil {
			writeStoreError(w, err, "create setup token failed")
			return
		}
		setupURL := sellerSetupURL(r, setup.Token)
		installCommand := fmt.Sprintf("curl -fsSL %s | bash -s -- --gateway %s --setup-token %s", publicInstallScriptURL(r), requestPublicBaseURL(r), setup.Token)
		writeJSON(w, http.StatusCreated, map[string]any{
			"setup_token":     setup.Token,
			"expires_at":      setup.ExpiresAt,
			"setup_url":       setupURL,
			"install_command": installCommand,
		})
	default:
		writeAPIError(w, http.StatusNotFound, "endpoint not found")
	}
}

func handleSellerSetup(w http.ResponseWriter, r *http.Request, cfg gatewayConfig) {
	if cfg.Store == nil {
		writeAPIError(w, http.StatusServiceUnavailable, "account store is not enabled")
		return
	}
	if r.Method != http.MethodGet {
		writeAPIError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	setupToken := strings.TrimSpace(r.URL.Query().Get("token"))
	setup, err := cfg.Store.RedeemSellerSetupToken(r.Context(), setupToken)
	if err != nil {
		writeAPIError(w, http.StatusUnauthorized, "invalid or expired seller setup token")
		return
	}
	wsURL := cfg.PublicGatewayWSURL
	if wsURL == "" {
		wsURL = requestPublicWSURL(r)
	}
	configEnv := sellerConfigEnv(wsURL, setup)
	writeJSON(w, http.StatusOK, map[string]any{
		"subi_gateway_ws_url":     wsURL,
		"subi_seller_node_token":  setup.NodeToken,
		"subi_node_id":            setup.NodeID,
		"seller_upstream_mode":    setup.Provider,
		"seller_codex_workers":    setup.MaxConcurrency,
		"seller_codex_workdir":    "/tmp/subi-codex-work",
		"seller_codex_sandbox":    "read-only",
		"seller_config_env":       configEnv,
		"seller_agent_configured": true,
	})
}

func handleSellerInstallScript(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeAPIError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	w.Header().Set("Content-Type", "text/x-shellscript; charset=utf-8")
	_, _ = io.WriteString(w, sellerInstallScript)
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
	value := buyerCredential(r)
	if value == "" {
		return ""
	}
	return sha256Hex(value)[:16]
}

func buyerCredential(r *http.Request) string {
	value := bearerToken(r)
	if value == "" && r != nil {
		value = strings.TrimSpace(r.Header.Get("x-api-key"))
	}
	return value
}

func sellerNodeBearerToken(r *http.Request) string {
	value := bearerToken(r)
	if value == "" && r != nil && r.URL != nil {
		value = strings.TrimSpace(r.URL.Query().Get("token"))
	}
	return value
}

func staticBuyerKeyAllowed(cfg gatewayConfig, secret string) bool {
	return strings.TrimSpace(secret) != "" && strings.TrimSpace(cfg.BuyerAPIKey) != "" && secret == cfg.BuyerAPIKey && (cfg.Store == nil || cfg.DevStaticKeys)
}

func staticSellerTokenAllowed(cfg gatewayConfig, secret string) bool {
	return strings.TrimSpace(secret) != "" && strings.TrimSpace(cfg.SellerNodeToken) != "" && secret == cfg.SellerNodeToken && (cfg.Store == nil || cfg.DevStaticKeys)
}

func authenticateBuyerRequest(ctx context.Context, cfg gatewayConfig, secret string) bool {
	if staticBuyerKeyAllowed(cfg, secret) {
		return true
	}
	if cfg.Store == nil {
		return false
	}
	_, err := cfg.Store.AuthenticateBuyerAPIKey(ctx, secret)
	if err != nil {
		log.Printf("buyer api key auth failed: %v", err)
		return false
	}
	return true
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
	return "buyer-key-" + sha256Hex(buyerCredential(r))
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

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeAPIError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]any{
			"message": message,
		},
	})
}

func writeStoreError(w http.ResponseWriter, err error, fallback string) {
	switch {
	case errors.Is(err, store.ErrConflict):
		writeAPIError(w, http.StatusConflict, fallback)
	case errors.Is(err, store.ErrInvalid):
		writeAPIError(w, http.StatusBadRequest, fallback)
	case errors.Is(err, store.ErrNotFound):
		writeAPIError(w, http.StatusNotFound, fallback)
	case errors.Is(err, store.ErrUnauthorized):
		writeAPIError(w, http.StatusUnauthorized, fallback)
	default:
		writeAPIError(w, http.StatusInternalServerError, fallback)
	}
}

func decodeJSONBody(w http.ResponseWriter, r *http.Request, out any) bool {
	defer r.Body.Close()
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(out); err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid JSON body")
		return false
	}
	return true
}

func requireWebUser(w http.ResponseWriter, r *http.Request, cfg gatewayConfig) (store.User, bool) {
	cookie, err := r.Cookie(cfg.SessionCookieName)
	if err != nil || strings.TrimSpace(cookie.Value) == "" {
		writeAPIError(w, http.StatusUnauthorized, "login required")
		return store.User{}, false
	}
	user, err := cfg.Store.UserBySession(r.Context(), cookie.Value)
	if err != nil {
		writeAPIError(w, http.StatusUnauthorized, "login required")
		return store.User{}, false
	}
	return user, true
}

func setSessionCookie(w http.ResponseWriter, r *http.Request, cfg gatewayConfig, value string, expiresAt time.Time) {
	http.SetCookie(w, &http.Cookie{
		Name:     cfg.SessionCookieName,
		Value:    value,
		Path:     "/",
		Expires:  expiresAt,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https"),
	})
}

func clearSessionCookie(w http.ResponseWriter, cfg gatewayConfig) {
	http.SetCookie(w, &http.Cookie{
		Name:     cfg.SessionCookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
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

func sellerConfigEnv(wsURL string, setup store.SellerSetupConfig) string {
	return fmt.Sprintf(`SUBI_GATEWAY_WS_URL=%q
SUBI_SELLER_NODE_TOKEN=%q
SUBI_NODE_ID=%q
SELLER_UPSTREAM_MODE=%q
SELLER_CODEX_WORKERS=%d
SELLER_CODEX_BIN="$(command -v codex)"
SELLER_CODEX_MODEL="gpt-5.5"
SELLER_CODEX_WORKDIR="/tmp/subi-codex-work"
SELLER_CODEX_SANDBOX="read-only"
SELLER_CODEX_APP_SERVER_PORT_BASE=19100
SELLER_CODEX_APP_SERVER_STICKY_THREADS=true`,
		wsURL,
		setup.NodeToken,
		setup.NodeID,
		setup.Provider,
		setup.MaxConcurrency,
	)
}

func sellerSetupURL(r *http.Request, token string) string {
	return requestPublicBaseURL(r) + "/api/v1/subi/seller/setup?token=" + token
}

func publicInstallScriptURL(r *http.Request) string {
	return requestPublicBaseURL(r) + "/api/v1/subi/seller/install.sh"
}

func requestPublicBaseURL(r *http.Request) string {
	scheme := strings.TrimSpace(r.Header.Get("X-Forwarded-Proto"))
	if scheme == "" {
		if r.TLS != nil {
			scheme = "https"
		} else {
			scheme = "http"
		}
	}
	host := strings.TrimSpace(r.Header.Get("X-Forwarded-Host"))
	if host == "" {
		host = r.Host
	}
	return scheme + "://" + host
}

func requestPublicWSURL(r *http.Request) string {
	scheme := "ws"
	if r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
		scheme = "wss"
	}
	host := strings.TrimSpace(r.Header.Get("X-Forwarded-Host"))
	if host == "" {
		host = r.Host
	}
	return scheme + "://" + host + "/api/v1/subi/seller/agent/ws"
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
