package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gorilla/websocket"
	"github.com/stretchr/testify/require"
	"github.com/tidwall/gjson"
)

func TestGatewaySessionSameSellerInjectsHistory(t *testing.T) {
	h := newGatewayTestHarness(t, true)
	defer h.close()

	seller := h.startSeller("seller-001", "我记住了。", "blue-lobster")
	defer seller.close()

	firstResp := h.post("mvp1-same-seller", "记住暗号是 blue-lobster。回复：记住了")
	require.Contains(t, firstResp.Body, "我记住了")
	firstReq := seller.nextRequest(t)
	require.Equal(t, "seller-001", firstResp.Header.Get("X-Subi-Seller-Node"))
	require.Equal(t, "false", firstResp.Header.Get("X-Subi-Session-Migrated"))
	require.False(t, gjson.GetBytes(firstReq.Body, "metadata.subi_context_injected").Bool())

	secondResp := h.post("mvp1-same-seller", "我的暗号是什么？只回答暗号。")
	require.Contains(t, secondResp.Body, "blue-lobster")
	secondReq := seller.nextRequest(t)
	require.Equal(t, "seller-001", secondResp.Header.Get("X-Subi-Seller-Node"))
	require.Equal(t, "false", secondResp.Header.Get("X-Subi-Session-Migrated"))
	require.True(t, gjson.GetBytes(secondReq.Body, "metadata.subi_context_injected").Bool())
	require.Equal(t, "记住暗号是 blue-lobster。回复：记住了", gjson.GetBytes(secondReq.Body, "input.1.content").String())
	require.Equal(t, "我记住了。", gjson.GetBytes(secondReq.Body, "input.2.content").String())
	require.Equal(t, "我的暗号是什么？只回答暗号。", gjson.GetBytes(secondReq.Body, "input.3.content").String())
}

func TestGatewaySessionMigrationInjectsHistoryIntoNewSeller(t *testing.T) {
	h := newGatewayTestHarness(t, true)
	defer h.close()

	seller1 := h.startSeller("seller-001", "我记住了。")

	firstResp := h.post("mvp1-switch-demo", "记住暗号是 red-crab。回复：记住了")
	require.Contains(t, firstResp.Body, "我记住了")
	firstReq := seller1.nextRequest(t)
	require.Equal(t, "seller-001", firstResp.Header.Get("X-Subi-Seller-Node"))
	require.Equal(t, "false", firstResp.Header.Get("X-Subi-Session-Migrated"))
	require.False(t, gjson.GetBytes(firstReq.Body, "metadata.subi_context_injected").Bool())

	seller1.close()
	seller2 := h.startSeller("seller-002", "red-crab")
	defer seller2.close()

	secondResp := h.post("mvp1-switch-demo", "我的暗号是什么？只回答暗号。")
	require.Contains(t, secondResp.Body, "red-crab")
	secondReq := seller2.nextRequest(t)

	require.Equal(t, "seller-002", secondResp.Header.Get("X-Subi-Seller-Node"))
	require.Equal(t, "true", secondResp.Header.Get("X-Subi-Session-Migrated"))
	require.Equal(t, "mvp1-switch-demo", secondResp.Header.Get("X-Subi-Session-ID"))
	require.Equal(t, "mvp1-switch-demo", secondReq.Meta["session_id"])
	require.Equal(t, "seller-001", secondReq.Meta["previous_seller_node"])
	require.Equal(t, true, secondReq.Meta["session_migrated"])
	require.True(t, gjson.GetBytes(secondReq.Body, "metadata.subi_context_injected").Bool())
	require.Equal(t, "记住暗号是 red-crab。回复：记住了", gjson.GetBytes(secondReq.Body, "input.1.content").String())
	require.Equal(t, "我记住了。", gjson.GetBytes(secondReq.Body, "input.2.content").String())
	require.Equal(t, "我的暗号是什么？只回答暗号。", gjson.GetBytes(secondReq.Body, "input.3.content").String())
}

func TestGatewaySessionIsolationBetweenSessionIDs(t *testing.T) {
	h := newGatewayTestHarness(t, true)
	defer h.close()

	seller := h.startSeller("seller-001", "记住了", "UNKNOWN")
	defer seller.close()

	sessionAResp := h.post("session-A", "记住暗号是 alpha。只回复：记住了")
	require.Contains(t, sessionAResp.Body, "记住了")
	_ = seller.nextRequest(t)

	sessionBResp := h.post("session-B", "我的暗号是什么？如果不知道只回答 UNKNOWN。")
	require.Contains(t, sessionBResp.Body, "UNKNOWN")
	sessionBReq := seller.nextRequest(t)
	require.False(t, gjson.GetBytes(sessionBReq.Body, "metadata.subi_context_injected").Bool())
	require.NotContains(t, string(sessionBReq.Body), "alpha")
}

func TestGatewaySessionContextDisabledDoesNotInjectHistory(t *testing.T) {
	h := newGatewayTestHarness(t, false)
	defer h.close()

	seller := h.startSeller("seller-001", "记住了", "UNKNOWN")
	defer seller.close()

	firstResp := h.post("context-disabled", "记住暗号是 no-inject。只回复：记住了")
	require.Contains(t, firstResp.Body, "记住了")
	_ = seller.nextRequest(t)

	secondResp := h.post("context-disabled", "我的暗号是什么？如果不知道只回答 UNKNOWN。")
	require.Contains(t, secondResp.Body, "UNKNOWN")
	secondReq := seller.nextRequest(t)
	require.False(t, gjson.GetBytes(secondReq.Body, "metadata.subi_context_injected").Bool())
	require.NotContains(t, string(secondReq.Body), "no-inject")
}

