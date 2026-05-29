package service

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/tidwall/gjson"
)

const (
	DefaultSubiSessionMaxTurns = 20
	DefaultSubiSessionMaxChars = 20000

	subiContextSystemPrompt = "Below is the prior conversation history for this buyer session. Continue consistently."
)

type SubiSessionState struct {
	SessionID      string
	BuyerHash      string
	LastSellerNode string
	Turns          []SubiSessionTurn
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

type SubiSessionTurn struct {
	Role      string
	Content   string
	RequestID string
	CreatedAt time.Time
}

type SubiSessionStore struct {
	mu       sync.Mutex
	sessions map[string]*SubiSessionState
	maxTurns int
	maxChars int
}

func NewSubiSessionStore(maxTurns, maxChars int) *SubiSessionStore {
	if maxTurns <= 0 {
		maxTurns = DefaultSubiSessionMaxTurns
	}
	if maxChars <= 0 {
		maxChars = DefaultSubiSessionMaxChars
	}
	return &SubiSessionStore{
		sessions: make(map[string]*SubiSessionState),
		maxTurns: maxTurns,
		maxChars: maxChars,
	}
}

func (s *SubiSessionStore) Snapshot(sessionID, buyerHash string) SubiSessionState {
	if s == nil {
		return SubiSessionState{}
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	state := s.ensureLocked(sessionID, buyerHash)
	return cloneSubiSessionState(state)
}

func (s *SubiSessionStore) AppendExchange(sessionID, buyerHash, requestID, userText, assistantText, sellerNode string) SubiSessionState {
	if s == nil {
		return SubiSessionState{}
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	state := s.ensureLocked(sessionID, buyerHash)
	now := time.Now()
	if text := strings.TrimSpace(userText); text != "" {
		state.Turns = append(state.Turns, SubiSessionTurn{
			Role:      "user",
			Content:   text,
			RequestID: requestID,
			CreatedAt: now,
		})
	}
	if text := strings.TrimSpace(assistantText); text != "" {
		state.Turns = append(state.Turns, SubiSessionTurn{
			Role:      "assistant",
			Content:   text,
			RequestID: requestID,
			CreatedAt: now,
		})
	}
	state.LastSellerNode = strings.TrimSpace(sellerNode)
	state.UpdatedAt = now
	s.truncateLocked(state)
	return cloneSubiSessionState(state)
}

func (s *SubiSessionStore) SetLastSeller(sessionID, buyerHash, sellerNode string) SubiSessionState {
	if s == nil {
		return SubiSessionState{}
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	state := s.ensureLocked(sessionID, buyerHash)
	state.LastSellerNode = strings.TrimSpace(sellerNode)
	state.UpdatedAt = time.Now()
	return cloneSubiSessionState(state)
}

func (s *SubiSessionStore) ensureLocked(sessionID, buyerHash string) *SubiSessionState {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		sessionID = "anonymous"
	}
	if state := s.sessions[sessionID]; state != nil {
		if state.BuyerHash == "" {
			state.BuyerHash = strings.TrimSpace(buyerHash)
		}
		return state
	}
	now := time.Now()
	state := &SubiSessionState{
		SessionID: sessionID,
		BuyerHash: strings.TrimSpace(buyerHash),
		CreatedAt: now,
		UpdatedAt: now,
	}
	s.sessions[sessionID] = state
	return state
}

func (s *SubiSessionStore) truncateLocked(state *SubiSessionState) {
	if state == nil {
		return
	}
	if s.maxTurns > 0 && len(state.Turns) > s.maxTurns {
		state.Turns = append([]SubiSessionTurn(nil), state.Turns[len(state.Turns)-s.maxTurns:]...)
	}
	if s.maxChars <= 0 {
		return
	}
	total := 0
	for _, turn := range state.Turns {
		total += len(turn.Content)
	}
	for len(state.Turns) > 0 && total > s.maxChars {
		total -= len(state.Turns[0].Content)
		state.Turns = state.Turns[1:]
	}
}

func cloneSubiSessionState(state *SubiSessionState) SubiSessionState {
	if state == nil {
		return SubiSessionState{}
	}
	clone := *state
	clone.Turns = append([]SubiSessionTurn(nil), state.Turns...)
	return clone
}

func ExtractSubiSessionID(headers http.Header, body []byte, buyerHash string) string {
	candidates := []string{
		strings.TrimSpace(gjson.GetBytes(body, "metadata.session_id").String()),
		strings.TrimSpace(gjson.GetBytes(body, "metadata.user_id").String()),
		strings.TrimSpace(headers.Get("x-session-id")),
		strings.TrimSpace(headers.Get("x-stainless-session-id")),
		strings.TrimSpace(headers.Get("session_id")),
		strings.TrimSpace(gjson.GetBytes(body, "conversation_id").String()),
		strings.TrimSpace(gjson.GetBytes(body, "previous_response_id").String()),
	}
	for _, candidate := range candidates {
		if candidate != "" {
			return candidate
		}
	}
	if buyerHash = strings.TrimSpace(buyerHash); buyerHash != "" {
		return "buyer-key-" + buyerHash
	}
	return "anonymous"
}

func SubiSessionHash(sessionID string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(sessionID)))
	return hex.EncodeToString(sum[:])
}

func ExtractSubiUserText(body []byte, path string) (string, bool) {
	var payload any
	if err := json.Unmarshal(body, &payload); err != nil {
		return "", false
	}
	root, _ := payload.(map[string]any)
	if root == nil {
		return subiCleanJoinedText(payload), subiCleanJoinedText(payload) != ""
	}

	path = subiSessionPathOnly(path)
	switch {
	case subiSessionIsResponsesPath(path):
		if input, ok := root["input"]; ok {
			return latestSubiRoleTextOrText(input, "user")
		}
	case subiSessionIsChatCompletionsPath(path), subiSessionIsAnthropicMessagesPath(path):
		if messages, ok := root["messages"]; ok {
			return latestSubiRoleTextOrText(messages, "user")
		}
	}

	for _, key := range []string{"input", "messages", "prompt"} {
		if value, ok := root[key]; ok {
			if text, ok := latestSubiRoleTextOrText(value, "user"); ok {
				return text, true
			}
		}
	}
	return "", false
}

func BuildSubiContextualRequestBody(body []byte, path string, history []SubiSessionTurn, currentUserText string) ([]byte, int, bool, error) {
	currentUserText = strings.TrimSpace(currentUserText)
	if currentUserText == "" || len(history) == 0 {
		return body, 0, false, nil
	}

	var root map[string]any
	if err := json.Unmarshal(body, &root); err != nil {
		return body, 0, false, err
	}

	path = subiSessionPathOnly(path)
	historyMessages, injected := subiHistoryMessages(history)
	if injected == 0 {
		return body, 0, false, nil
	}

	switch {
	case subiSessionIsResponsesPath(path):
		messages := make([]map[string]any, 0, injected+2)
		messages = append(messages, map[string]any{"role": "system", "content": subiContextSystemPrompt})
		messages = append(messages, historyMessages...)
		messages = append(messages, map[string]any{"role": "user", "content": currentUserText})
		root["input"] = messages
	case subiSessionIsChatCompletionsPath(path):
		messages := make([]map[string]any, 0, injected+2)
		messages = append(messages, map[string]any{"role": "system", "content": subiContextSystemPrompt})
		messages = append(messages, historyMessages...)
		messages = append(messages, map[string]any{"role": "user", "content": currentUserText})
		root["messages"] = messages
	case subiSessionIsAnthropicMessagesPath(path):
		system := strings.TrimSpace(subiContextSystemPrompt)
		if existing := strings.TrimSpace(subiCleanJoinedText(root["system"])); existing != "" {
			system = existing + "\n\n" + system
		}
		messages := make([]map[string]any, 0, injected+1)
		messages = append(messages, historyMessages...)
		messages = append(messages, map[string]any{"role": "user", "content": currentUserText})
		root["system"] = system
		root["messages"] = messages
	default:
		return body, 0, false, nil
	}

	metadata, _ := root["metadata"].(map[string]any)
	if metadata == nil {
		metadata = map[string]any{}
	}
	metadata["subi_context_injected"] = true
	metadata["subi_history_turns_injected"] = injected
	root["metadata"] = metadata

	rewritten, err := json.Marshal(root)
	if err != nil {
		return body, 0, false, err
	}
	return rewritten, injected, true, nil
}

func ExtractSubiAssistantText(body []byte, contentType string) string {
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		return ""
	}
	if strings.Contains(strings.ToLower(contentType), "text/event-stream") ||
		bytes.HasPrefix(trimmed, []byte("event:")) ||
		bytes.HasPrefix(trimmed, []byte("data:")) ||
		bytes.Contains(trimmed, []byte("\ndata:")) {
		if text := extractSubiAssistantTextFromSSE(trimmed); text != "" {
			return text
		}
	}
	return extractSubiAssistantTextFromJSON(trimmed)
}

