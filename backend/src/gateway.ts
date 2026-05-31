import { isStoreError } from "./errors";
import sellerInstallScript from "../cmd/subi-gateway/assets/install-seller.sh" with { type: "text" };
import sellerWindowsInstallScript from "../cmd/subi-gateway/assets/install-seller.ps1" with { type: "text" };
import { dirname, join } from "node:path";
import {
  bagToHeaders,
  defaultSubiSellerNodeRegistry,
  headersToBag,
  resetDefaultSubiSellerNodeRegistry,
  SubiP2PError,
  subiEnvelopeResponseChunk,
  subiEnvelopeResponseEnd,
  subiEnvelopeResponseError,
  subiEnvelopeResponseStart,
  type HeaderBag,
  type JSONSocket,
  type SubiP2PResponseEvent,
} from "./service/p2p";
import {
  buildSubiContextualRequestBody,
  extractSubiAssistantText,
  extractSubiSessionID,
  extractSubiUserText,
  isSubiSessionContextEligible,
  SubiSessionStore,
  subiSessionHash,
} from "./service/session";
import { creditMicrosPerCredit, Store, storeErrorStatus, type AuthenticatedBuyerKey, type SellerNode, type SellerSetupConfig, type User } from "./store";
import {
  apiError,
  clearCookieHeader,
  cookieValue,
  envBool,
  envInt,
  envString,
  jsonResponse,
  normalizeLimit,
  openAIError,
  parseAddr,
  requestBaseURL,
  requestWSURL,
  safeJSONParse,
  setCookieHeader,
  sha256Hex,
  trim,
} from "./utils";

const defaultAddr = "0.0.0.0:18080";
const defaultRequestTimeoutMS = 600_000;
const defaultMaxRequestBodyLen = 256 << 20;
const sellerDoctorExpected = "SUBI_SELLER_DOCTOR_OK";
const sellerDoctorTimeoutMS = 30_000;
const sellerDoctorModel = "gpt-5.5";

export interface GatewayConfig {
  addr: string;
  buyer_api_key: string;
  seller_node_token: string;
  db_path: string;
  dev_static_keys: boolean;
  public_gateway_ws_url: string;
  session_cookie_name: string;
  store?: Store;
  session_context_enabled: boolean;
  session_max_turns: number;
  session_max_chars: number;
  session_store: SubiSessionStore;
  request_cost_micros: number;
  seller_earning_micros: number;
  platform_fee_micros: number;
  reserve_micros: number;
  web_dir: string;
}

interface SocketData {
  hooks: {
    authNode?: (nodeID: string) => void;
    onNodeHeartbeat?: (nodeID: string) => void;
    onNodeDisconnected?: (nodeID: string) => void;
  };
}

type SellerDoctorStatus = "passed" | "failed" | "blocked";

interface SellerDoctorCheck {
  id: string;
  label: string;
  status: SellerDoctorStatus;
  message: string;
  code?: string;
}

interface SellerDoctorProbeResult {
  check: SellerDoctorCheck;
  status: SellerDoctorStatus;
  code?: string;
  next_action: string;
}

type SellerDoctorStrategy = (node: SellerNode) => Promise<SellerDoctorProbeResult>;

const sellerDoctorStrategies: Record<string, SellerDoctorStrategy> = {
  "codex-login": runCodexSellerDoctor,
};

export function loadGatewayConfig(): GatewayConfig {
  const dbPath = envString("SUBI_DB_PATH");
  const cfg: GatewayConfig = {
    addr: envString("SUBI_GATEWAY_ADDR", defaultAddr),
    buyer_api_key: envString("SUBI_BUYER_API_KEY"),
    seller_node_token: envString("SUBI_SELLER_NODE_TOKEN"),
    db_path: dbPath,
    dev_static_keys: envBool("SUBI_DEV_STATIC_KEYS"),
    public_gateway_ws_url: envString("SUBI_PUBLIC_GATEWAY_WS_URL"),
    session_cookie_name: envString("SUBI_SESSION_COOKIE_NAME", "subi_session"),
    session_context_enabled: envBool("SUBI_SESSION_CONTEXT_ENABLED"),
    session_max_turns: envInt("SUBI_SESSION_MAX_TURNS", 20),
    session_max_chars: envInt("SUBI_SESSION_MAX_CHARS", 20000),
    session_store: new SubiSessionStore(envInt("SUBI_SESSION_MAX_TURNS", 20), envInt("SUBI_SESSION_MAX_CHARS", 20000)),
    request_cost_micros: envInt("SUBI_FIXED_REQUEST_COST_MICROS", creditMicrosPerCredit),
    seller_earning_micros: envInt("SUBI_SELLER_EARNING_MICROS", 800_000),
    platform_fee_micros: envInt("SUBI_PLATFORM_FEE_MICROS", 150_000),
    reserve_micros: envInt("SUBI_RESERVE_MICROS", 50_000),
    web_dir: envString("SUBI_WEB_DIR", "web"),
  };
  if (dbPath) cfg.store = new Store(dbPath);
  validateGatewayConfig(cfg);
  return cfg;
}

export function validateGatewayConfig(cfg: GatewayConfig): void {
  if (!trim(cfg.addr)) throw new Error("SUBI_GATEWAY_ADDR is required");
  if (cfg.request_cost_micros <= 0) throw new Error("SUBI_FIXED_REQUEST_COST_MICROS must be positive");
  if (cfg.seller_earning_micros < 0 || cfg.platform_fee_micros < 0 || cfg.reserve_micros < 0) {
    throw new Error("SUBI settlement split values must be non-negative");
  }
  if (cfg.store && !cfg.dev_static_keys) return;
  if (!trim(cfg.buyer_api_key)) throw new Error("SUBI_BUYER_API_KEY is required");
  if (!trim(cfg.seller_node_token)) throw new Error("SUBI_SELLER_NODE_TOKEN is required");
}

export function createGatewayServer(cfg: GatewayConfig): Bun.Server<SocketData> {
  const addr = parseAddr(cfg.addr);
  return Bun.serve<SocketData>({
    hostname: addr.hostname,
    port: addr.port,
    async fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/api/v1/subi/seller/agent/ws") {
        return handleSellerAgentUpgrade(req, server, cfg);
      }
      return handleGatewayRequest(req, cfg);
    },
    websocket: {
      open(ws) {
        defaultSubiSellerNodeRegistry.attachSocket(ws as unknown as JSONSocket, ws.data.hooks);
      },
      message(ws, message) {
        const payload = typeof message === "string" ? message : message instanceof Uint8Array ? message : new Uint8Array(message as unknown as ArrayBuffer);
        void defaultSubiSellerNodeRegistry.handleSocketMessage(ws as unknown as JSONSocket, payload);
      },
      close(ws) {
        void defaultSubiSellerNodeRegistry.handleSocketClose(ws as unknown as JSONSocket);
      },
    },
  });
}

