import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { handleRequest, runSellerAgentUntilClosed, validateAgentConfig, type AgentConfig } from "../src/seller-agent";
import { decodeEnvelope, subiEnvelopeResponseChunk, subiEnvelopeResponseStart, type JSONSocket, type SubiEnvelope } from "../src/service/p2p";
import { delay } from "../src/utils";

const cleanupPaths: string[] = [];
const servers: Bun.Server<any>[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const path of cleanupPaths.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("seller-agent codex-login upstream", () => {
  test("rejects legacy local execution upstreams by default", async () => {
    expect(() => validateAgentConfig(agentConfig({ upstream_mode: "codex-app-server" }))).toThrow("must be codex-login");
    const socket = new CollectingSocket();
    await handleRequest(agentConfig({ upstream_mode: "codex-exec" }), socket, requestEnvelope("req-unsafe", "do not run locally"));
    const error = socket.sent.find((sent) => sent.type === "response_error");
    expect(error?.error).toContain("unsupported seller upstream mode");
  });

  test("stops cleanly when aborted", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, server) {
        if (server.upgrade(req)) return undefined;
        return new Response("not found", { status: 404 });
      },
      websocket: {
        message() {},
      },
    });
    servers.push(server);
    const controller = new AbortController();
    const done = runSellerAgentUntilClosed(
      agentConfig({
        gateway_ws_url: server.url.toString().replace(/^http/, "ws"),
        upstream_mode: "codex-login",
      }),
      controller.signal,
    );

    await delay(50);
    controller.abort();

    await Promise.race([
      done,
      delay(1000).then(() => {
        throw new Error("seller-agent did not stop after abort");
      }),
    ]);
  });

  test("proxies Responses requests with Codex ChatGPT auth and no local Codex runtime", async () => {
    const dir = await mkdtemp(`${tmpdir()}/subi-codex-home-`);
    cleanupPaths.push(dir);
    const accessToken = fakeJWT({ exp: Math.floor(Date.now() / 1000) + 3600 });
    await writeAuth(dir, accessToken, "refresh-token", "account-123");
    let upstreamPath = "";
    let upstreamBody = "";
    let upstreamHeaders: Record<string, string> = {};
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        upstreamPath = `${url.pathname}${url.search}`;
        upstreamBody = await req.text();
        upstreamHeaders = Object.fromEntries(req.headers.entries());
        return new Response(JSON.stringify({ output_text: "LOGIN_PROXY_OK" }), { headers: { "Content-Type": "application/json" } });
      },
    });
    servers.push(server);

    const cfg = agentConfig({
      upstream_mode: "codex-login",
      codex_home: dir,
      codex_base_url: `${server.url.toString().replace(/\/$/, "")}/backend-api/codex`,
    });
    const socket = new CollectingSocket();
    const env = requestEnvelope("req-login", "hello login");
    env.path = "/v1/responses?trace=1";
    env.headers = {
      Authorization: ["Bearer buyer-key"],
      "X-Api-Key": ["buyer-key"],
      "OpenAI-Organization": ["buyer-org"],
      "Content-Type": ["application/json"],
    };

    await handleRequest(cfg, socket, env);

    expect(upstreamPath).toBe("/backend-api/codex/responses?trace=1");
    expect(upstreamBody).toBe(new TextDecoder().decode(env.body));
    expect(upstreamHeaders.authorization).toBe(`Bearer ${accessToken}`);
    expect(upstreamHeaders["chatgpt-account-id"]).toBe("account-123");
    expect(upstreamHeaders["x-api-key"]).toBeUndefined();
    expect(upstreamHeaders["openai-organization"]).toBeUndefined();
    expect(upstreamHeaders["user-agent"]).toContain("subi-seller-agent");
    const start = socket.sent.find((sent) => sent.type === subiEnvelopeResponseStart);
    expect(start?.headers?.["X-Subi-Upstream-Mode"]).toEqual(["codex-login"]);
    const chunk = socket.sent.find((sent) => sent.type === subiEnvelopeResponseChunk);
    expect(new TextDecoder().decode(chunk?.data)).toContain("LOGIN_PROXY_OK");
  });

  test("strips gateway metadata before forwarding to Codex backend", async () => {
    const dir = await mkdtemp(`${tmpdir()}/subi-codex-home-`);
    cleanupPaths.push(dir);
    await writeAuth(dir, fakeJWT({ exp: Math.floor(Date.now() / 1000) + 3600 }), "refresh-token", "account-123");
    let upstreamBody: any;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        upstreamBody = await req.json();
        return new Response(JSON.stringify({ output_text: "METADATA_STRIPPED_OK" }), { headers: { "Content-Type": "application/json" } });
      },
    });
    servers.push(server);

    const cfg = agentConfig({
      codex_home: dir,
      codex_base_url: `${server.url.toString().replace(/\/$/, "")}/backend-api/codex`,
    });
    const socket = new CollectingSocket();
    const env = requestEnvelope("req-metadata", "hello metadata");
    env.body = new TextEncoder().encode(
      JSON.stringify({
        model: "gpt-5.5",
        input: "hello metadata",
        stream: true,
        metadata: { subi_context_injected: true, session_id: "internal-session" },
      }),
    );

    await handleRequest(cfg, socket, env);

    expect(upstreamBody.metadata).toBeUndefined();
    expect(upstreamBody.input).toBe("hello metadata");
    const chunk = socket.sent.find((sent) => sent.type === subiEnvelopeResponseChunk);
    expect(new TextDecoder().decode(chunk?.data)).toContain("METADATA_STRIPPED_OK");
  });

  test("refreshes Codex ChatGPT tokens and retries unauthorized requests", async () => {
    const dir = await mkdtemp(`${tmpdir()}/subi-codex-home-`);
    cleanupPaths.push(dir);
    const staleToken = fakeJWT({ exp: Math.floor(Date.now() / 1000) + 3600, token: "stale" });
    const refreshedToken = fakeJWT({ exp: Math.floor(Date.now() / 1000) + 3600, token: "refreshed" });
    await writeAuth(dir, staleToken, "refresh-old", "account-refresh");
    let refreshRequest: any;
    let responseCalls = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/oauth/token") {
          refreshRequest = await req.json();
          return new Response(
            JSON.stringify({
              access_token: refreshedToken,
              refresh_token: "refresh-new",
              id_token: fakeIDToken("account-refresh"),
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        }
        responseCalls++;
        if (req.headers.get("authorization") !== `Bearer ${refreshedToken}`) {
          return new Response(JSON.stringify({ error: { message: "expired" } }), { status: 401, headers: { "Content-Type": "application/json" } });
        }
        return new Response(JSON.stringify({ output_text: "REFRESHED_OK" }), { headers: { "Content-Type": "application/json" } });
      },
    });
    servers.push(server);

    const cfg = agentConfig({
      upstream_mode: "codex-login",
      codex_home: dir,
      codex_base_url: `${server.url.toString().replace(/\/$/, "")}/backend-api/codex`,
      codex_refresh_url: `${server.url.toString().replace(/\/$/, "")}/oauth/token`,
    });
    const socket = new CollectingSocket();
    await handleRequest(cfg, socket, requestEnvelope("req-refresh", "hello refresh"));

    expect(refreshRequest).toMatchObject({ client_id: "app_EMoamEEZ73f0CkXaXp7hrann", grant_type: "refresh_token", refresh_token: "refresh-old" });
    expect(responseCalls).toBe(2);
    const auth = JSON.parse(await Bun.file(`${dir}/auth.json`).text());
    expect(auth.tokens.access_token).toBe(refreshedToken);
    expect(auth.tokens.refresh_token).toBe("refresh-new");
    const chunk = socket.sent.find((sent) => sent.type === subiEnvelopeResponseChunk);
    expect(new TextDecoder().decode(chunk?.data)).toContain("REFRESHED_OK");
  });
});

