import { sha256Hex, safeJSONParse, trim } from "../utils";

export const defaultSubiSessionMaxTurns = 20;
export const defaultSubiSessionMaxChars = 20000;
export const subiContextSystemPrompt = "Below is the prior conversation history for this buyer session. Continue consistently.";

export interface SubiSessionTurn {
  role: string;
  content: string;
  request_id: string;
  created_at: string;
}

export interface SubiSessionState {
  session_id: string;
  buyer_hash: string;
  last_seller_node: string;
  turns: SubiSessionTurn[];
  created_at: string;
  updated_at: string;
}

export class SubiSessionStore {
  private sessions = new Map<string, SubiSessionState>();
  private readonly maxTurns: number;
  private readonly maxChars: number;

  constructor(maxTurns = defaultSubiSessionMaxTurns, maxChars = defaultSubiSessionMaxChars) {
    this.maxTurns = maxTurns > 0 ? maxTurns : defaultSubiSessionMaxTurns;
    this.maxChars = maxChars > 0 ? maxChars : defaultSubiSessionMaxChars;
  }

  snapshot(sessionID: string, buyerHash: string): SubiSessionState {
    return cloneState(this.ensure(sessionID, buyerHash));
  }

  appendExchange(sessionID: string, buyerHash: string, requestID: string, userText: string, assistantText: string, sellerNode: string): SubiSessionState {
    const state = this.ensure(sessionID, buyerHash);
    const now = new Date().toISOString();
    const user = trim(userText);
    if (user) {
      state.turns.push({ role: "user", content: user, request_id: requestID, created_at: now });
    }
    const assistant = trim(assistantText);
    if (assistant) {
      state.turns.push({ role: "assistant", content: assistant, request_id: requestID, created_at: now });
    }
    state.last_seller_node = trim(sellerNode);
    state.updated_at = now;
    this.truncate(state);
    return cloneState(state);
  }

  setLastSeller(sessionID: string, buyerHash: string, sellerNode: string): SubiSessionState {
    const state = this.ensure(sessionID, buyerHash);
    state.last_seller_node = trim(sellerNode);
    state.updated_at = new Date().toISOString();
    return cloneState(state);
  }

  private ensure(sessionID: string, buyerHash: string): SubiSessionState {
    const id = trim(sessionID) || "anonymous";
    const existing = this.sessions.get(id);
    if (existing) {
      if (!existing.buyer_hash) existing.buyer_hash = trim(buyerHash);
      return existing;
    }
    const now = new Date().toISOString();
    const state: SubiSessionState = {
      session_id: id,
      buyer_hash: trim(buyerHash),
      last_seller_node: "",
      turns: [],
      created_at: now,
      updated_at: now,
    };
    this.sessions.set(id, state);
    return state;
  }

  private truncate(state: SubiSessionState): void {
    if (this.maxTurns > 0 && state.turns.length > this.maxTurns) {
      state.turns = state.turns.slice(state.turns.length - this.maxTurns);
    }
    if (this.maxChars <= 0) return;
    let total = state.turns.reduce((sum, turn) => sum + turn.content.length, 0);
    while (state.turns.length > 0 && total > this.maxChars) {
      const first = state.turns.shift();
      total -= first?.content.length ?? 0;
    }
  }
}

function cloneState(state: SubiSessionState): SubiSessionState {
  return {
    ...state,
    turns: state.turns.map((turn) => ({ ...turn })),
  };
}

export function extractSubiSessionID(headers: Headers | Record<string, string | undefined>, body: Uint8Array | string, buyerHash: string): string {
  const payload = safeJSONParse<any>(body) ?? {};
  const candidates = [
    trim(payload?.metadata?.session_id),
    trim(payload?.metadata?.user_id),
    headerValue(headers, "x-session-id"),
    headerValue(headers, "x-stainless-session-id"),
    headerValue(headers, "session_id"),
    trim(payload?.conversation_id),
    trim(payload?.previous_response_id),
  ];
  for (const candidate of candidates) {
    if (candidate) return candidate;
  }
  const hash = trim(buyerHash);
  return hash ? `buyer-key-${hash}` : "anonymous";
}

