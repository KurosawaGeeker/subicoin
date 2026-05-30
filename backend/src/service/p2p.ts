import { delay, trim } from "../utils";

export const subiEnvelopeAgentHello = "agent_hello";
export const subiEnvelopeHeartbeat = "heartbeat";
export const subiEnvelopeRequestStart = "request_start";
export const subiEnvelopeResponseStart = "response_start";
export const subiEnvelopeResponseChunk = "response_chunk";
export const subiEnvelopeResponseEnd = "response_end";
export const subiEnvelopeResponseError = "response_error";

export const defaultSubiAgentStaleAfterMS = 45_000;
export const defaultSubiRequestTimeoutMS = 600_000;

export class SubiP2PError extends Error {
  constructor(readonly code: "no_available_node" | "agent_busy", message: string) {
    super(message);
  }
}

export const errNoAvailableNode = () => new SubiP2PError("no_available_node", "subi p2p: no available seller node");
export const errAgentBusy = () => new SubiP2PError("agent_busy", "subi p2p: seller node is busy");

export interface SubiEnvelope {
  type: string;
  node_id?: string;
  version?: string;
  max_concurrency?: number;
  request_id?: string;
  method?: string;
  path?: string;
  headers?: HeaderBag;
  body?: Uint8Array;
  stream?: boolean;
  timeout_ms?: number;
  session_hash?: string;
  status_code?: number;
  data?: Uint8Array;
  error?: string;
  meta?: Record<string, unknown>;
}

export type HeaderBag = Record<string, string[]>;

export interface SubiP2PRequest {
  request_id: string;
  method: string;
  path: string;
  headers: HeaderBag;
  body: Uint8Array;
  stream: boolean;
  session_id?: string;
  session_hash?: string;
  previous_seller_node?: string;
  timeout_ms?: number;
}

export interface SubiP2PResponseEvent {
  request_id: string;
  type: string;
  status_code?: number;
  headers?: HeaderBag;
  data?: Uint8Array;
  error?: string;
  node_id: string;
}

export interface SubiP2PDispatch {
  request_id: string;
  node_id: string;
  previous_seller_node: string;
  session_migrated: boolean;
  events: AsyncQueue<SubiP2PResponseEvent>;
  done: () => void;
}

export interface SubiSellerNodeHooks {
  authNode?: (nodeID: string) => Promise<void> | void;
  onNodeRegistered?: (nodeID: string) => Promise<void> | void;
  onNodeHeartbeat?: (nodeID: string) => Promise<void> | void;
  onNodeDisconnected?: (nodeID: string) => Promise<void> | void;
}

export interface JSONSocket {
  send(data: string): void | number;
  close(code?: number, reason?: string): void;
}

interface SellerNode {
  id: string;
  version: string;
  upstreamMode: string;
  maxConcurrency: number;
  socket?: JSONSocket;
  lastSeen: number;
  activeRequests: Set<string>;
}

interface RequestState {
  queue: AsyncQueue<SubiP2PResponseEvent>;
  closed: boolean;
}

interface SocketState {
  hooks: SubiSellerNodeHooks;
  nodeID: string;
  authenticated: boolean;
}

export class SubiSellerNodeRegistry {
  private nodes = new Map<string, SellerNode>();
  private sticky = new Map<string, string>();
  private requests = new Map<string, RequestState>();
  private sockets = new WeakMap<JSONSocket, SocketState>();

  registerNodeForTest(node: { id: string; maxConcurrency?: number; lastSeen?: number; upstreamMode?: string }): void {
    this.registerNode({
      id: node.id,
      version: "test",
      upstreamMode: node.upstreamMode ?? "codex-login",
      maxConcurrency: node.maxConcurrency ?? 1,
      lastSeen: node.lastSeen ?? Date.now(),
      activeRequests: new Set(),
    });
  }

  unregisterNodeForTest(nodeID: string): void {
    this.unregisterNode(nodeID);
  }

  reserveNodeForTest(sessionHash: string, requestID: string): { nodeID: string; previousNodeID: string } {
    const result = this.reserveNode(sessionHash, requestID);
    return { nodeID: result.node.id, previousNodeID: result.previousNodeID };
  }

  releaseRequestForTest(nodeID: string, requestID: string): void {
    this.releaseRequest(nodeID, requestID);
  }

  stickyNodeForTest(sessionHash: string): string {
    return this.sticky.get(sessionHash) ?? "";
  }

  attachSocket(socket: JSONSocket, hooks: SubiSellerNodeHooks = {}): void {
    this.sockets.set(socket, { hooks, nodeID: "", authenticated: false });
  }

