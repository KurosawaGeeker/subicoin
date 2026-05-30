import {
  decodeEnvelope,
  sendEnvelope,
  serializeEnvelope,
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
import { delay, envBool, envInt, envString, safeJSONParse, trim } from "./utils";
import { mkdir, rm } from "node:fs/promises";
import { createServer } from "node:net";

export const sellerAgentVersion = "mvp-0";

export interface AgentConfig {
  gateway_ws_url: string;
  node_token: string;
  node_id: string;
  upstream_mode: string;
  worker_count: number;
  worker_queue_len: number;
  local_base_url: string;
  local_api_key: string;
  codex_bin: string;
  codex_model: string;
  codex_workdir: string;
  codex_sandbox: string;
  codex_extra_args: string[];
  app_server_bin: string;
  app_server_host: string;
  app_server_port_base: number;
  app_server_startup_timeout_ms: number;
  app_server_sticky_threads: boolean;
}

export function loadAgentConfig(): AgentConfig {
  let nodeID = envString("SUBI_NODE_ID");
  if (!nodeID) nodeID = envString("HOSTNAME", "seller-node");
  let upstreamMode = envString("SELLER_UPSTREAM_MODE").toLowerCase();
  const localBaseURL = envString("SELLER_LOCAL_BASE_URL").replace(/\/+$/, "");
  if (!upstreamMode) upstreamMode = localBaseURL ? "http" : "codex-exec";
  upstreamMode = normalizeUpstreamMode(upstreamMode);
  const workerCount = envInt("SELLER_CODEX_WORKERS", envInt("SELLER_WORKERS", 1));
  const codexBin = envString("SELLER_CODEX_BIN", "codex");
  const appServerListen = appServerListenConfig();
  return {
    gateway_ws_url: envString("SUBI_GATEWAY_WS_URL"),
    node_token: envString("SUBI_SELLER_NODE_TOKEN"),
    node_id: nodeID,
    upstream_mode: upstreamMode,
    worker_count: workerCount,
    worker_queue_len: Math.max(envInt("SELLER_WORKER_QUEUE_SIZE", workerCount), workerCount),
    local_base_url: localBaseURL,
    local_api_key: envString("SELLER_LOCAL_API_KEY"),
    codex_bin: codexBin,
    codex_model: envString("SELLER_CODEX_MODEL"),
    codex_workdir: envString("SELLER_CODEX_WORKDIR", `${Bun.env.TMPDIR || "/tmp"}/subi-codex-work`),
    codex_sandbox: envString("SELLER_CODEX_SANDBOX", "read-only"),
    codex_extra_args: splitArgs(envString("SELLER_CODEX_EXTRA_ARGS")),
    app_server_bin: firstNonEmpty(envString("SELLER_CODEX_APP_SERVER_BIN"), envString("SELLER_CODEX_SERVER_BIN"), codexBin),
    app_server_host: appServerListen.host,
    app_server_port_base: appServerListen.port,
    app_server_startup_timeout_ms: envInt("SELLER_CODEX_APP_SERVER_STARTUP_TIMEOUT_MS", 15_000),
    app_server_sticky_threads: envBool("SELLER_CODEX_APP_SERVER_STICKY_THREADS", true),
  };
}

export function validateAgentConfig(cfg: AgentConfig): void {
  if (!cfg.gateway_ws_url) throw new Error("SUBI_GATEWAY_WS_URL is required");
  if (!cfg.node_token) throw new Error("SUBI_SELLER_NODE_TOKEN is required");
  if (!cfg.node_id) throw new Error("SUBI_NODE_ID or hostname is required");
  if (cfg.worker_count <= 0) throw new Error("SELLER_CODEX_WORKERS or SELLER_WORKERS must be greater than 0");
  if (cfg.worker_queue_len <= 0) throw new Error("SELLER_WORKER_QUEUE_SIZE must be greater than 0");
  switch (cfg.upstream_mode) {
    case "http":
      if (!cfg.local_base_url) throw new Error("SELLER_LOCAL_BASE_URL is required for http mode");
      if (!cfg.local_api_key) throw new Error("SELLER_LOCAL_API_KEY is required for http mode");
      break;
    case "codex-exec":
      if (!cfg.codex_bin) throw new Error("SELLER_CODEX_BIN is required for codex mode");
      if (!cfg.codex_workdir) throw new Error("SELLER_CODEX_WORKDIR is required for codex mode");
      break;
    case "codex-app-server":
      if (!cfg.app_server_bin) throw new Error("SELLER_CODEX_APP_SERVER_BIN or SELLER_CODEX_BIN is required for codex-app-server mode");
      if (!cfg.app_server_host) throw new Error("SELLER_CODEX_APP_SERVER_HOST is required for codex-app-server mode");
      if (cfg.app_server_port_base <= 0) throw new Error("SELLER_CODEX_APP_SERVER_PORT_BASE must be greater than 0");
      if (!cfg.codex_workdir) throw new Error("SELLER_CODEX_WORKDIR is required for codex-app-server mode");
      if (cfg.app_server_startup_timeout_ms <= 0) throw new Error("SELLER_CODEX_APP_SERVER_STARTUP_TIMEOUT_MS must be greater than 0");
      break;
    default:
      throw new Error(`SELLER_UPSTREAM_MODE must be codex-exec, codex-app-server, or http, got ${JSON.stringify(cfg.upstream_mode)}`);
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
        app_server_sticky_threads: cfg.app_server_sticky_threads,
        app_server_port_base: cfg.app_server_port_base,
        app_server_startup_timeout_ms: cfg.app_server_startup_timeout_ms,
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
  signal?.addEventListener("abort", () => ws.close());

  const heartbeat = setInterval(() => {
    if (closed || ws.readyState !== WebSocket.OPEN) return;
    sendEnvelope(socket, {
      type: subiEnvelopeHeartbeat,
      node_id: cfg.node_id,
      meta: {
        upstream_mode: cfg.upstream_mode,
        worker_count: cfg.worker_count,
        app_server_sticky_threads: cfg.app_server_sticky_threads,
      },
    });
  }, 15_000);

  async function pump(): Promise<void> {
    while (!closed && requests.length > 0) {
      const worker = workers.find((candidate) => !candidate.active);
      if (!worker) return;
      const env = requests.shift()!;
      worker.active = true;
      void handleRequest(cfg, socket, env, worker.appServer)
        .catch((error) => sendAgentError(socket, env.request_id || "", String(error)))
        .finally(() => {
          worker.active = false;
          void pump();
        });
    }
  }

  await closedPromise;
  clearInterval(heartbeat);
  await closeAgentWorkers(workers);
}

interface AgentWorkerState {
  id: number;
  active: boolean;
  appServer?: CodexAppServerUpstream;
}

async function startAgentWorkers(cfg: AgentConfig): Promise<AgentWorkerState[]> {
  const workers: AgentWorkerState[] = [];
  try {
    for (let i = 0; i < cfg.worker_count; i++) {
      const worker: AgentWorkerState = { id: i + 1, active: false };
      if (cfg.upstream_mode === "codex-app-server") {
        worker.appServer = new CodexAppServerUpstream(cfg, worker.id);
        await worker.appServer.ensure();
      }
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
  await Promise.all(workers.map((worker) => worker.appServer?.close()));
}

export async function handleRequest(cfg: AgentConfig, socket: JSONSocket, env: SubiEnvelope, appServer?: CodexAppServerUpstream): Promise<void> {
  switch (cfg.upstream_mode) {
    case "http":
      await handleHTTPUpstreamRequest(cfg, socket, env);
      return;
    case "codex-app-server":
      await handleCodexAppServerRequest(cfg, socket, env, appServer);
      return;
    default:
      await handleCodexExecRequest(cfg, socket, env);
  }
}

async function handleHTTPUpstreamRequest(cfg: AgentConfig, socket: JSONSocket, env: SubiEnvelope): Promise<void> {
  const url = `${cfg.local_base_url}${env.path || "/"}`;
  const headers = bagToFetchHeaders(env.headers);
  headers.delete("authorization");
  headers.delete("x-api-key");
  headers.delete("x-goog-api-key");
  headers.delete("cookie");
  headers.set("Authorization", `Bearer ${cfg.local_api_key}`);
  if (!headers.get("Content-Type")) headers.set("Content-Type", "application/json");

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: env.method || "POST",
      headers,
      body: env.body ? Buffer.from(env.body) : undefined,
    });
  } catch (error) {
    sendAgentError(socket, env.request_id || "", `local request failed: ${error}`);
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
  const data = new Uint8Array(await resp.arrayBuffer());
  if (data.length > 0) {
    sendEnvelope(socket, { type: subiEnvelopeResponseChunk, request_id: env.request_id, data });
  }
  sendEnvelope(socket, { type: subiEnvelopeResponseEnd, request_id: env.request_id });
}

async function handleCodexAppServerRequest(cfg: AgentConfig, socket: JSONSocket, env: SubiEnvelope, upstream?: CodexAppServerUpstream): Promise<void> {
  if (!upstream) {
    sendAgentError(socket, env.request_id || "", "codex app-server upstream is not initialized");
    return;
  }
  try {
    await upstream.ensure();
  } catch (error) {
    sendAgentError(socket, env.request_id || "", `codex app-server unavailable: ${error}`);
    return;
  }
  let prompt: string;
  try {
    prompt = promptFromRequestBody(env.body ?? new Uint8Array(), env.path || "");
  } catch (error) {
    sendAgentError(socket, env.request_id || "", `parse request body: ${error}`);
    return;
  }

  if (env.stream) {
    await handleCodexAppServerStreamingRequest(cfg, socket, env, upstream, prompt);
    return;
  }

  let text: string;
  try {
    text = await upstream.runPrompt(trim(env.session_hash), prompt, requestTimeoutMS(env));
  } catch (error) {
    await upstream.close();
    sendAgentError(socket, env.request_id || "", `codex app-server failed: ${error}`);
    return;
  }
  const { body, contentType } = codexExecResponseBody(env, text);
  sendEnvelope(socket, {
    type: subiEnvelopeResponseStart,
    request_id: env.request_id,
    status_code: 200,
    headers: { "Content-Type": [contentType], "X-Subi-Upstream-Mode": [cfg.upstream_mode] },
  });
  if (body.length > 0) sendEnvelope(socket, { type: subiEnvelopeResponseChunk, request_id: env.request_id, data: body });
  sendEnvelope(socket, { type: subiEnvelopeResponseEnd, request_id: env.request_id });
}

async function handleCodexAppServerStreamingRequest(cfg: AgentConfig, socket: JSONSocket, env: SubiEnvelope, upstream: CodexAppServerUpstream, prompt: string): Promise<void> {
  sendEnvelope(socket, {
    type: subiEnvelopeResponseStart,
    request_id: env.request_id,
    status_code: 200,
    headers: {
      "Content-Type": ["text/event-stream"],
      "Cache-Control": ["no-cache"],
      "X-Accel-Buffering": ["no"],
      "X-Subi-Upstream-Mode": [cfg.upstream_mode],
    },
  });
  let bytesSent = 0;
  const sendChunk = (data: Uint8Array) => {
    if (data.length === 0) return;
    bytesSent += data.length;
    sendEnvelope(socket, { type: subiEnvelopeResponseChunk, request_id: env.request_id, data });
  };
  sendChunk(codexStreamPrelude(env));
  try {
    const text = await upstream.runPrompt(trim(env.session_hash), prompt, requestTimeoutMS(env), (delta) => {
      sendChunk(codexStreamDelta(env, delta));
    });
    sendChunk(codexStreamDone(env, text));
  } catch (error) {
    await upstream.close();
    sendAgentError(socket, env.request_id || "", `codex app-server failed: ${error}`);
    return;
  }
  sendEnvelope(socket, { type: subiEnvelopeResponseEnd, request_id: env.request_id, meta: { bytes: bytesSent, status_code: 200 } });
}

async function handleCodexExecRequest(cfg: AgentConfig, socket: JSONSocket, env: SubiEnvelope): Promise<void> {
  let prompt: string;
  try {
    prompt = promptFromRequestBody(env.body ?? new Uint8Array(), env.path || "");
  } catch (error) {
    sendAgentError(socket, env.request_id || "", `parse request body: ${error}`);
    return;
  }
  let text: string;
  try {
    text = await runCodexExec(cfg, prompt);
  } catch (error) {
    sendAgentError(socket, env.request_id || "", `codex exec failed: ${error}`);
    return;
  }
  const { body, contentType } = codexExecResponseBody(env, text);
  sendEnvelope(socket, {
    type: subiEnvelopeResponseStart,
    request_id: env.request_id,
    status_code: 200,
    headers: { "Content-Type": [contentType], "X-Subi-Upstream-Mode": [cfg.upstream_mode] },
  });
  if (body.length > 0) sendEnvelope(socket, { type: subiEnvelopeResponseChunk, request_id: env.request_id, data: body });
  sendEnvelope(socket, { type: subiEnvelopeResponseEnd, request_id: env.request_id });
}

async function runCodexExec(cfg: AgentConfig, prompt: string): Promise<string> {
  await mkdir(cfg.codex_workdir, { recursive: true });
  await Bun.write(`${cfg.codex_workdir}/.subi-keep`, "");
  const outputPath = `${cfg.codex_workdir}/subi-codex-${crypto.randomUUID()}.txt`;
  const args = ["exec", "--skip-git-repo-check", "--sandbox", cfg.codex_sandbox, "--color", "never", "--output-last-message", outputPath];
  if (cfg.codex_model) args.push("--model", cfg.codex_model);
  args.push(...cfg.codex_extra_args, prompt);
  const proc = Bun.spawn([cfg.codex_bin, ...args], {
    cwd: cfg.codex_workdir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  try {
    if (code !== 0) throw new Error(trim(stderr) || `codex exited with ${code}`);
    const lastMessage = trim(await Bun.file(outputPath).text().catch(() => ""));
    if (lastMessage) return lastMessage;
    return trim(stdout).split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  } finally {
    await rm(outputPath, { force: true }).catch(() => undefined);
  }
}

interface AppServerMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { code?: number; message?: string; data?: unknown };
}

export class CodexAppServerUpstream {
  private port: number;
  private wsURL = "";
  private proc?: Bun.Subprocess;
  private socket?: WebSocket;
  private nextID = 1;
  private threads = new Map<string, string>();
  private messages: AppServerMessage[] = [];
  private waiters: Array<(msg: AppServerMessage) => void> = [];
  private processExited = false;

  constructor(
    private readonly cfg: AgentConfig,
    private readonly workerID: number,
  ) {
    this.port = cfg.app_server_port_base + workerID - 1;
  }

  async ensure(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN && this.proc && !this.processExited) return;
    await this.close();
    await this.start();
  }

  async runPrompt(sessionHash: string, prompt: string, timeoutMS: number, onDelta?: (delta: string) => void): Promise<string> {
    await this.ensure();
    const deadline = Date.now() + timeoutMS;
    const threadID = await this.threadID(sessionHash, deadline);
    let finalText = "";
    let completed = false;
    let completionError = "";
    const handleNotification = (msg: AppServerMessage) => {
      switch (msg.method) {
        case "item/agentMessage/delta": {
          const delta = trim(msg.params?.delta);
          if (delta) {
            finalText += delta;
            onDelta?.(delta);
          }
          break;
        }
        case "item/completed": {
          const item = msg.params?.item;
          const type = trim(item?.type);
          const text = trim(item?.text);
          if (!finalText && (type === "agentMessage" || type === "agent_message") && text) {
            finalText += text;
            onDelta?.(text);
          }
          break;
        }
        case "turn/completed":
          completed = true;
          completionError = codexTurnCompletionError(msg.params);
          break;
        case "error":
          completionError = appServerErrorNotificationMessage(msg.params) || "codex app-server error";
          completed = true;
          break;
      }
    };

    await this.rpc(
      "turn/start",
      {
        threadId: threadID,
        cwd: this.cfg.codex_workdir,
        approvalPolicy: "never",
        input: [{ type: "text", text: prompt, text_elements: [] }],
      },
      deadline,
      handleNotification,
    );
    while (!completed) {
      const msg = await this.readMessage(deadline);
      if (msg.method) handleNotification(msg);
    }
    if (completionError) throw new Error(completionError);
    if (!trim(finalText)) throw new Error("codex app-server returned no final message");
    return finalText;
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = undefined;
    if (socket && socket.readyState === WebSocket.OPEN) socket.close();
    const proc = this.proc;
    this.proc = undefined;
    this.processExited = false;
    this.messages = [];
    this.threads.clear();
    while (this.waiters.length > 0) this.waiters.shift()?.({ method: "error", params: { message: "codex app-server closed" } });
    if (!proc) return;
    proc.kill("SIGTERM");
    const exited = await Promise.race([proc.exited.then(() => true), delay(2000).then(() => false)]);
    if (!exited) proc.kill("SIGKILL");
    await proc.exited.catch(() => undefined);
  }

  private async start(): Promise<void> {
    await mkdir(this.cfg.codex_workdir, { recursive: true });
    this.port = await findAvailableAppServerPort(this.cfg.app_server_host, this.port);
    const addr = `${this.cfg.app_server_host}:${this.port}`;
    this.wsURL = `ws://${addr}`;
    const proc = Bun.spawn([this.cfg.app_server_bin, "app-server", "--listen", this.wsURL], {
      cwd: this.cfg.codex_workdir,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    });
    this.proc = proc;
    void proc.exited.then(() => {
      this.processExited = true;
    });

    try {
      await waitForAppServerReady(addr, this.cfg.app_server_startup_timeout_ms, proc);
      await this.connect(this.cfg.app_server_startup_timeout_ms);
      await this.initialize(Date.now() + this.cfg.app_server_startup_timeout_ms);
      console.error(`codex app-server ready: worker=${this.workerID} url=${this.wsURL}`);
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  private async connect(timeoutMS: number): Promise<void> {
    const ws = new WebSocket(this.wsURL);
    this.socket = ws;
    ws.addEventListener("message", (event) => {
      const raw = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer);
      let msg: AppServerMessage;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      const waiter = this.waiters.shift();
      if (waiter) waiter(msg);
      else this.messages.push(msg);
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("connect codex app-server websocket timed out")), timeoutMS);
      ws.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      ws.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("connect codex app-server websocket failed"));
        },
        { once: true },
      );
    });
  }

  private async initialize(deadline: number): Promise<void> {
    await this.rpc(
      "initialize",
      {
        clientInfo: { name: "subi-seller-agent", version: sellerAgentVersion },
        capabilities: { experimentalApi: true },
      },
      deadline,
    );
    this.notify("initialized");
  }

  private async threadID(sessionHash: string, deadline: number): Promise<string> {
    const key = this.cfg.app_server_sticky_threads ? trim(sessionHash) : "";
    if (key) {
      const existing = this.threads.get(key);
      if (existing) return existing;
    }
    const threadID = await this.startThread(deadline);
    if (key) this.threads.set(key, threadID);
    return threadID;
  }

  private async startThread(deadline: number): Promise<string> {
    const params: Record<string, unknown> = {
      cwd: this.cfg.codex_workdir,
      ephemeral: true,
      approvalPolicy: "never",
    };
    if (this.cfg.codex_model) params.model = this.cfg.codex_model;
    if (this.cfg.codex_sandbox) params.sandbox = this.cfg.codex_sandbox;
    const result = await this.rpc("thread/start", params, deadline);
    const threadID = trim(result?.thread?.id);
    if (!threadID) throw new Error(`codex thread response missing id: ${JSON.stringify(result)}`);
    return threadID;
  }

  private async rpc(method: string, params: unknown, deadline: number, onNotification?: (msg: AppServerMessage) => void): Promise<any> {
    const id = this.nextID++;
    this.writeJSON({ jsonrpc: "2.0", id, method, params });
    while (true) {
      const msg = await this.readMessage(deadline);
      if (appServerMessageID(msg.id) === id && !msg.method) {
        if (msg.error) throw new Error(appServerRPCErrorMessage(msg.error));
        return msg.result;
      }
      if (msg.id !== undefined && msg.method) {
        this.rejectServerRequest(msg);
        continue;
      }
      if (msg.method) onNotification?.(msg);
    }
  }

  private notify(method: string, params?: unknown): void {
    const payload: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) payload.params = params;
    this.writeJSON(payload);
  }

  private rejectServerRequest(msg: AppServerMessage): void {
    this.writeJSON({
      jsonrpc: "2.0",
      id: msg.id,
      error: {
        code: -32601,
        message: "Subi seller-agent does not implement Codex app-server server requests",
      },
    });
  }

  private writeJSON(payload: unknown): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error("codex app-server websocket is not connected");
    this.socket.send(JSON.stringify(payload));
  }

  private async readMessage(deadline: number): Promise<AppServerMessage> {
    while (true) {
      const msg = this.messages.shift();
      if (msg) return msg;
      if (!this.socket || this.socket.readyState === WebSocket.CLOSED) throw new Error("codex app-server websocket is not connected");
      const ms = deadline - Date.now();
      if (ms <= 0) throw new Error("codex app-server request timed out");
      const next = await new Promise<AppServerMessage | undefined>((resolve) => {
        const timer = setTimeout(() => resolve(undefined), ms);
        this.waiters.push((value) => {
          clearTimeout(timer);
          resolve(value);
        });
      });
      if (next) return next;
    }
  }
}

