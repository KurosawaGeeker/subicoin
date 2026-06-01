import {
  decodeEnvelope,
  sendEnvelope,
  subiEnvelopeAgentHello,
  subiEnvelopeHeartbeat,
  subiEnvelopeRequestStart,
  subiEnvelopeResponseChunk,
  subiEnvelopeResponseEnd,
  subiEnvelopeResponseError,
  subiEnvelopeResponseStart,
  type HeaderBag,
  type JSONSocket,
  type SubiEnvelope,
} from "./service/p2p";
import { delay, envInt, envString, safeJSONParse, trim } from "./utils";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod } from "node:fs/promises";

export const sellerAgentVersion = "mvp-0";

export interface AgentConfig {
  gateway_ws_url: string;
  node_token: string;
  node_id: string;
  upstream_mode: string;
  worker_count: number;
  worker_queue_len: number;
  codex_home: string;
  codex_base_url: string;
  codex_refresh_url: string;
  claude_home: string;
  anthropic_base_url: string;
  anthropic_auth_token: string;
  anthropic_api_key: string;
  claude_code_oauth_token: string;
  anthropic_version: string;
}

export function loadAgentConfig(): AgentConfig {
  let nodeID = envString("SUBI_NODE_ID");
  if (!nodeID) nodeID = envString("HOSTNAME", "seller-node");
  let upstreamMode = envString("SELLER_UPSTREAM_MODE").toLowerCase();
  if (!upstreamMode) upstreamMode = "codex-login";
  upstreamMode = normalizeUpstreamMode(upstreamMode);
  const workerCount = envInt("SELLER_CODEX_WORKERS", envInt("SELLER_WORKERS", 1));
  return {
    gateway_ws_url: envString("SUBI_GATEWAY_WS_URL"),
    node_token: envString("SUBI_SELLER_NODE_TOKEN"),
    node_id: nodeID,
    upstream_mode: upstreamMode,
    worker_count: workerCount,
    worker_queue_len: Math.max(envInt("SELLER_WORKER_QUEUE_SIZE", workerCount), workerCount),
    codex_home: envString("SELLER_CODEX_HOME", envString("CODEX_HOME", `${Bun.env.HOME || ""}/.codex`)),
    codex_base_url: envString("SELLER_CODEX_BASE_URL", "https://chatgpt.com/backend-api/codex").replace(/\/+$/, ""),
    codex_refresh_url: envString("SELLER_CODEX_REFRESH_URL", envString("CODEX_REFRESH_TOKEN_URL_OVERRIDE", "https://auth.openai.com/oauth/token")),
    claude_home: envString("SELLER_CLAUDE_HOME", envString("CLAUDE_CONFIG_DIR", `${Bun.env.HOME || ""}/.claude`)),
    anthropic_base_url: envString("SELLER_ANTHROPIC_BASE_URL", envString("ANTHROPIC_BASE_URL", "https://api.anthropic.com")).replace(/\/+$/, ""),
    anthropic_auth_token: envString("SELLER_ANTHROPIC_AUTH_TOKEN", envString("ANTHROPIC_AUTH_TOKEN")),
    anthropic_api_key: envString("SELLER_ANTHROPIC_API_KEY", envString("ANTHROPIC_API_KEY")),
    claude_code_oauth_token: envString("SELLER_CLAUDE_CODE_OAUTH_TOKEN", envString("CLAUDE_CODE_OAUTH_TOKEN")),
    anthropic_version: envString("SELLER_ANTHROPIC_VERSION", envString("ANTHROPIC_VERSION", "2023-06-01")),
  };
}

