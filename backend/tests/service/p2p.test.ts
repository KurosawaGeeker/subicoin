import { describe, expect, test } from "bun:test";
import {
  AsyncQueue,
  defaultSubiAgentStaleAfterMS,
  SubiP2PError,
  SubiSellerNodeRegistry,
  subiEnvelopeResponseError,
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
});