export function resetGatewayRegistryForTests(): void {
  resetDefaultSubiSellerNodeRegistry();
}

async function handleGatewayRequest(req: Request, cfg: GatewayConfig): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/health") {
    return jsonResponse({ ok: true });
  }
  const staticResp = await handleStatic(req, cfg);
  if (staticResp) return staticResp;
  if (url.pathname.startsWith("/api/web/auth/")) return handleWebAuth(req, cfg);
  if (url.pathname.startsWith("/api/web/buyer/")) return handleWebBuyer(req, cfg);
  if (url.pathname.startsWith("/api/web/seller/")) return handleWebSeller(req, cfg);
  if (url.pathname === "/api/v1/subi/seller/setup") return handleSellerSetup(req, cfg);
  if (url.pathname === "/api/v1/subi/seller/install.sh") return handleSellerInstallScript(req);
  if (url.pathname === "/api/v1/subi/seller/install.ps1") return handleSellerWindowsInstallScript(req);
  if (url.pathname.startsWith("/api/v1/subi/seller/downloads/")) return handleSellerDownload(req);
  return handleBuyerRequest(req, cfg);
}

function handleSellerAgentUpgrade(req: Request, server: Bun.Server<SocketData>, cfg: GatewayConfig): Response | undefined {
  const token = sellerNodeBearerToken(req);
  let hooks: SocketData["hooks"] = {};
  if (!cfg.store || staticSellerTokenAllowed(cfg, token)) {
    if (token !== cfg.seller_node_token) {
      return openAIError(new URL(req.url).pathname, 401, "authentication_error", "invalid seller node token");
    }
  } else {
    if (!token) return openAIError(new URL(req.url).pathname, 401, "authentication_error", "invalid seller node token");
    hooks = {
      authNode: (nodeID: string) => {
        cfg.store!.authenticateSellerNode(nodeID, token);
      },
      onNodeHeartbeat: (nodeID: string) => {
        cfg.store!.markSellerNodeHeartbeat(nodeID);
      },
      onNodeDisconnected: (nodeID: string) => {
        cfg.store!.markSellerNodeOffline(nodeID);
      },
    };
  }
  if (server.upgrade(req, { data: { hooks } })) return undefined;
  return apiError(400, "websocket upgrade failed");
}

