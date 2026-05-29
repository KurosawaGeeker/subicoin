package service

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	SubiEnvelopeAgentHello    = "agent_hello"
	SubiEnvelopeHeartbeat     = "heartbeat"
	SubiEnvelopeRequestStart  = "request_start"
	SubiEnvelopeResponseStart = "response_start"
	SubiEnvelopeResponseChunk = "response_chunk"
	SubiEnvelopeResponseEnd   = "response_end"
	SubiEnvelopeResponseError = "response_error"

	defaultSubiAgentStaleAfter = 45 * time.Second
	defaultSubiRequestTimeout  = 10 * time.Minute
	defaultSubiWSWriteTimeout  = 30 * time.Second
)

var (
	ErrSubiP2PNoAvailableNode = errors.New("subi p2p: no available seller node")
	ErrSubiP2PAgentBusy       = errors.New("subi p2p: seller node is busy")
)

// DefaultSubiSellerNodeRegistry is the MVP-0 in-memory registry used by both
// the Gateway handler and the seller-agent websocket route.
var DefaultSubiSellerNodeRegistry = NewSubiSellerNodeRegistry()

type SubiEnvelope struct {
	Type string `json:"type"`

	NodeID         string `json:"node_id,omitempty"`
	Version        string `json:"version,omitempty"`
	MaxConcurrency int    `json:"max_concurrency,omitempty"`

	RequestID   string      `json:"request_id,omitempty"`
	Method      string      `json:"method,omitempty"`
	Path        string      `json:"path,omitempty"`
	Headers     http.Header `json:"headers,omitempty"`
	Body        []byte      `json:"body,omitempty"`
	Stream      bool        `json:"stream,omitempty"`
	TimeoutMS   int64       `json:"timeout_ms,omitempty"`
	SessionHash string      `json:"session_hash,omitempty"`

	StatusCode int            `json:"status_code,omitempty"`
	Data       []byte         `json:"data,omitempty"`
	Error      string         `json:"error,omitempty"`
	Meta       map[string]any `json:"meta,omitempty"`
}

type SubiP2PRequest struct {
	RequestID          string
	Method             string
	Path               string
	Headers            http.Header
	Body               []byte
	Stream             bool
	SessionID          string
	SessionHash        string
	PreviousSellerNode string
	Timeout            time.Duration
}

type SubiP2PResponseEvent struct {
	RequestID  string
	Type       string
	StatusCode int
	Headers    http.Header
	Data       []byte
	Error      string
	NodeID     string
}

type SubiP2PDispatch struct {
	RequestID          string
	NodeID             string
	PreviousSellerNode string
	SessionMigrated    bool
	Events             <-chan SubiP2PResponseEvent
	Done               func()
}

type SubiSellerNodeRegistry struct {
	mu       sync.Mutex
	nodes    map[string]*subiSellerNode
	sticky   map[string]string
	requests map[string]*subiP2PRequestState
}

type subiSellerNode struct {
	id             string
	version        string
	maxConcurrency int
	conn           *websocket.Conn
	writeMu        sync.Mutex
	lastSeen       time.Time
	activeRequests map[string]struct{}
}

type subiP2PRequestState struct {
	ch        chan SubiP2PResponseEvent
	done      chan struct{}
	closeOnce sync.Once
	sendMu    sync.Mutex
}

type subiReserveResult struct {
	node           *subiSellerNode
	previousNodeID string
}

func NewSubiSellerNodeRegistry() *SubiSellerNodeRegistry {
	return &SubiSellerNodeRegistry{
		nodes:    make(map[string]*subiSellerNode),
		sticky:   make(map[string]string),
		requests: make(map[string]*subiP2PRequestState),
	}
}

func IsSubiP2PEnabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("SUBI_P2P_ENABLED"))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func NewSubiP2PRequestID() string {
	return fmt.Sprintf("subi_%d", time.Now().UnixNano())
}

func SubiSellerNodeToken() string {
	return strings.TrimSpace(os.Getenv("SUBI_SELLER_NODE_TOKEN"))
}