  async handleSocketMessage(socket: JSONSocket, raw: string | Uint8Array): Promise<void> {
    const state = this.sockets.get(socket);
    if (!state) return;
    const env = decodeEnvelope(raw);
    if (!state.authenticated) {
      if (env.type !== subiEnvelopeAgentHello) {
        socket.close(1008, `first seller agent envelope must be ${subiEnvelopeAgentHello}`);
        return;
      }
      const nodeID = trim(env.node_id);
      if (!nodeID) {
        socket.close(1008, "seller agent node_id is required");
        return;
      }
      try {
        await state.hooks.authNode?.(nodeID);
      } catch {
        socket.close(1008, "seller agent auth failed");
        return;
      }
      state.authenticated = true;
      state.nodeID = nodeID;
      this.registerNode({
        id: nodeID,
        version: trim(env.version),
        upstreamMode: trim(env.meta?.upstream_mode),
        maxConcurrency: env.max_concurrency && env.max_concurrency > 0 ? env.max_concurrency : 1,
        socket,
        lastSeen: Date.now(),
        activeRequests: new Set(),
      });
      await state.hooks.onNodeRegistered?.(nodeID);
      return;
    }

    switch (env.type) {
      case subiEnvelopeHeartbeat:
        this.touchNode(state.nodeID);
        await state.hooks.onNodeHeartbeat?.(state.nodeID);
        break;
      case subiEnvelopeResponseStart:
      case subiEnvelopeResponseChunk:
      case subiEnvelopeResponseEnd:
      case subiEnvelopeResponseError:
        this.deliverAgentEvent(state.nodeID, env);
        break;
      default:
        break;
    }
  }

  async handleSocketClose(socket: JSONSocket): Promise<void> {
    const state = this.sockets.get(socket);
    if (!state) return;
    this.sockets.delete(socket);
    if (state.nodeID) {
      this.unregisterNode(state.nodeID);
      await state.hooks.onNodeDisconnected?.(state.nodeID);
    }
  }

  dispatch(req: SubiP2PRequest): SubiP2PDispatch {
    const timeout = req.timeout_ms && req.timeout_ms > 0 ? req.timeout_ms : defaultSubiRequestTimeoutMS;
    const requestID = trim(req.request_id) || newSubiP2PRequestID();
    const state: RequestState = { queue: new AsyncQueue<SubiP2PResponseEvent>(), closed: false };
    const reservation = this.reserveNode(trim(req.session_hash), requestID);
    const node = reservation.node;
    this.requests.set(requestID, state);

    const done = once(() => this.releaseRequest(node.id, requestID));
    const previousNodeID = trim(req.previous_seller_node) || reservation.previousNodeID;
    const env: SubiEnvelope = {
      type: subiEnvelopeRequestStart,
      request_id: requestID,
      method: req.method,
      path: req.path,
      headers: req.headers,
      body: req.body,
      stream: req.stream,
      timeout_ms: timeout,
      session_hash: trim(req.session_hash),
    };
    if (trim(req.session_id) || previousNodeID) {
      env.meta = {
        session_id: trim(req.session_id),
        previous_seller_node: previousNodeID,
        session_migrated: previousNodeID !== "" && previousNodeID !== node.id,
      };
    }

    try {
      if (!node.socket) throw new Error("seller node socket is not connected");
      sendEnvelope(node.socket, env);
    } catch (error) {
      done();
      throw error;
    }

    void (async () => {
      await delay(timeout);
      this.failRequest(node.id, requestID, "seller agent request timeout");
    })();

    return {
      request_id: requestID,
      node_id: node.id,
      previous_seller_node: previousNodeID,
      session_migrated: previousNodeID !== "" && previousNodeID !== node.id,
      events: state.queue,
      done,
    };
  }

  private registerNode(node: SellerNode): void {
    prepareSellerNode(node);
    const old = this.nodes.get(node.id);
    if (old?.socket && old.socket !== node.socket) {
      old.socket.close();
    }
    this.nodes.set(node.id, node);
  }

  private unregisterNode(nodeID: string): void {
    const node = this.nodes.get(nodeID);
    this.nodes.delete(nodeID);
    for (const [session, stickyNodeID] of [...this.sticky.entries()]) {
      if (stickyNodeID === nodeID) this.sticky.delete(session);
    }
    const states = new Map<string, RequestState>();
    if (node) {
      for (const requestID of node.activeRequests) {
        const state = this.requests.get(requestID);
        if (state) states.set(requestID, state);
        this.requests.delete(requestID);
      }
    }
    for (const [requestID, state] of states) {
      state.queue.push({
        type: subiEnvelopeResponseError,
        error: "seller agent disconnected",
        node_id: nodeID,
        request_id: requestID,
      });
      state.queue.close();
    }
  }

  private touchNode(nodeID: string): void {
    const node = this.nodes.get(nodeID);
    if (node) node.lastSeen = Date.now();
  }