async function handleBuyerRequest(req: Request, cfg: GatewayConfig): Promise<Response> {
  const startedAt = Date.now();
  const requestID = `subi_${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
  const url = new URL(req.url);
  const path = `${url.pathname}${url.search}`;
  let status = 0;
  let sellerNode = "";
  let previousSellerNode = "";
  let sessionMigrated = false;
  let historyTurnsInjected = 0;
  let upstreamMode = "";
  let errorMessage = "";
  let stream = false;
  let timeToFirstChunkMS = -1;
  let bytesOut = 0;
  let creditsReserved = false;
  let creditsChargedMicros = 0;
  let buyerAuth: AuthenticatedBuyerKey = { id: "", user_id: "", key_hash: "" };
  let buyerKeyHash = buyerCredentialHash(req);
  let sessionID = "";
  let userText = "";
  const baseHeaders = new Headers({ "X-Subi-Request-ID": requestID });

  const fail = (code: number, type: string, message: string) => {
    status = code;
    errorMessage = message;
    logGatewayAccess({ requestID, buyerKeyHash, sessionID, path, status, sellerNode, previousSellerNode, sessionMigrated, historyTurnsInjected, upstreamMode, startedAt, timeToFirstChunkMS, bytesOut, creditsChargedMicros, error: errorMessage, stream });
    const resp = openAIError(url.pathname, code, type, message);
    resp.headers.set("X-Subi-Request-ID", requestID);
    return resp;
  };

  if (!isForwardablePath(url.pathname)) return fail(404, "not_found_error", "endpoint not found");
  if (req.method !== "POST") return fail(405, "invalid_request_error", "method not allowed");

  const buyerSecret = buyerCredential(req);
  try {
    buyerAuth = authenticateBuyerCredential(cfg, buyerSecret);
  } catch (error) {
    console.error(`buyer api key auth failed: ${error}`);
  }
  if (!buyerAuth.id && !staticBuyerKeyAllowed(cfg, buyerSecret)) return fail(401, "authentication_error", "invalid buyer API key");
  const accountingEnabled = Boolean(cfg.store && buyerAuth.user_id && buyerAuth.id);
  if (accountingEnabled) buyerKeyHash = buyerAuth.key_hash.slice(0, 16);

  let body: Uint8Array;
  try {
    body = new Uint8Array(await req.arrayBuffer());
  } catch {
    return fail(400, "invalid_request_error", "failed to read request body");
  }
  if (body.length === 0) return fail(400, "invalid_request_error", "request body is empty");
  if (body.length > defaultMaxRequestBodyLen) return fail(400, "invalid_request_error", "failed to read request body");

  const refundReservedCredits = (reason: string) => {
    if (!creditsReserved || !accountingEnabled) return;
    try {
      cfg.store!.refundBuyerCreditsForRequest(buyerAuth.user_id, requestID, reason);
      creditsReserved = false;
      creditsChargedMicros = 0;
    } catch (error) {
      console.error(`subi credit refund failed: request_id=${requestID} buyer_user_id=${buyerAuth.user_id} error=${error}`);
    }
  };
  const recordUsage = (costMicros: number, sellerEarningMicros: number, recordError: string) => {
    if (!accountingEnabled) return;
    try {
      cfg.store!.recordRequestUsage({
        request_id: requestID,
        buyer_user_id: buyerAuth.user_id,
        buyer_api_key_id: buyerAuth.id,
        seller_node_id: sellerNode,
        path,
        status_code: status,
        stream,
        duration_ms: Date.now() - startedAt,
        time_to_first_chunk_ms: timeToFirstChunkMS,
        bytes_out: bytesOut,
        cost_micros: costMicros,
        seller_earning_micros: sellerEarningMicros,
        platform_fee_micros: cfg.platform_fee_micros,
        reserve_micros: cfg.reserve_micros,
        error: recordError,
      });
    } catch (error) {
      console.error(`subi request usage record failed: request_id=${requestID} buyer_user_id=${buyerAuth.user_id} error=${error}`);
    }
  };
  const settleSuccessfulRequest = (): boolean => {
    if (!accountingEnabled || !creditsReserved) return true;
    try {
      const { fill } = cfg.store!.recordSuccessfulRequestFillAndSellerEarning({
        request_id: requestID,
        buyer_user_id: buyerAuth.user_id,
        buyer_api_key_id: buyerAuth.id,
        seller_node_id: sellerNode,
        path,
        status_code: status,
        stream,
        duration_ms: Date.now() - startedAt,
        time_to_first_chunk_ms: timeToFirstChunkMS,
        bytes_out: bytesOut,
        cost_micros: cfg.request_cost_micros,
        seller_earning_micros: cfg.seller_earning_micros,
        platform_fee_micros: cfg.platform_fee_micros,
        reserve_micros: cfg.reserve_micros,
      });
      creditsReserved = false;
      creditsChargedMicros = fill.cost_micros;
      return true;
    } catch (error) {
      console.error(`subi successful request settlement failed: request_id=${requestID} buyer_user_id=${buyerAuth.user_id} seller_node=${sellerNode} error=${error}`);
      refundReservedCredits("settlement failed");
      recordUsage(0, 0, "settlement failed");
      return false;
    }
  };

  if (accountingEnabled) {
    baseHeaders.set("X-Subi-Cost-Micros", String(cfg.request_cost_micros));
    baseHeaders.set("X-Subi-Cost-Credits", (cfg.request_cost_micros / creditMicrosPerCredit).toFixed(6));
    try {
      cfg.store!.reserveBuyerCreditsForRequest(buyerAuth.user_id, requestID, cfg.request_cost_micros, "request pre-authorization");
      creditsReserved = true;
      creditsChargedMicros = cfg.request_cost_micros;
    } catch (error) {
      if (isStoreError(error, "insufficient_credits")) return fail(402, "insufficient_credits", "insufficient credits");
      console.error(`subi credit reserve failed: request_id=${requestID} buyer_user_id=${buyerAuth.user_id} error=${error}`);
      return fail(500, "api_error", "failed to reserve credits");
    }
  }

  const payload = safeJSONParse<any>(body) ?? {};
  stream = Boolean(payload.stream);
  sessionID = extractSubiSessionID(req.headers, body, buyerKeyHash);
  let sessionHashValue = sessionHash(req, body);
  let responseContentType = "";
  const responseBodyParts: Uint8Array[] = [];
  let sessionSaved = false;
  let sessionTextContextActive = false;
  if (cfg.session_context_enabled) {
    baseHeaders.set("X-Subi-Session-ID", sessionID);
    sessionHashValue = subiSessionHash(sessionID);
    sessionTextContextActive = isSubiSessionContextEligible(body, url.pathname);
    if (sessionTextContextActive) {
      const snapshot = cfg.session_store.snapshot(sessionID, buyerKeyHash);
      previousSellerNode = snapshot.last_seller_node;
      const extracted = extractSubiUserText(body, url.pathname);
      if (extracted[1]) {
        userText = extracted[0];
        try {
          const rewritten = buildSubiContextualRequestBody(body, url.pathname, snapshot.turns, userText);
          if (rewritten.rewritten) {
            body = rewritten.body;
            historyTurnsInjected = rewritten.injected;
          }
        } catch (error) {
          console.error(`subi session context rewrite failed: request_id=${requestID} session_id=${sessionID} error=${error}`);
        }
      }
    }
  }
  const saveSession = () => {
    if (sessionSaved || !cfg.session_context_enabled || !sessionTextContextActive || status < 200 || status >= 400) return;
    sessionSaved = true;
    const combined = concatBytes(responseBodyParts);
    const assistantText = extractSubiAssistantText(combined, responseContentType);
    cfg.session_store.appendExchange(sessionID, buyerKeyHash, requestID, userText, assistantText, sellerNode);
  };

  let dispatch;
  try {
    dispatch = defaultSubiSellerNodeRegistry.dispatch({
      request_id: requestID,
      method: req.method,
      path,
      headers: headersToBag(req.headers),
      body,
      stream,
      session_id: sessionID,
      session_hash: sessionHashValue,
      previous_seller_node: previousSellerNode,
      timeout_ms: defaultRequestTimeoutMS,
    });
  } catch (error) {
    if (error instanceof SubiP2PError && error.code === "agent_busy") {
      refundReservedCredits("seller node busy");
      status = 503;
      errorMessage = "seller node is busy, please retry later";
      recordUsage(0, 0, errorMessage);
      return fail(503, "api_error", errorMessage);
    }
    refundReservedCredits("no available seller node");
    status = 503;
    errorMessage = "no available seller node";
    recordUsage(0, 0, errorMessage);
    return fail(503, "api_error", errorMessage);
  }
  sellerNode = dispatch.node_id;
  if (!previousSellerNode) previousSellerNode = dispatch.previous_seller_node;
  sessionMigrated = dispatch.session_migrated;
  if (cfg.session_context_enabled) {
    baseHeaders.set("X-Subi-Session-Migrated", String(sessionMigrated));
  }

  const firstResult = await dispatch.events.next();
  if (firstResult.done) {
    errorMessage = "seller agent response stream closed";
    refundReservedCredits(errorMessage);
    recordUsage(0, 0, errorMessage);
    return fail(502, "api_error", errorMessage);
  }

  const first = firstResult.value;
  if (first.type === subiEnvelopeResponseError) {
    errorMessage = first.error || "seller agent response error";
    status = 502;
    refundReservedCredits(errorMessage);
    recordUsage(0, 0, errorMessage);
    return fail(502, "api_error", errorMessage);
  }

  const responseHeaders = new Headers(baseHeaders);
  if (first.type === subiEnvelopeResponseStart) {
    copyResponseHeaders(responseHeaders, first.headers);
    responseHeaders.set("X-Subi-Seller-Node", sellerNode);
    if (cfg.session_context_enabled) {
      responseHeaders.set("X-Subi-Session-ID", sessionID);
      responseHeaders.set("X-Subi-Session-Migrated", String(sessionMigrated));
    }
    upstreamMode = headerBagGet(first.headers, "X-Subi-Upstream-Mode");
    if (upstreamMode) responseHeaders.set("X-Subi-Upstream-Mode", upstreamMode);
    responseContentType = headerBagGet(first.headers, "Content-Type");
    status = first.status_code && first.status_code > 0 ? first.status_code : 200;
  } else {
    responseHeaders.set("Content-Type", "text/event-stream");
    responseHeaders.set("Cache-Control", "no-cache");
    responseHeaders.set("X-Accel-Buffering", "no");
    responseHeaders.set("X-Subi-Seller-Node", sellerNode);
    status = 200;
  }

  const streamBody = new ReadableStream<Uint8Array>({
    async start(controller) {
      const process = (ev: SubiP2PResponseEvent): boolean => {
        switch (ev.type) {
          case subiEnvelopeResponseStart:
            return true;
          case subiEnvelopeResponseChunk:
            if (ev.data && ev.data.length > 0) {
              if (timeToFirstChunkMS < 0) timeToFirstChunkMS = Date.now() - startedAt;
              bytesOut += ev.data.length;
              if (cfg.session_context_enabled) responseBodyParts.push(ev.data);
              controller.enqueue(ev.data);
            }
            return true;
          case subiEnvelopeResponseError:
            errorMessage = ev.error || "seller agent response error";
            refundReservedCredits(errorMessage);
            recordUsage(0, 0, errorMessage);
            controller.enqueue(new TextEncoder().encode(sseError(errorMessage)));
            return false;
          case subiEnvelopeResponseEnd:
            if (status === 0) status = 200;
            if (status >= 200 && status < 400) {
              if (!settleSuccessfulRequest()) errorMessage = "settlement failed";
            } else {
              errorMessage ||= `upstream status ${status}`;
              refundReservedCredits(errorMessage);
              recordUsage(0, 0, errorMessage);
            }
            saveSession();
            return false;
          default:
            return true;
        }
      };
      if (first.type !== subiEnvelopeResponseStart && !process(first)) {
        controller.close();
        logGatewayAccess({ requestID, buyerKeyHash, sessionID, path, status, sellerNode, previousSellerNode, sessionMigrated, historyTurnsInjected, upstreamMode, startedAt, timeToFirstChunkMS, bytesOut, creditsChargedMicros, error: errorMessage, stream });
        return;
      }
      for await (const ev of dispatch.events) {
        if (!process(ev)) break;
      }
      controller.close();
      dispatch.done();
      logGatewayAccess({ requestID, buyerKeyHash, sessionID, path, status, sellerNode, previousSellerNode, sessionMigrated, historyTurnsInjected, upstreamMode, startedAt, timeToFirstChunkMS, bytesOut, creditsChargedMicros, error: errorMessage, stream });
    },
    cancel() {
      refundReservedCredits("buyer connection write failed");
      recordUsage(0, 0, "buyer connection write failed");
      dispatch.done();
    },
  });

  return new Response(streamBody, { status, headers: responseHeaders });
}

async function handleWebAuth(req: Request, cfg: GatewayConfig): Promise<Response> {
  if (!cfg.store) return apiError(503, "account store is not enabled");
  const url = new URL(req.url);
  try {
    if (req.method === "POST" && url.pathname === "/api/web/auth/register") {
      const body = await req.json().catch(() => undefined) as any;
      if (!body) return apiError(400, "invalid JSON body");
      const user = cfg.store.registerUser(body.email, body.password);
      const session = cfg.store.createWebSession(user.id);
      const headers = new Headers();
      headers.set("Set-Cookie", setCookieHeader(cfg.session_cookie_name, session.session, session.expires_at, isSecure(req)));
      return jsonResponse({ user, roles: ["buyer", "seller"] }, 201, headers);
    }
    if (req.method === "POST" && url.pathname === "/api/web/auth/login") {
      const body = await req.json().catch(() => undefined) as any;
      if (!body) return apiError(400, "invalid JSON body");
      const user = cfg.store.authenticateUser(body.email, body.password);
      const session = cfg.store.createWebSession(user.id);
      const headers = new Headers();
      headers.set("Set-Cookie", setCookieHeader(cfg.session_cookie_name, session.session, session.expires_at, isSecure(req)));
      return jsonResponse({ user, roles: ["buyer", "seller"] }, 200, headers);
    }
    if (req.method === "POST" && url.pathname === "/api/web/auth/logout") {
      const cookie = cookieValue(req.headers.get("cookie"), cfg.session_cookie_name);
      cfg.store.deleteWebSession(cookie);
      return jsonResponse({ ok: true }, 200, { "Set-Cookie": clearCookieHeader(cfg.session_cookie_name) });
    }
    if (req.method === "GET" && url.pathname === "/api/web/auth/me") {
      const user = requireWebUser(req, cfg);
      return jsonResponse({ user, roles: ["buyer", "seller"] });
    }
    return apiError(404, "endpoint not found");
  } catch (error) {
    return storeErrorResponse(error, "register failed");
  }
}

async function handleWebBuyer(req: Request, cfg: GatewayConfig): Promise<Response> {
  if (!cfg.store) return apiError(503, "account store is not enabled");
  let user: User;
  try {
    user = requireWebUser(req, cfg);
  } catch {
    return apiError(401, "login required");
  }
  const url = new URL(req.url);
  try {
    if (req.method === "GET" && url.pathname === "/api/web/buyer/me") return jsonResponse({ buyer: { user_id: user.id, email: user.email } });
    if (req.method === "GET" && url.pathname === "/api/web/buyer/balance") return jsonResponse({ wallet: cfg.store.getBuyerCreditWallet(user.id) });
    if (req.method === "GET" && url.pathname === "/api/web/buyer/credits/plans") {
      return jsonResponse({
        plans: [
          { id: "credits_100", credits: 100, amount_micros: 100 * creditMicrosPerCredit, mode: "mock" },
          { id: "credits_500", credits: 500, amount_micros: 500 * creditMicrosPerCredit, mode: "mock" },
          { id: "credits_2000", credits: 2000, amount_micros: 2000 * creditMicrosPerCredit, mode: "mock" },
        ],
      });
    }
    if (req.method === "POST" && url.pathname === "/api/web/buyer/credits/orders") {
      const body = await req.json().catch(() => undefined) as any;
      if (!body) return apiError(400, "invalid JSON body");
      const amountMicros = Number(body.amount_micros || 0) || Number(body.amount_credits || 0) * creditMicrosPerCredit;
      return jsonResponse(cfg.store.createMockCreditOrder(user.id, amountMicros), 201);
    }
    if (req.method === "GET" && url.pathname === "/api/web/buyer/credits/ledger") {
      return jsonResponse({ ledger: cfg.store.listBuyerCreditLedger(user.id, normalizeLimit(url.searchParams.get("limit"), 50)) });
    }
    if (req.method === "GET" && url.pathname === "/api/web/buyer/usage") {
      return jsonResponse({ usage: cfg.store.listBuyerUsage(user.id, normalizeLimit(url.searchParams.get("limit"), 50)) });
    }
    if (req.method === "GET" && url.pathname === "/api/web/buyer/api-keys") return jsonResponse({ api_keys: cfg.store.listBuyerAPIKeys(user.id) });
    if (req.method === "POST" && url.pathname === "/api/web/buyer/api-keys") {
      const body = await req.json().catch(() => ({})) as any;
      const created = cfg.store.createBuyerAPIKey(user.id, body?.name);
      return jsonResponse({ api_key: created.api_key, secret: created.secret }, 201);
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/api/web/buyer/api-keys/")) {
      const keyID = url.pathname.slice("/api/web/buyer/api-keys/".length);
      if (!keyID) return apiError(404, "endpoint not found");
      cfg.store.deleteBuyerAPIKey(user.id, keyID);
      return jsonResponse({ ok: true });
    }
    return apiError(404, "endpoint not found");
  } catch (error) {
    return storeErrorResponse(error, "buyer request failed");
  }
}

async function handleWebSeller(req: Request, cfg: GatewayConfig): Promise<Response> {
  if (!cfg.store) return apiError(503, "account store is not enabled");
  let user: User;
  try {
    user = requireWebUser(req, cfg);
  } catch {
    return apiError(401, "login required");
  }
  const url = new URL(req.url);
  try {
    if (req.method === "GET" && url.pathname === "/api/web/seller/me") return jsonResponse({ seller: { user_id: user.id, email: user.email } });
    if (req.method === "GET" && url.pathname === "/api/web/seller/earnings") {
      return jsonResponse({
        earnings: cfg.store.getSellerEarningsSummary(user.id),
        ledger: cfg.store.listSellerEarningLedger(user.id, normalizeLimit(url.searchParams.get("limit"), 50)),
      });
    }
    if (req.method === "GET" && url.pathname === "/api/web/seller/activity") {
      return jsonResponse({ activity: cfg.store.listSellerActivity(user.id, normalizeLimit(url.searchParams.get("limit"), 50)) });
    }
    if (req.method === "GET" && url.pathname === "/api/web/seller/nodes") return jsonResponse({ nodes: cfg.store.listSellerNodes(user.id) });
    if (req.method === "POST" && url.pathname === "/api/web/seller/nodes") {
      const body = await req.json().catch(() => undefined) as any;
      if (!body) return apiError(400, "invalid JSON body");
      const node = cfg.store.createSellerNode(user.id, body.node_id, body.provider, Number(body.max_concurrency || 0));
      return jsonResponse({ node }, 201);
    }
    if (req.method === "PATCH" && url.pathname.startsWith("/api/web/seller/nodes/")) {
      const nodeID = url.pathname.slice("/api/web/seller/nodes/".length);
      if (!nodeID || nodeID.includes("/")) return apiError(404, "endpoint not found");
      const body = await req.json().catch(() => undefined) as any;
      if (!body) return apiError(400, "invalid JSON body");
      const node = cfg.store.updateSellerNode(user.id, decodeURIComponent(nodeID), body.provider, Number(body.max_concurrency || 0));
      return jsonResponse({ node });
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/web/seller/nodes/") && url.pathname.endsWith("/doctor")) {
      const nodeID = url.pathname.slice("/api/web/seller/nodes/".length, -"/doctor".length);
      if (!nodeID) return apiError(404, "endpoint not found");
      return await runSellerNodeDoctor(cfg, user, decodeURIComponent(nodeID));
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/web/seller/nodes/") && url.pathname.endsWith("/setup-token")) {
      const nodeID = url.pathname.slice("/api/web/seller/nodes/".length, -"/setup-token".length);
      if (!nodeID) return apiError(404, "endpoint not found");
      const setup = cfg.store.createSellerSetupToken(user.id, decodeURIComponent(nodeID), 30 * 60 * 1000);
      const baseURL = requestBaseURL(req);
      const setupURL = `${baseURL}/api/v1/subi/seller/setup?token=${setup.setup_token}`;
      const installCommandUnix = `curl -fsSL ${baseURL}/api/v1/subi/seller/install.sh | bash -s -- --gateway ${baseURL} --setup-token ${setup.setup_token}`;
      const installCommandWindows = `iwr -UseBasicParsing ${baseURL}/api/v1/subi/seller/install.ps1 | iex; Install-SubiSeller -Gateway ${powerShellSingleQuote(baseURL)} -SetupToken ${powerShellSingleQuote(setup.setup_token)}`;
      return jsonResponse({
        setup_token: setup.setup_token,
        expires_at: setup.expires_at,
        setup_url: setupURL,
        install_command: installCommandUnix,
        install_command_unix: installCommandUnix,
        install_command_windows: installCommandWindows,
      }, 201);
    }
    return apiError(404, "endpoint not found");
  } catch (error) {
    return storeErrorResponse(error, "seller request failed");
  }
}

async function runSellerNodeDoctor(cfg: GatewayConfig, user: User, nodeID: string): Promise<Response> {
  const startedAt = Date.now();
  const node = cfg.store!.getSellerNode(user.id, nodeID);
  if (!node) return apiError(404, "seller node not found");

  const checks: SellerDoctorCheck[] = [
    { id: "web_login", label: "网页登录", status: "passed", message: "当前卖家账号已登录。" },
    { id: "node_created", label: "节点创建", status: "passed", message: `节点 ${node.node_id} 已创建。` },
  ];

  if (node.provider !== "codex-login") {
    checks.push({
      id: "provider_doctor",
      label: "Provider 自检",
      status: "blocked",
      code: "provider_not_ready",
      message: `${sellerProviderLabel(node.provider)} 自检暂未开放。`,
    });
    return sellerDoctorJSON(node, checks, "blocked", "当前版本只开放 Codex 订阅自检，请切换到 Codex 节点。", startedAt, "provider_not_ready");
  }

  if (node.status === "created") {
    checks.push({
      id: "setup_redeemed",
      label: "安装配置",
      status: "blocked",
      code: "setup_not_redeemed",
      message: "安装命令尚未兑换 setup token。",
    });
    return sellerDoctorJSON(node, checks, "blocked", "重新复制安装命令，并在卖家机器上完成安装。", startedAt, "setup_not_redeemed");
  }
  checks.push({ id: "setup_redeemed", label: "安装配置", status: "passed", message: "setup token 已兑换，节点 token 已写入本机配置。" });

  const snapshot = defaultSubiSellerNodeRegistry.getNodeSnapshot(node.node_id);
  if (!snapshot) {
    checks.push({
      id: "agent_online",
      label: "Seller Agent",
      status: "blocked",
      code: "agent_offline",
      message: "seller-agent 当前未连接 Gateway。",
    });
    return sellerDoctorJSON(node, checks, "blocked", "启动或重启本机 seller-agent，然后刷新节点状态。", startedAt, "agent_offline");
  }
  checks.push({ id: "agent_online", label: "Seller Agent", status: "passed", message: "seller-agent 已连接 Gateway。" });

  if (snapshot.stale) {
    checks.push({
      id: "agent_heartbeat",
      label: "心跳",
      status: "blocked",
      code: "agent_stale",
      message: "seller-agent 心跳已过期。",
    });
    return sellerDoctorJSON(node, checks, "blocked", "重启 seller-agent，确认网络能访问 Gateway WebSocket。", startedAt, "agent_stale");
  }
  checks.push({ id: "agent_heartbeat", label: "心跳", status: "passed", message: "最近心跳正常。" });

  if (snapshot.active_requests >= snapshot.max_concurrency) {
    checks.push({
      id: "agent_capacity",
      label: "Worker",
      status: "blocked",
      code: "agent_busy",
      message: `当前 ${snapshot.active_requests}/${snapshot.max_concurrency} worker 正在处理请求。`,
    });
    return sellerDoctorJSON(node, checks, "blocked", "等待当前请求完成后再运行自检。", startedAt, "agent_busy");
  }
  checks.push({ id: "agent_capacity", label: "Worker", status: "passed", message: `${snapshot.max_concurrency} worker 可接入。` });

  const strategy = sellerDoctorStrategies[node.provider];
  if (!strategy) {
    checks.push({
      id: "provider_doctor",
      label: "Provider 自检",
      status: "blocked",
      code: "provider_not_ready",
      message: `${sellerProviderLabel(node.provider)} 自检暂未开放。`,
    });
    return sellerDoctorJSON(node, checks, "blocked", "当前版本只开放 Codex 订阅自检。", startedAt, "provider_not_ready");
  }

  const probe = await strategy(node);
  checks.push(probe.check);
  return sellerDoctorJSON(node, checks, probe.status, probe.next_action, startedAt, probe.code);
}

async function runCodexSellerDoctor(node: SellerNode): Promise<SellerDoctorProbeResult> {
  const requestID = `subi_doctor_${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
  const body = new TextEncoder().encode(
    JSON.stringify({
      model: sellerDoctorModel,
      instructions: `You are a diagnostic responder. Reply exactly with ${sellerDoctorExpected} and no extra text.`,
      input: [{ role: "user", content: `Reply exactly: ${sellerDoctorExpected}` }],
      stream: true,
      store: false,
    }),
  );

  let dispatch;
  try {
    dispatch = defaultSubiSellerNodeRegistry.dispatchToNode(node.node_id, {
      request_id: requestID,
      method: "POST",
      path: "/v1/responses",
      headers: { "Content-Type": ["application/json"], "X-Subi-Doctor": ["seller-codex"] },
      body,
      stream: true,
      timeout_ms: sellerDoctorTimeoutMS,
      session_hash: `seller-doctor-${sha256Hex(requestID)}`,
      meta: { diagnostic: true, doctor_provider: "codex-login" },
    });
  } catch (error) {
    return sellerDoctorDispatchError(error);
  }

  let statusCode = 0;
  let upstreamMode = "";
  let errorMessage = "";
  const parts: Uint8Array[] = [];
  try {
    for await (const ev of dispatch.events) {
      switch (ev.type) {
        case subiEnvelopeResponseStart:
          statusCode = ev.status_code && ev.status_code > 0 ? ev.status_code : 200;
          upstreamMode = headerBagGet(ev.headers, "X-Subi-Upstream-Mode");
          break;
        case subiEnvelopeResponseChunk:
          if (ev.data?.length) parts.push(ev.data);
          break;
        case subiEnvelopeResponseError:
          errorMessage = ev.error || "seller-agent 返回自检错误";
          break;
        case subiEnvelopeResponseEnd:
          break;
      }
    }
  } finally {
    dispatch.done();
  }

  const responseText = new TextDecoder().decode(concatBytes(parts));
  if (errorMessage) {
    return {
      status: "failed",
      code: "codex_probe_error",
      next_action: codexDoctorNextAction(statusCode, errorMessage),
      check: {
        id: "codex_probe",
        label: "Codex 上游",
        status: "failed",
        code: "codex_probe_error",
        message: truncateText(errorMessage, 240),
      },
    };
  }

  if (statusCode >= 200 && statusCode < 300 && upstreamMode === "codex-login" && responseText.includes(sellerDoctorExpected)) {
    return {
      status: "passed",
      next_action: "自检通过，随时可以接单赚钱。",
      check: {
        id: "codex_probe",
        label: "Codex 上游",
        status: "passed",
        message: "Codex Responses probe 返回预期标记。",
      },
    };
  }

  const code = statusCode === 401 || statusCode === 403 ? "codex_auth_failed" : "codex_probe_failed";
  return {
    status: "failed",
    code,
    next_action: codexDoctorNextAction(statusCode, responseText),
    check: {
      id: "codex_probe",
      label: "Codex 上游",
      status: "failed",
      code,
      message: codexDoctorFailureMessage(statusCode, upstreamMode, responseText),
    },
  };
}

function sellerDoctorDispatchError(error: unknown): SellerDoctorProbeResult {
  if (error instanceof SubiP2PError) {
    const blockedCodes = new Set(["agent_busy", "node_not_found", "agent_stale", "provider_mismatch"]);
    const status: SellerDoctorStatus = blockedCodes.has(error.code) ? "blocked" : "failed";
    return {
      status,
      code: error.code,
      next_action: error.code === "agent_busy" ? "等待当前请求完成后再运行自检。" : "检查 seller-agent 是否在线，并确认节点 provider 是 codex-login。",
      check: {
        id: "codex_probe",
        label: "Codex 上游",
        status,
        code: error.code,
        message: error.message,
      },
    };
  }
  return {
    status: "failed",
    code: "codex_probe_error",
    next_action: "查看 seller-agent 日志后重试。",
    check: {
      id: "codex_probe",
      label: "Codex 上游",
      status: "failed",
      code: "codex_probe_error",
      message: String(error),
    },
  };
}

function sellerDoctorJSON(node: SellerNode, checks: SellerDoctorCheck[], status: SellerDoctorStatus, nextAction: string, startedAt: number, code?: string): Response {
  return jsonResponse({
    status,
    code,
    provider: node.provider,
    node_id: node.node_id,
    checks,
    next_action: nextAction,
    duration_ms: Date.now() - startedAt,
  });
}

function sellerProviderLabel(provider: string): string {
  switch (provider) {
    case "codex-login":
      return "Codex";
    case "claude-code":
      return "Claude Code";
    default:
      return provider || "当前 Provider";
  }
}

function codexDoctorFailureMessage(statusCode: number, upstreamMode: string, responseText: string): string {
  if (statusCode === 401 || statusCode === 403) return `Codex probe 被上游拒绝：HTTP ${statusCode}。`;
  if (upstreamMode && upstreamMode !== "codex-login") return `Codex probe 返回了非 Codex provider：${upstreamMode}。`;
  if (statusCode >= 200 && statusCode < 300) return `Codex probe 未返回预期标记。响应预览：${truncateText(responseText, 180)}`;
  if (statusCode > 0) return `Codex probe 返回 HTTP ${statusCode}。响应预览：${truncateText(responseText, 180)}`;
  return `Codex probe 没有收到有效响应。响应预览：${truncateText(responseText, 180)}`;
}

function codexDoctorNextAction(statusCode: number, text: string): string {
  const lower = text.toLowerCase();
  if (statusCode === 401 || statusCode === 403 || lower.includes("auth") || lower.includes("token") || lower.includes("codex chatgpt")) {
    return "检查本机 Codex ChatGPT 登录态，确认 ~/.codex/auth.json 可读，然后重启 seller-agent。";
  }
  return "查看 seller-agent 日志和网络连接后重试。";
}

function truncateText(value: string, maxLen: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= maxLen) return text || "-";
  return `${text.slice(0, maxLen - 3)}...`;
}

