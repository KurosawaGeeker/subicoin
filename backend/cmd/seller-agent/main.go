package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gorilla/websocket"
)

const sellerAgentVersion = "mvp-0"
const sellerAgentWSWriteTimeout = 30 * time.Second

type agentConfig struct {
	GatewayWSURL            string
	NodeToken               string
	NodeID                  string
	UpstreamMode            string
	WorkerCount             int
	WorkerQueueLen          int
	LocalBaseURL            string
	LocalAPIKey             string
	CodexBin                string
	CodexModel              string
	CodexWorkDir            string
	CodexSandbox            string
	CodexExtraArgs          []string
	AppServerBin            string
	AppServerHost           string
	AppServerPortBase       int
	AppServerStartupTimeout time.Duration
	AppServerStickyThreads  bool
}

type wsWriter struct {
	conn *websocket.Conn
	mu   sync.Mutex
}

type agentWorkerPool struct {
	ctx      context.Context
	cfg      agentConfig
	writer   *wsWriter
	requests chan service.SubiEnvelope
	workers  []*agentWorker
	wg       sync.WaitGroup
}

type agentWorker struct {
	id        int
	cfg       agentConfig
	writer    *wsWriter
	appServer *codexAppServerUpstream
}

func main() {
	cfg := loadConfig()
	if err := validateConfig(cfg); err != nil {
		log.Fatalf("seller-agent config error: %v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	for {
		if err := run(ctx, cfg); err != nil && !errors.Is(err, context.Canceled) {
			log.Printf("seller-agent disconnected: %v", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(3 * time.Second):
		}
	}
}

func loadConfig() agentConfig {
	nodeID := strings.TrimSpace(os.Getenv("SUBI_NODE_ID"))
	if nodeID == "" {
		host, _ := os.Hostname()
		nodeID = host
	}
	localAPIKey := strings.TrimSpace(os.Getenv("SELLER_LOCAL_API_KEY"))
	upstreamMode := strings.ToLower(strings.TrimSpace(os.Getenv("SELLER_UPSTREAM_MODE")))
	localBaseURL := strings.TrimRight(strings.TrimSpace(os.Getenv("SELLER_LOCAL_BASE_URL")), "/")
	if upstreamMode == "" {
		if localBaseURL != "" {
			upstreamMode = "http"
		} else {
			upstreamMode = "codex-exec"
		}
	}
	upstreamMode = normalizeUpstreamMode(upstreamMode)
	codexBin := strings.TrimSpace(os.Getenv("SELLER_CODEX_BIN"))
	if codexBin == "" {
		codexBin = "codex"
	}
	appServerBin := firstNonEmpty(
		os.Getenv("SELLER_CODEX_APP_SERVER_BIN"),
		os.Getenv("SELLER_CODEX_SERVER_BIN"),
		codexBin,
	)
	appServerHost, appServerPortBase := appServerListenConfig()
	codexWorkDir := strings.TrimSpace(os.Getenv("SELLER_CODEX_WORKDIR"))
	if codexWorkDir == "" {
		codexWorkDir = filepath.Join(os.TempDir(), "subi-codex-work")
	}
	codexSandbox := strings.TrimSpace(os.Getenv("SELLER_CODEX_SANDBOX"))
	if codexSandbox == "" {
		codexSandbox = "read-only"
	}
	workerCount := envInt("SELLER_CODEX_WORKERS", 0)
	if workerCount <= 0 {
		workerCount = envInt("SELLER_WORKERS", 1)
	}
	workerQueueLen := envInt("SELLER_WORKER_QUEUE_SIZE", workerCount)
	if workerQueueLen < workerCount {
		workerQueueLen = workerCount
	}
	return agentConfig{
		GatewayWSURL:            strings.TrimSpace(os.Getenv("SUBI_GATEWAY_WS_URL")),
		NodeToken:               strings.TrimSpace(os.Getenv("SUBI_SELLER_NODE_TOKEN")),
		NodeID:                  nodeID,
		UpstreamMode:            upstreamMode,
		WorkerCount:             workerCount,
		WorkerQueueLen:          workerQueueLen,
		LocalBaseURL:            localBaseURL,
		LocalAPIKey:             localAPIKey,
		CodexBin:                codexBin,
		CodexModel:              strings.TrimSpace(os.Getenv("SELLER_CODEX_MODEL")),
		CodexWorkDir:            codexWorkDir,
		CodexSandbox:            codexSandbox,
		CodexExtraArgs:          splitArgs(os.Getenv("SELLER_CODEX_EXTRA_ARGS")),
		AppServerBin:            strings.TrimSpace(appServerBin),
		AppServerHost:           appServerHost,
		AppServerPortBase:       appServerPortBase,
		AppServerStartupTimeout: envDurationMS("SELLER_CODEX_APP_SERVER_STARTUP_TIMEOUT_MS", 15*time.Second),
		AppServerStickyThreads:  envBool("SELLER_CODEX_APP_SERVER_STICKY_THREADS", true),
	}
}

func validateConfig(cfg agentConfig) error {
	if cfg.GatewayWSURL == "" {
		return errors.New("SUBI_GATEWAY_WS_URL is required")
	}
	if cfg.NodeToken == "" {
		return errors.New("SUBI_SELLER_NODE_TOKEN is required")
	}
	if cfg.NodeID == "" {
		return errors.New("SUBI_NODE_ID or hostname is required")
	}
	if cfg.WorkerCount <= 0 {
		return errors.New("SELLER_CODEX_WORKERS or SELLER_WORKERS must be greater than 0")
	}
	if cfg.WorkerQueueLen <= 0 {
		return errors.New("SELLER_WORKER_QUEUE_SIZE must be greater than 0")
	}
	switch cfg.UpstreamMode {
	case "codex-exec":
		if cfg.CodexBin == "" {
			return errors.New("SELLER_CODEX_BIN is required for codex-exec mode")
		}
		if cfg.CodexWorkDir == "" {
			return errors.New("SELLER_CODEX_WORKDIR is required for codex-exec mode")
		}
	case "http":
		if cfg.LocalBaseURL == "" {
			return errors.New("SELLER_LOCAL_BASE_URL is required for http mode")
		}
		localURL, err := url.Parse(cfg.LocalBaseURL)
		if err != nil {
			return fmt.Errorf("SELLER_LOCAL_BASE_URL is invalid: %w", err)
		}
		if localURL.Scheme != "http" && localURL.Scheme != "https" {
			return errors.New("SELLER_LOCAL_BASE_URL must start with http:// or https://")
		}
		if localURL.Host == "" {
			return errors.New("SELLER_LOCAL_BASE_URL must include a host")
		}
		if cfg.LocalAPIKey == "" {
			return errors.New("SELLER_LOCAL_API_KEY is required for http mode")
		}
	case "codex-app-server":
		if cfg.AppServerBin == "" {
			return errors.New("SELLER_CODEX_APP_SERVER_BIN or SELLER_CODEX_BIN is required for codex-app-server mode")
		}
		if cfg.AppServerHost == "" {
			return errors.New("SELLER_CODEX_APP_SERVER_HOST is required for codex-app-server mode")
		}
		if cfg.AppServerPortBase <= 0 {
			return errors.New("SELLER_CODEX_APP_SERVER_PORT_BASE must be greater than 0")
		}
		if cfg.CodexWorkDir == "" {
			return errors.New("SELLER_CODEX_WORKDIR is required for codex-app-server mode")
		}
		if cfg.AppServerStartupTimeout <= 0 {
			return errors.New("SELLER_CODEX_APP_SERVER_STARTUP_TIMEOUT_MS must be greater than 0")
		}
	default:
		return fmt.Errorf("SELLER_UPSTREAM_MODE must be codex-exec, codex-app-server, or http, got %q", cfg.UpstreamMode)
	}
	return nil
}

func run(ctx context.Context, cfg agentConfig) error {
	header := http.Header{}
	header.Set("Authorization", "Bearer "+cfg.NodeToken)
	conn, _, err := websocket.DefaultDialer.DialContext(ctx, cfg.GatewayWSURL, header)
	if err != nil {
		return fmt.Errorf("connect gateway: %w", err)
	}
	defer conn.Close()
	connCtx, cancel := context.WithCancel(ctx)

	writer := &wsWriter{conn: conn}
	pool, err := newAgentWorkerPool(connCtx, cfg, writer)
	if err != nil {
		cancel()
		return fmt.Errorf("start seller workers: %w", err)
	}
	defer func() {
		cancel()
		pool.wait()
	}()
	if err := writer.writeJSON(service.SubiEnvelope{
		Type:           service.SubiEnvelopeAgentHello,
		NodeID:         cfg.NodeID,
		Version:        sellerAgentVersion,
		MaxConcurrency: cfg.WorkerCount,
		Meta: map[string]any{
			"upstream_mode":              cfg.UpstreamMode,
			"worker_count":               cfg.WorkerCount,
			"worker_queue_len":           cfg.WorkerQueueLen,
			"app_server_sticky_threads":  cfg.AppServerStickyThreads,
			"app_server_port_base":       cfg.AppServerPortBase,
			"app_server_startup_timeout": cfg.AppServerStartupTimeout.Milliseconds(),
		},
	}); err != nil {
		return fmt.Errorf("send hello: %w", err)
	}
	log.Printf("seller-agent connected: node=%s gateway=%s mode=%s workers=%d queue=%d", cfg.NodeID, cfg.GatewayWSURL, cfg.UpstreamMode, cfg.WorkerCount, cfg.WorkerQueueLen)

	heartbeatDone := make(chan struct{})
	go func() {
		defer close(heartbeatDone)
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-connCtx.Done():
				return
			case <-ticker.C:
				if err := writer.writeJSON(service.SubiEnvelope{
					Type:   service.SubiEnvelopeHeartbeat,
					NodeID: cfg.NodeID,
					Meta: map[string]any{
						"upstream_mode":             cfg.UpstreamMode,
						"worker_count":              cfg.WorkerCount,
						"app_server_sticky_threads": cfg.AppServerStickyThreads,
					},
				}); err != nil {
					_ = conn.Close()
					return
				}
			}
		}
	}()

	for {
		var env service.SubiEnvelope
		if err := conn.ReadJSON(&env); err != nil {
			return err
		}
		if env.Type != service.SubiEnvelopeRequestStart {
			continue
		}
		if !pool.submit(env) {
			sendAgentError(writer, env.RequestID, "seller worker queue is full")
		}
		select {
		case <-heartbeatDone:
			return errors.New("heartbeat writer stopped")
		default:
		}
	}
}