export function validateAgentConfig(cfg: AgentConfig): void {
  if (!cfg.gateway_ws_url) throw new Error("SUBI_GATEWAY_WS_URL is required");
  if (!cfg.node_token) throw new Error("SUBI_SELLER_NODE_TOKEN is required");
  if (!cfg.node_id) throw new Error("SUBI_NODE_ID or hostname is required");
  if (cfg.worker_count <= 0) throw new Error("SELLER_CODEX_WORKERS or SELLER_WORKERS must be greater than 0");
  if (cfg.worker_queue_len <= 0) throw new Error("SELLER_WORKER_QUEUE_SIZE must be greater than 0");
  if (!["codex-login", "claude-code"].includes(cfg.upstream_mode)) {
    throw new Error(`SELLER_UPSTREAM_MODE must be codex-login or claude-code, got ${JSON.stringify(cfg.upstream_mode)}`);
  }
  if (cfg.upstream_mode === "codex-login") {
    if (!cfg.codex_home) throw new Error("SELLER_CODEX_HOME or CODEX_HOME is required for codex-login mode");
    if (!cfg.codex_base_url) throw new Error("SELLER_CODEX_BASE_URL is required for codex-login mode");
    if (!cfg.codex_refresh_url) throw new Error("SELLER_CODEX_REFRESH_URL is required for codex-login mode");
  }
  if (cfg.upstream_mode === "claude-code") {
    if (!cfg.claude_home) throw new Error("SELLER_CLAUDE_HOME or CLAUDE_CONFIG_DIR is required for claude-code mode");
    if (!cfg.anthropic_base_url) throw new Error("SELLER_ANTHROPIC_BASE_URL or ANTHROPIC_BASE_URL is required for claude-code mode");
    if (!cfg.anthropic_version) throw new Error("SELLER_ANTHROPIC_VERSION or ANTHROPIC_VERSION is required for claude-code mode");
  }
}

export async function runSellerAgentUntilClosed(cfg: AgentConfig, signal?: AbortSignal): Promise<void> {
  validateAgentConfig(cfg);
  while (!signal?.aborted) {
    try {
      await runOnce(cfg, signal);
    } catch (error) {
      if (signal?.aborted) return;
      console.error(`seller-agent disconnected: ${error}`);
      await delay(3000);
    }
  }
}

async function runOnce(cfg: AgentConfig, signal?: AbortSignal): Promise<void> {
  const workers = await startAgentWorkers(cfg);
  const ws = new WebSocket(cfg.gateway_ws_url, {
    headers: { Authorization: `Bearer ${cfg.node_token}` },
  } as any);
  const socket = ws as unknown as JSONSocket;
  const requests: SubiEnvelope[] = [];
  let closed = false;
  let closeResolve!: () => void;
  const closedPromise = new Promise<void>((resolve) => {
    closeResolve = resolve;
  });

  ws.addEventListener("open", () => {
    sendEnvelope(socket, {
      type: subiEnvelopeAgentHello,
      node_id: cfg.node_id,
      version: sellerAgentVersion,
      max_concurrency: cfg.worker_count,
      meta: {
        upstream_mode: cfg.upstream_mode,
        worker_count: cfg.worker_count,
        worker_queue_len: cfg.worker_queue_len,
      },
    });
    console.error(`seller-agent connected: node=${cfg.node_id} gateway=${cfg.gateway_ws_url} mode=${cfg.upstream_mode} workers=${cfg.worker_count} queue=${cfg.worker_queue_len}`);
  });
  ws.addEventListener("message", (event) => {
    const env = decodeEnvelope(String(event.data));
    if (env.type !== subiEnvelopeRequestStart) return;
    const activeCount = workers.filter((worker) => worker.active).length;
    if (requests.length + activeCount >= cfg.worker_queue_len) {
      sendAgentError(socket, env.request_id || "", "seller worker queue is full");
      return;
    }
    requests.push(env);
    void pump();
  });
  ws.addEventListener("error", () => {
    closed = true;
    closeResolve();
  });
  ws.addEventListener("close", () => {
    closed = true;
    closeResolve();
  });
  const abort = () => {
    if (closed) return;
    closed = true;
    try {
      ws.close();
    } finally {
      closeResolve();
    }
  };
  signal?.addEventListener("abort", abort, { once: true });

  const heartbeat = setInterval(() => {
    if (closed || ws.readyState !== WebSocket.OPEN) return;
    sendEnvelope(socket, {
      type: subiEnvelopeHeartbeat,
      node_id: cfg.node_id,
      meta: {
        upstream_mode: cfg.upstream_mode,
        worker_count: cfg.worker_count,
      },
    });
  }, 15_000);

  async function pump(): Promise<void> {
    while (!closed && requests.length > 0) {
      const worker = workers.find((candidate) => !candidate.active);
      if (!worker) return;
      const env = requests.shift()!;
      worker.active = true;
      void handleRequest(cfg, socket, env)
        .catch((error) => sendAgentError(socket, env.request_id || "", String(error)))
        .finally(() => {
          worker.active = false;
          void pump();
        });
    }
  }

  await closedPromise;
  signal?.removeEventListener("abort", abort);
  clearInterval(heartbeat);
  await closeAgentWorkers(workers);
}