function handleSellerSetup(req: Request, cfg: GatewayConfig): Response {
  if (!cfg.store) return apiError(503, "account store is not enabled");
  if (req.method !== "GET") return apiError(405, "method not allowed");
  const token = new URL(req.url).searchParams.get("token") ?? "";
  try {
    const setup = cfg.store.redeemSellerSetupToken(token);
    const wsURL = cfg.public_gateway_ws_url || requestWSURL(req);
    return jsonResponse({
      subi_gateway_ws_url: wsURL,
      subi_seller_node_token: setup.node_token,
      subi_node_id: setup.node_id,
      seller_upstream_mode: setup.provider,
      seller_codex_workers: setup.max_concurrency,
      seller_workers: setup.max_concurrency,
      seller_codex_home: "$HOME/.codex",
      seller_claude_home: "$HOME/.claude",
      seller_config_env: sellerConfigEnv(wsURL, setup),
      seller_agent_configured: true,
    });
  } catch {
    return apiError(401, "invalid or expired seller setup token");
  }
}

async function handleSellerInstallScript(req: Request): Promise<Response> {
  if (req.method !== "GET") return apiError(405, "method not allowed");
  const candidates = [
    "cmd/subi-gateway/assets/install-seller.sh",
    "backend/cmd/subi-gateway/assets/install-seller.sh",
    "../backend/cmd/subi-gateway/assets/install-seller.sh",
    "scripts/install-seller.sh",
    "../scripts/install-seller.sh",
    "/opt/subi/scripts/install-seller.sh",
    "/opt/subi-canary/scripts/install-seller.sh",
  ];
  for (const path of candidates) {
    const file = Bun.file(path);
    if (await file.exists()) {
      return new Response(file, { headers: { "Content-Type": "text/x-shellscript; charset=utf-8" } });
    }
  }
  return new Response(sellerInstallScript, {
    headers: { "Content-Type": "text/x-shellscript; charset=utf-8" },
  });
}

