import { describe, expect, test } from "bun:test";
import {
  AsyncQueue,
  bagToHeaders,
  defaultSubiAgentStaleAfterMS,
  decodeEnvelope,
  SubiP2PError,
  SubiSellerNodeRegistry,
  subiEnvelopeResponseError,
  type JSONSocket,
  type SubiP2PRequest,
} from "../../src/service/p2p";

describe("Subi seller registry", () => {
  test("keeps sticky session on same seller while busy", () => {
    const registry = new SubiSellerNodeRegistry();
    registry.registerNodeForTest({ id: "seller-a" });
    const first = registry.reserveNodeForTest("session-1", "req-1");
    expect(first.nodeID).toBe("seller-a");
    registry.registerNodeForTest({ id: "seller-b" });
    expect(() => registry.reserveNodeForTest("session-1", "req-2")).toThrow(SubiP2PError);
    registry.releaseRequestForTest("seller-a", "req-1");
    const second = registry.reserveNodeForTest("session-1", "req-3");
    expect(second.nodeID).toBe("seller-a");
  });

  test("falls back from stale sticky seller and records previous node", () => {
    const registry = new SubiSellerNodeRegistry();
    registry.registerNodeForTest({ id: "seller-a", lastSeen: Date.now() - defaultSubiAgentStaleAfterMS - 1000 });
    (registry as any).sticky.set("session-1", "seller-a");
    registry.registerNodeForTest({ id: "seller-b" });
    const next = registry.reserveNodeForTest("session-1", "req-1");
    expect(next.nodeID).toBe("seller-b");
    expect(next.previousNodeID).toBe("seller-a");
    expect(registry.stickyNodeForTest("session-1")).toBe("seller-b");
  });

  test("unregister emits error for pending request", async () => {
    const registry = new SubiSellerNodeRegistry();
    registry.registerNodeForTest({ id: "seller-a" });
    const queue = new AsyncQueue<any>();
    (registry as any).requests.set("req-1", { queue, closed: false });
    (registry as any).nodes.get("seller-a").activeRequests.add("req-1");
    registry.unregisterNodeForTest("seller-a");
    const ev = await queue.next();
    expect(ev.value.type).toBe(subiEnvelopeResponseError);
    expect(ev.value.error).toBe("seller agent disconnected");
    expect((await queue.next()).done).toBe(true);
  });

  test("respects max concurrency", () => {
    const registry = new SubiSellerNodeRegistry();
    registry.registerNodeForTest({ id: "seller-a", maxConcurrency: 2 });
    expect(registry.reserveNodeForTest("", "req-1").nodeID).toBe("seller-a");
    expect(registry.reserveNodeForTest("", "req-2").nodeID).toBe("seller-a");
    expect(() => registry.reserveNodeForTest("", "req-3")).toThrow(SubiP2PError);
    registry.releaseRequestForTest("seller-a", "req-1");
    expect(registry.reserveNodeForTest("", "req-3").nodeID).toBe("seller-a");
  });

  test("does not dispatch buyer traffic to seller-side Codex agent runtime modes", () => {
    const registry = new SubiSellerNodeRegistry();
    registry.registerNodeForTest({ id: "seller-app-server", upstreamMode: "codex-app-server" });
    registry.registerNodeForTest({ id: "seller-exec", upstreamMode: "codex-exec" });
    expect(() => registry.reserveNodeForTest("", "req-unsafe")).toThrow(SubiP2PError);
    registry.registerNodeForTest({ id: "seller-login", upstreamMode: "codex-login" });
    expect(registry.reserveNodeForTest("", "req-safe").nodeID).toBe("seller-login");
  });

  test("dispatches Anthropic Messages only to Claude Code sellers", () => {
    const registry = new SubiSellerNodeRegistry();
    registry.registerNodeForTest({ id: "seller-codex", upstreamMode: "codex-login" });
    registry.registerNodeForTest({ id: "seller-claude", upstreamMode: "claude-code" });

    expect(registry.reserveNodeForPathForTest("session-a", "req-claude", "/v1/messages").nodeID).toBe("seller-claude");
    expect(registry.reserveNodeForPathForTest("session-b", "req-codex", "/v1/responses").nodeID).toBe("seller-codex");
    expect(() => registry.reserveNodeForPathForTest("session-c", "req-chat", "/v1/chat/completions")).toThrow(SubiP2PError);
  });

  test("doctor dispatch targets a specific node without changing sticky session", async () => {
    const registry = new SubiSellerNodeRegistry();
    registry.registerNodeForTest({ id: "seller-a", upstreamMode: "codex-login" });
    const sticky = registry.reserveNodeForPathForTest("session-a", "req-sticky", "/v1/responses");
    expect(sticky.nodeID).toBe("seller-a");
    registry.releaseRequestForTest("seller-a", "req-sticky");

    const socket = new CollectingSocket();
    registry.attachSocket(socket);
    await registry.handleSocketMessage(
      socket,
      JSON.stringify({
        type: "agent_hello",
        node_id: "seller-b",
        version: "test",
        max_concurrency: 1,
        meta: { upstream_mode: "codex-login" },
      }),
    );

    const dispatch = registry.dispatchToNodeForTest("seller-b", doctorRequest("req-doctor"));
    expect(dispatch.node_id).toBe("seller-b");
    expect(registry.stickyNodeForTest("session-a")).toBe("seller-a");
    expect(decodeEnvelope(socket.sent[0]).path).toBe("/v1/responses");
    dispatch.done();
  });

  test("doctor dispatch reports busy and provider mismatch", async () => {
    const registry = new SubiSellerNodeRegistry();
    const codexSocket = new CollectingSocket();
    registry.attachSocket(codexSocket);
    await registry.handleSocketMessage(
      codexSocket,
      JSON.stringify({
        type: "agent_hello",
        node_id: "seller-codex",
        version: "test",
        max_concurrency: 1,
        meta: { upstream_mode: "codex-login" },
      }),
    );

    const held = registry.dispatchToNodeForTest("seller-codex", doctorRequest("req-held"));
    expect(() => registry.dispatchToNodeForTest("seller-codex", doctorRequest("req-busy"))).toThrow(SubiP2PError);
    held.done();

    const claudeSocket = new CollectingSocket();
    registry.attachSocket(claudeSocket);
    await registry.handleSocketMessage(
      claudeSocket,
      JSON.stringify({
        type: "agent_hello",
        node_id: "seller-claude",
        version: "test",
        max_concurrency: 1,
        meta: { upstream_mode: "claude-code" },
      }),
    );
    expect(() => registry.dispatchToNodeForTest("seller-claude", doctorRequest("req-mismatch"))).toThrow(SubiP2PError);
  });

  test("does not forward transport response headers from seller agents", () => {
    const headers = bagToHeaders({
      "Content-Type": ["application/json"],
      "Content-Encoding": ["gzip"],
      "Content-Length": ["100"],
      Connection: ["keep-alive"],
      "Transfer-Encoding": ["chunked"],
    });

    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("Content-Encoding")).toBeNull();
    expect(headers.get("Content-Length")).toBeNull();
    expect(headers.get("Connection")).toBeNull();
    expect(headers.get("Transfer-Encoding")).toBeNull();
  });
});

class CollectingSocket implements JSONSocket {
  sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {}
}

function doctorRequest(requestID: string): SubiP2PRequest {
  return {
    request_id: requestID,
    method: "POST",
    path: "/v1/responses",
    headers: { "Content-Type": ["application/json"] },
    body: new TextEncoder().encode(JSON.stringify({ model: "gpt-5.5", input: "Reply exactly: SUBI_SELLER_DOCTOR_OK", stream: false })),
    stream: false,
    timeout_ms: 50,
    session_hash: "doctor-session",
    meta: { diagnostic: true },
  };
}