func TestGatewayNoSellerReturnsReadableError(t *testing.T) {
	h := newGatewayTestHarness(t, true)
	defer h.close()

	resp := h.postExpectStatus("no-seller", "Reply exactly: SHOULD_NOT_RUN", http.StatusServiceUnavailable)

	require.Contains(t, resp.Body, "no available seller node")
	require.Equal(t, "application/json", strings.Split(resp.Header.Get("Content-Type"), ";")[0])
}

type gatewayTestHarness struct {
	t      *testing.T
	server *httptest.Server
}

type gatewayTestResponse struct {
	StatusCode int
	Header     http.Header
	Body       string
}

func newGatewayTestHarness(t *testing.T, sessionContextEnabled bool) *gatewayTestHarness {
	t.Helper()

	service.DefaultSubiSellerNodeRegistry = service.NewSubiSellerNodeRegistry()
	cfg := gatewayConfig{
		BuyerAPIKey:           "buyer-secret",
		SellerNodeToken:       "seller-secret",
		SessionContextEnabled: sessionContextEnabled,
		SessionMaxTurns:       20,
		SessionMaxChars:       20000,
		SessionStore:          service.NewSubiSessionStore(20, 20000),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/subi/seller/agent/ws", func(w http.ResponseWriter, r *http.Request) {
		handleSellerAgentWS(w, r, cfg)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		handleBuyerRequest(w, r, cfg)
	})

	return &gatewayTestHarness{t: t, server: httptest.NewServer(mux)}
}

func (h *gatewayTestHarness) close() {
	if h != nil && h.server != nil {
		h.server.Close()
	}
}

func (h *gatewayTestHarness) startSeller(nodeID string, responses ...string) *gatewayTestSeller {
	h.t.Helper()
	wsURL := "ws" + strings.TrimPrefix(h.server.URL, "http") + "/api/v1/subi/seller/agent/ws?token=seller-secret"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	require.NoError(h.t, err)

	seller := &gatewayTestSeller{
		nodeID:    nodeID,
		conn:      conn,
		responses: append([]string(nil), responses...),
		requests:  make(chan service.SubiEnvelope, 8),
	}
	if len(seller.responses) == 0 {
		seller.responses = []string{"OK"}
	}

	err = conn.WriteJSON(service.SubiEnvelope{
		Type:           service.SubiEnvelopeAgentHello,
		NodeID:         nodeID,
		Version:        "test",
		MaxConcurrency: 1,
	})
	require.NoError(h.t, err)

	go seller.serve()
	time.Sleep(50 * time.Millisecond)
	return seller
}

func (h *gatewayTestHarness) post(sessionID, input string) gatewayTestResponse {
	h.t.Helper()
	return h.postExpectStatus(sessionID, input, http.StatusOK)
}

func (h *gatewayTestHarness) postExpectStatus(sessionID, input string, expectedStatus int) gatewayTestResponse {
	h.t.Helper()
	body, err := json.Marshal(map[string]any{
		"model":  "subi-codex-subscription",
		"stream": false,
		"input":  input,
	})
	require.NoError(h.t, err)

	req, err := http.NewRequest(http.MethodPost, h.server.URL+"/v1/responses", bytes.NewReader(body))
	require.NoError(h.t, err)
	req.Header.Set("Authorization", "Bearer buyer-secret")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-session-id", sessionID)

	resp, err := http.DefaultClient.Do(req)
	require.NoError(h.t, err)
	defer resp.Body.Close()
	respBody, err := io.ReadAll(resp.Body)
	require.NoError(h.t, err)
	require.Equal(h.t, expectedStatus, resp.StatusCode, string(respBody))
	return gatewayTestResponse{
		StatusCode: resp.StatusCode,
		Header:     resp.Header.Clone(),
		Body:       string(respBody),
	}
}

type gatewayTestSeller struct {
	nodeID    string
	conn      *websocket.Conn
	responses []string
	requests  chan service.SubiEnvelope
	mu        sync.Mutex
	next      int
}

func (s *gatewayTestSeller) serve() {
	for {
		var env service.SubiEnvelope
		if err := s.conn.ReadJSON(&env); err != nil {
			return
		}
		if env.Type != service.SubiEnvelopeRequestStart {
			continue
		}
		s.requests <- env
		headers := http.Header{}
		headers.Set("Content-Type", "application/json")
		headers.Set("X-Subi-Upstream-Mode", "fake")
		_ = s.conn.WriteJSON(service.SubiEnvelope{
			Type:       service.SubiEnvelopeResponseStart,
			RequestID:  env.RequestID,
			StatusCode: http.StatusOK,
			Headers:    headers,
		})
		body, _ := json.Marshal(map[string]any{
			"output": []map[string]any{
				{
					"role": "assistant",
					"content": []map[string]any{
						{"type": "output_text", "text": s.nextResponse()},
					},
				},
			},
		})
		_ = s.conn.WriteJSON(service.SubiEnvelope{
			Type:      service.SubiEnvelopeResponseChunk,
			RequestID: env.RequestID,
			Data:      body,
		})
		_ = s.conn.WriteJSON(service.SubiEnvelope{
			Type:      service.SubiEnvelopeResponseEnd,
			RequestID: env.RequestID,
		})
	}
}

func (s *gatewayTestSeller) nextResponse() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.next >= len(s.responses) {
		return s.responses[len(s.responses)-1]
	}
	response := s.responses[s.next]
	s.next++
	return response
}

func (s *gatewayTestSeller) nextRequest(t *testing.T) service.SubiEnvelope {
	t.Helper()
	select {
	case req := <-s.requests:
		return req
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for seller request")
		return service.SubiEnvelope{}
	}
}

func (s *gatewayTestSeller) close() {
	if s == nil || s.conn == nil {
		return
	}
	_ = s.conn.Close()
	time.Sleep(100 * time.Millisecond)
}