async function handleSellerWindowsInstallScript(req: Request): Promise<Response> {
  if (req.method !== "GET") return apiError(405, "method not allowed");
  const candidates = [
    "cmd/subi-gateway/assets/install-seller.ps1",
    "backend/cmd/subi-gateway/assets/install-seller.ps1",
    "../backend/cmd/subi-gateway/assets/install-seller.ps1",
    "scripts/install-seller.ps1",
    "../scripts/install-seller.ps1",
    "/opt/subi/scripts/install-seller.ps1",
    "/opt/subi-canary/scripts/install-seller.ps1",
  ];
  for (const path of candidates) {
    const file = Bun.file(path);
    if (await file.exists()) {
      return new Response(file, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
  }
  return new Response(sellerWindowsInstallScript, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

async function handleSellerDownload(req: Request): Promise<Response> {
  if (req.method !== "GET") return apiError(405, "method not allowed");
  const name = decodeURIComponent(new URL(req.url).pathname.split("/").pop() || "");
  const allowed = new Set(["seller-agent-darwin-arm64", "seller-agent-linux-amd64", "seller-agent-windows-x64.exe", "seller-agent"]);
  if (!allowed.has(name)) return apiError(404, "seller download not found");
  const executableDir = dirname(process.execPath);
  const candidates = [
    join(executableDir, name),
    `downloads/${name}`,
    `dist/${name}`,
    `../dist/${name}`,
    `/opt/subi/dist/${name}`,
    `/opt/subi-canary/dist/${name}`,
  ];
  for (const path of candidates) {
    const file = Bun.file(path);
    if (await file.exists()) {
      return new Response(file, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${name}"`,
          "Cache-Control": "no-store",
        },
      });
    }
  }
  return apiError(404, "seller download not found");
}

function requireWebUser(req: Request, cfg: GatewayConfig): User {
  const cookie = cookieValue(req.headers.get("cookie"), cfg.session_cookie_name);
  if (!cookie) throw new Error("login required");
  return cfg.store!.userBySession(cookie);
}

function powerShellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function storeErrorResponse(error: unknown, fallback: string): Response {
  if (!isStoreError(error)) return apiError(500, fallback);
  const mapped = storeErrorStatus(error);
  if (error.code === "insufficient_credits") return apiError(mapped.status, mapped.message);
  return apiError(mapped.status, fallback);
}

function staticBuyerKeyAllowed(cfg: GatewayConfig, secret: string): boolean {
  return trim(secret) !== "" && trim(cfg.buyer_api_key) !== "" && secret === cfg.buyer_api_key && (!cfg.store || cfg.dev_static_keys);
}

function staticSellerTokenAllowed(cfg: GatewayConfig, secret: string): boolean {
  return trim(secret) !== "" && trim(cfg.seller_node_token) !== "" && secret === cfg.seller_node_token && (!cfg.store || cfg.dev_static_keys);
}

function authenticateBuyerCredential(cfg: GatewayConfig, secret: string): AuthenticatedBuyerKey {
  if (staticBuyerKeyAllowed(cfg, secret)) return { id: "", user_id: "", key_hash: "" };
  if (!cfg.store) throw new Error("account store is not enabled");
  return cfg.store.authenticateBuyerAPIKey(secret);
}

function buyerCredential(req: Request): string {
  return bearerToken(req) || trim(req.headers.get("x-api-key"));
}

function buyerCredentialHash(req: Request): string {
  const value = buyerCredential(req);
  return value ? sha256Hex(value).slice(0, 16) : "";
}

function sellerNodeBearerToken(req: Request): string {
  const url = new URL(req.url);
  return bearerToken(req) || trim(url.searchParams.get("token"));
}

function bearerToken(req: Request): string {
  const auth = trim(req.headers.get("authorization"));
  const [scheme, value] = auth.split(/\s+/, 2);
  return scheme?.toLowerCase() === "bearer" ? trim(value) : "";
}

function isForwardablePath(path: string): boolean {
  return (
    path === "/v1/messages" ||
    path.startsWith("/v1/messages/") ||
    path === "/messages" ||
    path.startsWith("/messages/") ||
    path === "/v1/responses" ||
    path.startsWith("/v1/responses/") ||
    path === "/responses" ||
    path.startsWith("/responses/") ||
    path === "/backend-api/codex/responses" ||
    path.startsWith("/backend-api/codex/responses/") ||
    path === "/v1/chat/completions" ||
    path === "/chat/completions"
  );
}

function sessionHash(req: Request, body: Uint8Array): string {
  const payload = safeJSONParse<any>(body) ?? {};
  const candidates = [
    trim(req.headers.get("session_id")),
    trim(req.headers.get("x-session-id")),
    trim(req.headers.get("x-stainless-session-id")),
    trim(payload?.metadata?.user_id),
    trim(payload?.metadata?.session_id),
    trim(payload?.prompt_cache_key),
    trim(payload?.conversation_id),
    trim(payload?.previous_response_id),
  ];
  for (const candidate of candidates) {
    if (candidate) return sha256Hex(candidate);
  }
  return `buyer-key-${sha256Hex(buyerCredential(req))}`;
}

function copyResponseHeaders(dst: Headers, src?: HeaderBag): void {
  for (const [key, values] of Object.entries(src ?? {})) {
    if (["content-encoding", "content-length", "connection", "transfer-encoding"].includes(key.toLowerCase())) continue;
    for (const value of values) dst.append(key, value);
  }
}

function headerBagGet(headers: HeaderBag | undefined, key: string): string {
  const lower = key.toLowerCase();
  for (const [name, values] of Object.entries(headers ?? {})) {
    if (name.toLowerCase() === lower) return values[0] ?? "";
  }
  return "";
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function sseError(message: string): string {
  return `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message } })}\n\n`;
}

function sellerConfigEnv(wsURL: string, setup: SellerSetupConfig): string {
  if (setup.provider === "claude-code") {
    return `SUBI_GATEWAY_WS_URL=${JSON.stringify(wsURL)}
SUBI_SELLER_NODE_TOKEN=${JSON.stringify(setup.node_token)}
SUBI_NODE_ID=${JSON.stringify(setup.node_id)}
SELLER_UPSTREAM_MODE="claude-code"
SELLER_CODEX_WORKERS=${setup.max_concurrency}
SELLER_WORKERS=${setup.max_concurrency}
SELLER_CLAUDE_HOME="$HOME/.claude"
SELLER_ANTHROPIC_BASE_URL="https://api.anthropic.com"
SELLER_CLAUDE_CODE_OAUTH_TOKEN=""
SELLER_ANTHROPIC_VERSION="2023-06-01"`;
  }
  return `SUBI_GATEWAY_WS_URL=${JSON.stringify(wsURL)}
SUBI_SELLER_NODE_TOKEN=${JSON.stringify(setup.node_token)}
SUBI_NODE_ID=${JSON.stringify(setup.node_id)}
SELLER_UPSTREAM_MODE=${JSON.stringify(setup.provider)}
SELLER_CODEX_WORKERS=${setup.max_concurrency}
SELLER_WORKERS=${setup.max_concurrency}
SELLER_CODEX_HOME="$HOME/.codex"
SELLER_CODEX_BASE_URL="https://chatgpt.com/backend-api/codex"`;
}

async function handleStatic(req: Request, cfg: GatewayConfig): Promise<Response | undefined> {
  if (req.method !== "GET" && req.method !== "HEAD") return undefined;
  const url = new URL(req.url);
  if (url.pathname === "/" || url.pathname === "/index.html") {
    return staticFileResponse(`${cfg.web_dir}/index.html`, "index.html", req.method);
  }
  if (url.pathname.startsWith("/assets/")) {
    const rel = decodeURIComponent(url.pathname.slice("/assets/".length));
    if (!rel || rel.includes("..")) return apiError(404, "endpoint not found");
    return staticFileResponse(`${cfg.web_dir}/assets/${rel}`, rel, req.method);
  }
  if (url.pathname === "/buyer") return Response.redirect(`${url.origin}/buyer/`, 307);
  if (url.pathname === "/seller" || url.pathname === "/seller-market") return Response.redirect(`${url.origin}/seller/`, 307);

  const mapping = url.pathname.startsWith("/buyer/")
    ? { prefix: "/buyer/", dir: `${cfg.web_dir}/buyer` }
    : url.pathname.startsWith("/seller/")
      ? { prefix: "/seller/", dir: `${cfg.web_dir}/seller-market` }
      : url.pathname.startsWith("/seller-market/")
        ? { prefix: "/seller-market/", dir: `${cfg.web_dir}/seller-market` }
        : undefined;
  if (!mapping) return undefined;
  let rel = decodeURIComponent(url.pathname.slice(mapping.prefix.length));
  if (!rel || rel.endsWith("/")) rel += "index.html";
  if (rel.includes("..")) return apiError(404, "endpoint not found");
  return staticFileResponse(`${mapping.dir}/${rel}`, rel, req.method);
}

async function staticFileResponse(path: string, rel: string, method: string): Promise<Response> {
  const file = Bun.file(path);
  if (!(await file.exists())) return apiError(404, "endpoint not found");
  const headers = new Headers();
  const type = contentType(rel);
  if (type) headers.set("Content-Type", type);
  return new Response(method === "HEAD" ? undefined : file, { headers });
}

function contentType(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

function isSecure(req: Request): boolean {
  const url = new URL(req.url);
  return url.protocol === "https:" || trim(req.headers.get("x-forwarded-proto")).toLowerCase() === "https";
}

function logGatewayAccess(entry: {
  requestID: string;
  buyerKeyHash: string;
  sessionID: string;
  path: string;
  status: number;
  sellerNode: string;
  previousSellerNode: string;
  sessionMigrated: boolean;
  historyTurnsInjected: number;
  upstreamMode: string;
  startedAt: number;
  timeToFirstChunkMS: number;
  bytesOut: number;
  creditsChargedMicros: number;
  error: string;
  stream: boolean;
}): void {
  console.log(
    `subi_gateway_access request_id=${entry.requestID} buyer_key_hash=${JSON.stringify(entry.buyerKeyHash)} session_id=${JSON.stringify(entry.sessionID)} path=${JSON.stringify(entry.path)} status=${entry.status} seller_node=${JSON.stringify(entry.sellerNode)} previous_seller_node=${JSON.stringify(entry.previousSellerNode)} session_migrated=${entry.sessionMigrated} history_turns_injected=${entry.historyTurnsInjected} upstream_mode=${JSON.stringify(entry.upstreamMode)} duration_ms=${Date.now() - entry.startedAt} time_to_first_chunk_ms=${entry.timeToFirstChunkMS} bytes_out=${entry.bytesOut} credits_charged_micros=${entry.creditsChargedMicros} error=${JSON.stringify(entry.error)} stream=${entry.stream}`,
  );
}