export function promptFromRequestBody(body: Uint8Array, path: string): string {
  const payload = safeJSONParse<any>(body);
  if (!payload) throw new Error("invalid JSON body");
  if (payload?.metadata?.subi_context_injected && Array.isArray(payload.input)) {
    return payload.input.map((item: any) => `${item.role || "user"}: ${cleanJoinedText(item.content)}`).join("\n\n");
  }
  if (isResponsesPath(path)) return cleanJoinedText(payload.input ?? payload.prompt);
  if (isChatCompletionsPath(path) || isAnthropicMessagesPath(path)) return cleanJoinedText(payload.messages ?? payload.prompt);
  return cleanJoinedText(payload.input ?? payload.messages ?? payload.prompt ?? payload);
}

export function codexExecResponseBody(env: SubiEnvelope, text: string): { body: Uint8Array; contentType: string } {
  const path = env.path || "";
  const stream = Boolean(env.stream);
  if (stream) {
    if (isChatCompletionsPath(path)) {
      return bytes(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, index: 0 }] })}\n\ndata: [DONE]\n\n`, "text/event-stream");
    }
    if (isAnthropicMessagesPath(path)) {
      return bytes(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text } })}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`, "text/event-stream");
    }
    return bytes(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\ndata: [DONE]\n\n`, "text/event-stream");
  }
  if (isChatCompletionsPath(path)) {
    return bytes(
      JSON.stringify({ id: "chatcmpl_subi_codex_exec", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] }),
      "application/json",
    );
  }
  if (isAnthropicMessagesPath(path)) {
    return bytes(JSON.stringify({ id: "msg_subi_codex_exec", type: "message", role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn" }), "application/json");
  }
  return bytes(
    JSON.stringify({
      id: "resp_subi_codex_exec",
      object: "response",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
      output_text: text,
    }),
    "application/json",
  );
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
    case "app-server":
    case "codex-server":
    case "codex_app_server":
    case "codex-appserver":
      return "codex-app-server";
    default:
      return value;
  }
}

function appServerListenConfig(): { host: string; port: number } {
  let host = envString("SELLER_CODEX_APP_SERVER_HOST", "127.0.0.1");
  let port = envInt("SELLER_CODEX_APP_SERVER_PORT_BASE", 19100);
  const listenBase = envString("SELLER_CODEX_SERVER_LISTEN_BASE");
  if (listenBase) {
    try {
      if (listenBase.includes("://")) {
        const parsed = new URL(listenBase);
        if (parsed.hostname) host = parsed.hostname;
        if (parsed.port) port = Number.parseInt(parsed.port, 10) || port;
      } else {
        const idx = listenBase.lastIndexOf(":");
        if (idx > -1) {
          host = listenBase.slice(0, idx) || host;
          port = Number.parseInt(listenBase.slice(idx + 1), 10) || port;
        }
      }
    } catch {
      // Keep explicit env defaults when the compatibility listen value is malformed.
    }
  }
  return { host, port };
}

function firstNonEmpty(...values: string[]): string {
  for (const value of values) {
    const cleaned = trim(value);
    if (cleaned) return cleaned;
  }
  return "";
}

function splitArgs(value: string): string[] {
  return trim(value).split(/\s+/).filter(Boolean);
}

function requestTimeoutMS(env: SubiEnvelope): number {
  return env.timeout_ms && env.timeout_ms > 0 ? env.timeout_ms : 600_000;
}

async function findAvailableAppServerPort(host: string, startPort: number): Promise<number> {
  for (let port = startPort; port < startPort + 100; port++) {
    if (await canListen(host, port)) return port;
  }
  throw new Error(`no available codex app-server port near ${host}:${startPort}`);
}

function canListen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

async function waitForAppServerReady(addr: string, timeoutMS: number, proc: Bun.Subprocess): Promise<void> {
  const deadline = Date.now() + timeoutMS;
  while (Date.now() < deadline) {
    if (await processExited(proc)) throw new Error("codex app-server exited during startup");
    for (const path of ["/readyz", "/healthz"]) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 300);
      try {
        const resp = await fetch(`http://${addr}${path}`, { signal: controller.signal });
        resp.body?.cancel().catch(() => undefined);
        if (resp.status >= 200 && resp.status < 500) return;
      } catch {
        // Retry until startup timeout.
      } finally {
        clearTimeout(timer);
      }
    }
    await delay(100);
  }
  throw new Error("codex app-server did not become ready");
}

