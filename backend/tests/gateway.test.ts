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

  test("no seller returns readable error", async () => {
    const h = newGatewayTestHarness(true);
    const resp = await h.post("no-seller", "should not run", 503);
    expect(resp.body).toContain("no available seller node");
    expect(resp.headers.get("Content-Type")?.split(";")[0]).toBe("application/json");
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
    web_dir: "web",
  };
  const server = createGatewayServer(cfg);
  servers.push(server);
  const baseURL = server.url.toString().replace(/\/$/, "");
  return {
    baseURL,
    async startSeller(nodeID: string, responses: string[], token = "seller-secret") {
      const wsURL = baseURL.replace(/^http/, "ws") + `/api/v1/subi/seller/agent/ws?token=${encodeURIComponent(token)}`;
      const seller = new GatewayTestSeller(wsURL, nodeID, responses);
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
  };
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
  ) {}

  async connect(): Promise<void> {
    const ws = new WebSocket(this.wsURL);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("seller websocket failed")), { once: true });
    });
    sendEnvelope(ws as unknown as JSONSocket, { type: subiEnvelopeAgentHello, node_id: this.nodeID, version: "test", max_concurrency: 1 });
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

  private handleMessage(raw: string): void {
    const env = decodeEnvelope(raw);
    if (env.type !== subiEnvelopeRequestStart) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter(env);
    else this.requests.push(env);
    const socket = this.ws as unknown as JSONSocket;
    sendEnvelope(socket, {
      type: subiEnvelopeResponseStart,
      request_id: env.request_id,
      status_code: 200,
      headers: { "Content-Type": ["application/json"], "X-Subi-Upstream-Mode": ["fake"] },
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