export function subiSessionHash(sessionID: string): string {
  return sha256Hex(trim(sessionID));
}

export function extractSubiUserText(body: Uint8Array | string, path: string): [string, boolean] {
  const payload = safeJSONParse<any>(body);
  if (payload === undefined) return ["", false];
  if (!isPlainObject(payload)) {
    const text = cleanJoinedText(payload);
    return [text, text !== ""];
  }

  const pathOnly = sessionPathOnly(path);
  if (isResponsesPath(pathOnly) && "input" in payload) {
    return latestRoleTextOrText(payload.input, "user");
  }
  if ((isChatCompletionsPath(pathOnly) || isAnthropicMessagesPath(pathOnly)) && "messages" in payload) {
    return latestRoleTextOrText(payload.messages, "user");
  }
  for (const key of ["input", "messages", "prompt"]) {
    if (key in payload) {
      const result = latestRoleTextOrText(payload[key], "user");
      if (result[1]) return result;
    }
  }
  return ["", false];
}

export function buildSubiContextualRequestBody(
  body: Uint8Array | string,
  path: string,
  history: SubiSessionTurn[],
  currentUserText: string,
): { body: Uint8Array; injected: number; rewritten: boolean } {
  const userText = trim(currentUserText);
  if (!userText || history.length === 0) {
    return { body: toBytes(body), injected: 0, rewritten: false };
  }
  const root = safeJSONParse<any>(body);
  if (!isPlainObject(root)) {
    throw new Error("request body must be a JSON object");
  }

  const { messages: historyMessages, injected } = historyToMessages(history);
  if (injected === 0) return { body: toBytes(body), injected: 0, rewritten: false };

  const pathOnly = sessionPathOnly(path);
  if (isResponsesPath(pathOnly)) {
    root.input = [{ role: "system", content: subiContextSystemPrompt }, ...historyMessages, { role: "user", content: userText }];
  } else if (isChatCompletionsPath(pathOnly)) {
    root.messages = [{ role: "system", content: subiContextSystemPrompt }, ...historyMessages, { role: "user", content: userText }];
  } else if (isAnthropicMessagesPath(pathOnly)) {
    const existingSystem = cleanJoinedText(root.system);
    root.system = existingSystem ? `${existingSystem}\n\n${subiContextSystemPrompt}` : subiContextSystemPrompt;
    root.messages = [...historyMessages, { role: "user", content: userText }];
  } else {
    return { body: toBytes(body), injected: 0, rewritten: false };
  }

  if (!isPlainObject(root.metadata)) root.metadata = {};
  root.metadata.subi_context_injected = true;
  root.metadata.subi_history_turns_injected = injected;
  return { body: new TextEncoder().encode(JSON.stringify(root)), injected, rewritten: true };
}

export function extractSubiAssistantText(body: Uint8Array | string, contentType = ""): string {
  const text = typeof body === "string" ? body.trim() : new TextDecoder().decode(body).trim();
  if (!text) return "";
  const lower = contentType.toLowerCase();
  if (lower.includes("text/event-stream") || text.startsWith("event:") || text.startsWith("data:") || text.includes("\ndata:")) {
    const fromSSE = extractAssistantFromSSE(text);
    if (fromSSE) return fromSSE;
  }
  return extractAssistantFromJSON(text);
}

function historyToMessages(history: SubiSessionTurn[]): { messages: Array<{ role: string; content: string }>; injected: number } {
  const messages: Array<{ role: string; content: string }> = [];
  for (const turn of history) {
    const role = trim(turn.role).toLowerCase();
    const content = trim(turn.content);
    if ((role === "user" || role === "assistant") && content) {
      messages.push({ role, content });
    }
  }
  return { messages, injected: messages.length };
}

function latestRoleTextOrText(value: unknown, role: string): [string, boolean] {
  let latest = "";
  findLatestRoleText(value, role, (text) => {
    latest = text;
  });
  const roleText = trim(latest);
  if (roleText) return [roleText, true];
  const text = cleanJoinedText(value);
  return [text, text !== ""];
}