async function processExited(proc: Bun.Subprocess): Promise<boolean> {
  return await Promise.race([proc.exited.then(() => true), delay(0).then(() => false)]);
}

function appServerMessageID(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function appServerRPCErrorMessage(error: { code?: number; message?: string; data?: unknown }): string {
  const message = trim(error.message) || "codex app-server rpc error";
  if (error.data !== undefined) return `codex app-server rpc error ${error.code ?? ""}: ${message}: ${JSON.stringify(error.data)}`;
  return `codex app-server rpc error ${error.code ?? ""}: ${message}`;
}

function codexTurnCompletionError(params: any): string {
  const turn = params?.turn ?? {};
  const message = trim(turn?.error?.message);
  if (message) return message;
  const status = appServerStatusString(turn?.status);
  if (status && status !== "completed") return `codex turn ended with status ${status}`;
  return "";
}

function appServerStatusString(value: unknown): string {
  if (typeof value === "string") return trim(value);
  if (typeof value === "object" && value !== null) return trim((value as any).type);
  return "";
}

function appServerErrorNotificationMessage(params: any): string {
  return trim(params?.message) || trim(params?.error?.message);
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
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, any>;
    for (const key of ["text", "input_text", "output_text", "content", "message", "messages", "input"]) {
      if (key in obj) collectText(obj[key], parts);
    }
  }
}

