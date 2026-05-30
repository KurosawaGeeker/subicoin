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
  };
}

export function validateAgentConfig(cfg: AgentConfig): void {
  if (!cfg.gateway_ws_url) throw new Error("SUBI_GATEWAY_WS_URL is required");
  if (!cfg.node_token) throw new Error("SUBI_SELLER_NODE_TOKEN is required");
  if (!cfg.node_id) throw new Error("SUBI_NODE_ID or hostname is required");
  if (cfg.worker_count <= 0) throw new Error("SELLER_CODEX_WORKERS or SELLER_WORKERS must be greater than 0");
  if (cfg.worker_queue_len <= 0) throw new Error("SELLER_WORKER_QUEUE_SIZE must be greater than 0");
  if (cfg.upstream_mode !== "codex-login") throw new Error(`SELLER_UPSTREAM_MODE must be codex-login, got ${JSON.stringify(cfg.upstream_mode)}`);
  if (!cfg.codex_home) throw new Error("SELLER_CODEX_HOME or CODEX_HOME is required for codex-login mode");
  if (!cfg.codex_base_url) throw new Error("SELLER_CODEX_BASE_URL is required for codex-login mode");
  if (!cfg.codex_refresh_url) throw new Error("SELLER_CODEX_REFRESH_URL is required for codex-login mode");
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
  if (cfg.upstream_mode !== "codex-login") {
    sendAgentError(socket, env.request_id || "", `unsupported seller upstream mode: ${cfg.upstream_mode}`);
    return;
  }
  await handleCodexLoginRequest(cfg, socket, env);
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
  const body = new TextEncoder().encode(JSON.stringify(payload));
  sendEnvelope(socket, {
    type: subiEnvelopeResponseStart,
    request_id: env.request_id,
    status_code: statusCode,
    headers: { "Content-Type": ["application/json"], "X-Subi-Upstream-Mode": ["codex-login"] },
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

function requestTimeoutMS(env: SubiEnvelope): number {
  return env.timeout_ms && env.timeout_ms > 0 ? env.timeout_ms : 600_000;
}