func subiHistoryMessages(history []SubiSessionTurn) ([]map[string]any, int) {
	messages := make([]map[string]any, 0, len(history))
	for _, turn := range history {
		role := strings.ToLower(strings.TrimSpace(turn.Role))
		if role != "user" && role != "assistant" {
			continue
		}
		content := strings.TrimSpace(turn.Content)
		if content == "" {
			continue
		}
		messages = append(messages, map[string]any{
			"role":    role,
			"content": content,
		})
	}
	return messages, len(messages)
}

func latestSubiRoleTextOrText(value any, role string) (string, bool) {
	var latest string
	findLatestSubiRoleText(value, role, &latest)
	if text := strings.TrimSpace(latest); text != "" {
		return text, true
	}
	text := subiCleanJoinedText(value)
	return text, text != ""
}

func findLatestSubiRoleText(value any, role string, latest *string) {
	switch v := value.(type) {
	case []any:
		for _, item := range v {
			findLatestSubiRoleText(item, role, latest)
		}
	case map[string]any:
		itemRole, _ := v["role"].(string)
		if strings.EqualFold(strings.TrimSpace(itemRole), role) {
			parts := make([]string, 0, 4)
			if content, ok := v["content"]; ok {
				collectSubiText(content, &parts)
			} else {
				collectSubiText(v, &parts)
			}
			if text := strings.TrimSpace(strings.Join(parts, "\n\n")); text != "" {
				*latest = text
			}
			return
		}
		for _, key := range []string{"input", "messages", "content"} {
			if child, ok := v[key]; ok {
				findLatestSubiRoleText(child, role, latest)
			}
		}
	}
}

