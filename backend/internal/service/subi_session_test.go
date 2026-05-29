package service

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/tidwall/gjson"
)

func TestExtractSubiSessionIDFromHeader(t *testing.T) {
	headers := http.Header{}
	headers.Set("x-session-id", "demo-session-001")

	sessionID := ExtractSubiSessionID(headers, []byte(`{"input":"hello"}`), "buyerhash")

	require.Equal(t, "demo-session-001", sessionID)
}

func TestExtractSubiSessionIDFromMetadata(t *testing.T) {
	headers := http.Header{}
	headers.Set("x-session-id", "header-session")

	sessionID := ExtractSubiSessionID(headers, []byte(`{"metadata":{"session_id":"metadata-session"}}`), "buyerhash")

	require.Equal(t, "metadata-session", sessionID)
}

func TestBuildSubiContextualRequestBodyIncludesHistory(t *testing.T) {
	body := []byte(`{"model":"subi-codex-subscription","stream":true,"input":"我的暗号是什么？"}`)
	history := []SubiSessionTurn{
		{Role: "user", Content: "记住暗号是 blue-lobster"},
		{Role: "assistant", Content: "我记住了。"},
	}

	rewritten, injected, ok, err := BuildSubiContextualRequestBody(body, "/v1/responses", history, "我的暗号是什么？")

	require.NoError(t, err)
	require.True(t, ok)
	require.Equal(t, 2, injected)
	require.Equal(t, "Below is the prior conversation history for this buyer session. Continue consistently.", gjson.GetBytes(rewritten, "input.0.content").String())
	require.Equal(t, "记住暗号是 blue-lobster", gjson.GetBytes(rewritten, "input.1.content").String())
	require.Equal(t, "我记住了。", gjson.GetBytes(rewritten, "input.2.content").String())
	require.Equal(t, "我的暗号是什么？", gjson.GetBytes(rewritten, "input.3.content").String())
	require.True(t, gjson.GetBytes(rewritten, "metadata.subi_context_injected").Bool())
}

func TestSubiSessionStoreTruncatesOldTurns(t *testing.T) {
	store := NewSubiSessionStore(3, 1000)

	store.AppendExchange("session-1", "buyerhash", "req-1", "u1", "a1", "seller-001")
	state := store.AppendExchange("session-1", "buyerhash", "req-2", "u2", "a2", "seller-001")

	require.Len(t, state.Turns, 3)
	require.Equal(t, "assistant", state.Turns[0].Role)
	require.Equal(t, "a1", state.Turns[0].Content)
	require.Equal(t, "u2", state.Turns[1].Content)
	require.Equal(t, "a2", state.Turns[2].Content)
}

func TestSubiAssistantTextExtractionFromResponsesJSON(t *testing.T) {
	body, err := json.Marshal(map[string]any{
		"output": []map[string]any{
			{
				"role": "assistant",
				"content": []map[string]any{
					{"type": "output_text", "text": "blue-lobster"},
				},
			},
		},
	})
	require.NoError(t, err)

	text := ExtractSubiAssistantText(body, "application/json")

	require.Equal(t, "blue-lobster", text)
}

func TestSubiAssistantTextExtractionFromResponsesSSE(t *testing.T) {
	body := []byte("event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"blue\"}\n\nevent: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"-lobster\"}\n\ndata: [DONE]\n\n")

	text := ExtractSubiAssistantText(body, "text/event-stream")

	require.Equal(t, "blue-lobster", text)
}
