const minMaxOutputTokens = 128;

export interface ChatCompletionsRequest {
  model: string;
  messages: any[];
  instructions?: string;
  max_tokens?: number;
  max_completion_tokens?: number;
  reasoning_effort?: string;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  tools?: any[];
  functions?: any[];
  tool_choice?: any;
  function_call?: any;
  service_tier?: string;
}

export interface ResponsesRequest {
  model: string;
  instructions?: string;
  input: any;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream: boolean;
  tools?: any[];
  include?: string[];
  store?: boolean;
  reasoning?: { effort: string; summary?: string };
  tool_choice?: any;
  service_tier?: string;
}

export interface AnthropicRequest {
  model: string;
  max_tokens: number;
  system?: any;
  messages: any[];
  tools?: any[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  thinking?: { type: string; budget_tokens?: number };
  tool_choice?: any;
  output_config?: { effort?: string };
}

export function chatCompletionsToResponses(req: ChatCompletionsRequest): ResponsesRequest {
  const input = req.messages.flatMap(chatMessageToResponsesItems);
  const out: ResponsesRequest = {
    model: req.model,
    instructions: req.instructions,
    input,
    stream: true,
    include: ["reasoning.encrypted_content"],
    store: false,
    service_tier: req.service_tier,
  };
  if (!isReasoningModel(req.model)) {
    out.temperature = req.temperature;
    out.top_p = req.top_p;
  }
  const maxTokens = req.max_completion_tokens ?? req.max_tokens;
  if (maxTokens && maxTokens > 0) out.max_output_tokens = Math.max(maxTokens, minMaxOutputTokens);
  if (req.reasoning_effort) out.reasoning = { effort: req.reasoning_effort, summary: "auto" };
  const tools = [...(req.tools ?? []), ...(req.functions ?? []).map((fn) => ({ type: "function", function: fn }))];
  if (tools.length > 0) out.tools = tools.map((tool) => ({
    type: "function",
    name: tool.function?.name ?? tool.name,
    description: tool.function?.description ?? tool.description,
    parameters: tool.function?.parameters ?? tool.parameters ?? {},
    strict: tool.function?.strict ?? tool.strict,
  }));
  if (req.tool_choice !== undefined) out.tool_choice = req.tool_choice;
  else if (req.function_call !== undefined) out.tool_choice = chatFunctionCallToToolChoice(req.function_call);
  return stripUndefined(out);
}

export function anthropicToResponses(req: AnthropicRequest): ResponsesRequest {
  const input: any[] = [];
  const systemParts = anthropicSystemParts(req.system);
  if (systemParts.length > 0) input.push({ role: "developer", content: systemParts });
  for (const message of req.messages ?? []) input.push(...anthropicMessageToResponsesItems(message));
  const out: ResponsesRequest = {
    model: req.model,
    input,
    stream: Boolean(req.stream),
    store: false,
  };
  if (req.max_tokens > 0) out.max_output_tokens = Math.max(req.max_tokens, minMaxOutputTokens);
  if (!isReasoningModel(req.model)) {
    out.temperature = req.temperature;
    out.top_p = req.top_p;
  }
  const effort = req.output_config?.effort || anthropicThinkingEffort(req.thinking);
  if (effort) out.reasoning = { effort, summary: "auto" };
  if (req.tools?.length) {
    out.tools = req.tools.map((tool) => ({
      type: tool.type === "web_search_20250305" ? "web_search" : "function",
      name: tool.name,
      description: tool.description,
      parameters: normalizeToolParameters(tool.input_schema),
      strict: false,
    }));
  }
  if (req.tool_choice !== undefined) out.tool_choice = anthropicToolChoiceToResponses(req.tool_choice);
  return stripUndefined(out);
}

export function responsesToChatCompletions(resp: any, model: string): any {
  let content = "";
  const toolCalls: any[] = [];
  let reasoningContent = "";
  for (const item of resp.output ?? []) {
    if (item.type === "message") {
      for (const part of item.content ?? []) {
        if (part.type === "output_text") content += part.text ?? "";
      }
    } else if (item.type === "function_call") {
      toolCalls.push({ id: item.call_id, type: "function", function: { name: item.name, arguments: item.arguments || "{}" } });
    } else if (item.type === "reasoning") {
      for (const summary of item.summary ?? []) {
        if (summary.type === "summary_text") reasoningContent += summary.text ?? "";
      }
    }
  }
  const message: any = { role: "assistant" };
  if (content) message.content = content;
  if (toolCalls.length) message.tool_calls = toolCalls;
  if (reasoningContent) message.reasoning_content = reasoningContent;
  return {
    id: resp.id || `chatcmpl_${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason(resp.status, resp.incomplete_details, toolCalls) }],
    usage: resp.usage
      ? {
          prompt_tokens: resp.usage.input_tokens,
          completion_tokens: resp.usage.output_tokens,
          total_tokens: (resp.usage.input_tokens ?? 0) + (resp.usage.output_tokens ?? 0),
          prompt_tokens_details: resp.usage.input_tokens_details?.cached_tokens ? { cached_tokens: resp.usage.input_tokens_details.cached_tokens } : undefined,
        }
      : undefined,
  };
}

export function responsesToAnthropic(resp: any, model: string): any {
  const content: any[] = [];
  let stopReason = "end_turn";
  for (const item of resp.output ?? []) {
    if (item.type === "message") {
      for (const part of item.content ?? []) {
        if (part.type === "output_text") content.push({ type: "text", text: part.text ?? "" });
      }
    } else if (item.type === "function_call") {
      content.push({ type: "tool_use", id: item.call_id, name: item.name, input: safeParse(item.arguments) ?? {} });
      stopReason = "tool_use";
    } else if (item.type === "reasoning") {
      for (const summary of item.summary ?? []) {
        if (summary.type === "summary_text") content.push({ type: "thinking", thinking: summary.text ?? "" });
      }
    }
  }
  if (resp.status === "incomplete") stopReason = "max_tokens";
  if (resp.status === "failed") stopReason = "error";
  const usage = resp.usage ?? {};
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  const input = Math.max((usage.input_tokens ?? 0) - cached, 0);
  return {
    id: resp.id || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: stopReason,
    usage: {
      input_tokens: input,
      output_tokens: usage.output_tokens ?? 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: cached,
    },
  };
}

function chatMessageToResponsesItems(message: any): any[] {
  switch (message.role) {
    case "system":
      return [{ role: "system", content: chatContentToResponsesContent(message.content, "input") }];
    case "assistant": {
      const items: any[] = [];
      let text = message.reasoning_content ? `<thinking>${message.reasoning_content}</thinking>` : "";
      text += assistantText(message.content);
      if (text) items.push({ role: "assistant", content: [{ type: "output_text", text }] });
      for (const call of message.tool_calls ?? []) {
        items.push({ type: "function_call", call_id: call.id, name: call.function?.name, arguments: call.function?.arguments || "{}" });
      }
      return items;
    }
    case "tool":
    case "function":
      return [{ type: "function_call_output", call_id: message.tool_call_id || message.name, output: cleanText(message.content) }];
    default:
      return [{ role: "user", content: chatContentToResponsesContent(message.content, "input") }];
  }
}

function chatContentToResponsesContent(content: any, mode: "input" | "output"): any {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: any[] = [];
  for (const part of content) {
    if ((part.type === "text" || !part.type) && part.text) parts.push({ type: mode === "input" ? "input_text" : "output_text", text: part.text });
    if (part.type === "image_url") {
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      if (url && !url.match(/^data:image\/[^,]+,\s*$/)) parts.push({ type: "input_image", image_url: url });
    }
  }
  return parts.length ? parts : "";
}

function assistantText(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (part.type === "thinking" || part.type === "reasoning") return `<thinking>${part.thinking || part.text || ""}</thinking>`;
      return part.text || "";
    })
    .join("");
}

function anthropicSystemParts(system: any): any[] {
  if (!system) return [];
  const parts = typeof system === "string" ? [{ type: "text", text: system }] : Array.isArray(system) ? system : [];
  return parts
    .filter((part) => part.type === "text" && part.text && !String(part.text).startsWith("x-anthropic-billing-header:"))
    .map((part) => ({ type: "input_text", text: part.text }));
}

function anthropicMessageToResponsesItems(message: any): any[] {
  const role = message.role === "assistant" ? "assistant" : "user";
  if (typeof message.content === "string") {
    return [{ type: "message", role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text: message.content }] }];
  }
  const items: any[] = [];
  const parts: any[] = [];
  for (const block of Array.isArray(message.content) ? message.content : []) {
    if (block.type === "text") parts.push({ type: role === "assistant" ? "output_text" : "input_text", text: block.text || "" });
    if (block.type === "image") parts.push({ type: "input_image", image_url: `data:${block.source?.media_type || "application/octet-stream"};base64,${block.source?.data || ""}` });
    if (block.type === "tool_use") items.push({ type: "function_call", call_id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) });
    if (block.type === "tool_result") items.push({ type: "function_call_output", call_id: block.tool_use_id, output: cleanText(block.content) });
  }
  if (parts.length > 0) items.unshift({ type: "message", role, content: parts });
  return items;
}

export function normalizeToolParameters(schema: any): any {
  const parameters = schema && typeof schema === "object" ? { ...schema } : { type: "object", properties: {} };
  parameters.type ||= "object";
  parameters.properties ||= {};
  return parameters;
}

function anthropicThinkingEffort(thinking?: { type: string }): string {
  if (!thinking || thinking.type === "disabled") return "";
  if (thinking.type === "adaptive") return "medium";
  return "high";
}

function anthropicToolChoiceToResponses(choice: any): any {
  if (choice?.type === "tool") return { type: "function", name: choice.name };
  return choice;
}

function chatFunctionCallToToolChoice(choice: any): any {
  if (choice === "none" || choice === "auto") return choice;
  const name = typeof choice === "string" ? choice : choice?.name;
  return name ? { type: "function", name } : choice;
}

function finishReason(status: string, details: any, toolCalls: any[]): string {
  if (status === "incomplete" && details?.reason === "max_output_tokens") return "length";
  if (status === "completed" && toolCalls.length > 0) return "tool_calls";
  return "stop";
}

function isReasoningModel(model: string): boolean {
  return /^gpt-5(\.|-|$)/.test(model);
}

function cleanText(value: any): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(cleanText).join("\n\n");
  if (value && typeof value === "object") return cleanText(value.text ?? value.content ?? value.output ?? "");
  return "";
}

function safeParse(value: string): any {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return {};
  }
}

function stripUndefined<T extends Record<string, any>>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}
