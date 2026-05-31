import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { createGatewayServer, resetGatewayRegistryForTests, type GatewayConfig } from "../src/gateway";
import { decodeEnvelope, sendEnvelope, subiEnvelopeAgentHello, subiEnvelopeRequestStart, subiEnvelopeResponseChunk, subiEnvelopeResponseEnd, subiEnvelopeResponseStart, type JSONSocket, type SubiEnvelope } from "../src/service/p2p";
import { SubiSessionStore } from "../src/service/session";
import { Store, creditMicrosPerCredit } from "../src/store";
import { delay } from "../src/utils";

const servers: Bun.Server<any>[] = [];
const stores: Store[] = [];
const cleanupPaths: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const store of stores.splice(0)) store.close();
  for (const path of cleanupPaths.splice(0)) await rm(path, { force: true, recursive: true });
  resetGatewayRegistryForTests();
});

describe("Gateway", () => {
  test("same seller session injects history", async () => {
    const h = newGatewayTestHarness(true);
    const seller = await h.startSeller("seller-001", ["saved", "blue-lobster"]);

    const firstResp = await h.post("mvp1-same-seller", "remember code blue-lobster");
    expect(firstResp.body).toContain("saved");
    const firstReq = await seller.nextRequest();
    expect(firstResp.headers.get("X-Subi-Seller-Node")).toBe("seller-001");
    expect(firstResp.headers.get("X-Subi-Session-Migrated")).toBe("false");
    expect(JSON.parse(new TextDecoder().decode(firstReq.body)).metadata?.subi_context_injected).toBeUndefined();

    const secondResp = await h.post("mvp1-same-seller", "what is my code?");
    expect(secondResp.body).toContain("blue-lobster");
    const secondReq = await seller.nextRequest();
    const secondBody = JSON.parse(new TextDecoder().decode(secondReq.body));
    expect(secondResp.headers.get("X-Subi-Seller-Node")).toBe("seller-001");
    expect(secondResp.headers.get("X-Subi-Session-Migrated")).toBe("false");
    expect(secondBody.metadata.subi_context_injected).toBe(true);
    expect(secondBody.input[1].content).toBe("remember code blue-lobster");
    expect(secondBody.input[2].content).toBe("saved");
    seller.close();
  });

  test("session migration injects history into new seller", async () => {
    const h = newGatewayTestHarness(true);
    const seller1 = await h.startSeller("seller-001", ["saved"]);
    const firstResp = await h.post("mvp1-switch-demo", "remember code red-crab");
    expect(firstResp.body).toContain("saved");
    await seller1.nextRequest();
    seller1.close();
    await delay(120);

    const seller2 = await h.startSeller("seller-002", ["red-crab"]);
    const secondResp = await h.post("mvp1-switch-demo", "what is my code?");
    const secondReq = await seller2.nextRequest();
    const secondBody = JSON.parse(new TextDecoder().decode(secondReq.body));
    expect(secondResp.headers.get("X-Subi-Seller-Node")).toBe("seller-002");
    expect(secondResp.headers.get("X-Subi-Session-Migrated")).toBe("true");
    expect(secondResp.headers.get("X-Subi-Session-ID")).toBe("mvp1-switch-demo");
    expect(secondReq.meta?.session_id).toBe("mvp1-switch-demo");
    expect(secondReq.meta?.previous_seller_node).toBe("seller-001");
    expect(secondReq.meta?.session_migrated).toBe(true);
    expect(secondBody.metadata.subi_context_injected).toBe(true);
    expect(secondBody.input[1].content).toBe("remember code red-crab");
    expect(secondBody.input[2].content).toBe("saved");
    seller2.close();
  });

  test("session context disabled does not inject history", async () => {
    const h = newGatewayTestHarness(false);
    const seller = await h.startSeller("seller-001", ["saved", "UNKNOWN"]);
    await h.post("context-disabled", "remember code no-inject");
    await seller.nextRequest();
    const secondResp = await h.post("context-disabled", "what is my code?");
    const secondReq = await seller.nextRequest();
    expect(secondResp.body).toContain("UNKNOWN");
    expect(new TextDecoder().decode(secondReq.body)).not.toContain("no-inject");
    seller.close();
  });

  test("Codex tool protocol requests are passed through without Subi text-history rewrite", async () => {
    const h = newGatewayTestHarness(true);
    const seller = await h.startSeller("seller-001", ["tool-plan", "tool-result-seen"]);
    const firstPayload = {
      model: "gpt-5.5",
      stream: false,
      tools: [{ type: "function", name: "shell", parameters: { type: "object" } }],
      input: [{ role: "user", content: "look for nova" }],
    };
    const firstResp = await h.postRaw("codex-tool-session", firstPayload);
    expect(firstResp.body).toContain("tool-plan");
    const firstReq = await seller.nextRequest();
    const firstBody = JSON.parse(new TextDecoder().decode(firstReq.body));
    expect(firstBody.metadata?.subi_context_injected).toBeUndefined();
    expect(firstBody.tools).toHaveLength(1);
    expect(firstBody.input).toEqual(firstPayload.input);

    const continuationPayload = {
      model: "gpt-5.5",
      stream: false,
      input: [
        { type: "function_call", call_id: "call_1", name: "shell", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "nova not found" },
      ],
    };
    const secondResp = await h.postRaw("codex-tool-session", continuationPayload);
    expect(secondResp.body).toContain("tool-result-seen");
    const secondReq = await seller.nextRequest();
    const secondBody = JSON.parse(new TextDecoder().decode(secondReq.body));
    expect(secondBody.metadata?.subi_context_injected).toBeUndefined();
    expect(secondBody.input).toEqual(continuationPayload.input);
    expect(new TextDecoder().decode(secondReq.body)).not.toContain("tool-plan");
    seller.close();
  });

  test("no seller returns readable error", async () => {
    const h = newGatewayTestHarness(true);
    const resp = await h.post("no-seller", "should not run", 503);
    expect(resp.body).toContain("no available seller node");
    expect(resp.headers.get("Content-Type")?.split(";")[0]).toBe("application/json");
  });

  test("routes Anthropic Messages to Claude Code sellers", async () => {
    const h = newGatewayTestHarness(true);
    const codexSeller = await h.startSeller("seller-codex", ["SHOULD_NOT_ROUTE"], "seller-secret", "codex-login");
    const claudeSeller = await h.startSeller("seller-claude", ["CLAUDE_ROUTE_OK"], "seller-secret", "claude-code");

    const resp = await fetch(`${h.baseURL}/v1/messages`, {
      method: "POST",
      headers: { Authorization: "Bearer buyer-secret", "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 128, messages: [{ role: "user", content: "hi" }] }),
    });
    const body = await resp.text();
    expect(resp.status, body).toBe(200);
    expect(body).toContain("CLAUDE_ROUTE_OK");
    expect(resp.headers.get("X-Subi-Seller-Node")).toBe("seller-claude");
    const req = await claudeSeller.nextRequest();
    expect(req.path).toBe("/v1/messages");
    expect(codexSeller.pendingRequestCount()).toBe(0);
    codexSeller.close();
    claudeSeller.close();
  });

  test("web seller setup and DB-backed buyer key", async () => {
    const store = newStore();
    const h = newGatewayTestHarness(true, store);

    const register = await postJSON(`${h.baseURL}/api/web/auth/register`, { email: "seller@example.com", password: "password123" }, 201);
    const cookie = register.cookie;
    const nodeResp = await postJSON(`${h.baseURL}/api/web/seller/nodes`, { node_id: "seller-macbook-001", max_concurrency: 1 }, 201, cookie);
    expect(nodeResp.json.node.node_id).toBe("seller-macbook-001");
    const setupResp = await postJSON(`${h.baseURL}/api/web/seller/nodes/seller-macbook-001/setup-token`, {}, 201, cookie);
    const setup = await getJSON(`${h.baseURL}/api/v1/subi/seller/setup?token=${setupResp.json.setup_token}`, 200);
    expect(setup.json.subi_node_id).toBe("seller-macbook-001");

    const seller = await h.startSeller("seller-macbook-001", ["DB_KEY_OK"], setup.json.subi_seller_node_token);
    const keyResp = await postJSON(`${h.baseURL}/api/web/buyer/api-keys`, { name: "Codex" }, 201, cookie);
    const temporaryKey = await postJSON(`${h.baseURL}/api/web/buyer/api-keys`, { name: "Temporary delete test" }, 201, cookie);
    await deleteJSON(`${h.baseURL}/api/web/buyer/api-keys/${temporaryKey.json.api_key.id}`, 200, cookie);
    const keysAfterDelete = await getJSON(`${h.baseURL}/api/web/buyer/api-keys`, 200, cookie);
    expect(keysAfterDelete.json.api_keys.some((key: any) => key.id === temporaryKey.json.api_key.id)).toBe(false);
    const creditResp = await postJSON(`${h.baseURL}/api/web/buyer/credits/orders`, { amount_credits: 100 }, 201, cookie);
    expect(creditResp.json.wallet.balance_micros).toBe(100 * creditMicrosPerCredit);

    const buyerResp = await fetch(`${h.baseURL}/v1/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${keyResp.json.secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "subi-codex-subscription", stream: false, input: "hi" }),
    });
    const buyerBody = await buyerResp.text();
    expect(buyerResp.status).toBe(200);
    expect(buyerBody).toContain("DB_KEY_OK");
    await seller.nextRequest();

    const balance = await getJSON(`${h.baseURL}/api/web/buyer/balance`, 200, cookie);
    expect(balance.json.wallet.balance_micros).toBe(99 * creditMicrosPerCredit);
    const usage = await getJSON(`${h.baseURL}/api/web/buyer/usage`, 200, cookie);
    expect(usage.json.usage[0].seller_node_id).toBe("seller-macbook-001");
    expect(usage.json.usage[0].cost_micros).toBe(creditMicrosPerCredit);
    const earnings = await getJSON(`${h.baseURL}/api/web/seller/earnings`, 200, cookie);
    expect(earnings.json.earnings.balance_micros).toBe(800_000);
    seller.close();
  });

  test("seller doctor blocks unauthenticated, unprovisioned, offline, and cross-account nodes", async () => {
    const store = newStore();
    const h = newGatewayTestHarness(true, store);

    await postJSON(`${h.baseURL}/api/web/seller/nodes/seller-unprovisioned/doctor`, {}, 401);

    const sellerAccount = await postJSON(`${h.baseURL}/api/web/auth/register`, { email: "doctor-seller@example.com", password: "password123" }, 201);
    await postJSON(`${h.baseURL}/api/web/seller/nodes`, { node_id: "seller-unprovisioned", provider: "codex-login", max_concurrency: 1 }, 201, sellerAccount.cookie);
    const unprovisioned = await postJSON(`${h.baseURL}/api/web/seller/nodes/seller-unprovisioned/doctor`, {}, 200, sellerAccount.cookie);
    expect(unprovisioned.json.status).toBe("blocked");
    expect(unprovisioned.json.code).toBe("setup_not_redeemed");

    await postJSON(`${h.baseURL}/api/web/seller/nodes`, { node_id: "seller-offline", provider: "codex-login", max_concurrency: 1 }, 201, sellerAccount.cookie);
    const setupResp = await postJSON(`${h.baseURL}/api/web/seller/nodes/seller-offline/setup-token`, {}, 201, sellerAccount.cookie);
    await getJSON(`${h.baseURL}/api/v1/subi/seller/setup?token=${setupResp.json.setup_token}`, 200);
    const offline = await postJSON(`${h.baseURL}/api/web/seller/nodes/seller-offline/doctor`, {}, 200, sellerAccount.cookie);
    expect(offline.json.status).toBe("blocked");
    expect(offline.json.code).toBe("agent_offline");

    const otherAccount = await postJSON(`${h.baseURL}/api/web/auth/register`, { email: "doctor-other@example.com", password: "password123" }, 201);
    await postJSON(`${h.baseURL}/api/web/seller/nodes/seller-offline/doctor`, {}, 404, otherAccount.cookie);
  });

  test("seller doctor runs Codex probe without billing or seller earnings", async () => {
    const store = newStore();
    const h = newGatewayTestHarness(true, store);
    const account = await postJSON(`${h.baseURL}/api/web/auth/register`, { email: "doctor-codex@example.com", password: "password123" }, 201);
    await postJSON(`${h.baseURL}/api/web/seller/nodes`, { node_id: "seller-doctor-codex", provider: "codex-login", max_concurrency: 1 }, 201, account.cookie);
    const setupResp = await postJSON(`${h.baseURL}/api/web/seller/nodes/seller-doctor-codex/setup-token`, {}, 201, account.cookie);
    const setup = await getJSON(`${h.baseURL}/api/v1/subi/seller/setup?token=${setupResp.json.setup_token}`, 200);
    const seller = await h.startSeller("seller-doctor-codex", ["SUBI_SELLER_DOCTOR_OK"], setup.json.subi_seller_node_token, "codex-login");

    const doctor = await postJSON(`${h.baseURL}/api/web/seller/nodes/seller-doctor-codex/doctor`, {}, 200, account.cookie);
    expect(doctor.json.status).toBe("passed");
    expect(doctor.json.provider).toBe("codex-login");
    expect(doctor.json.checks.some((check: any) => check.id === "codex_probe" && check.status === "passed")).toBe(true);
    const req = await seller.nextRequest();
    expect(req.path).toBe("/v1/responses");
    expect(req.meta?.diagnostic).toBe(true);
    const reqBody = JSON.parse(new TextDecoder().decode(req.body));
    expect(reqBody.instructions).toContain("SUBI_SELLER_DOCTOR_OK");
    expect(reqBody.input[0].content).toContain("SUBI_SELLER_DOCTOR_OK");
    expect(reqBody.stream).toBe(true);
    expect(reqBody.store).toBe(false);

    const activity = await getJSON(`${h.baseURL}/api/web/seller/activity`, 200, account.cookie);
    expect(activity.json.activity).toHaveLength(0);
    const earnings = await getJSON(`${h.baseURL}/api/web/seller/earnings`, 200, account.cookie);
    expect(earnings.json.earnings.balance_micros).toBe(0);
    seller.close();
  });

  test("seller doctor reports Codex probe failure when marker is missing", async () => {
    const store = newStore();
    const h = newGatewayTestHarness(true, store);
    const account = await postJSON(`${h.baseURL}/api/web/auth/register`, { email: "doctor-failed@example.com", password: "password123" }, 201);
    await postJSON(`${h.baseURL}/api/web/seller/nodes`, { node_id: "seller-doctor-failed", provider: "codex-login", max_concurrency: 1 }, 201, account.cookie);
    const setupResp = await postJSON(`${h.baseURL}/api/web/seller/nodes/seller-doctor-failed/setup-token`, {}, 201, account.cookie);
    const setup = await getJSON(`${h.baseURL}/api/v1/subi/seller/setup?token=${setupResp.json.setup_token}`, 200);
    const seller = await h.startSeller("seller-doctor-failed", ["WRONG_MARKER"], setup.json.subi_seller_node_token, "codex-login");

    const doctor = await postJSON(`${h.baseURL}/api/web/seller/nodes/seller-doctor-failed/doctor`, {}, 200, account.cookie);
    expect(doctor.json.status).toBe("failed");
    expect(doctor.json.code).toBe("codex_probe_failed");
    await seller.nextRequest();
    seller.close();
  });

  test("seller doctor leaves Claude Code space but does not send Anthropic probe", async () => {
    const store = newStore();
    const h = newGatewayTestHarness(true, store);
    const account = await postJSON(`${h.baseURL}/api/web/auth/register`, { email: "doctor-claude@example.com", password: "password123" }, 201);
    await postJSON(`${h.baseURL}/api/web/seller/nodes`, { node_id: "seller-doctor-claude", provider: "claude-code", max_concurrency: 1 }, 201, account.cookie);
    const setupResp = await postJSON(`${h.baseURL}/api/web/seller/nodes/seller-doctor-claude/setup-token`, {}, 201, account.cookie);
    const setup = await getJSON(`${h.baseURL}/api/v1/subi/seller/setup?token=${setupResp.json.setup_token}`, 200);
    const seller = await h.startSeller("seller-doctor-claude", ["SHOULD_NOT_RUN"], setup.json.subi_seller_node_token, "claude-code");

    const doctor = await postJSON(`${h.baseURL}/api/web/seller/nodes/seller-doctor-claude/doctor`, {}, 200, account.cookie);
    expect(doctor.json.status).toBe("blocked");
    expect(doctor.json.code).toBe("provider_not_ready");
    expect(seller.pendingRequestCount()).toBe(0);
    seller.close();
  });

  test("DB-backed buyer without credits receives 402", async () => {
    const store = newStore();
    const h = newGatewayTestHarness(true, store);
    const register = await postJSON(`${h.baseURL}/api/web/auth/register`, { email: "buyer-zero@example.com", password: "password123" }, 201);
    const keyResp = await postJSON(`${h.baseURL}/api/web/buyer/api-keys`, { name: "Codex" }, 201, register.cookie);
    const buyerResp = await fetch(`${h.baseURL}/v1/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${keyResp.json.secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "subi-codex-subscription", stream: false, input: "hi" }),
    });
    const body = await buyerResp.text();
    expect(buyerResp.status).toBe(402);
    expect(body).toContain("insufficient credits");
    const balance = await getJSON(`${h.baseURL}/api/web/buyer/balance`, 200, register.cookie);
    expect(balance.json.wallet.balance_micros).toBe(0);
  });

  test("serves seller installer and agent downloads", async () => {
    const h = newGatewayTestHarness(true);
    await mkdir("downloads", { recursive: true });
    cleanupPaths.push("downloads/seller-agent");
    await Bun.write("downloads/seller-agent", "seller-binary");

    const installResp = await fetch(`${h.baseURL}/api/v1/subi/seller/install.sh`);
    const installScript = await installResp.text();
    expect(installResp.status, installScript).toBe(200);
    expect(installScript).toContain("--service-name");

    const downloadResp = await fetch(`${h.baseURL}/api/v1/subi/seller/downloads/seller-agent`);
    const downloadBody = await downloadResp.text();
    expect(downloadResp.status, downloadBody).toBe(200);
    expect(downloadResp.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(downloadBody).toBe("seller-binary");

    const missingResp = await fetch(`${h.baseURL}/api/v1/subi/seller/downloads/not-allowed`);
    expect(missingResp.status).toBe(404);
  });

  test("serves root role chooser and console redirects", async () => {
    const h = newGatewayTestHarness(true);

    const rootResp = await fetch(`${h.baseURL}/`);
    const rootBody = await rootResp.text();
    expect(rootResp.status, rootBody).toBe(200);
    expect(rootResp.headers.get("Content-Type")).toContain("text/html");
    expect(rootBody).toContain("你想用 Subi");
    expect(rootBody).toContain("使用顶级编程模型");
    expect(rootBody).toContain('id="network-map"');
    expect(rootBody).toContain("./seller-market/app.js");

    const assetResp = await fetch(`${h.baseURL}/assets/subi-mark.svg`);
    const assetBody = await assetResp.text();
    expect(assetResp.status, assetBody).toBe(200);
    expect(assetResp.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(assetBody).toContain("<svg");

    const buyerRedirect = await fetch(`${h.baseURL}/buyer`, { redirect: "manual" });
    expect(buyerRedirect.status).toBe(307);
    expect(buyerRedirect.headers.get("Location")).toBe(`${h.baseURL}/buyer/`);

    const sellerRedirect = await fetch(`${h.baseURL}/seller`, { redirect: "manual" });
    expect(sellerRedirect.status).toBe(307);
    expect(sellerRedirect.headers.get("Location")).toBe(`${h.baseURL}/seller/`);
  });
});

function newGatewayTestHarness(sessionContextEnabled: boolean, store?: Store) {
  resetGatewayRegistryForTests();
  const cfg: GatewayConfig = {
    addr: "127.0.0.1:0",
    buyer_api_key: "buyer-secret",
    seller_node_token: "seller-secret",
    db_path: "",
    dev_static_keys: false,
    public_gateway_ws_url: "",
    session_cookie_name: "subi_session",
    store,
    session_context_enabled: sessionContextEnabled,
    session_max_turns: 20,
    session_max_chars: 20000,
    session_store: new SubiSessionStore(20, 20000),
    request_cost_micros: creditMicrosPerCredit,
    seller_earning_micros: 800_000,
    platform_fee_micros: 150_000,
    reserve_micros: 50_000,
    web_dir: "../web",
  };
  const server = createGatewayServer(cfg);
  servers.push(server);
  const baseURL = server.url.toString().replace(/\/$/, "");
  return {
    baseURL,
    async startSeller(nodeID: string, responses: string[], token = "seller-secret", upstreamMode = "codex-login", options: GatewayTestSellerOptions = {}) {
      const wsURL = baseURL.replace(/^http/, "ws") + `/api/v1/subi/seller/agent/ws?token=${encodeURIComponent(token)}`;
      const seller = new GatewayTestSeller(wsURL, nodeID, responses, upstreamMode, options);
      await seller.connect();
      return seller;
    },
    async post(sessionID: string, input: string, expectedStatus = 200) {
      const resp = await fetch(`${baseURL}/v1/responses`, {
        method: "POST",
        headers: { Authorization: "Bearer buyer-secret", "Content-Type": "application/json", "x-session-id": sessionID },
        body: JSON.stringify({ model: "subi-codex-subscription", stream: false, input }),
      });
      const body = await resp.text();
      expect(resp.status, body).toBe(expectedStatus);
      return { headers: resp.headers, body, status: resp.status };
    },
    async postRaw(sessionID: string, payload: unknown, expectedStatus = 200) {
      const resp = await fetch(`${baseURL}/v1/responses`, {
        method: "POST",
        headers: { Authorization: "Bearer buyer-secret", "Content-Type": "application/json", "x-session-id": sessionID },
        body: JSON.stringify(payload),
      });
      const body = await resp.text();
      expect(resp.status, body).toBe(expectedStatus);
      return { headers: resp.headers, body, status: resp.status };
    },
  };
}

interface GatewayTestSellerOptions {
  statusCode?: number;
  upstreamModeHeader?: string;
  autoRespond?: boolean;
}

class GatewayTestSeller {
  private ws?: WebSocket;
  private requests: SubiEnvelope[] = [];
  private waiters: Array<(env: SubiEnvelope) => void> = [];
  private next = 0;

  constructor(
    private readonly wsURL: string,
    private readonly nodeID: string,
    private readonly responses: string[],
    private readonly upstreamMode: string,
    private readonly options: GatewayTestSellerOptions = {},
  ) {}

  async connect(): Promise<void> {
    const ws = new WebSocket(this.wsURL);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("seller websocket failed")), { once: true });
    });
    sendEnvelope(ws as unknown as JSONSocket, {
      type: subiEnvelopeAgentHello,
      node_id: this.nodeID,
      version: "test",
      max_concurrency: 1,
      meta: { upstream_mode: this.upstreamMode },
    });
    ws.addEventListener("message", (event) => this.handleMessage(String(event.data)));
    await delay(50);
  }

  close(): void {
    this.ws?.close();
  }

  async nextRequest(): Promise<SubiEnvelope> {
    const existing = this.requests.shift();
    if (existing) return existing;
    return Promise.race([
      new Promise<SubiEnvelope>((resolve) => this.waiters.push(resolve)),
      delay(2000).then(() => {
        throw new Error("timed out waiting for seller request");
      }),
    ]);
  }

  pendingRequestCount(): number {
    return this.requests.length;
  }

  private handleMessage(raw: string): void {
    const env = decodeEnvelope(raw);
    if (env.type !== subiEnvelopeRequestStart) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter(env);
    else this.requests.push(env);
    if (this.options.autoRespond === false) return;
    const socket = this.ws as unknown as JSONSocket;
    sendEnvelope(socket, {
      type: subiEnvelopeResponseStart,
      request_id: env.request_id,
      status_code: this.options.statusCode ?? 200,
      headers: { "Content-Type": ["application/json"], "X-Subi-Upstream-Mode": [this.options.upstreamModeHeader || this.upstreamMode] },
    });
    const text = this.responses[Math.min(this.next, this.responses.length - 1)] ?? "OK";
    this.next++;
    const body = new TextEncoder().encode(
      JSON.stringify({
        output: [{ role: "assistant", content: [{ type: "output_text", text }] }],
      }),
    );
    sendEnvelope(socket, { type: subiEnvelopeResponseChunk, request_id: env.request_id, data: body });
    sendEnvelope(socket, { type: subiEnvelopeResponseEnd, request_id: env.request_id });
  }
}

function newStore(): Store {
  const store = new Store(`${Bun.env.TMPDIR || "/tmp"}/subi-gateway-${crypto.randomUUID()}.db`);
  stores.push(store);
  return store;
}

async function postJSON(url: string, payload: unknown, expectedStatus: number, cookie = "") {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(payload),
  });
  const text = await resp.text();
  expect(resp.status, text).toBe(expectedStatus);
  return { json: JSON.parse(text), cookie: resp.headers.get("set-cookie") || cookie };
}

async function getJSON(url: string, expectedStatus: number, cookie = "") {
  const resp = await fetch(url, { headers: cookie ? { Cookie: cookie } : undefined });
  const text = await resp.text();
  expect(resp.status, text).toBe(expectedStatus);
  return { json: JSON.parse(text), cookie: resp.headers.get("set-cookie") || cookie };
}

async function deleteJSON(url: string, expectedStatus: number, cookie = "") {
  const resp = await fetch(url, {
    method: "DELETE",
    headers: cookie ? { Cookie: cookie } : undefined,
  });
  const text = await resp.text();
  expect(resp.status, text).toBe(expectedStatus);
  return { json: JSON.parse(text), cookie: resp.headers.get("set-cookie") || cookie };
}