function isResponsesPath(path: string): boolean {
  const clean = path.split("?")[0] ?? path;
  return clean === "/v1/responses" || clean === "/responses" || clean === "/backend-api/codex/responses" || clean.startsWith("/v1/responses/") || clean.startsWith("/responses/") || clean.startsWith("/backend-api/codex/responses/");
}

function isChatCompletionsPath(path: string): boolean {
  const clean = path.split("?")[0] ?? path;
  return clean === "/v1/chat/completions" || clean === "/chat/completions";
}

function isAnthropicMessagesPath(path: string): boolean {
  const clean = path.split("?")[0] ?? path;
  return clean === "/v1/messages" || clean === "/messages";
}

function bytes(text: string, contentType: string): { body: Uint8Array; contentType: string } {
  return { body: new TextEncoder().encode(text), contentType };
}

function codexStreamPrelude(env: SubiEnvelope): Uint8Array {
  if (isChatCompletionsPath(env.path || "")) return encodeSSEData(chatCompletionStreamChunk(env.request_id || "", { role: "assistant" }, null));
  const responseID = `resp_${env.request_id || ""}`;
  const messageID = `msg_${env.request_id || ""}`;
  return bytes(
    `${sseEvent("response.created", { type: "response.created", response: responseJSON(env.request_id || "", "") })}` +
      `${sseEvent("response.output_item.added", { type: "response.output_item.added", response_id: responseID, output_index: 0, item: { id: messageID, type: "message", status: "in_progress", role: "assistant", content: [] } })}` +
      `${sseEvent("response.content_part.added", { type: "response.content_part.added", response_id: responseID, item_id: messageID, output_index: 0, content_index: 0, part: { type: "output_text", text: "" } })}`,
    "text/event-stream",
  ).body;
}

