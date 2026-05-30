import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { CodexAppServerUpstream, handleRequest, type AgentConfig } from "../src/seller-agent";
import { decodeEnvelope, subiEnvelopeResponseChunk, subiEnvelopeResponseEnd, subiEnvelopeResponseStart, type JSONSocket, type SubiEnvelope } from "../src/service/p2p";

const cleanupPaths: string[] = [];
const upstreams: CodexAppServerUpstream[] = [];

afterEach(async () => {
  for (const upstream of upstreams.splice(0)) await upstream.close();
  for (const path of cleanupPaths.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("seller-agent codex app-server upstream", () => {
  test("uses persistent app-server JSON-RPC instead of per-request codex exec", async () => {
    const dir = await mkdtemp(`${tmpdir()}/subi-fake-codex-`);
    cleanupPaths.push(dir);
    const fakeCodex = `${dir}/fake-codex`;
    await Bun.write(fakeCodex, fakeCodexAppServerSource());
    await chmod(fakeCodex, 0o700);

    const cfg: AgentConfig = {
      gateway_ws_url: "ws://127.0.0.1:1/api/v1/subi/seller/agent/ws",
      node_token: "seller-token",
      node_id: "seller-app-server-test",
      upstream_mode: "codex-app-server",
      worker_count: 1,
      worker_queue_len: 1,
      local_base_url: "",
      local_api_key: "",
      codex_bin: fakeCodex,
      codex_model: "fake-model",
      codex_workdir: dir,
      codex_sandbox: "read-only",
      codex_extra_args: [],
      app_server_bin: fakeCodex,
      app_server_host: "127.0.0.1",
      app_server_port_base: 19700,
      app_server_startup_timeout_ms: 5000,
      app_server_sticky_threads: true,
    };
    const upstream = new CodexAppServerUpstream(cfg, 1);
    upstreams.push(upstream);
    await upstream.ensure();

    const socket = new CollectingSocket();
    await handleRequest(cfg, socket, requestEnvelope("req-1", "hello app-server"), upstream);

    const start = socket.sent.find((env) => env.type === subiEnvelopeResponseStart);
    expect(start?.status_code).toBe(200);
    expect(start?.headers?.["X-Subi-Upstream-Mode"]).toEqual(["codex-app-server"]);
    const chunk = socket.sent.find((env) => env.type === subiEnvelopeResponseChunk);
    const body = JSON.parse(new TextDecoder().decode(chunk?.data));
    expect(body.output_text).toBe("APP_SERVER_OK: hello app-server");
    expect(socket.sent.some((env) => env.type === subiEnvelopeResponseEnd)).toBe(true);
  });
});

class CollectingSocket implements JSONSocket {
  sent: SubiEnvelope[] = [];
  send(data: string): void {
    this.sent.push(decodeEnvelope(data));
  }
  close(): void {}
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

function fakeCodexAppServerSource(): string {
  return `#!/usr/bin/env bun
const args = Bun.argv.slice(2);
if (args[0] !== "app-server") {
  console.error("fake codex only supports app-server");
  process.exit(2);
}
const listen = args[args.indexOf("--listen") + 1];
const url = new URL(listen);
let threadSeq = 0;
const server = Bun.serve({
  hostname: url.hostname,
  port: Number(url.port),
  fetch(req, server) {
    const path = new URL(req.url).pathname;
    if (path === "/readyz" || path === "/healthz") return new Response("ok");
    if (server.upgrade(req)) return undefined;
    return new Response("not found", { status: 404 });
  },
  websocket: {
    message(ws, raw) {
      const msg = JSON.parse(String(raw));
      if (msg.method === "initialize") {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
        return;
      }
      if (msg.method === "initialized") return;
      if (msg.method === "thread/start") {
        threadSeq += 1;
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: "thread-" + threadSeq } } }));
        return;
      }
      if (msg.method === "turn/start") {
        const prompt = msg.params?.input?.[0]?.text ?? "";
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: "turn-1", status: "inProgress", items: [], error: null } } }));
        queueMicrotask(() => {
          ws.send(JSON.stringify({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: msg.params.threadId, turnId: "turn-1", itemId: "item-1", delta: "APP_SERVER_OK: " + prompt } }));
          ws.send(JSON.stringify({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: msg.params.threadId, turn: { id: "turn-1", status: "completed", items: [], error: null } } }));
        });
      }
    },
  },
});
console.error("fake codex app-server listening " + server.hostname + ":" + server.port);
`;
}
