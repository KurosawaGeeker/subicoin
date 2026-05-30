import { describe, expect, test } from "bun:test";
import { anthropicToResponses, chatCompletionsToResponses, responsesToAnthropic, responsesToChatCompletions } from "../src/apicompat";

describe("API compatibility conversions", () => {
  test("converts Chat Completions text and tools to Responses", () => {
    const resp = chatCompletionsToResponses({
      model: "gpt-4o",
      messages: [
        { role: "user", content: "Call the function" },
        { role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "ping", arguments: "{\"host\":\"example.com\"}" } }] },
        { role: "tool", tool_call_id: "call_1", content: "pong" },
      ],
      tools: [{ type: "function", function: { name: "ping", parameters: { type: "object" } } }],
      max_tokens: 10,
    });
    expect(resp.stream).toBe(true);
    expect(resp.store).toBe(false);
    expect(resp.max_output_tokens).toBe(128);
    expect(resp.input[1].type).toBe("function_call");
    expect(resp.input[2].type).toBe("function_call_output");
    expect(resp.tools?.[0].name).toBe("ping");
  });

  test("strips sampling for reasoning models", () => {
    const resp = chatCompletionsToResponses({
      model: "gpt-5.5",
      temperature: 0.8,
      top_p: 0.9,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(resp.temperature).toBeUndefined();
    expect(resp.top_p).toBeUndefined();
  });

  test("converts Anthropic messages to Responses", () => {
    const resp = anthropicToResponses({
      model: "gpt-5.2",
      max_tokens: 10,
      stream: true,
      system: [{ type: "text", text: "x-anthropic-billing-header: cc_version=1;" }, { type: "text", text: "Project prompt" }],
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      tools: [{ name: "get_weather", input_schema: { properties: { city: { type: "string" } } } }],
    });
    expect(resp.max_output_tokens).toBe(128);
    expect(resp.input[0].content[0].text).toBe("Project prompt");
    expect(resp.input[1].content[0].text).toBe("Hello");
    expect(resp.tools?.[0].parameters.type).toBe("object");
  });

  test("converts Responses to Chat Completions and Anthropic responses", () => {
    const response = {
      id: "resp_123",
      model: "gpt-5.2",
      status: "completed",
      output: [
        { type: "message", content: [{ type: "output_text", text: "Hello there!" }] },
        { type: "function_call", call_id: "call_1", name: "ping", arguments: "{\"ok\":true}" },
      ],
      usage: { input_tokens: 100, output_tokens: 5, input_tokens_details: { cached_tokens: 80 } },
    };
    const chat = responsesToChatCompletions(response, "gpt-5.2");
    expect(chat.choices[0].finish_reason).toBe("tool_calls");
    expect(chat.choices[0].message.content).toBe("Hello there!");
    expect(chat.usage.prompt_tokens_details.cached_tokens).toBe(80);
    const anthropic = responsesToAnthropic(response, "claude-sonnet");
    expect(anthropic.stop_reason).toBe("tool_use");
    expect(anthropic.usage.input_tokens).toBe(20);
    expect(anthropic.usage.cache_read_input_tokens).toBe(80);
  });
});