func subiCleanJoinedText(value any) string {
	parts := make([]string, 0, 4)
	collectSubiText(value, &parts)
	return strings.TrimSpace(strings.Join(parts, "\n\n"))
}

func collectSubiText(value any, parts *[]string) {
	switch v := value.(type) {
	case string:
		if text := strings.TrimSpace(v); text != "" {
			*parts = append(*parts, text)
		}
	case []any:
		for _, item := range v {
			collectSubiText(item, parts)
		}
	case map[string]any:
		for _, key := range []string{"text", "input_text", "output_text", "content", "message", "messages", "input"} {
			if child, ok := v[key]; ok {
				collectSubiText(child, parts)
			}
		}
	}
}

func extractSubiAssistantTextFromJSON(body []byte) string {
	if text := strings.TrimSpace(gjson.GetBytes(body, "output_text").String()); text != "" {
		return text
	}

	var parts []string
	gjson.GetBytes(body, "output").ForEach(func(_, item gjson.Result) bool {
		role := strings.TrimSpace(item.Get("role").String())
		if role != "" && !strings.EqualFold(role, "assistant") {
			return true
		}
		item.Get("content").ForEach(func(_, content gjson.Result) bool {
			for _, key := range []string{"text", "output_text"} {
				if text := strings.TrimSpace(content.Get(key).String()); text != "" {
					parts = append(parts, text)
				}
			}
			return true
		})
		return true
	})
	if len(parts) > 0 {
		return strings.TrimSpace(strings.Join(parts, ""))
	}

	gjson.GetBytes(body, "choices").ForEach(func(_, choice gjson.Result) bool {
		if text := strings.TrimSpace(choice.Get("message.content").String()); text != "" {
			parts = append(parts, text)
		}
		return true
	})
	if len(parts) > 0 {
		return strings.TrimSpace(strings.Join(parts, ""))
	}

	gjson.GetBytes(body, "content").ForEach(func(_, content gjson.Result) bool {
		if text := strings.TrimSpace(content.Get("text").String()); text != "" {
			parts = append(parts, text)
		}
		return true
	})
	return strings.TrimSpace(strings.Join(parts, ""))
}