func (r *SubiSellerNodeRegistry) ServeAgent(ctx context.Context, conn *websocket.Conn) error {
	var hello SubiEnvelope
	if err := conn.SetReadDeadline(time.Now().Add(10 * time.Second)); err != nil {
		return err
	}
	if err := conn.ReadJSON(&hello); err != nil {
		return fmt.Errorf("read agent hello: %w", err)
	}
	if err := conn.SetReadDeadline(time.Time{}); err != nil {
		return err
	}
	if hello.Type != SubiEnvelopeAgentHello {
		return fmt.Errorf("first seller agent envelope must be %s", SubiEnvelopeAgentHello)
	}
	nodeID := strings.TrimSpace(hello.NodeID)
	if nodeID == "" {
		return errors.New("seller agent node_id is required")
	}
	maxConcurrency := hello.MaxConcurrency
	if maxConcurrency <= 0 {
		maxConcurrency = 1
	}

	node := &subiSellerNode{
		id:             nodeID,
		version:        strings.TrimSpace(hello.Version),
		maxConcurrency: maxConcurrency,
		conn:           conn,
		lastSeen:       time.Now(),
	}

	r.registerNode(node)
	defer r.unregisterNode(nodeID)

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		var env SubiEnvelope
		if err := conn.ReadJSON(&env); err != nil {
			return err
		}
		switch env.Type {
		case SubiEnvelopeHeartbeat:
			r.touchNode(nodeID)
		case SubiEnvelopeResponseStart, SubiEnvelopeResponseChunk, SubiEnvelopeResponseEnd, SubiEnvelopeResponseError:
			r.deliverAgentEvent(nodeID, env)
		default:
			// Ignore unknown events so older gateways can survive newer agents.
		}
	}
}

func (r *SubiSellerNodeRegistry) Dispatch(ctx context.Context, req SubiP2PRequest) (*SubiP2PDispatch, error) {
	if req.Timeout <= 0 {
		req.Timeout = defaultSubiRequestTimeout
	}
	requestID := strings.TrimSpace(req.RequestID)
	if requestID == "" {
		requestID = NewSubiP2PRequestID()
	}
	state := &subiP2PRequestState{
		ch:   make(chan SubiP2PResponseEvent, 64),
		done: make(chan struct{}),
	}

	reservation, err := r.reserveNode(req.SessionHash, requestID)
	if err != nil {
		return nil, err
	}
	node := reservation.node

	r.mu.Lock()
	r.requests[requestID] = state
	r.mu.Unlock()

	done := sync.OnceFunc(func() {
		r.releaseRequest(node.id, requestID)
	})

	env := SubiEnvelope{
		Type:        SubiEnvelopeRequestStart,
		RequestID:   requestID,
		Method:      req.Method,
		Path:        req.Path,
		Headers:     req.Headers,
		Body:        req.Body,
		Stream:      req.Stream,
		TimeoutMS:   req.Timeout.Milliseconds(),
		SessionHash: req.SessionHash,
	}
	if req.SessionID != "" || req.PreviousSellerNode != "" {
		env.Meta = map[string]any{
			"session_id":           req.SessionID,
			"previous_seller_node": req.PreviousSellerNode,
			"session_migrated":     strings.TrimSpace(req.PreviousSellerNode) != "" && strings.TrimSpace(req.PreviousSellerNode) != node.id,
		}
	}

	if err := node.writeJSON(env); err != nil {
		done()
		return nil, fmt.Errorf("write seller agent request: %w", err)
	}

	go func() {
		select {
		case <-ctx.Done():
			done()
		case <-time.After(req.Timeout):
			r.failRequest(node.id, requestID, "seller agent request timeout")
		}
	}()

	previousNodeID := strings.TrimSpace(req.PreviousSellerNode)
	if previousNodeID == "" {
		previousNodeID = reservation.previousNodeID
	}

	return &SubiP2PDispatch{
		RequestID:          requestID,
		NodeID:             node.id,
		PreviousSellerNode: previousNodeID,
		SessionMigrated:    previousNodeID != "" && previousNodeID != node.id,
		Events:             state.ch,
		Done:               done,
	}, nil
}

func (r *SubiSellerNodeRegistry) registerNode(node *subiSellerNode) {
	r.mu.Lock()
	defer r.mu.Unlock()

	prepareSellerNode(node)
	if old := r.nodes[node.id]; old != nil && old.conn != nil && old.conn != node.conn {
		_ = old.conn.Close()
	}
	r.nodes[node.id] = node
}

func (r *SubiSellerNodeRegistry) unregisterNode(nodeID string) {
	r.mu.Lock()
	node := r.nodes[nodeID]
	delete(r.nodes, nodeID)
	for session, stickyNodeID := range r.sticky {
		if stickyNodeID == nodeID {
			delete(r.sticky, session)
		}
	}
	states := make(map[string]*subiP2PRequestState)
	if node != nil {
		for requestID := range node.activeRequests {
			if state := r.requests[requestID]; state != nil {
				states[requestID] = state
			}
			delete(r.requests, requestID)
		}
	}
	r.mu.Unlock()

	for requestID, state := range states {
		state.send(SubiP2PResponseEvent{
			Type:      SubiEnvelopeResponseError,
			Error:     "seller agent disconnected",
			NodeID:    nodeID,
			RequestID: requestID,
		})
		state.close()
	}
}