interface AgentWorkerState {
  id: number;
  active: boolean;
}

async function startAgentWorkers(cfg: AgentConfig): Promise<AgentWorkerState[]> {
  const workers: AgentWorkerState[] = [];
  try {
    for (let i = 0; i < cfg.worker_count; i++) {
      const worker: AgentWorkerState = { id: i + 1, active: false };
      workers.push(worker);
      console.error(`seller-agent worker online: node=${cfg.node_id} worker=${worker.id} mode=${cfg.upstream_mode}`);
    }
    return workers;
  } catch (error) {
    await closeAgentWorkers(workers);
    throw error;
  }
}

async function closeAgentWorkers(workers: AgentWorkerState[]): Promise<void> {
  workers.length = 0;
}

export async function handleRequest(cfg: AgentConfig, socket: JSONSocket, env: SubiEnvelope): Promise<void> {
  switch (cfg.upstream_mode) {
    case "codex-login":
      await handleCodexLoginRequest(cfg, socket, env);
      return;
    case "claude-code":
      await handleClaudeCodeRequest(cfg, socket, env);
      return;
    default:
      sendAgentError(socket, env.request_id || "", `unsupported seller upstream mode: ${cfg.upstream_mode}`);
  }
}

async function handleCodexLoginRequest(cfg: AgentConfig, socket: JSONSocket, env: SubiEnvelope): Promise<void> {
  const upstreamPath = codexLoginResponsesPath(env.path || "");
  if (!upstreamPath) {
    sendCodexLoginJSON(socket, env, 400, { error: { type: "invalid_request_error", message: "codex-login mode only supports Responses requests" } });
    return;
  }
  const url = `${cfg.codex_base_url}${upstreamPath}`;
  const body = codexLoginRequestBody(env.body) as unknown as BodyInit | undefined;

  let resp: Response;
  try {
    resp = await fetchCodexLogin(cfg, env, url, body, false);
    if (resp.status === 401) {
      resp.body?.cancel().catch(() => undefined);
      resp = await fetchCodexLogin(cfg, env, url, body, true);
    }
  } catch (error) {
    sendAgentError(socket, env.request_id || "", `codex-login request failed: ${error}`);
    return;
  }

  const responseHeaders = fetchHeadersToBag(resp.headers);
  responseHeaders["X-Subi-Upstream-Mode"] = [cfg.upstream_mode];
  sendEnvelope(socket, {
    type: subiEnvelopeResponseStart,
    request_id: env.request_id,
    status_code: resp.status,
    headers: responseHeaders,
  });
  await streamFetchResponse(socket, env.request_id || "", resp);
  sendEnvelope(socket, { type: subiEnvelopeResponseEnd, request_id: env.request_id });
}