func newAgentWorkerPool(ctx context.Context, cfg agentConfig, writer *wsWriter) (*agentWorkerPool, error) {
	pool := &agentWorkerPool{
		ctx:      ctx,
		cfg:      cfg,
		writer:   writer,
		requests: make(chan service.SubiEnvelope, cfg.WorkerQueueLen),
	}
	for i := 0; i < cfg.WorkerCount; i++ {
		workerID := i + 1
		worker := &agentWorker{id: workerID, cfg: cfg, writer: writer}
		if cfg.UpstreamMode == "codex-app-server" {
			appServer := newCodexAppServerUpstream(cfg, workerID)
			if err := appServer.Ensure(ctx); err != nil {
				pool.closeWorkers()
				return nil, fmt.Errorf("worker %d app-server: %w", workerID, err)
			}
			worker.appServer = appServer
		}
		pool.workers = append(pool.workers, worker)
	}
	for _, worker := range pool.workers {
		pool.wg.Add(1)
		go func(worker *agentWorker) {
			defer pool.wg.Done()
			worker.run(ctx, pool.requests)
		}(worker)
	}
	return pool, nil
}

func (p *agentWorkerPool) submit(env service.SubiEnvelope) bool {
	select {
	case <-p.ctx.Done():
		return false
	case p.requests <- env:
		return true
	default:
		return false
	}
}

func (p *agentWorkerPool) wait() {
	p.wg.Wait()
}

func (p *agentWorkerPool) closeWorkers() {
	for _, worker := range p.workers {
		worker.close()
	}
}

func (w *agentWorker) run(ctx context.Context, requests <-chan service.SubiEnvelope) {
	defer w.close()
	log.Printf("seller-agent worker online: node=%s worker=%d mode=%s", w.cfg.NodeID, w.id, w.cfg.UpstreamMode)
	for {
		select {
		case <-ctx.Done():
			return
		case env := <-requests:
			w.handleRequest(ctx, env)
		}
	}
}

func (w *agentWorker) handleRequest(parent context.Context, env service.SubiEnvelope) {
	switch w.cfg.UpstreamMode {
	case "codex-app-server":
		handleCodexAppServerRequest(parent, w.cfg, w.writer, env, w.appServer)
	case "codex-exec":
		handleCodexExecRequest(parent, w.cfg, w.writer, env)
	default:
		handleHTTPUpstreamRequest(parent, w.cfg, w.writer, env)
	}
}

func (w *agentWorker) close() {
	if w.appServer != nil {
		w.appServer.Close()
	}
}