func (r *SubiSellerNodeRegistry) touchNode(nodeID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if node := r.nodes[nodeID]; node != nil {
		node.lastSeen = time.Now()
	}
}

func (r *SubiSellerNodeRegistry) reserveNode(sessionHash, requestID string) (*subiReserveResult, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	now := time.Now()
	previousNodeID := ""
	if sessionHash != "" {
		if nodeID := r.sticky[sessionHash]; nodeID != "" {
			previousNodeID = nodeID
			node := r.nodes[nodeID]
			if node == nil || now.Sub(node.lastSeen) > defaultSubiAgentStaleAfter {
				delete(r.sticky, sessionHash)
			} else {
				if !nodeHasCapacity(node) {
					return nil, ErrSubiP2PAgentBusy
				}
				reserveNodeRequest(node, requestID)
				return &subiReserveResult{node: node, previousNodeID: previousNodeID}, nil
			}
		}
	}

	for _, node := range r.nodes {
		if now.Sub(node.lastSeen) > defaultSubiAgentStaleAfter || !nodeHasCapacity(node) {
			continue
		}
		reserveNodeRequest(node, requestID)
		if sessionHash != "" {
			r.sticky[sessionHash] = node.id
		}
		return &subiReserveResult{node: node, previousNodeID: previousNodeID}, nil
	}
	return nil, ErrSubiP2PNoAvailableNode
}

func (r *SubiSellerNodeRegistry) deliverAgentEvent(nodeID string, env SubiEnvelope) {
	r.mu.Lock()
	state := r.requests[env.RequestID]
	r.mu.Unlock()
	if state == nil {
		return
	}

	state.send(SubiP2PResponseEvent{
		Type:       env.Type,
		StatusCode: env.StatusCode,
		Headers:    env.Headers,
		Data:       env.Data,
		Error:      env.Error,
		NodeID:     nodeID,
		RequestID:  env.RequestID,
	})

	if env.Type == SubiEnvelopeResponseEnd || env.Type == SubiEnvelopeResponseError {
		r.releaseRequest(nodeID, env.RequestID)
	}
}

func (r *SubiSellerNodeRegistry) failRequest(nodeID, requestID, message string) {
	r.mu.Lock()
	state := r.requests[requestID]
	r.mu.Unlock()
	if state != nil {
		state.send(SubiP2PResponseEvent{
			Type:      SubiEnvelopeResponseError,
			Error:     message,
			NodeID:    nodeID,
			RequestID: requestID,
		})
	}
	r.releaseRequest(nodeID, requestID)
}

func (r *SubiSellerNodeRegistry) releaseRequest(nodeID, requestID string) {
	r.mu.Lock()
	state := r.requests[requestID]
	if state != nil {
		delete(r.requests, requestID)
	}
	if node := r.nodes[nodeID]; node != nil {
		delete(node.activeRequests, requestID)
		node.lastSeen = time.Now()
	}
	r.mu.Unlock()

	if state != nil {
		state.close()
	}
}

func prepareSellerNode(node *subiSellerNode) {
	if node.maxConcurrency <= 0 {
		node.maxConcurrency = 1
	}
	if node.activeRequests == nil {
		node.activeRequests = make(map[string]struct{})
	}
}

func nodeHasCapacity(node *subiSellerNode) bool {
	prepareSellerNode(node)
	return len(node.activeRequests) < node.maxConcurrency
}

func reserveNodeRequest(node *subiSellerNode, requestID string) {
	prepareSellerNode(node)
	node.activeRequests[requestID] = struct{}{}
}

func (n *subiSellerNode) writeJSON(env SubiEnvelope) error {
	n.writeMu.Lock()
	defer n.writeMu.Unlock()
	if err := n.conn.SetWriteDeadline(time.Now().Add(defaultSubiWSWriteTimeout)); err != nil {
		return err
	}
	defer n.conn.SetWriteDeadline(time.Time{})
	return n.conn.WriteJSON(env)
}

func (s *subiP2PRequestState) send(ev SubiP2PResponseEvent) bool {
	select {
	case <-s.done:
		return false
	default:
	}

	s.sendMu.Lock()
	defer s.sendMu.Unlock()
	select {
	case <-s.done:
		return false
	case s.ch <- ev:
		return true
	}
}

func (s *subiP2PRequestState) close() {
	s.closeOnce.Do(func() {
		close(s.done)
		s.sendMu.Lock()
		defer s.sendMu.Unlock()
		close(s.ch)
	})
}
