import { describe, expect, test } from "bun:test";
import { Store, creditMicrosPerCredit } from "../src/store";
import { isStoreError } from "../src/errors";

function newStore(): Store {
  return new Store(`${Bun.env.TMPDIR || "/tmp"}/subi-test-${crypto.randomUUID()}.db`);
}

describe("Store", () => {
  test("covers user, buyer key, and seller setup flow", () => {
    const store = newStore();
    try {
      const user = store.registerUser("seller@example.com", "password123");
      expect(user.email).toBe("seller@example.com");
      expect(() => store.registerUser("seller@example.com", "password123")).toThrow();
      const authenticated = store.authenticateUser("seller@example.com", "password123");
      expect(authenticated.id).toBe(user.id);
      const session = store.createWebSession(user.id, 60_000);
      expect(store.userBySession(session.session).id).toBe(user.id);
      const apiKey = store.createBuyerAPIKey(user.id, "Codex");
      expect(apiKey.secret).toStartWith("sk-subi_");
      expect(store.authenticateBuyerAPIKey(apiKey.secret).user_id).toBe(user.id);
      const temporaryKey = store.createBuyerAPIKey(user.id, "Temporary");
      expect(store.listBuyerAPIKeys(user.id).some((key) => key.id === temporaryKey.api_key.id)).toBe(true);
      store.deleteBuyerAPIKey(user.id, temporaryKey.api_key.id);
      expect(store.listBuyerAPIKeys(user.id).some((key) => key.id === temporaryKey.api_key.id)).toBe(false);
      expect(() => store.authenticateBuyerAPIKey(temporaryKey.secret)).toThrow();
      const node = store.createSellerNode(user.id, "seller-macbook-001", "codex-login", 1);
      expect(node.node_id).toBe("seller-macbook-001");
      const setup = store.createSellerSetupToken(user.id, node.node_id, 60_000);
      expect(setup.setup_token).toStartWith("subi_setup_");
      const config = store.redeemSellerSetupToken(setup.setup_token);
      expect(config.node_id).toBe(node.node_id);
      expect(config.node_token).toStartWith("seller_node_");
      expect(() => store.redeemSellerSetupToken(setup.setup_token)).toThrow();
      const sellerNode = store.authenticateSellerNode(config.node_id, config.node_token);
      expect(sellerNode.status).toBe("online");
      expect(store.listSellerNodes(user.id)[0].status).toBe("online");
    } finally {
      store.close();
    }
  });

  test("covers credit ledger and seller earnings flow", () => {
    const store = newStore();
    try {
      const buyer = store.registerUser("buyer@example.com", "password123");
      const seller = store.registerUser("seller@example.com", "password123");
      const apiKey = store.createBuyerAPIKey(buyer.id, "Codex");
      const node = store.createSellerNode(seller.id, "seller-001", "codex-login", 1);
      expect(store.getBuyerCreditWallet(buyer.id).balance_micros).toBe(0);
      try {
        store.reserveBuyerCreditsForRequest(buyer.id, "req-empty", creditMicrosPerCredit, "test");
        throw new Error("expected insufficient credits");
      } catch (error) {
        expect(isStoreError(error, "insufficient_credits")).toBe(true);
      }
      const recharge = store.createMockCreditOrder(buyer.id, 100 * creditMicrosPerCredit);
      expect(recharge.order.status).toBe("paid");
      expect(recharge.wallet.balance_micros).toBe(100 * creditMicrosPerCredit);
      const debit = store.reserveBuyerCreditsForRequest(buyer.id, "req-refund", creditMicrosPerCredit, "test reserve");
      expect(debit.ledger_entry.type).toBe("debit");
      expect(debit.wallet.balance_micros).toBe(99 * creditMicrosPerCredit);
      const refund = store.refundBuyerCreditsForRequest(buyer.id, "req-refund", "failed");
      expect(refund.ledger_entry.type).toBe("refund");
      expect(refund.wallet.balance_micros).toBe(100 * creditMicrosPerCredit);
      store.reserveBuyerCreditsForRequest(buyer.id, "req-success", creditMicrosPerCredit, "test reserve");
      const settled = store.recordSuccessfulRequestFillAndSellerEarning({
        request_id: "req-success",
        buyer_user_id: buyer.id,
        buyer_api_key_id: apiKey.api_key.id,
        seller_node_id: node.node_id,
        path: "/v1/responses",
        status_code: 200,
        stream: false,
        duration_ms: 123,
        time_to_first_chunk_ms: 12,
        bytes_out: 456,
        cost_micros: creditMicrosPerCredit,
        seller_earning_micros: 800_000,
        platform_fee_micros: 150_000,
        reserve_micros: 50_000,
      });
      expect(settled.earning.amount_micros).toBe(800_000);
      expect(store.getBuyerCreditWallet(buyer.id).balance_micros).toBe(99 * creditMicrosPerCredit);
      expect(store.listBuyerCreditLedger(buyer.id, 10)).toHaveLength(4);
      expect(store.listBuyerUsage(buyer.id, 10)[0].seller_node_id).toBe("seller-001");
      expect(store.getSellerEarningsSummary(seller.id).balance_micros).toBe(800_000);
      expect(store.listSellerActivity(seller.id, 10)[0].request_id).toBe("req-success");
    } finally {
      store.close();
    }
  });
});