func handleHTTPUpstreamRequest(parent context.Context, cfg agentConfig, writer *wsWriter, env service.SubiEnvelope) {
	start := time.Now()
	timeout := time.Duration(env.TimeoutMS) * time.Millisecond
	if timeout <= 0 {
		timeout = 10 * time.Minute
	}
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()

	localURL := cfg.LocalBaseURL + env.Path
	req, err := http.NewRequestWithContext(ctx, env.Method, localURL, bytes.NewReader(env.Body))
	if err != nil {
		sendAgentError(writer, env.RequestID, fmt.Sprintf("build local request: %v", err))
		return
	}
	copyHeaders(req.Header, env.Headers)
	req.Header.Del("Authorization")
	req.Header.Del("x-api-key")
	req.Header.Del("x-goog-api-key")
	req.Header.Del("Cookie")
	req.Header.Set("Authorization", "Bearer "+cfg.LocalAPIKey)
	if req.Header.Get("Content-Type") == "" {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		sendAgentError(writer, env.RequestID, fmt.Sprintf("local request failed: %v", err))
		return
	}
	defer resp.Body.Close()
	resp.Header.Set("X-Subi-Upstream-Mode", cfg.UpstreamMode)

	if err := writer.writeJSON(service.SubiEnvelope{
		Type:       service.SubiEnvelopeResponseStart,
		RequestID:  env.RequestID,
		StatusCode: resp.StatusCode,
		Headers:    resp.Header,
	}); err != nil {
		return
	}

	reader := bufio.NewReader(resp.Body)
	buf := make([]byte, 32*1024)
	var total int64
	for {
		n, readErr := reader.Read(buf)
		if n > 0 {
			total += int64(n)
			if err := writer.writeJSON(service.SubiEnvelope{
				Type:      service.SubiEnvelopeResponseChunk,
				RequestID: env.RequestID,
				Data:      append([]byte(nil), buf[:n]...),
			}); err != nil {
				return
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				break
			}
			sendAgentError(writer, env.RequestID, fmt.Sprintf("read local response: %v", readErr))
			return
		}
	}

	_ = writer.writeJSON(service.SubiEnvelope{
		Type:      service.SubiEnvelopeResponseEnd,
		RequestID: env.RequestID,
		Meta: map[string]any{
			"duration_ms": time.Since(start).Milliseconds(),
			"bytes":       total,
			"status_code": resp.StatusCode,
		},
	})
	log.Printf("seller-agent request done: request_id=%s status=%d bytes=%d duration=%s", env.RequestID, resp.StatusCode, total, time.Since(start))
}

func handleCodexAppServerRequest(parent context.Context, cfg agentConfig, writer *wsWriter, env service.SubiEnvelope, upstream *codexAppServerUpstream) {
	start := time.Now()
	timeout := time.Duration(env.TimeoutMS) * time.Millisecond
	if timeout <= 0 {
		timeout = 10 * time.Minute
	}
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()

	if upstream == nil {
		sendAgentError(writer, env.RequestID, "codex app-server upstream is not initialized")
		return
	}
	if err := upstream.Ensure(ctx); err != nil {
		sendAgentError(writer, env.RequestID, fmt.Sprintf("codex app-server unavailable: %v", err))
		return
	}
	prompt, err := promptFromRequestBody(env.Body)
	if err != nil {
		sendAgentError(writer, env.RequestID, fmt.Sprintf("parse request body: %v", err))
		return
	}

	if env.Stream {
		handleCodexAppServerStreamingRequest(ctx, cfg, writer, env, upstream, prompt, start)
		return
	}

	text, err := upstream.RunPrompt(ctx, env.SessionHash, prompt, nil)
	if err != nil {
		upstream.Close()
		sendAgentError(writer, env.RequestID, fmt.Sprintf("codex app-server failed: %v", err))
		return
	}
	body, contentType, err := codexExecResponseBody(env, text)
	if err != nil {
		sendAgentError(writer, env.RequestID, fmt.Sprintf("build codex response: %v", err))
		return
	}
	headers := http.Header{}
	headers.Set("Content-Type", contentType)
	headers.Set("X-Subi-Upstream-Mode", cfg.UpstreamMode)
	if err := writer.writeJSON(service.SubiEnvelope{
		Type:       service.SubiEnvelopeResponseStart,
		RequestID:  env.RequestID,
		StatusCode: http.StatusOK,
		Headers:    headers,
	}); err != nil {
		return
	}
	if len(body) > 0 {
		if err := writer.writeJSON(service.SubiEnvelope{
			Type:      service.SubiEnvelopeResponseChunk,
			RequestID: env.RequestID,
			Data:      body,
		}); err != nil {
			return
		}
	}
	_ = writer.writeJSON(service.SubiEnvelope{
		Type:      service.SubiEnvelopeResponseEnd,
		RequestID: env.RequestID,
		Meta: map[string]any{
			"duration_ms": time.Since(start).Milliseconds(),
			"bytes":       len(body),
			"status_code": http.StatusOK,
		},
	})
	log.Printf("seller-agent codex app-server request done: request_id=%s bytes=%d duration=%s stream=false", env.RequestID, len(body), time.Since(start))
}

func handleCodexAppServerStreamingRequest(ctx context.Context, cfg agentConfig, writer *wsWriter, env service.SubiEnvelope, upstream *codexAppServerUpstream, prompt string, start time.Time) {
	headers := http.Header{}
	headers.Set("Content-Type", "text/event-stream")
	headers.Set("Cache-Control", "no-cache")
	headers.Set("X-Accel-Buffering", "no")
	headers.Set("X-Subi-Upstream-Mode", cfg.UpstreamMode)
	if err := writer.writeJSON(service.SubiEnvelope{
		Type:       service.SubiEnvelopeResponseStart,
		RequestID:  env.RequestID,
		StatusCode: http.StatusOK,
		Headers:    headers,
	}); err != nil {
		return
	}

	bytesSent := 0
	sendChunk := func(data []byte) error {
		if len(data) == 0 {
			return nil
		}
		bytesSent += len(data)
		return writer.writeJSON(service.SubiEnvelope{
			Type:      service.SubiEnvelopeResponseChunk,
			RequestID: env.RequestID,
			Data:      data,
		})
	}
	if err := sendChunk(codexStreamPrelude(env)); err != nil {
		return
	}

	text, err := upstream.RunPrompt(ctx, env.SessionHash, prompt, func(delta string) error {
		return sendChunk(codexStreamDelta(env, delta))
	})
	if err != nil {
		upstream.Close()
		sendAgentError(writer, env.RequestID, fmt.Sprintf("codex app-server failed: %v", err))
		return
	}
	if err := sendChunk(codexStreamDone(env, text)); err != nil {
		return
	}
	_ = writer.writeJSON(service.SubiEnvelope{
		Type:      service.SubiEnvelopeResponseEnd,
		RequestID: env.RequestID,
		Meta: map[string]any{
			"duration_ms": time.Since(start).Milliseconds(),
			"bytes":       bytesSent,
			"status_code": http.StatusOK,
		},
	})
	log.Printf("seller-agent codex app-server request done: request_id=%s bytes=%d duration=%s stream=true", env.RequestID, bytesSent, time.Since(start))
}