  private reserveNode(sessionHash: string, requestID: string): { node: SellerNode; previousNodeID: string } {
    const now = Date.now();
    let previousNodeID = "";
    if (sessionHash) {
      const stickyNodeID = this.sticky.get(sessionHash);
      if (stickyNodeID) {
        previousNodeID = stickyNodeID;
        const node = this.nodes.get(stickyNodeID);
        if (!node || now - node.lastSeen > defaultSubiAgentStaleAfterMS || !nodeDispatchable(node)) {
          this.sticky.delete(sessionHash);
        } else {
          if (!nodeHasCapacity(node)) throw errAgentBusy();
          reserveNodeRequest(node, requestID);
          return { node, previousNodeID };
        }
      }
    }

    for (const node of this.nodes.values()) {
      if (now - node.lastSeen > defaultSubiAgentStaleAfterMS || !nodeDispatchable(node) || !nodeHasCapacity(node)) continue;
      reserveNodeRequest(node, requestID);
      if (sessionHash) this.sticky.set(sessionHash, node.id);
      return { node, previousNodeID };
    }
    throw errNoAvailableNode();
  }

  private deliverAgentEvent(nodeID: string, env: SubiEnvelope): void {
    const requestID = trim(env.request_id);
    const state = this.requests.get(requestID);
    if (!state) return;
    state.queue.push({
      type: env.type,
      status_code: env.status_code,
      headers: env.headers,
      data: env.data,
      error: env.error,
      node_id: nodeID,
      request_id: requestID,
    });
    if (env.type === subiEnvelopeResponseEnd || env.type === subiEnvelopeResponseError) {
      this.releaseRequest(nodeID, requestID);
    }
  }

  private failRequest(nodeID: string, requestID: string, message: string): void {
    const state = this.requests.get(requestID);
    if (state) {
      state.queue.push({ type: subiEnvelopeResponseError, error: message, node_id: nodeID, request_id: requestID });
    }
    this.releaseRequest(nodeID, requestID);
  }

  private releaseRequest(nodeID: string, requestID: string): void {
    const state = this.requests.get(requestID);
    if (state) this.requests.delete(requestID);
    const node = this.nodes.get(nodeID);
    if (node) {
      node.activeRequests.delete(requestID);
      node.lastSeen = Date.now();
    }
    state?.queue.close();
  }
}

export class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private waits: Array<(value: IteratorResult<T>) => void> = [];
  private isClosed = false;

  push(value: T): void {
    if (this.isClosed) return;
    const waiter = this.waits.shift();
    if (waiter) {
      waiter({ value, done: false });
      return;
    }
    this.values.push(value);
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    while (this.waits.length > 0) {
      this.waits.shift()?.({ value: undefined as T, done: true });
    }
  }

  async next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return { value, done: false };
    if (this.isClosed) return { value: undefined as T, done: true };
    return new Promise((resolve) => this.waits.push(resolve));
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }
}

export let defaultSubiSellerNodeRegistry = new SubiSellerNodeRegistry();

export function resetDefaultSubiSellerNodeRegistry(): SubiSellerNodeRegistry {
  defaultSubiSellerNodeRegistry = new SubiSellerNodeRegistry();
  return defaultSubiSellerNodeRegistry;
}

export function newSubiP2PRequestID(): string {
  return `subi_${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
}

export function isSubiP2PEnabled(): boolean {
  const value = trim(Bun.env.SUBI_P2P_ENABLED).toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function sendEnvelope(socket: JSONSocket, env: SubiEnvelope): void {
  socket.send(JSON.stringify(serializeEnvelope(env)));
}

export function decodeEnvelope(raw: string | Uint8Array): SubiEnvelope {
  const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
  const parsed = JSON.parse(text) as Record<string, any>;
  return {
    ...parsed,
    type: trim(parsed.type),
    body: typeof parsed.body === "string" ? Buffer.from(parsed.body, "base64") : undefined,
    data: typeof parsed.data === "string" ? Buffer.from(parsed.data, "base64") : undefined,
  };
}

export function serializeEnvelope(env: SubiEnvelope): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value === "" || (typeof value === "number" && value === 0)) continue;
    if (key === "body" || key === "data") {
      out[key] = Buffer.from(value as Uint8Array).toString("base64");
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function headersToBag(headers: Headers): HeaderBag {
  const bag: HeaderBag = {};
  headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (["authorization", "x-api-key", "x-goog-api-key", "cookie", "host", "content-length", "connection"].includes(lower)) {
      return;
    }
    bag[key] = [value];
  });
  return bag;
}

export function bagToHeaders(bag?: HeaderBag): Headers {
  const headers = new Headers();
  for (const [key, values] of Object.entries(bag ?? {})) {
    if (["content-length", "connection", "transfer-encoding"].includes(key.toLowerCase())) continue;
    for (const value of values) headers.append(key, value);
  }
  return headers;
}

function prepareSellerNode(node: SellerNode): void {
  if (node.maxConcurrency <= 0) node.maxConcurrency = 1;
  node.activeRequests ??= new Set();
}

function nodeHasCapacity(node: SellerNode): boolean {
  prepareSellerNode(node);
  return node.activeRequests.size < node.maxConcurrency;
}

function nodeDispatchable(node: SellerNode): boolean {
  return node.upstreamMode === "codex-login";
}

function reserveNodeRequest(node: SellerNode, requestID: string): void {
  prepareSellerNode(node);
  node.activeRequests.add(requestID);
}

function once(fn: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    fn();
  };
}
