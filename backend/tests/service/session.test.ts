import { describe, expect, test } from "bun:test";
import {
  buildSubiContextualRequestBody,
  extractSubiAssistantText,
  extractSubiSessionID,
  isSubiSessionContextEligible,
  SubiSessionStore,
  subiContextSystemPrompt,
  type SubiSessionTurn,
} from "../../src/service/session";

describe("Subi session context", () => {
  test("extracts session id from header and metadata with metadata precedence", () => {
    const headers = new Headers({ "x-session-id": "header-session" });
    expect(extractSubiSessionID(headers, `{"input":"hello"}`, "buyerhash")).toBe("header-session");
    expect(extractSubiSessionID(headers, `{"metadata":{"session_id":"metadata-session"}}`, "buyerhash")).toBe("metadata-session");
  });

  test("rewrites Responses request body with prior turns", () => {
    const history: SubiSessionTurn[] = [
      { role: "user", content: "remember blue-lobster", request_id: "req-1", created_at: new Date().toISOString() },
      { role: "assistant", content: "saved", request_id: "req-1", created_at: new Date().toISOString() },
    ];
    const rewritten = buildSubiContextualRequestBody(
      `{"model":"subi-codex-subscription","stream":true,"input":"what is my code?"}`,
      "/v1/responses",
      history,
      "what is my code?",
    );
    const body = JSON.parse(new TextDecoder().decode(rewritten.body));
    expect(rewritten.rewritten).toBe(true);
    expect(rewritten.injected).toBe(2);
    expect(body.input[0].content).toBe(subiContextSystemPrompt);
    expect(body.input[1].content).toBe("remember blue-lobster");
    expect(body.input[2].content).toBe("saved");
    expect(body.input[3].content).toBe("what is my code?");
    expect(body.metadata.subi_context_injected).toBe(true);
  });

  test("does not rewrite Codex tool protocol Responses bodies", () => {
    const history: SubiSessionTurn[] = [
      { role: "user", content: "old request", request_id: "req-1", created_at: new Date().toISOString() },
      { role: "assistant", content: "old answer", request_id: "req-1", created_at: new Date().toISOString() },
    ];
    const toolRequest = JSON.stringify({
      model: "gpt-5.5",
      stream: true,
      tools: [{ type: "function", name: "shell", parameters: { type: "object" } }],
      input: [{ role: "user", content: "look for nova" }],
    });
    expect(isSubiSessionContextEligible(toolRequest, "/v1/responses")).toBe(false);
    const rewrittenToolRequest = buildSubiContextualRequestBody(toolRequest, "/v1/responses", history, "look for nova");
    expect(rewrittenToolRequest.rewritten).toBe(false);
    expect(new TextDecoder().decode(rewrittenToolRequest.body)).toBe(toolRequest);

    const toolContinuation = JSON.stringify({
      model: "gpt-5.5",
      stream: true,
      input: [
        { type: "function_call", call_id: "call_1", name: "shell", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "nova not found" },
      ],
    });
    expect(isSubiSessionContextEligible(toolContinuation, "/v1/responses")).toBe(false);
    const rewrittenToolContinuation = buildSubiContextualRequestBody(toolContinuation, "/v1/responses", history, "nova not found");
    expect(rewrittenToolContinuation.rewritten).toBe(false);
    expect(new TextDecoder().decode(rewrittenToolContinuation.body)).toBe(toolContinuation);
  });

  test("store truncates old turns", () => {
    const store = new SubiSessionStore(3, 1000);
    store.appendExchange("session-1", "buyerhash", "req-1", "u1", "a1", "seller-001");
    const state = store.appendExchange("session-1", "buyerhash", "req-2", "u2", "a2", "seller-001");
    expect(state.turns).toHaveLength(3);
    expect(state.turns[0].role).toBe("assistant");
    expect(state.turns[0].content).toBe("a1");
    expect(state.turns[1].content).toBe("u2");
    expect(state.turns[2].content).toBe("a2");
  });

  test("extracts assistant text from Responses JSON and SSE", () => {
    const json = JSON.stringify({
      output: [{ role: "assistant", content: [{ type: "output_text", text: "blue-lobster" }] }],
    });
    expect(extractSubiAssistantText(json, "application/json")).toBe("blue-lobster");
    const sse =
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"blue"}\n\n' +
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"-lobster"}\n\n' +
      "data: [DONE]\n\n";
    expect(extractSubiAssistantText(sse, "text/event-stream")).toBe("blue-lobster");
  });
});