func handleCodexExecRequest(parent context.Context, cfg agentConfig, writer *wsWriter, env service.SubiEnvelope) {
	start := time.Now()
	timeout := time.Duration(env.TimeoutMS) * time.Millisecond
	if timeout <= 0 {
		timeout = 10 * time.Minute
	}
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()

	prompt, err := promptFromRequestBody(env.Body)
	if err != nil {
		sendAgentError(writer, env.RequestID, fmt.Sprintf("parse request body: %v", err))
		return
	}
	text, err := runCodexExec(ctx, cfg, prompt)
	if err != nil {
		sendAgentError(writer, env.RequestID, fmt.Sprintf("codex exec failed: %v", err))
		return
	}

	body, contentType, err := codexExecResponseBody(env, text)
	if err != nil {
		sendAgentError(writer, env.RequestID, fmt.Sprintf("build codex response: %v", err))
		return
	}
	headers := http.Header{}
	headers.Set("Content-Type", contentType)
	headers.Set("X-Subi-Upstream-Mode", cfg.UpstreamMode)
	if strings.HasPrefix(contentType, "text/event-stream") {
		headers.Set("Cache-Control", "no-cache")
		headers.Set("X-Accel-Buffering", "no")
	}
	if err := writer.writeJSON(service.SubiEnvelope{
		Type:       service.SubiEnvelopeResponseStart,
		RequestID:  env.RequestID,
		StatusCode: http.StatusOK,
		Headers:    headers,
	}); err != nil {
		return
	}
	if len(body) > 0 {
		if err := writer.writeJSON(service.SubiEnvelope{
			Type:      service.SubiEnvelopeResponseChunk,
			RequestID: env.RequestID,
			Data:      body,
		}); err != nil {
			return
		}
	}
	_ = writer.writeJSON(service.SubiEnvelope{
		Type:      service.SubiEnvelopeResponseEnd,
		RequestID: env.RequestID,
		Meta: map[string]any{
			"duration_ms": time.Since(start).Milliseconds(),
			"bytes":       len(body),
			"status_code": http.StatusOK,
		},
	})
	log.Printf("seller-agent codex request done: request_id=%s bytes=%d duration=%s", env.RequestID, len(body), time.Since(start))
}