function codexStreamDelta(env: SubiEnvelope, delta: string): Uint8Array {
  if (isChatCompletionsPath(env.path || "")) return encodeSSEData(chatCompletionStreamChunk(env.request_id || "", { content: delta }, null));
  const responseID = `resp_${env.request_id || ""}`;
  const messageID = `msg_${env.request_id || ""}`;
  return bytes(sseEvent("response.output_text.delta", { type: "response.output_text.delta", response_id: responseID, item_id: messageID, output_index: 0, content_index: 0, delta }), "text/event-stream").body;
}

function codexStreamDone(env: SubiEnvelope, text: string): Uint8Array {
  if (isChatCompletionsPath(env.path || "")) return bytes(`${sseData(chatCompletionStreamChunk(env.request_id || "", {}, "stop"))}data: [DONE]\n\n`, "text/event-stream").body;
  const responseID = `resp_${env.request_id || ""}`;
  const messageID = `msg_${env.request_id || ""}`;
  return bytes(
    `${sseEvent("response.output_text.done", { type: "response.output_text.done", response_id: responseID, item_id: messageID, output_index: 0, content_index: 0, text })}` +
      `${sseEvent("response.content_part.done", { type: "response.content_part.done", response_id: responseID, item_id: messageID, output_index: 0, content_index: 0, part: { type: "output_text", text } })}` +
      `${sseEvent("response.output_item.done", { type: "response.output_item.done", response_id: responseID, output_index: 0, item: { id: messageID, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] } })}` +
      `${sseEvent("response.completed", { type: "response.completed", response: responseJSON(env.request_id || "", text) })}` +
      "data: [DONE]\n\n",
    "text/event-stream",
  ).body;
}

function responseJSON(requestID: string, text: string): Record<string, unknown> {
  return {
    id: `resp_${requestID}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: "subi-codex-subscription",
    output: [
      {
        id: `msg_${requestID}`,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    output_text: text,
  };
}

function chatCompletionStreamChunk(requestID: string, delta: Record<string, unknown>, finishReason: string | null): Record<string, unknown> {
  return {
    id: `chatcmpl_${requestID}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "subi-codex-subscription",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function sseEvent(event: string, payload: unknown): string {
  return `event: ${event}\n${sseData(payload)}`;
}

function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function encodeSSEData(payload: unknown): Uint8Array {
  return bytes(sseData(payload), "text/event-stream").body;
}