async function fetchCodexLogin(cfg: AgentConfig, env: SubiEnvelope, url: string, body: BodyInit | undefined, forceRefresh: boolean): Promise<Response> {
  const auth = await loadCodexLoginAuth(cfg, forceRefresh);
  const headers = codexLoginHeaders(env, auth);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMS(env));
  try {
    return await fetch(url, {
      method: env.method || "POST",
      headers,
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function codexLoginRequestBody(body?: Uint8Array): Uint8Array | undefined {
  if (!body) return undefined;
  const payload = safeJSONParse<any>(body);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return new Uint8Array(body);
  if (!("metadata" in payload)) return new Uint8Array(body);
  const cleaned = { ...payload };
  delete cleaned.metadata;
  return new TextEncoder().encode(JSON.stringify(cleaned));
}

function sendCodexLoginJSON(socket: JSONSocket, env: SubiEnvelope, statusCode: number, payload: unknown): void {
  sendAgentJSON(socket, env, statusCode, payload, "codex-login");
}

async function handleClaudeCodeRequest(cfg: AgentConfig, socket: JSONSocket, env: SubiEnvelope): Promise<void> {
  const upstreamPath = claudeCodeMessagesPath(env.path || "");
  if (!upstreamPath) {
    sendAgentJSON(socket, env, 400, { error: { type: "invalid_request_error", message: "claude-code mode only supports Anthropic Messages requests" } }, "claude-code");
    return;
  }
  const url = anthropicURL(cfg.anthropic_base_url, upstreamPath);

  let resp: Response;
  try {
    const auth = await loadClaudeCodeAuth(cfg);
    const bodyBytes = claudeCodeRequestBody(env.body, auth);
    resp = await fetchClaudeCode(cfg, env, url, bodyBytes, auth);
  } catch (error) {
    sendAgentError(socket, env.request_id || "", `claude-code request failed: ${error}`);
    return;
  }

  const responseHeaders = fetchHeadersToBag(resp.headers);
  responseHeaders["X-Subi-Upstream-Mode"] = [cfg.upstream_mode];
  sendEnvelope(socket, {
    type: subiEnvelopeResponseStart,
    request_id: env.request_id,
    status_code: resp.status,
    headers: responseHeaders,
  });
  await streamFetchResponse(socket, env.request_id || "", resp);
  sendEnvelope(socket, { type: subiEnvelopeResponseEnd, request_id: env.request_id });
}

async function fetchClaudeCode(cfg: AgentConfig, env: SubiEnvelope, url: string, body: Uint8Array | undefined, auth: ClaudeCodeAuth): Promise<Response> {
  const headers = claudeCodeHeaders(env, cfg, auth, body);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMS(env));
  try {
    return await fetch(url, {
      method: env.method || "POST",
      headers,
      body: body as unknown as BodyInit | undefined,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function sendAgentJSON(socket: JSONSocket, env: SubiEnvelope, statusCode: number, payload: unknown, upstreamMode: string): void {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  sendEnvelope(socket, {
    type: subiEnvelopeResponseStart,
    request_id: env.request_id,
    status_code: statusCode,
    headers: { "Content-Type": ["application/json"], "X-Subi-Upstream-Mode": [upstreamMode] },
  });
  sendEnvelope(socket, { type: subiEnvelopeResponseChunk, request_id: env.request_id, data: body });
  sendEnvelope(socket, { type: subiEnvelopeResponseEnd, request_id: env.request_id });
}

async function streamFetchResponse(socket: JSONSocket, requestID: string, resp: Response): Promise<void> {
  if (!resp.body) {
    const data = new Uint8Array(await resp.arrayBuffer());
    if (data.length > 0) sendEnvelope(socket, { type: subiEnvelopeResponseChunk, request_id: requestID, data });
    return;
  }
  const reader = resp.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value?.length) sendEnvelope(socket, { type: subiEnvelopeResponseChunk, request_id: requestID, data: value });
    }
  } finally {
    reader.releaseLock();
  }
}

function sendAgentError(socket: JSONSocket, requestID: string, message: string): void {
  sendEnvelope(socket, { type: subiEnvelopeResponseError, request_id: requestID, error: message });
}

function bagToFetchHeaders(bag?: HeaderBag): Headers {
  const headers = new Headers();
  for (const [key, values] of Object.entries(bag ?? {})) {
    for (const value of values) headers.append(key, value);
  }
  return headers;
}

function fetchHeadersToBag(headers: Headers): HeaderBag {
  const out: HeaderBag = {};
  headers.forEach((value, key) => {
    if (["content-encoding", "content-length", "connection", "transfer-encoding"].includes(key.toLowerCase())) return;
    out[key] = [value];
  });
  return out;
}

function normalizeUpstreamMode(value: string): string {
  switch (value) {
    case "codex":
    case "chatgpt":
    case "login":
    case "codex_login":
    case "codex-login-proxy":
    case "codex_login_proxy":
    case "codex-login-transport":
    case "codex_login_transport":
      return "codex-login";
    case "claude":
    case "claude_code":
    case "claude-code-login":
    case "claude_code_login":
    case "anthropic":
      return "claude-code";
    default:
      return value;
  }
}

const codexOAuthClientID = "app_EMoamEEZ73f0CkXaXp7hrann";
const codexAccessTokenRefreshWindowMS = 5 * 60 * 1000;
const codexLastRefreshIntervalMS = 8 * 24 * 60 * 60 * 1000;

interface CodexLoginAuth {
  accessToken: string;
  accountID: string;
  isFedrampAccount: boolean;
}

async function loadCodexLoginAuth(cfg: AgentConfig, forceRefresh: boolean): Promise<CodexLoginAuth> {
  const authPath = codexAuthPath(cfg);
  let auth = await readCodexAuthJSON(authPath);
  if (forceRefresh || shouldRefreshCodexAuth(auth)) {
    auth = await refreshCodexAuthJSON(cfg, authPath, auth);
  }
  const tokens = auth?.tokens ?? {};
  const accessToken = trim(tokens.access_token);
  if (!accessToken) throw new Error(`Codex ChatGPT access token is missing in ${authPath}`);
  const accountID = trim(tokens.account_id) || trim(idTokenClaims(trim(tokens.id_token))?.["https://api.openai.com/auth"]?.chatgpt_account_id);
  if (!accountID) throw new Error(`Codex ChatGPT account id is missing in ${authPath}`);
  return {
    accessToken,
    accountID,
    isFedrampAccount: Boolean(idTokenClaims(trim(tokens.id_token))?.["https://api.openai.com/auth"]?.chatgpt_account_is_fedramp),
  };
}

async function readCodexAuthJSON(path: string): Promise<any> {
  const text = await Bun.file(path).text().catch((error) => {
    throw new Error(`read Codex auth: ${error}`);
  });
  const auth = safeJSONParse<any>(text);
  if (!auth || typeof auth !== "object") throw new Error(`invalid Codex auth JSON at ${path}`);
  const mode = trim(auth.auth_mode).toLowerCase();
  if (mode && !mode.includes("chatgpt")) throw new Error(`Codex auth mode must be ChatGPT login, got ${JSON.stringify(auth.auth_mode)}`);
  if (!auth.tokens || typeof auth.tokens !== "object") throw new Error(`Codex ChatGPT tokens are missing in ${path}`);
  return auth;
}

async function refreshCodexAuthJSON(cfg: AgentConfig, authPath: string, auth: any): Promise<any> {
  const refreshToken = trim(auth?.tokens?.refresh_token);
  if (!refreshToken) throw new Error(`Codex refresh token is missing in ${authPath}`);
  const resp = await fetch(cfg.codex_refresh_url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: codexOAuthClientID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  const bodyText = await resp.text();
  if (!resp.ok) {
    const message = refreshFailureMessage(bodyText) || `HTTP ${resp.status}`;
    throw new Error(`refresh Codex ChatGPT token failed: ${message}`);
  }
  const refreshed = safeJSONParse<any>(bodyText) ?? {};
  const tokens = auth.tokens ?? {};
  if (trim(refreshed.id_token)) tokens.id_token = trim(refreshed.id_token);
  if (trim(refreshed.access_token)) tokens.access_token = trim(refreshed.access_token);
  if (trim(refreshed.refresh_token)) tokens.refresh_token = trim(refreshed.refresh_token);
  auth.tokens = tokens;
  auth.last_refresh = new Date().toISOString();
  await Bun.write(authPath, JSON.stringify(auth, null, 2));
  await chmod(authPath, 0o600).catch(() => undefined);
  return auth;
}

function codexAuthPath(cfg: AgentConfig): string {
  return `${cfg.codex_home.replace(/\/+$/, "")}/auth.json`;
}

function shouldRefreshCodexAuth(auth: any): boolean {
  const accessExp = jwtExpiresAtMS(trim(auth?.tokens?.access_token));
  if (accessExp !== undefined) return accessExp <= Date.now() + codexAccessTokenRefreshWindowMS;
  const lastRefreshMS = Date.parse(trim(auth?.last_refresh));
  return Number.isFinite(lastRefreshMS) && lastRefreshMS < Date.now() - codexLastRefreshIntervalMS;
}

function jwtExpiresAtMS(jwt: string): number | undefined {
  const exp = jwtClaims(jwt)?.exp;
  return typeof exp === "number" ? exp * 1000 : undefined;
}

function idTokenClaims(jwt: string): any {
  return jwtClaims(jwt) ?? {};
}

function jwtClaims(jwt: string): any | undefined {
  const payload = jwt.split(".")[1];
  if (!payload) return undefined;
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
}

function refreshFailureMessage(body: string): string {
  const parsed = safeJSONParse<any>(body);
  return trim(parsed?.error?.message) || trim(parsed?.error_description) || trim(parsed?.message) || trim(parsed?.error?.code) || trim(parsed?.code);
}

function codexLoginResponsesPath(path: string): string {
  try {
    const parsed = path.startsWith("http://") || path.startsWith("https://") ? new URL(path) : new URL(path || "/", "http://subi.local");
    const clean = parsed.pathname.replace(/\/+$/, "") || "/";
    const query = parsed.search || "";
    if (clean === "/v1/responses" || clean === "/responses" || clean === "/backend-api/codex/responses") return `/responses${query}`;
    if (clean.startsWith("/v1/responses/")) return `/responses/${clean.slice("/v1/responses/".length)}${query}`;
    if (clean.startsWith("/responses/")) return `${clean}${query}`;
    if (clean.startsWith("/backend-api/codex/responses/")) return `/responses/${clean.slice("/backend-api/codex/responses/".length)}${query}`;
    return "";
  } catch {
    return "";
  }
}

interface ClaudeCodeAuth {
  type: "api-key" | "auth-token";
  value: string;
}

async function loadClaudeCodeAuth(cfg: AgentConfig): Promise<ClaudeCodeAuth> {
  const apiKey = trim(cfg.anthropic_api_key);
  if (apiKey) return { type: "api-key", value: apiKey };
  const envToken = trimBearer(cfg.anthropic_auth_token);
  if (envToken) return { type: "auth-token", value: envToken };
  const claudeCodeOAuthToken = trimBearer(cfg.claude_code_oauth_token);
  if (claudeCodeOAuthToken) return { type: "auth-token", value: claudeCodeOAuthToken };

  const credentialsPath = claudeCredentialsPath(cfg);
  const text = await Bun.file(credentialsPath).text().catch((error) => {
    throw new Error(`read Claude Code credentials: ${error}`);
  });
  const credentials = safeJSONParse<any>(text);
  if (!credentials || typeof credentials !== "object") throw new Error(`invalid Claude Code credentials JSON at ${credentialsPath}`);
  const token = trimBearer(firstStringAtPaths(credentials, [
    ["claudeAiOauth", "accessToken"],
    ["claudeAiOauth", "access_token"],
    ["claudeAiOauth", "token"],
    ["oauth", "accessToken"],
    ["oauth", "access_token"],
    ["accessToken"],
    ["access_token"],
    ["authToken"],
    ["auth_token"],
  ]));
  if (!token) {
    throw new Error(`Claude Code access token is missing in ${credentialsPath}; set SELLER_ANTHROPIC_AUTH_TOKEN or SELLER_ANTHROPIC_API_KEY`);
  }
  return { type: "auth-token", value: token };
}

function claudeCredentialsPath(cfg: AgentConfig): string {
  return `${cfg.claude_home.replace(/\/+$/, "")}/.credentials.json`;
}

function firstStringAtPaths(root: any, paths: string[][]): string {
  for (const path of paths) {
    let value = root;
    for (const key of path) {
      value = value?.[key];
    }
    const text = trim(value);
    if (text) return text;
  }
  return "";
}

function trimBearer(value: string): string {
  const text = trim(value);
  return text.toLowerCase().startsWith("bearer ") ? trim(text.slice("bearer ".length)) : text;
}

function claudeCodeMessagesPath(path: string): string {
  try {
    const parsed = path.startsWith("http://") || path.startsWith("https://") ? new URL(path) : new URL(path || "/", "http://subi.local");
    const clean = parsed.pathname.replace(/\/+$/, "") || "/";
    const query = parsed.search || "";
    if (clean === "/v1/messages" || clean === "/messages") return `/v1/messages${query}`;
    if (clean.startsWith("/v1/messages/")) return `/v1/messages/${clean.slice("/v1/messages/".length)}${query}`;
    if (clean.startsWith("/messages/")) return `/v1/messages/${clean.slice("/messages/".length)}${query}`;
    return "";
  } catch {
    return "";
  }
}

function anthropicURL(baseURL: string, upstreamPath: string): string {
  const base = baseURL.replace(/\/+$/, "");
  if (base.endsWith("/v1") && upstreamPath.startsWith("/v1/")) return `${base}${upstreamPath.slice("/v1".length)}`;
  return `${base}${upstreamPath}`;
}

function codexLoginHeaders(env: SubiEnvelope, auth: CodexLoginAuth): Headers {
  const headers = bagToFetchHeaders(env.headers);
  for (const key of [
    "authorization",
    "x-api-key",
    "x-goog-api-key",
    "cookie",
    "host",
    "content-length",
    "connection",
    "openai-organization",
    "openai-project",
  ]) {
    headers.delete(key);
  }
  headers.set("Authorization", `Bearer ${auth.accessToken}`);
  headers.set("ChatGPT-Account-ID", auth.accountID);
  if (auth.isFedrampAccount) headers.set("X-OpenAI-Fedramp", "true");
  if (!headers.get("Accept")) headers.set("Accept", env.stream ? "text/event-stream" : "application/json, text/event-stream");
  headers.set("Content-Type", "application/json");
  headers.set("User-Agent", `subi-seller-agent/${sellerAgentVersion}`);
  headers.set("version", sellerAgentVersion);
  return headers;
}

const claudeCodeSystemPrompt = "You are Claude Code, Anthropic's official CLI for Claude.";
const claudeCodeCLIVersion = "2.1.92";
const claudeCodeUserAgent = `claude-cli/${claudeCodeCLIVersion} (external, cli)`;
const claudeCodeClientID = randomHex(32);
const claudeCodeFullMimicBetas = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "prompt-caching-scope-2026-01-05",
  "effort-2025-11-24",
  "context-management-2025-06-27",
  "extended-cache-ttl-2025-04-11",
];

const claudeCodeDefaultHeaders: Record<string, string> = {
  "User-Agent": claudeCodeUserAgent,
  "X-Stainless-Lang": "js",
  "X-Stainless-Package-Version": "0.70.0",
  "X-Stainless-OS": "Linux",
  "X-Stainless-Arch": "arm64",
  "X-Stainless-Runtime": "node",
  "X-Stainless-Runtime-Version": "v24.13.0",
  "X-Stainless-Retry-Count": "0",
  "X-Stainless-Timeout": "600",
  "X-App": "cli",
  "Anthropic-Dangerous-Direct-Browser-Access": "true",
};

function claudeCodeRequestBody(body: Uint8Array | undefined, auth: ClaudeCodeAuth): Uint8Array | undefined {
  if (!body) return undefined;
  if (auth.type !== "auth-token") return new Uint8Array(body);
  const payload = safeJSONParse<any>(body);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return new Uint8Array(body);
  const normalized = normalizeClaudeCodeOAuthPayload(payload, body);
  return new TextEncoder().encode(JSON.stringify(normalized));
}

function normalizeClaudeCodeOAuthPayload(payload: Record<string, any>, originalBody: Uint8Array): Record<string, any> {
  const out: Record<string, any> = { ...payload };
  if (typeof out.model === "string") out.model = normalizeClaudeCodeModelID(out.model);
  normalizeClaudeCodeSystem(out);
  normalizeClaudeCodeMetadata(out, originalBody);
  if (!Array.isArray(out.tools)) out.tools = [];
  if (!("temperature" in out)) out.temperature = 1;
  if (!("max_tokens" in out)) out.max_tokens = 128000;
  const thinkingType = typeof out.thinking?.type === "string" ? out.thinking.type : "";
  if (!("context_management" in out) && (thinkingType === "enabled" || thinkingType === "adaptive")) {
    out.context_management = { edits: [{ type: "clear_thinking_20251015", keep: "all" }] };
  }
  if ((!Array.isArray(out.tools) || out.tools.length === 0) && "tool_choice" in out) delete out.tool_choice;
  return out;
}

function normalizeClaudeCodeSystem(payload: Record<string, any>): void {
  const original = extractClaudeCodeSystemText(payload.system);
  if (systemHasClaudeCodePrompt(payload.system)) {
    if (!Array.isArray(payload.system)) payload.system = [{ type: "text", text: claudeCodeSystemPrompt }];
    return;
  }

  payload.system = [{ type: "text", text: claudeCodeSystemPrompt }];
  if (!original || original === claudeCodeSystemPrompt) return;
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  payload.messages = [
    { role: "user", content: [{ type: "text", text: `[System Instructions]\n${original}` }] },
    { role: "assistant", content: [{ type: "text", text: "Understood. I will follow these instructions." }] },
    ...messages,
  ];
}

function extractClaudeCodeSystemText(system: unknown): string {
  if (typeof system === "string") return system.trim();
  if (!Array.isArray(system)) return "";
  const parts: string[] = [];
  for (const item of system) {
    if (item && typeof item === "object" && typeof (item as any).text === "string" && trim((item as any).text)) parts.push((item as any).text);
  }
  return parts.join("\n\n").trim();
}

function systemHasClaudeCodePrompt(system: unknown): boolean {
  const hasPrompt = (text: string) =>
    text.startsWith("You are Claude Code, Anthropic's official CLI for Claude") ||
    text.startsWith("You are a Claude agent, built on Anthropic's Claude Agent SDK") ||
    text.startsWith("You are a file search specialist for Claude Code") ||
    text.startsWith("You are a helpful AI assistant tasked with summarizing conversations");
  if (typeof system === "string") return hasPrompt(system);
  if (!Array.isArray(system)) return false;
  return system.some((item) => item && typeof item === "object" && typeof (item as any).text === "string" && hasPrompt((item as any).text));
}

function normalizeClaudeCodeMetadata(payload: Record<string, any>, originalBody: Uint8Array): void {
  const existing = typeof payload.metadata?.user_id === "string" ? trim(payload.metadata.user_id) : "";
  if (existing) return;
  if (!payload.metadata || typeof payload.metadata !== "object" || Array.isArray(payload.metadata)) payload.metadata = {};
  payload.metadata.user_id = formatClaudeCodeMetadataUserID(claudeCodeClientID, "", deterministicUUID(`seller-agent::${hashBytes(originalBody)}`));
}

function formatClaudeCodeMetadataUserID(deviceID: string, accountUUID: string, sessionID: string): string {
  return `user_${deviceID}_account_${accountUUID}_session_${sessionID}`;
}

function claudeCodeMetadataSessionID(userID: string): string {
  const match = /^user_[a-fA-F0-9]{64}_account_[a-fA-F0-9-]*_session_([a-fA-F0-9-]{36})$/.exec(userID);
  if (match) return match[1];
  const parsed = safeJSONParse<any>(userID);
  return trim(parsed?.session_id);
}

function normalizeClaudeCodeModelID(id: string): string {
  switch (id) {
    case "claude-sonnet-4-5":
      return "claude-sonnet-4-5-20250929";
    case "claude-opus-4-5":
      return "claude-opus-4-5-20251101";
    case "claude-haiku-4-5":
      return "claude-haiku-4-5-20251001";
    default:
      return id;
  }
}

function claudeCodeHeaders(env: SubiEnvelope, cfg: AgentConfig, auth: ClaudeCodeAuth, body?: Uint8Array): Headers {
  if (auth.type === "auth-token") return claudeCodeOAuthHeaders(env, cfg, auth, body);

  const headers = bagToFetchHeaders(env.headers);
  for (const key of ["authorization", "x-api-key", "x-goog-api-key", "cookie", "host", "content-length", "connection"]) {
    headers.delete(key);
  }
  headers.set("X-Api-Key", auth.value);
  if (!headers.get("anthropic-version")) headers.set("anthropic-version", cfg.anthropic_version);
  if (!headers.get("Accept")) headers.set("Accept", env.stream ? "text/event-stream" : "application/json, text/event-stream");
  headers.set("Content-Type", "application/json");
  headers.set("User-Agent", `subi-seller-agent/${sellerAgentVersion}`);
  return headers;
}

function claudeCodeOAuthHeaders(env: SubiEnvelope, cfg: AgentConfig, auth: ClaudeCodeAuth, body?: Uint8Array): Headers {
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${auth.value}`);
  headers.set("Content-Type", "application/json");
  headers.set("Accept", "application/json");
  headers.set("anthropic-version", cfg.anthropic_version || "2023-06-01");
  headers.set("anthropic-beta", claudeCodeFullMimicBetas.join(","));
  for (const [key, value] of Object.entries(claudeCodeDefaultHeaders)) headers.set(key, value);
  if (env.stream || claudeCodeBodyStream(body)) headers.set("x-stainless-helper-method", "stream");
  headers.set("x-client-request-id", randomUUID());
  const metadataUserID = claudeCodeBodyMetadataUserID(body);
  const sessionID = metadataUserID ? claudeCodeMetadataSessionID(metadataUserID) : "";
  if (sessionID) headers.set("X-Claude-Code-Session-Id", sessionID);
  return headers;
}

function claudeCodeBodyStream(body?: Uint8Array): boolean {
  const payload = body ? safeJSONParse<any>(body) : undefined;
  return payload?.stream === true;
}

function claudeCodeBodyMetadataUserID(body?: Uint8Array): string {
  const payload = body ? safeJSONParse<any>(body) : undefined;
  return trim(payload?.metadata?.user_id);
}

function requestTimeoutMS(env: SubiEnvelope): number {
  return env.timeout_ms && env.timeout_ms > 0 ? env.timeout_ms : 600_000;
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function hashBytes(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 32);
}

function deterministicUUID(seed: string): string {
  const bytes = createHash("sha256").update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