type codexExecJSONEvent struct {
	Type    string `json:"type"`
	Message string `json:"message"`
	Item    struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"item"`
	Error struct {
		Message string `json:"message"`
	} `json:"error"`
}

func runCodexExec(ctx context.Context, cfg agentConfig, prompt string) (string, error) {
	if err := os.MkdirAll(cfg.CodexWorkDir, 0o700); err != nil {
		return "", fmt.Errorf("prepare workdir: %w", err)
	}
	args := []string{"exec", "--json", "--skip-git-repo-check"}
	if cfg.CodexSandbox != "" {
		args = append(args, "--sandbox", cfg.CodexSandbox)
	}
	if cfg.CodexModel != "" {
		args = append(args, "--model", cfg.CodexModel)
	}
	args = append(args, "-C", cfg.CodexWorkDir)
	args = append(args, cfg.CodexExtraArgs...)
	args = append(args, prompt)

	cmd := exec.CommandContext(ctx, cfg.CodexBin, args...)
	cmd.Stdin = strings.NewReader("")
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("%w: %s", err, tailString(stderr.String(), 2000))
	}

	scanner := bufio.NewScanner(bytes.NewReader(stdout.Bytes()))
	scanner.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	var finalText string
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		var ev codexExecJSONEvent
		if err := json.Unmarshal(line, &ev); err != nil {
			continue
		}
		switch ev.Type {
		case "item.completed":
			if ev.Item.Type == "agent_message" {
				finalText = ev.Item.Text
			}
		case "error":
			if ev.Message != "" {
				return "", errors.New(ev.Message)
			}
			if ev.Error.Message != "" {
				return "", errors.New(ev.Error.Message)
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return "", fmt.Errorf("read codex output: %w", err)
	}
	if strings.TrimSpace(finalText) == "" {
		return "", fmt.Errorf("codex returned no final message: %s", tailString(stderr.String(), 2000))
	}
	return finalText, nil
}

type codexAppServerUpstream struct {
	cfg      agentConfig
	workerID int
	host     string
	port     int
	addr     string
	wsURL    string

	cmd      *exec.Cmd
	waitDone <-chan error
	conn     *websocket.Conn
	nextID   int64
	threads  map[string]string
}

type appServerRPCError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

type appServerMessage struct {
	JSONRPC string             `json:"jsonrpc,omitempty"`
	ID      json.RawMessage    `json:"id,omitempty"`
	Method  string             `json:"method,omitempty"`
	Params  json.RawMessage    `json:"params,omitempty"`
	Result  json.RawMessage    `json:"result,omitempty"`
	Error   *appServerRPCError `json:"error,omitempty"`
}

func newCodexAppServerUpstream(cfg agentConfig, workerID int) *codexAppServerUpstream {
	return &codexAppServerUpstream{
		cfg:      cfg,
		workerID: workerID,
		host:     cfg.AppServerHost,
		port:     cfg.AppServerPortBase + workerID - 1,
		nextID:   1,
		threads:  make(map[string]string),
	}
}

func (u *codexAppServerUpstream) Ensure(ctx context.Context) error {
	if u.conn != nil && u.cmd != nil {
		select {
		case err := <-u.waitDone:
			u.cleanupConnection()
			u.cmd = nil
			u.waitDone = nil
			if err != nil {
				log.Printf("codex app-server exited before request: worker=%d error=%v", u.workerID, err)
			}
		default:
			return nil
		}
	}
	return u.start(ctx)
}

func (u *codexAppServerUpstream) start(ctx context.Context) error {
	if err := os.MkdirAll(u.cfg.CodexWorkDir, 0o700); err != nil {
		return fmt.Errorf("prepare workdir: %w", err)
	}
	port, err := findAvailableAppServerPort(u.host, u.port)
	if err != nil {
		return err
	}
	u.port = port
	u.addr = net.JoinHostPort(u.host, strconv.Itoa(u.port))
	u.wsURL = "ws://" + u.addr

	cmd := exec.CommandContext(ctx, u.cfg.AppServerBin, "app-server", "--listen", u.wsURL)
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start codex app-server: %w", err)
	}
	waitDone := make(chan error, 1)
	go func() {
		waitDone <- cmd.Wait()
		close(waitDone)
	}()
	u.cmd = cmd
	u.waitDone = waitDone

	startupCtx, cancel := context.WithTimeout(ctx, u.cfg.AppServerStartupTimeout)
	defer cancel()
	if err := waitForAppServerReady(startupCtx, u.addr, waitDone); err != nil {
		u.Close()
		return err
	}
	conn, _, err := websocket.DefaultDialer.DialContext(startupCtx, u.wsURL, nil)
	if err != nil {
		u.Close()
		return fmt.Errorf("connect codex app-server websocket: %w", err)
	}
	u.conn = conn
	if err := u.initialize(startupCtx); err != nil {
		u.Close()
		return err
	}
	log.Printf("codex app-server ready: worker=%d url=%s", u.workerID, u.wsURL)
	return nil
}

func (u *codexAppServerUpstream) initialize(ctx context.Context) error {
	_, err := u.rpc(ctx, "initialize", map[string]any{
		"clientInfo": map[string]any{
			"name":    "subi-seller-agent",
			"version": sellerAgentVersion,
		},
		"capabilities": map[string]any{
			"experimentalApi": true,
		},
	}, nil)
	if err != nil {
		return fmt.Errorf("initialize codex app-server: %w", err)
	}
	if err := u.notify(ctx, "initialized", nil); err != nil {
		return fmt.Errorf("send initialized notification: %w", err)
	}
	return nil
}

func (u *codexAppServerUpstream) RunPrompt(ctx context.Context, sessionHash, prompt string, onDelta func(string) error) (string, error) {
	threadID, err := u.threadID(ctx, sessionHash)
	if err != nil {
		return "", err
	}

	var finalText strings.Builder
	completed := false
	var completionErr error
	handleNotification := func(msg appServerMessage) error {
		switch msg.Method {
		case "item/agentMessage/delta":
			var ev struct {
				Delta string `json:"delta"`
			}
			if err := json.Unmarshal(msg.Params, &ev); err != nil {
				return fmt.Errorf("parse agent delta: %w", err)
			}
			if ev.Delta != "" {
				finalText.WriteString(ev.Delta)
				if onDelta != nil {
					if err := onDelta(ev.Delta); err != nil {
						return err
					}
				}
			}
		case "item/completed":
			if finalText.Len() == 0 {
				var ev struct {
					Item struct {
						Type string `json:"type"`
						Text string `json:"text"`
					} `json:"item"`
				}
				if err := json.Unmarshal(msg.Params, &ev); err == nil && ev.Item.Type == "agentMessage" && ev.Item.Text != "" {
					finalText.WriteString(ev.Item.Text)
					if onDelta != nil {
						if err := onDelta(ev.Item.Text); err != nil {
							return err
						}
					}
				}
			}
		case "turn/completed":
			completed = true
			if err := codexTurnCompletionError(msg.Params); err != nil {
				completionErr = err
			}
		case "error":
			if message := appServerErrorNotificationMessage(msg.Params); message != "" {
				completionErr = errors.New(message)
				completed = true
			}
		}
		return nil
	}

	if _, err := u.rpc(ctx, "turn/start", map[string]any{
		"threadId":       threadID,
		"cwd":            u.cfg.CodexWorkDir,
		"approvalPolicy": "never",
		"input": []map[string]any{
			{"type": "text", "text": prompt},
		},
	}, handleNotification); err != nil {
		return "", fmt.Errorf("start codex turn: %w", err)
	}

	for !completed {
		msg, err := u.readMessage(ctx)
		if err != nil {
			return "", fmt.Errorf("read codex turn: %w", err)
		}
		if msg.Method == "" {
			continue
		}
		if err := handleNotification(msg); err != nil {
			return "", err
		}
	}
	if completionErr != nil {
		return "", completionErr
	}
	text := finalText.String()
	if strings.TrimSpace(text) == "" {
		return "", errors.New("codex app-server returned no final message")
	}
	return text, nil
}

func (u *codexAppServerUpstream) startThread(ctx context.Context) (string, error) {
	params := map[string]any{
		"cwd":            u.cfg.CodexWorkDir,
		"ephemeral":      true,
		"approvalPolicy": "never",
	}
	if u.cfg.CodexModel != "" {
		params["model"] = u.cfg.CodexModel
	}
	if u.cfg.CodexSandbox != "" {
		params["sandbox"] = u.cfg.CodexSandbox
	}
	result, err := u.rpc(ctx, "thread/start", params, nil)
	if err != nil {
		return "", fmt.Errorf("start codex thread: %w", err)
	}
	var resp struct {
		Thread struct {
			ID string `json:"id"`
		} `json:"thread"`
	}
	if err := json.Unmarshal(result, &resp); err != nil {
		return "", fmt.Errorf("parse codex thread response: %w", err)
	}
	if resp.Thread.ID == "" {
		return "", fmt.Errorf("codex thread response missing id: %s", string(result))
	}
	return resp.Thread.ID, nil
}

func (u *codexAppServerUpstream) threadID(ctx context.Context, sessionHash string) (string, error) {
	key := ""
	if u.cfg.AppServerStickyThreads {
		key = strings.TrimSpace(sessionHash)
	}
	if key != "" {
		if threadID := strings.TrimSpace(u.threads[key]); threadID != "" {
			return threadID, nil
		}
	}
	threadID, err := u.startThread(ctx)
	if err != nil {
		return "", err
	}
	if key != "" {
		u.threads[key] = threadID
	}
	return threadID, nil
}

func (u *codexAppServerUpstream) rpc(ctx context.Context, method string, params any, onNotification func(appServerMessage) error) (json.RawMessage, error) {
	id := u.nextID
	u.nextID++
	if err := u.writeJSON(ctx, map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"method":  method,
		"params":  params,
	}); err != nil {
		return nil, err
	}
	for {
		msg, err := u.readMessage(ctx)
		if err != nil {
			return nil, err
		}
		if responseID, ok := appServerMessageID(msg.ID); ok && responseID == id && msg.Method == "" {
			if msg.Error != nil {
				return nil, msg.Error
			}
			return msg.Result, nil
		}
		if msg.Method != "" && onNotification != nil {
			if err := onNotification(msg); err != nil {
				return nil, err
			}
		}
	}
}

func (u *codexAppServerUpstream) notify(ctx context.Context, method string, params any) error {
	payload := map[string]any{
		"jsonrpc": "2.0",
		"method":  method,
	}
	if params != nil {
		payload["params"] = params
	}
	return u.writeJSON(ctx, payload)
}

func (u *codexAppServerUpstream) writeJSON(ctx context.Context, payload any) error {
	if u.conn == nil {
		return errors.New("codex app-server websocket is not connected")
	}
	if deadline, ok := ctx.Deadline(); ok {
		if err := u.conn.SetWriteDeadline(deadline); err != nil {
			return err
		}
	} else if err := u.conn.SetWriteDeadline(time.Now().Add(sellerAgentWSWriteTimeout)); err != nil {
		return err
	}
	defer u.conn.SetWriteDeadline(time.Time{})
	return u.conn.WriteJSON(payload)
}

func (u *codexAppServerUpstream) readMessage(ctx context.Context) (appServerMessage, error) {
	for {
		if u.conn == nil {
			return appServerMessage{}, errors.New("codex app-server websocket is not connected")
		}
		if deadline, ok := ctx.Deadline(); ok {
			if err := u.conn.SetReadDeadline(deadline); err != nil {
				return appServerMessage{}, err
			}
		}
		var msg appServerMessage
		if err := u.conn.ReadJSON(&msg); err != nil {
			return appServerMessage{}, err
		}
		if len(msg.ID) > 0 && msg.Method != "" {
			_ = u.rejectServerRequest(ctx, msg)
			continue
		}
		return msg, nil
	}
}

func (u *codexAppServerUpstream) rejectServerRequest(ctx context.Context, msg appServerMessage) error {
	return u.writeJSON(ctx, map[string]any{
		"jsonrpc": "2.0",
		"id":      json.RawMessage(append([]byte(nil), msg.ID...)),
		"error": map[string]any{
			"code":    -32601,
			"message": "Subi seller-agent does not implement Codex app-server server requests",
		},
	})
}

func (u *codexAppServerUpstream) Close() {
	u.cleanupConnection()
	cmd := u.cmd
	waitDone := u.waitDone
	u.cmd = nil
	u.waitDone = nil
	if cmd == nil || cmd.Process == nil {
		return
	}
	pid := cmd.Process.Pid
	if pid > 0 {
		_ = syscall.Kill(-pid, syscall.SIGTERM)
	} else {
		_ = cmd.Process.Signal(syscall.SIGTERM)
	}
	select {
	case <-waitDone:
	case <-time.After(2 * time.Second):
		if pid > 0 {
			_ = syscall.Kill(-pid, syscall.SIGKILL)
		} else {
			_ = cmd.Process.Kill()
		}
		<-waitDone
	}
}

func (u *codexAppServerUpstream) cleanupConnection() {
	if u.conn != nil {
		_ = u.conn.Close()
		u.conn = nil
	}
	u.threads = make(map[string]string)
}

func (e *appServerRPCError) Error() string {
	if e == nil {
		return ""
	}
	if len(e.Data) > 0 {
		return fmt.Sprintf("codex app-server rpc error %d: %s: %s", e.Code, e.Message, string(e.Data))
	}
	return fmt.Sprintf("codex app-server rpc error %d: %s", e.Code, e.Message)
}

func waitForAppServerReady(ctx context.Context, addr string, waitDone <-chan error) error {
	client := http.Client{Timeout: 300 * time.Millisecond}
	readyURL := "http://" + addr + "/readyz"
	healthURL := "http://" + addr + "/healthz"
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		for _, endpoint := range []string{readyURL, healthURL} {
			resp, err := client.Get(endpoint)
			if err == nil {
				_ = resp.Body.Close()
				if resp.StatusCode >= 200 && resp.StatusCode < 500 {
					return nil
				}
			}
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("codex app-server did not become ready: %w", ctx.Err())
		case err := <-waitDone:
			if err != nil {
				return fmt.Errorf("codex app-server exited during startup: %w", err)
			}
			return errors.New("codex app-server exited during startup")
		case <-ticker.C:
		}
	}
}

func findAvailableAppServerPort(host string, startPort int) (int, error) {
	for port := startPort; port < startPort+100; port++ {
		ln, err := net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(port)))
		if err != nil {
			continue
		}
		_ = ln.Close()
		return port, nil
	}
	return 0, fmt.Errorf("no available codex app-server port near %s:%d", host, startPort)
}

func appServerMessageID(raw json.RawMessage) (int64, bool) {
	if len(raw) == 0 {
		return 0, false
	}
	var number int64
	if err := json.Unmarshal(raw, &number); err == nil {
		return number, true
	}
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		value, err := strconv.ParseInt(text, 10, 64)
		return value, err == nil
	}
	return 0, false
}

func codexTurnCompletionError(raw json.RawMessage) error {
	var ev struct {
		Turn struct {
			Status any `json:"status"`
			Error  *struct {
				Message string `json:"message"`
			} `json:"error"`
		} `json:"turn"`
	}
	if err := json.Unmarshal(raw, &ev); err != nil {
		return fmt.Errorf("parse turn completion: %w", err)
	}
	if ev.Turn.Error != nil && ev.Turn.Error.Message != "" {
		return errors.New(ev.Turn.Error.Message)
	}
	status := appServerStatusString(ev.Turn.Status)
	if status != "" && status != "completed" {
		return fmt.Errorf("codex turn ended with status %s", status)
	}
	return nil
}

func appServerStatusString(value any) string {
	switch v := value.(type) {
	case string:
		return strings.TrimSpace(v)
	case map[string]any:
		if text, _ := v["type"].(string); text != "" {
			return strings.TrimSpace(text)
		}
	}
	return ""
}

func appServerErrorNotificationMessage(raw json.RawMessage) string {
	var ev struct {
		Message string `json:"message"`
		Error   struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(raw, &ev); err != nil {
		return ""
	}
	if ev.Message != "" {
		return ev.Message
	}
	return ev.Error.Message
}

func promptFromRequestBody(body []byte) (string, error) {
	var payload any
	if err := json.Unmarshal(body, &payload); err != nil {
		return "", err
	}
	if root, ok := payload.(map[string]any); ok {
		if metadata, _ := root["metadata"].(map[string]any); metadata != nil {
			if injected, _ := metadata["subi_context_injected"].(bool); injected {
				parts := make([]string, 0, 8)
				collectNamedText(root, "system", &parts)
				collectNamedText(root, "input", &parts)
				collectNamedText(root, "messages", &parts)
				if prompt := strings.TrimSpace(strings.Join(parts, "\n\n")); prompt != "" {
					return prompt, nil
				}
			}
		}
		for _, key := range []string{"input", "messages"} {
			if value, ok := root[key]; ok {
				if prompt := strings.TrimSpace(latestRoleText(value, "user")); prompt != "" {
					return prompt, nil
				}
			}
		}
	}
	parts := make([]string, 0, 8)
	if root, ok := payload.(map[string]any); ok {
		collectNamedText(root, "system", &parts)
		collectNamedText(root, "instructions", &parts)
		collectNamedText(root, "prompt", &parts)
		collectNamedText(root, "input", &parts)
		collectNamedText(root, "messages", &parts)
	} else {
		collectText(payload, &parts)
	}
	prompt := strings.TrimSpace(strings.Join(parts, "\n\n"))
	if prompt == "" {
		return "", errors.New("no textual prompt found")
	}
	return prompt, nil
}

func latestRoleText(value any, role string) string {
	var latest string
	findLatestRoleText(value, role, &latest)
	return latest
}

func findLatestRoleText(value any, role string, latest *string) {
	switch v := value.(type) {
	case []any:
		for _, item := range v {
			findLatestRoleText(item, role, latest)
		}
	case map[string]any:
		itemRole, _ := v["role"].(string)
		if strings.EqualFold(strings.TrimSpace(itemRole), role) {
			parts := make([]string, 0, 4)
			if content, ok := v["content"]; ok {
				collectText(content, &parts)
			} else {
				collectText(v, &parts)
			}
			if text := strings.TrimSpace(strings.Join(parts, "\n\n")); text != "" {
				*latest = text
			}
			return
		}
		for _, key := range []string{"input", "messages", "content"} {
			if child, ok := v[key]; ok {
				findLatestRoleText(child, role, latest)
			}
		}
	}
}

func collectNamedText(m map[string]any, key string, parts *[]string) {
	if value, ok := m[key]; ok {
		collectText(value, parts)
	}
}

func collectText(value any, parts *[]string) {
	switch v := value.(type) {
	case string:
		if text := strings.TrimSpace(v); text != "" {
			*parts = append(*parts, text)
		}
	case []any:
		for _, item := range v {
			collectText(item, parts)
		}
	case map[string]any:
		role, _ := v["role"].(string)
		before := len(*parts)
		for _, key := range []string{"text", "input_text", "output_text", "content", "message", "messages", "input"} {
			if child, ok := v[key]; ok {
				collectText(child, parts)
			}
		}
		if role != "" && len(*parts) > before {
			(*parts)[before] = strings.TrimSpace(role) + ": " + (*parts)[before]
		}
	}
}

func codexExecResponseBody(env service.SubiEnvelope, text string) ([]byte, string, error) {
	path := requestPathOnly(env.Path)
	switch {
	case isChatCompletionsPath(path):
		if env.Stream {
			return chatCompletionSSE(env.RequestID, text), "text/event-stream", nil
		}
		body, err := json.Marshal(chatCompletionJSON(env.RequestID, text))
		return body, "application/json", err
	case isOpenAIResponsesPath(path):
		if env.Stream {
			return responsesSSE(env.RequestID, text), "text/event-stream", nil
		}
		body, err := json.Marshal(responseJSON(env.RequestID, text))
		return body, "application/json", err
	default:
		body, err := json.Marshal(map[string]any{
			"type": "message",
			"role": "assistant",
			"content": []map[string]any{
				{"type": "text", "text": text},
			},
		})
		return body, "application/json", err
	}
}

func requestPathOnly(requestURI string) string {
	path, _, _ := strings.Cut(requestURI, "?")
	return path
}

func isOpenAIResponsesPath(path string) bool {
	return path == "/v1/responses" ||
		path == "/responses" ||
		path == "/backend-api/codex/responses" ||
		strings.HasPrefix(path, "/v1/responses/") ||
		strings.HasPrefix(path, "/responses/") ||
		strings.HasPrefix(path, "/backend-api/codex/responses/")
}

func isChatCompletionsPath(path string) bool {
	return path == "/v1/chat/completions" || path == "/chat/completions"
}

func responseJSON(requestID, text string) map[string]any {
	now := time.Now().Unix()
	responseID := "resp_" + requestID
	messageID := "msg_" + requestID
	return map[string]any{
		"id":         responseID,
		"object":     "response",
		"created_at": now,
		"status":     "completed",
		"model":      "subi-codex-subscription",
		"output": []map[string]any{
			{
				"id":     messageID,
				"type":   "message",
				"status": "completed",
				"role":   "assistant",
				"content": []map[string]any{
					{
						"type":        "output_text",
						"text":        text,
						"annotations": []any{},
					},
				},
			},
		},
	}
}

func codexStreamPrelude(env service.SubiEnvelope) []byte {
	path := requestPathOnly(env.Path)
	if isChatCompletionsPath(path) {
		return chatCompletionStreamPrelude(env.RequestID)
	}
	return responsesStreamPrelude(env.RequestID)
}

func codexStreamDelta(env service.SubiEnvelope, delta string) []byte {
	path := requestPathOnly(env.Path)
	if isChatCompletionsPath(path) {
		return chatCompletionStreamDelta(env.RequestID, delta)
	}
	return responsesStreamDelta(env.RequestID, delta)
}

func codexStreamDone(env service.SubiEnvelope, text string) []byte {
	path := requestPathOnly(env.Path)
	if isChatCompletionsPath(path) {
		return chatCompletionStreamDone(env.RequestID)
	}
	return responsesStreamDone(env.RequestID, text)
}

func responsesStreamPrelude(requestID string) []byte {
	responseID := "resp_" + requestID
	messageID := "msg_" + requestID
	var b bytes.Buffer
	writeSSE(&b, "response.created", map[string]any{
		"type":     "response.created",
		"response": responseJSON(requestID, ""),
	})
	writeSSE(&b, "response.output_item.added", map[string]any{
		"type":         "response.output_item.added",
		"response_id":  responseID,
		"output_index": 0,
		"item": map[string]any{
			"id":      messageID,
			"type":    "message",
			"status":  "in_progress",
			"role":    "assistant",
			"content": []any{},
		},
	})
	writeSSE(&b, "response.content_part.added", map[string]any{
		"type":          "response.content_part.added",
		"response_id":   responseID,
		"item_id":       messageID,
		"output_index":  0,
		"content_index": 0,
		"part": map[string]any{
			"type": "output_text",
			"text": "",
		},
	})
	return b.Bytes()
}

func responsesStreamDelta(requestID, delta string) []byte {
	responseID := "resp_" + requestID
	messageID := "msg_" + requestID
	var b bytes.Buffer
	writeSSE(&b, "response.output_text.delta", map[string]any{
		"type":          "response.output_text.delta",
		"response_id":   responseID,
		"item_id":       messageID,
		"output_index":  0,
		"content_index": 0,
		"delta":         delta,
	})
	return b.Bytes()
}

func responsesStreamDone(requestID, text string) []byte {
	responseID := "resp_" + requestID
	messageID := "msg_" + requestID
	var b bytes.Buffer
	writeSSE(&b, "response.output_text.done", map[string]any{
		"type":          "response.output_text.done",
		"response_id":   responseID,
		"item_id":       messageID,
		"output_index":  0,
		"content_index": 0,
		"text":          text,
	})
	writeSSE(&b, "response.content_part.done", map[string]any{
		"type":          "response.content_part.done",
		"response_id":   responseID,
		"item_id":       messageID,
		"output_index":  0,
		"content_index": 0,
		"part": map[string]any{
			"type": "output_text",
			"text": text,
		},
	})
	writeSSE(&b, "response.output_item.done", map[string]any{
		"type":         "response.output_item.done",
		"response_id":  responseID,
		"output_index": 0,
		"item": map[string]any{
			"id":     messageID,
			"type":   "message",
			"status": "completed",
			"role":   "assistant",
			"content": []map[string]any{
				{"type": "output_text", "text": text, "annotations": []any{}},
			},
		},
	})
	writeSSE(&b, "response.completed", map[string]any{
		"type":     "response.completed",
		"response": responseJSON(requestID, text),
	})
	b.WriteString("data: [DONE]\n\n")
	return b.Bytes()
}

func responsesSSE(requestID, text string) []byte {
	responseID := "resp_" + requestID
	messageID := "msg_" + requestID
	var b bytes.Buffer
	writeSSE(&b, "response.created", map[string]any{
		"type":     "response.created",
		"response": responseJSON(requestID, ""),
	})
	writeSSE(&b, "response.output_item.added", map[string]any{
		"type":         "response.output_item.added",
		"response_id":  responseID,
		"output_index": 0,
		"item": map[string]any{
			"id":      messageID,
			"type":    "message",
			"status":  "in_progress",
			"role":    "assistant",
			"content": []any{},
		},
	})
	writeSSE(&b, "response.content_part.added", map[string]any{
		"type":          "response.content_part.added",
		"response_id":   responseID,
		"item_id":       messageID,
		"output_index":  0,
		"content_index": 0,
		"part": map[string]any{
			"type": "output_text",
			"text": "",
		},
	})
	writeSSE(&b, "response.output_text.delta", map[string]any{
		"type":          "response.output_text.delta",
		"response_id":   responseID,
		"item_id":       messageID,
		"output_index":  0,
		"content_index": 0,
		"delta":         text,
	})
	writeSSE(&b, "response.output_text.done", map[string]any{
		"type":          "response.output_text.done",
		"response_id":   responseID,
		"item_id":       messageID,
		"output_index":  0,
		"content_index": 0,
		"text":          text,
	})
	writeSSE(&b, "response.content_part.done", map[string]any{
		"type":          "response.content_part.done",
		"response_id":   responseID,
		"item_id":       messageID,
		"output_index":  0,
		"content_index": 0,
		"part": map[string]any{
			"type": "output_text",
			"text": text,
		},
	})
	writeSSE(&b, "response.output_item.done", map[string]any{
		"type":         "response.output_item.done",
		"response_id":  responseID,
		"output_index": 0,
		"item": map[string]any{
			"id":     messageID,
			"type":   "message",
			"status": "completed",
			"role":   "assistant",
			"content": []map[string]any{
				{"type": "output_text", "text": text, "annotations": []any{}},
			},
		},
	})
	writeSSE(&b, "response.completed", map[string]any{
		"type":     "response.completed",
		"response": responseJSON(requestID, text),
	})
	b.WriteString("data: [DONE]\n\n")
	return b.Bytes()
}

func chatCompletionJSON(requestID, text string) map[string]any {
	return map[string]any{
		"id":      "chatcmpl_" + requestID,
		"object":  "chat.completion",
		"created": time.Now().Unix(),
		"model":   "subi-codex-subscription",
		"choices": []map[string]any{
			{
				"index": 0,
				"message": map[string]any{
					"role":    "assistant",
					"content": text,
				},
				"finish_reason": "stop",
			},
		},
	}
}

func chatCompletionStreamPrelude(requestID string) []byte {
	chunkID := "chatcmpl_" + requestID
	now := time.Now().Unix()
	var b bytes.Buffer
	writeDataSSE(&b, map[string]any{
		"id":      chunkID,
		"object":  "chat.completion.chunk",
		"created": now,
		"model":   "subi-codex-subscription",
		"choices": []map[string]any{
			{"index": 0, "delta": map[string]any{"role": "assistant"}, "finish_reason": nil},
		},
	})
	return b.Bytes()
}

func chatCompletionStreamDelta(requestID, delta string) []byte {
	chunkID := "chatcmpl_" + requestID
	now := time.Now().Unix()
	var b bytes.Buffer
	writeDataSSE(&b, map[string]any{
		"id":      chunkID,
		"object":  "chat.completion.chunk",
		"created": now,
		"model":   "subi-codex-subscription",
		"choices": []map[string]any{
			{"index": 0, "delta": map[string]any{"content": delta}, "finish_reason": nil},
		},
	})
	return b.Bytes()
}

func chatCompletionStreamDone(requestID string) []byte {
	chunkID := "chatcmpl_" + requestID
	now := time.Now().Unix()
	var b bytes.Buffer
	writeDataSSE(&b, map[string]any{
		"id":      chunkID,
		"object":  "chat.completion.chunk",
		"created": now,
		"model":   "subi-codex-subscription",
		"choices": []map[string]any{
			{"index": 0, "delta": map[string]any{}, "finish_reason": "stop"},
		},
	})
	b.WriteString("data: [DONE]\n\n")
	return b.Bytes()
}

func chatCompletionSSE(requestID, text string) []byte {
	chunkID := "chatcmpl_" + requestID
	now := time.Now().Unix()
	var b bytes.Buffer
	writeDataSSE(&b, map[string]any{
		"id":      chunkID,
		"object":  "chat.completion.chunk",
		"created": now,
		"model":   "subi-codex-subscription",
		"choices": []map[string]any{
			{"index": 0, "delta": map[string]any{"role": "assistant"}, "finish_reason": nil},
		},
	})
	writeDataSSE(&b, map[string]any{
		"id":      chunkID,
		"object":  "chat.completion.chunk",
		"created": now,
		"model":   "subi-codex-subscription",
		"choices": []map[string]any{
			{"index": 0, "delta": map[string]any{"content": text}, "finish_reason": nil},
		},
	})
	writeDataSSE(&b, map[string]any{
		"id":      chunkID,
		"object":  "chat.completion.chunk",
		"created": now,
		"model":   "subi-codex-subscription",
		"choices": []map[string]any{
			{"index": 0, "delta": map[string]any{}, "finish_reason": "stop"},
		},
	})
	b.WriteString("data: [DONE]\n\n")
	return b.Bytes()
}

func writeSSE(b *bytes.Buffer, event string, payload any) {
	b.WriteString("event: ")
	b.WriteString(event)
	b.WriteByte('\n')
	writeDataSSE(b, payload)
}

func writeDataSSE(b *bytes.Buffer, payload any) {
	data, _ := json.Marshal(payload)
	b.WriteString("data: ")
	b.Write(data)
	b.WriteString("\n\n")
}

func normalizeUpstreamMode(mode string) string {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case "codex-server", "app-server", "codex_app_server", "codex-appserver":
		return "codex-app-server"
	default:
		return strings.ToLower(strings.TrimSpace(mode))
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func appServerListenConfig() (string, int) {
	host := strings.TrimSpace(os.Getenv("SELLER_CODEX_APP_SERVER_HOST"))
	if host == "" {
		host = "127.0.0.1"
	}
	port := envInt("SELLER_CODEX_APP_SERVER_PORT_BASE", 0)
	listenBase := strings.TrimSpace(os.Getenv("SELLER_CODEX_SERVER_LISTEN_BASE"))
	if listenBase != "" {
		if strings.Contains(listenBase, "://") {
			if parsed, err := url.Parse(listenBase); err == nil {
				if parsed.Hostname() != "" {
					host = parsed.Hostname()
				}
				if parsed.Port() != "" {
					if parsedPort, err := strconv.Atoi(parsed.Port()); err == nil {
						port = parsedPort
					}
				}
			}
		} else if parsedHost, parsedPort, err := net.SplitHostPort(listenBase); err == nil {
			if parsedHost != "" {
				host = parsedHost
			}
			if parsedPort != "" {
				if parsedPortInt, err := strconv.Atoi(parsedPort); err == nil {
					port = parsedPortInt
				}
			}
		}
	}
	if port <= 0 {
		port = 19100
	}
	return host, port
}

func splitArgs(value string) []string {
	fields := strings.Fields(value)
	if len(fields) == 0 {
		return nil
	}
	return fields
}

func envInt(key string, fallback int) int {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	return value
}

func envDurationMS(key string, fallback time.Duration) time.Duration {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value <= 0 {
		return fallback
	}
	return time.Duration(value) * time.Millisecond
}

func envBool(key string, fallback bool) bool {
	raw := strings.ToLower(strings.TrimSpace(os.Getenv(key)))
	if raw == "" {
		return fallback
	}
	switch raw {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	default:
		return fallback
	}
}

func tailString(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[len(value)-limit:]
}

func sendAgentError(writer *wsWriter, requestID, msg string) {
	_ = writer.writeJSON(service.SubiEnvelope{
		Type:      service.SubiEnvelopeResponseError,
		RequestID: requestID,
		Error:     msg,
	})
}

func (w *wsWriter) writeJSON(v any) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if err := w.conn.SetWriteDeadline(time.Now().Add(sellerAgentWSWriteTimeout)); err != nil {
		return err
	}
	defer w.conn.SetWriteDeadline(time.Time{})
	return w.conn.WriteJSON(v)
}

func copyHeaders(dst, src http.Header) {
	for key, values := range src {
		lower := strings.ToLower(strings.TrimSpace(key))
		switch lower {
		case "host", "content-length", "connection":
			continue
		}
		for _, v := range values {
			dst.Add(key, v)
		}
	}
}