function findLatestRoleText(value: unknown, role: string, setLatest: (value: string) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) findLatestRoleText(item, role, setLatest);
    return;
  }
  if (!isPlainObject(value)) return;
  if (trim(value.role).toLowerCase() === role.toLowerCase()) {
    const parts: string[] = [];
    collectText("content" in value ? value.content : value, parts);
    const joined = trim(parts.join("\n\n"));
    if (joined) setLatest(joined);
    return;
  }
  for (const key of ["input", "messages", "content"]) {
    if (key in value) findLatestRoleText(value[key], role, setLatest);
  }
}

function cleanJoinedText(value: unknown): string {
  const parts: string[] = [];
  collectText(value, parts);
  return trim(parts.join("\n\n"));
}

function collectText(value: unknown, parts: string[]): void {
  if (typeof value === "string") {
    const text = trim(value);
    if (text) parts.push(text);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, parts);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const key of ["text", "input_text", "output_text", "content", "message", "messages", "input"]) {
    if (key in value) collectText(value[key], parts);
  }
}

function extractAssistantFromJSON(text: string): string {
  const root = safeJSONParse<any>(text);
  if (!root) return "";
  if (trim(root.output_text)) return trim(root.output_text);
  const parts: string[] = [];
  if (Array.isArray(root.output)) {
    for (const item of root.output) {
      const role = trim(item?.role);
      if (role && role.toLowerCase() !== "assistant") continue;
      if (Array.isArray(item?.content)) {
        for (const content of item.content) {
          const value = trim(content?.text) || trim(content?.output_text);
          if (value) parts.push(value);
        }
      }
    }
  }
  if (parts.length > 0) return trim(parts.join(""));
  if (Array.isArray(root.choices)) {
    for (const choice of root.choices) {
      const value = trim(choice?.message?.content);
      if (value) parts.push(value);
    }
  }
  if (parts.length > 0) return trim(parts.join(""));
  if (Array.isArray(root.content)) {
    for (const content of root.content) {
      const value = trim(content?.text);
      if (value) parts.push(value);
    }
  }
  return trim(parts.join(""));
}

function extractAssistantFromSSE(text: string): string {
  const blocks = text.split(/\n\s*\n/);
  let deltas = "";
  let doneText = "";
  let completedText = "";
  for (const block of blocks) {
    const dataLines = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => trim(line.slice(5)));
    if (dataLines.length === 0) continue;
    const data = trim(dataLines.join("\n"));
    if (!data || data === "[DONE]") continue;
    const payload = safeJSONParse<any>(data);
    if (!payload) continue;
    switch (payload.type) {
      case "response.output_text.delta":
        deltas += trim(payload.delta);
        break;
      case "response.output_text.done":
        doneText = trim(payload.text);
        break;
      case "response.completed":
        if (payload.response) completedText = extractAssistantFromJSON(JSON.stringify(payload.response));
        break;
      case "content_block_delta":
        if (payload.delta?.text) deltas += payload.delta.text;
        break;
    }
    if (Array.isArray(payload.choices)) {
      for (const choice of payload.choices) {
        if (choice?.delta?.content) deltas += choice.delta.content;
      }
    }
  }
  return trim(deltas) || trim(doneText) || trim(completedText);
}

function sessionPathOnly(requestURI: string): string {
  return requestURI.split("?")[0] ?? requestURI;
}

function isResponsesPath(path: string): boolean {
  return (
    path === "/v1/responses" ||
    path === "/responses" ||
    path === "/backend-api/codex/responses" ||
    path.startsWith("/v1/responses/") ||
    path.startsWith("/responses/") ||
    path.startsWith("/backend-api/codex/responses/")
  );
}

function isChatCompletionsPath(path: string): boolean {
  return path === "/v1/chat/completions" || path === "/chat/completions";
}

function isAnthropicMessagesPath(path: string): boolean {
  return path === "/v1/messages" || path === "/messages";
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toBytes(body: Uint8Array | string): Uint8Array {
  return typeof body === "string" ? new TextEncoder().encode(body) : body;
}

function headerValue(headers: Headers | Record<string, string | undefined>, key: string): string {
  if (headers instanceof Headers) return trim(headers.get(key));
  const lower = key.toLowerCase();
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === lower) return trim(value);
  }
  return "";
}