func extractSubiAssistantTextFromSSE(body []byte) string {
	scanner := bufio.NewScanner(bytes.NewReader(body))
	scanner.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)

	var deltas strings.Builder
	doneText := ""
	completedText := ""
	dataLines := make([]string, 0, 2)
	flushBlock := func() {
		if len(dataLines) == 0 {
			return
		}
		data := strings.TrimSpace(strings.Join(dataLines, "\n"))
		dataLines = dataLines[:0]
		if data == "" || data == "[DONE]" {
			return
		}
		payload := []byte(data)
		switch gjson.GetBytes(payload, "type").String() {
		case "response.output_text.delta":
			deltas.WriteString(gjson.GetBytes(payload, "delta").String())
		case "response.output_text.done":
			doneText = gjson.GetBytes(payload, "text").String()
		case "response.completed":
			if raw := gjson.GetBytes(payload, "response").Raw; raw != "" {
				completedText = extractSubiAssistantTextFromJSON([]byte(raw))
			}
		case "content_block_delta":
			if text := gjson.GetBytes(payload, "delta.text").String(); text != "" {
				deltas.WriteString(text)
			}
		}
		gjson.GetBytes(payload, "choices").ForEach(func(_, choice gjson.Result) bool {
			if text := choice.Get("delta.content").String(); text != "" {
				deltas.WriteString(text)
			}
			return true
		})
	}

	for scanner.Scan() {
		line := strings.TrimRight(scanner.Text(), "\r")
		if strings.TrimSpace(line) == "" {
			flushBlock()
			continue
		}
		if strings.HasPrefix(line, "data:") {
			dataLines = append(dataLines, strings.TrimSpace(strings.TrimPrefix(line, "data:")))
		}
	}
	flushBlock()

	if text := strings.TrimSpace(deltas.String()); text != "" {
		return text
	}
	if text := strings.TrimSpace(doneText); text != "" {
		return text
	}
	return strings.TrimSpace(completedText)
}

func subiSessionPathOnly(requestURI string) string {
	path, _, _ := strings.Cut(requestURI, "?")
	return path
}

func subiSessionIsResponsesPath(path string) bool {
	return path == "/v1/responses" ||
		path == "/responses" ||
		path == "/backend-api/codex/responses" ||
		strings.HasPrefix(path, "/v1/responses/") ||
		strings.HasPrefix(path, "/responses/") ||
		strings.HasPrefix(path, "/backend-api/codex/responses/")
}

func subiSessionIsChatCompletionsPath(path string) bool {
	return path == "/v1/chat/completions" || path == "/chat/completions"
}

func subiSessionIsAnthropicMessagesPath(path string) bool {
	return path == "/v1/messages" || path == "/messages"
}