class CollectingSocket implements JSONSocket {
  sent: SubiEnvelope[] = [];
  send(data: string): void {
    this.sent.push(decodeEnvelope(data));
  }
  close(): void {}
}

function agentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    gateway_ws_url: "ws://127.0.0.1:1/api/v1/subi/seller/agent/ws",
    node_token: "seller-token",
    node_id: "seller-test",
    upstream_mode: "codex-login",
    worker_count: 1,
    worker_queue_len: 1,
    codex_home: `${tmpdir()}/missing-codex-home`,
    codex_base_url: "https://chatgpt.com/backend-api/codex",
    codex_refresh_url: "https://auth.openai.com/oauth/token",
    ...overrides,
  };
}

function requestEnvelope(requestID: string, input: string): SubiEnvelope {
  return {
    type: "request_start",
    request_id: requestID,
    method: "POST",
    path: "/v1/responses",
    headers: { "Content-Type": ["application/json"] },
    body: new TextEncoder().encode(JSON.stringify({ model: "subi-codex-subscription", input })),
    stream: false,
    timeout_ms: 10000,
    session_hash: "session-hash",
  };
}

async function writeAuth(dir: string, accessToken: string, refreshToken: string, accountID: string): Promise<void> {
  await Bun.write(
    `${dir}/auth.json`,
    JSON.stringify(
      {
        auth_mode: "chatgpt",
        last_refresh: new Date().toISOString(),
        tokens: {
          access_token: accessToken,
          refresh_token: refreshToken,
          id_token: fakeIDToken(accountID),
          account_id: accountID,
        },
      },
      null,
      2,
    ),
  );
}

function fakeIDToken(accountID: string): string {
  return fakeJWT({
    "https://api.openai.com/auth": {
      chatgpt_account_id: accountID,
      chatgpt_account_is_fedramp: false,
    },
  });
}

function fakeJWT(payload: Record<string, unknown>): string {
  return [base64URL({ alg: "none", typ: "JWT" }), base64URL(payload), "signature"].join(".");
}

function base64URL(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
