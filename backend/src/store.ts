import { Database } from "bun:sqlite";
import { errConflict, errInsufficientCredits, errInvalid, errNotFound, errUnauthorized, isStoreError } from "./errors";
import { hashSecret, isoNow, newID, newSecret, secretPrefix, sha256Hex, trim } from "./utils";

export const creditMicrosPerCredit = 1_000_000;

export interface User {
  id: string;
  email: string;
  status: string;
  created_at: string;
}

export interface BuyerAPIKey {
  id: string;
  name: string;
  key_prefix: string;
  created_at: string;
  last_used_at?: string | null;
  revoked_at?: string | null;
}

export interface CreatedBuyerAPIKey {
  api_key: BuyerAPIKey;
  secret: string;
}

export interface AuthenticatedBuyerKey {
  id: string;
  user_id: string;
  key_hash: string;
}

export interface SellerNode {
  id: string;
  seller_user_id: string;
  node_id: string;
  status: string;
  provider: string;
  max_concurrency: number;
  last_seen_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface SellerSetupToken {
  setup_token: string;
  expires_at: string;
}

export interface SellerSetupConfig {
  node_id: string;
  node_token: string;
  max_concurrency: number;
  provider: string;
}

export interface CreditWallet {
  buyer_user_id: string;
  balance_micros: number;
  created_at: string;
  updated_at: string;
}

export interface CreditLedgerEntry {
  id: string;
  buyer_user_id: string;
  type: string;
  amount_micros: number;
  balance_after_micros: number;
  request_id: string;
  note: string;
  created_at: string;
}

export interface CreditOrder {
  id: string;
  buyer_user_id: string;
  amount_micros: number;
  status: string;
  created_at: string;
  paid_at?: string | null;
}

export interface RequestFill {
  request_id: string;
  buyer_user_id: string;
  buyer_api_key_id: string;
  seller_node_id: string;
  path: string;
  status: number;
  stream: boolean;
  duration_ms: number;
  time_to_first_chunk_ms: number;
  bytes_out: number;
  cost_micros: number;
  seller_earning_micros: number;
  platform_fee_micros: number;
  reserve_micros: number;
  error?: string;
  created_at: string;
}

export interface RequestFillInput {
  request_id: string;
  buyer_user_id: string;
  buyer_api_key_id?: string;
  seller_node_id?: string;
  path?: string;
  status_code: number;
  stream: boolean;
  duration_ms: number;
  time_to_first_chunk_ms: number;
  bytes_out: number;
  cost_micros: number;
  seller_earning_micros: number;
  platform_fee_micros: number;
  reserve_micros: number;
  error?: string;
}

export interface SellerEarningsSummary {
  seller_user_id: string;
  balance_micros: number;
  total_earned_micros: number;
  total_paid_out_micros: number;
  available_payout_micros: number;
}

export interface SellerEarningLedgerEntry {
  id: string;
  seller_user_id: string;
  seller_node_id: string;
  type: string;
  amount_micros: number;
  balance_after_micros: number;
  request_id: string;
  note: string;
  created_at: string;
}

export class Store {
  private db: Database;

  constructor(path: string) {
    if (!trim(path)) throw errInvalid();
    this.db = new Database(path);
    this.db.run("PRAGMA busy_timeout = 5000");
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  registerUser(emailValue: string, password: string): User {
    const email = normalizeEmail(emailValue);
    if (password.length < 8) throw errInvalid("password must be at least 8 characters");
    const now = isoNow();
    const user: User = { id: newID("usr"), email, status: "active", created_at: now };
    const tx = this.db.transaction(() => {
      this.db
        .query("INSERT INTO users (id, email, password_hash, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(user.id, user.email, passwordHash(password), user.status, now, now);
      this.db.query("INSERT INTO buyer_profiles (user_id, created_at) VALUES (?, ?)").run(user.id, now);
      this.db.query("INSERT INTO seller_profiles (user_id, created_at) VALUES (?, ?)").run(user.id, now);
      this.db
        .query("INSERT INTO credit_wallets (buyer_user_id, balance_micros, created_at, updated_at) VALUES (?, 0, ?, ?)")
        .run(user.id, now, now);
      this.db
        .query("INSERT INTO seller_earning_wallets (seller_user_id, balance_micros, created_at, updated_at) VALUES (?, 0, ?, ?)")
        .run(user.id, now, now);
    });
    try {
      tx();
      return user;
    } catch (error) {
      if (isUniqueError(error)) throw errConflict();
      throw error;
    }
  }

  authenticateUser(emailValue: string, password: string): User {
    let email: string;
    try {
      email = normalizeEmail(emailValue);
    } catch {
      throw errUnauthorized();
    }
    const row = this.db
      .query("SELECT id, email, password_hash, status, created_at FROM users WHERE email = ? AND status = 'active'")
      .get(email) as any;
    if (!row || row.password_hash !== passwordHash(password)) throw errUnauthorized();
    return userFromRow(row);
  }

  createWebSession(userID: string, ttlMS = 7 * 24 * 60 * 60 * 1000): { session: string; expires_at: string } {
    const secret = newSecret("subi_sess");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (ttlMS > 0 ? ttlMS : 7 * 24 * 60 * 60 * 1000)).toISOString();
    this.db
      .query("INSERT INTO web_sessions (id, user_id, session_token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(newID("sess"), userID, hashSecret(secret), expiresAt, now.toISOString());
    return { session: secret, expires_at: expiresAt };
  }

  userBySession(sessionSecret: string): User {
    if (!trim(sessionSecret)) throw errUnauthorized();
    const row = this.db
      .query(
        `SELECT u.id, u.email, u.status, u.created_at
         FROM web_sessions ws
         JOIN users u ON u.id = ws.user_id
         WHERE ws.session_token_hash = ? AND ws.expires_at > ? AND u.status = 'active'`,
      )
      .get(hashSecret(sessionSecret), isoNow()) as any;
    if (!row) throw errUnauthorized();
    return userFromRow(row);
  }

  deleteWebSession(sessionSecret: string): void {
    if (!trim(sessionSecret)) return;
    this.db.query("DELETE FROM web_sessions WHERE session_token_hash = ?").run(hashSecret(sessionSecret));
  }

  createBuyerAPIKey(userID: string, nameValue: string): CreatedBuyerAPIKey {
    const name = trim(nameValue) || "Default key";
    const secret = newSecret("sk-subi");
    const now = isoNow();
    const key: BuyerAPIKey = {
      id: newID("bak"),
      name,
      key_prefix: secretPrefix(secret),
      created_at: now,
      last_used_at: null,
      revoked_at: null,
    };
    this.db
      .query("INSERT INTO buyer_api_keys (id, buyer_user_id, name, key_hash, key_prefix, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(key.id, userID, key.name, hashSecret(secret), key.key_prefix, key.created_at);
    return { api_key: key, secret };
  }

  listBuyerAPIKeys(userID: string): BuyerAPIKey[] {
    return (this.db
      .query("SELECT id, name, key_prefix, created_at, last_used_at, revoked_at FROM buyer_api_keys WHERE buyer_user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC")
      .all(userID) as any[]).map(buyerAPIKeyFromRow);
  }

  deleteBuyerAPIKey(userID: string, keyID: string): void {
    const result = this.db
      .query("DELETE FROM buyer_api_keys WHERE id = ? AND buyer_user_id = ?")
      .run(keyID, userID);
    requireRows(result.changes);
  }

  authenticateBuyerAPIKey(secret: string): AuthenticatedBuyerKey {
    const keyHash = hashSecret(secret);
    const row = this.db
      .query("SELECT id, buyer_user_id, key_hash FROM buyer_api_keys WHERE key_hash = ? AND revoked_at IS NULL")
      .get(keyHash) as any;
    if (!row) throw errUnauthorized();
    this.db.query("UPDATE buyer_api_keys SET last_used_at = ? WHERE id = ?").run(isoNow(), row.id);
    return { id: row.id, user_id: row.buyer_user_id, key_hash: row.key_hash };
  }

  getBuyerCreditWallet(userID: string): CreditWallet {
    this.ensureBuyerWallet(userID);
    const row = this.db
      .query("SELECT buyer_user_id, balance_micros, created_at, updated_at FROM credit_wallets WHERE buyer_user_id = ?")
      .get(userID) as any;
    if (!row) throw errNotFound();
    return creditWalletFromRow(row);
  }

  createMockCreditOrder(userID: string, amountMicros: number): { order: CreditOrder; ledger_entry: CreditLedgerEntry; wallet: CreditWallet } {
    if (amountMicros <= 0) throw errInvalid();
    const now = isoNow();
    const order: CreditOrder = {
      id: newID("co"),
      buyer_user_id: userID,
      amount_micros: amountMicros,
      status: "paid",
      created_at: now,
      paid_at: now,
    };
    const result = this.db.transaction(() => {
      this.ensureBuyerWallet(userID);
      const balance = this.buyerWalletBalance(userID);
      const nextBalance = balance + amountMicros;
      const ledger: CreditLedgerEntry = {
        id: newID("cle"),
        buyer_user_id: userID,
        type: "recharge",
        amount_micros: amountMicros,
        balance_after_micros: nextBalance,
        request_id: "",
        note: "mock credit recharge",
        created_at: now,
      };
      this.db
        .query("INSERT INTO credit_orders (id, buyer_user_id, amount_micros, status, created_at, paid_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(order.id, order.buyer_user_id, order.amount_micros, order.status, order.created_at, order.paid_at ?? null);
      this.db.query("UPDATE credit_wallets SET balance_micros = ?, updated_at = ? WHERE buyer_user_id = ?").run(nextBalance, now, userID);
      this.db
        .query(
          "INSERT INTO credit_ledger_entries (id, buyer_user_id, type, amount_micros, balance_after_micros, request_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(ledger.id, ledger.buyer_user_id, ledger.type, ledger.amount_micros, ledger.balance_after_micros, ledger.request_id, ledger.note, ledger.created_at);
      return {
        order,
        ledger_entry: ledger,
        wallet: { buyer_user_id: userID, balance_micros: nextBalance, created_at: now, updated_at: now } satisfies CreditWallet,
      };
    })();
    return result;
  }

  reserveBuyerCreditsForRequest(userID: string, requestID: string, amountMicros: number, noteValue: string): { ledger_entry: CreditLedgerEntry; wallet: CreditWallet } {
    requestID = trim(requestID);
    if (!trim(userID) || !requestID || amountMicros <= 0) throw errInvalid();
    const now = isoNow();
    return this.db.transaction(() => {
      const existing = this.creditLedgerByRequestType(userID, requestID, "debit", false);
      if (existing) return { ledger_entry: existing, wallet: this.getBuyerCreditWallet(userID) };
      this.ensureBuyerWallet(userID);
      const balance = this.buyerWalletBalance(userID);
      if (balance < amountMicros) throw errInsufficientCredits();
      const nextBalance = balance - amountMicros;
      const ledger: CreditLedgerEntry = {
        id: newID("cle"),
        buyer_user_id: userID,
        type: "debit",
        amount_micros: -amountMicros,
        balance_after_micros: nextBalance,
        request_id: requestID,
        note: trim(noteValue) || "request pre-authorization",
        created_at: now,
      };
      this.db.query("UPDATE credit_wallets SET balance_micros = ?, updated_at = ? WHERE buyer_user_id = ?").run(nextBalance, now, userID);
      this.db
        .query(
          "INSERT INTO credit_ledger_entries (id, buyer_user_id, type, amount_micros, balance_after_micros, request_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(ledger.id, ledger.buyer_user_id, ledger.type, ledger.amount_micros, ledger.balance_after_micros, ledger.request_id, ledger.note, ledger.created_at);
      return { ledger_entry: ledger, wallet: { buyer_user_id: userID, balance_micros: nextBalance, created_at: now, updated_at: now } };
    })();
  }

  refundBuyerCreditsForRequest(userID: string, requestID: string, noteValue: string): { ledger_entry: CreditLedgerEntry; wallet: CreditWallet } {
    requestID = trim(requestID);
    if (!trim(userID) || !requestID) throw errInvalid();
    const now = isoNow();
    return this.db.transaction(() => {
      const existing = this.creditLedgerByRequestType(userID, requestID, "refund", false);
      if (existing) return { ledger_entry: existing, wallet: this.getBuyerCreditWallet(userID) };
      const debit = this.creditLedgerByRequestType(userID, requestID, "debit", true);
      const refundAmount = -debit.amount_micros;
      if (refundAmount <= 0) throw errInvalid();
      const balance = this.buyerWalletBalance(userID);
      const nextBalance = balance + refundAmount;
      const ledger: CreditLedgerEntry = {
        id: newID("cle"),
        buyer_user_id: userID,
        type: "refund",
        amount_micros: refundAmount,
        balance_after_micros: nextBalance,
        request_id: requestID,
        note: trim(noteValue) || "request failed",
        created_at: now,
      };
      this.db.query("UPDATE credit_wallets SET balance_micros = ?, updated_at = ? WHERE buyer_user_id = ?").run(nextBalance, now, userID);
      this.db
        .query(
          "INSERT INTO credit_ledger_entries (id, buyer_user_id, type, amount_micros, balance_after_micros, request_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(ledger.id, ledger.buyer_user_id, ledger.type, ledger.amount_micros, ledger.balance_after_micros, ledger.request_id, ledger.note, ledger.created_at);
      return { ledger_entry: ledger, wallet: { buyer_user_id: userID, balance_micros: nextBalance, created_at: now, updated_at: now } };
    })();
  }

  recordRequestUsage(input: RequestFillInput): RequestFill {
    if (!trim(input.request_id) || !trim(input.buyer_user_id)) throw errInvalid();
    const fill = requestFillFromInput(input, isoNow());
    this.db
      .query(
        `INSERT OR IGNORE INTO request_fills (
          request_id, buyer_user_id, buyer_api_key_id, seller_node_id, path, status_code, stream,
          duration_ms, time_to_first_chunk_ms, bytes_out, cost_micros, seller_earning_micros,
          platform_fee_micros, reserve_micros, error, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        fill.request_id,
        fill.buyer_user_id,
        fill.buyer_api_key_id,
        fill.seller_node_id,
        fill.path,
        fill.status,
        fill.stream ? 1 : 0,
        fill.duration_ms,
        fill.time_to_first_chunk_ms,
        fill.bytes_out,
        fill.cost_micros,
        fill.seller_earning_micros,
        fill.platform_fee_micros,
        fill.reserve_micros,
        fill.error ?? "",
        fill.created_at,
      );
    return fill;
  }

  recordSuccessfulRequestFillAndSellerEarning(input: RequestFillInput): { fill: RequestFill; earning: SellerEarningLedgerEntry } {
    if (!trim(input.request_id) || !trim(input.buyer_user_id) || !trim(input.seller_node_id)) throw errInvalid();
    if (input.status_code < 200 || input.status_code >= 400 || input.cost_micros <= 0 || input.seller_earning_micros < 0) throw errInvalid();
    const now = isoNow();
    const fill = requestFillFromInput(input, now);
    return this.db.transaction(() => {
      const existing = this.requestFillExists(fill.request_id);
      if (existing) {
        return { fill, earning: this.sellerEarningByRequest(fill.request_id, false) ?? emptySellerEarning() };
      }
      const node = this.db.query("SELECT seller_user_id FROM seller_nodes WHERE node_id = ?").get(fill.seller_node_id) as any;
      if (!node) throw errNotFound();
      this.ensureSellerEarningWallet(node.seller_user_id);
      this.db
        .query(
          `INSERT INTO request_fills (
            request_id, buyer_user_id, buyer_api_key_id, seller_node_id, path, status_code, stream,
            duration_ms, time_to_first_chunk_ms, bytes_out, cost_micros, seller_earning_micros,
            platform_fee_micros, reserve_micros, error, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          fill.request_id,
          fill.buyer_user_id,
          fill.buyer_api_key_id,
          fill.seller_node_id,
          fill.path,
          fill.status,
          fill.stream ? 1 : 0,
          fill.duration_ms,
          fill.time_to_first_chunk_ms,
          fill.bytes_out,
          fill.cost_micros,
          fill.seller_earning_micros,
          fill.platform_fee_micros,
          fill.reserve_micros,
          fill.error ?? "",
          fill.created_at,
        );
      const balance = this.sellerWalletBalance(node.seller_user_id);
      const nextBalance = balance + fill.seller_earning_micros;
      const earning: SellerEarningLedgerEntry = {
        id: newID("sel"),
        seller_user_id: node.seller_user_id,
        seller_node_id: fill.seller_node_id,
        type: "earning",
        amount_micros: fill.seller_earning_micros,
        balance_after_micros: nextBalance,
        request_id: fill.request_id,
        note: "successful request fill",
        created_at: now,
      };
      this.db.query("UPDATE seller_earning_wallets SET balance_micros = ?, updated_at = ? WHERE seller_user_id = ?").run(nextBalance, now, node.seller_user_id);
      this.db
        .query(
          `INSERT INTO seller_earning_ledger_entries (
            id, seller_user_id, seller_node_id, type, amount_micros, balance_after_micros, request_id, note, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          earning.id,
          earning.seller_user_id,
          earning.seller_node_id,
          earning.type,
          earning.amount_micros,
          earning.balance_after_micros,
          earning.request_id,
          earning.note,
          earning.created_at,
        );
      return { fill, earning };
    })();
  }

  listBuyerCreditLedger(userID: string, limit = 50): CreditLedgerEntry[] {
    return (this.db
      .query(
        "SELECT id, buyer_user_id, type, amount_micros, balance_after_micros, request_id, note, created_at FROM credit_ledger_entries WHERE buyer_user_id = ? ORDER BY created_at DESC LIMIT ?",
      )
      .all(userID, normalizeLimit(limit)) as any[]).map(creditLedgerFromRow);
  }

  listBuyerUsage(userID: string, limit = 50): RequestFill[] {
    return (this.db
      .query(
        `SELECT request_id, buyer_user_id, buyer_api_key_id, seller_node_id, path, status_code, stream,
          duration_ms, time_to_first_chunk_ms, bytes_out, cost_micros, seller_earning_micros,
          platform_fee_micros, reserve_micros, error, created_at
         FROM request_fills WHERE buyer_user_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(userID, normalizeLimit(limit)) as any[]).map(requestFillFromRow);
  }

  getSellerEarningsSummary(userID: string): SellerEarningsSummary {
    this.ensureSellerEarningWallet(userID);
    const wallet = this.db.query("SELECT balance_micros FROM seller_earning_wallets WHERE seller_user_id = ?").get(userID) as any;
    if (!wallet) throw errNotFound();
    const totals = this.db
      .query(
        `SELECT
          COALESCE(SUM(CASE WHEN amount_micros > 0 THEN amount_micros ELSE 0 END), 0) AS total_earned_micros,
          COALESCE(SUM(CASE WHEN amount_micros < 0 THEN -amount_micros ELSE 0 END), 0) AS total_paid_out_micros
         FROM seller_earning_ledger_entries WHERE seller_user_id = ?`,
      )
      .get(userID) as any;
    return {
      seller_user_id: userID,
      balance_micros: Number(wallet.balance_micros),
      total_earned_micros: Number(totals?.total_earned_micros ?? 0),
      total_paid_out_micros: Number(totals?.total_paid_out_micros ?? 0),
      available_payout_micros: Number(wallet.balance_micros),
    };
  }

  listSellerEarningLedger(userID: string, limit = 50): SellerEarningLedgerEntry[] {
    return (this.db
      .query(
        "SELECT id, seller_user_id, seller_node_id, type, amount_micros, balance_after_micros, request_id, note, created_at FROM seller_earning_ledger_entries WHERE seller_user_id = ? ORDER BY created_at DESC LIMIT ?",
      )
      .all(userID, normalizeLimit(limit)) as any[]).map(sellerEarningFromRow);
  }

  listSellerActivity(userID: string, limit = 50): RequestFill[] {
    return (this.db
      .query(
        `SELECT rf.request_id, rf.buyer_user_id, rf.buyer_api_key_id, rf.seller_node_id, rf.path, rf.status_code, rf.stream,
          rf.duration_ms, rf.time_to_first_chunk_ms, rf.bytes_out, rf.cost_micros, rf.seller_earning_micros,
          rf.platform_fee_micros, rf.reserve_micros, rf.error, rf.created_at
         FROM request_fills rf
         JOIN seller_nodes sn ON sn.node_id = rf.seller_node_id
         WHERE sn.seller_user_id = ? ORDER BY rf.created_at DESC LIMIT ?`,
      )
      .all(userID, normalizeLimit(limit)) as any[]).map(requestFillFromRow);
  }

  createSellerNode(userID: string, nodeIDValue: string, providerValue: string, maxConcurrencyValue: number): SellerNode {
    const nodeID = trim(nodeIDValue) || `seller-${sha256Hex(`${Date.now()}${Math.random()}`).slice(0, 8)}`;
    const provider = trim(providerValue) || "codex-login";
    const maxConcurrency = maxConcurrencyValue > 0 ? maxConcurrencyValue : 1;
    const now = isoNow();
    const node: SellerNode = {
      id: newID("node"),
      seller_user_id: userID,
      node_id: nodeID,
      status: "created",
      provider,
      max_concurrency: maxConcurrency,
      last_seen_at: null,
      created_at: now,
      updated_at: now,
    };
    try {
      this.db
        .query(
          "INSERT INTO seller_nodes (id, seller_user_id, node_id, status, provider, max_concurrency, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(node.id, node.seller_user_id, node.node_id, node.status, node.provider, node.max_concurrency, node.created_at, node.updated_at);
      return node;
    } catch (error) {
      if (isUniqueError(error)) throw errConflict();
      throw error;
    }
  }

  listSellerNodes(userID: string): SellerNode[] {
    return (this.db
      .query(
        "SELECT id, seller_user_id, node_id, status, provider, max_concurrency, last_seen_at, created_at, updated_at FROM seller_nodes WHERE seller_user_id = ? ORDER BY created_at DESC",
      )
      .all(userID) as any[]).map(sellerNodeFromRow);
  }

  createSellerSetupToken(userID: string, nodeID: string, ttlMS = 30 * 60 * 1000): SellerSetupToken {
    const row = this.db.query("SELECT id FROM seller_nodes WHERE seller_user_id = ? AND node_id = ?").get(userID, nodeID) as any;
    if (!row) throw errNotFound();
    const token = newSecret("subi_setup");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (ttlMS > 0 ? ttlMS : 30 * 60 * 1000)).toISOString();
    this.db
      .query("INSERT INTO seller_setup_tokens (id, seller_node_id, setup_token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(newID("setup"), row.id, hashSecret(token), expiresAt, now.toISOString());
    return { setup_token: token, expires_at: expiresAt };
  }

  redeemSellerSetupToken(setupSecret: string): SellerSetupConfig {
    if (!trim(setupSecret)) throw errUnauthorized();
    const now = isoNow();
    return this.db.transaction(() => {
      const row = this.db
        .query(
          `SELECT st.id AS setup_id, sn.node_id, sn.provider, sn.max_concurrency
           FROM seller_setup_tokens st
           JOIN seller_nodes sn ON sn.id = st.seller_node_id
           WHERE st.setup_token_hash = ? AND st.used_at IS NULL AND st.expires_at > ?`,
        )
        .get(hashSecret(setupSecret), now) as any;
      if (!row) throw errUnauthorized();
      const nodeToken = newSecret("seller_node");
      this.db.query("UPDATE seller_nodes SET node_token_hash = ?, status = 'provisioned', updated_at = ? WHERE node_id = ?").run(hashSecret(nodeToken), now, row.node_id);
      this.db.query("UPDATE seller_setup_tokens SET used_at = ? WHERE id = ?").run(now, row.setup_id);
      return {
        node_id: row.node_id,
        node_token: nodeToken,
        max_concurrency: Number(row.max_concurrency),
        provider: row.provider,
      };
    })();
  }

  authenticateSellerNode(nodeID: string, nodeToken: string): SellerNode {
    const row = this.db
      .query(
        "SELECT id, seller_user_id, node_id, status, provider, max_concurrency, last_seen_at, created_at, updated_at FROM seller_nodes WHERE node_id = ? AND node_token_hash = ?",
      )
      .get(trim(nodeID), hashSecret(nodeToken)) as any;
    if (!row) throw errUnauthorized();
    this.markSellerNodeOnline(row.node_id);
    const node = sellerNodeFromRow(row);
    node.status = "online";
    node.last_seen_at = isoNow();
    node.updated_at = node.last_seen_at;
    return node;
  }

  markSellerNodeOnline(nodeID: string): void {
    const now = isoNow();
    this.db.query("UPDATE seller_nodes SET status = 'online', last_seen_at = ?, updated_at = ? WHERE node_id = ?").run(now, now, trim(nodeID));
  }

  markSellerNodeHeartbeat(nodeID: string): void {
    const now = isoNow();
    this.db.query("UPDATE seller_nodes SET last_seen_at = ?, updated_at = ? WHERE node_id = ?").run(now, now, trim(nodeID));
  }

  markSellerNodeOffline(nodeID: string): void {
    this.db.query("UPDATE seller_nodes SET status = 'offline', updated_at = ? WHERE node_id = ?").run(isoNow(), trim(nodeID));
  }

  private ensureBuyerWallet(userID: string): void {
    if (!trim(userID)) throw errInvalid();
    const now = isoNow();
    this.db.query("INSERT OR IGNORE INTO credit_wallets (buyer_user_id, balance_micros, created_at, updated_at) VALUES (?, 0, ?, ?)").run(userID, now, now);
  }

  private ensureSellerEarningWallet(userID: string): void {
    if (!trim(userID)) throw errInvalid();
    const now = isoNow();
    this.db.query("INSERT OR IGNORE INTO seller_earning_wallets (seller_user_id, balance_micros, created_at, updated_at) VALUES (?, 0, ?, ?)").run(userID, now, now);
  }

  private buyerWalletBalance(userID: string): number {
    const row = this.db.query("SELECT balance_micros FROM credit_wallets WHERE buyer_user_id = ?").get(userID) as any;
    if (!row) throw errNotFound();
    return Number(row.balance_micros);
  }

  private sellerWalletBalance(userID: string): number {
    const row = this.db.query("SELECT balance_micros FROM seller_earning_wallets WHERE seller_user_id = ?").get(userID) as any;
    if (!row) throw errNotFound();
    return Number(row.balance_micros);
  }

  private creditLedgerByRequestType(userID: string, requestID: string, type: string, required: true): CreditLedgerEntry;
  private creditLedgerByRequestType(userID: string, requestID: string, type: string, required: false): CreditLedgerEntry | undefined;
  private creditLedgerByRequestType(userID: string, requestID: string, type: string, required: boolean): CreditLedgerEntry | undefined {
    const row = this.db
      .query(
        "SELECT id, buyer_user_id, type, amount_micros, balance_after_micros, request_id, note, created_at FROM credit_ledger_entries WHERE buyer_user_id = ? AND request_id = ? AND type = ?",
      )
      .get(userID, requestID, type) as any;
    if (!row) {
      if (required) throw errNotFound();
      return undefined;
    }
    return creditLedgerFromRow(row);
  }

  private requestFillExists(requestID: string): boolean {
    return Boolean(this.db.query("SELECT request_id FROM request_fills WHERE request_id = ?").get(requestID));
  }

  private sellerEarningByRequest(requestID: string, required: true): SellerEarningLedgerEntry;
  private sellerEarningByRequest(requestID: string, required: false): SellerEarningLedgerEntry | undefined;
  private sellerEarningByRequest(requestID: string, required: boolean): SellerEarningLedgerEntry | undefined {
    const row = this.db
      .query(
        "SELECT id, seller_user_id, seller_node_id, type, amount_micros, balance_after_micros, request_id, note, created_at FROM seller_earning_ledger_entries WHERE request_id = ? AND type = 'earning'",
      )
      .get(requestID) as any;
    if (!row) {
      if (required) throw errNotFound();
      return undefined;
    }
    return sellerEarningFromRow(row);
  }

  private migrate(): void {
    for (const stmt of migrationStatements) this.db.run(stmt);
  }
}

function passwordHash(password: string): string {
  return sha256Hex(`subi-password:${password}`);
}

function normalizeEmail(value: string): string {
  const email = trim(value).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw errInvalid();
  return email;
}

function normalizeLimit(limit: number): number {
  if (limit <= 0) return 50;
  return Math.min(limit, 200);
}

function requireRows(changes: number): void {
  if (changes === 0) throw errNotFound();
}

function isUniqueError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes("unique");
}

function userFromRow(row: any): User {
  return { id: row.id, email: row.email, status: row.status, created_at: row.created_at };
}

function buyerAPIKeyFromRow(row: any): BuyerAPIKey {
  return {
    id: row.id,
    name: row.name,
    key_prefix: row.key_prefix,
    created_at: row.created_at,
    last_used_at: row.last_used_at ?? null,
    revoked_at: row.revoked_at ?? null,
  };
}

function sellerNodeFromRow(row: any): SellerNode {
  return {
    id: row.id,
    seller_user_id: row.seller_user_id,
    node_id: row.node_id,
    status: row.status,
    provider: row.provider,
    max_concurrency: Number(row.max_concurrency),
    last_seen_at: row.last_seen_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function creditWalletFromRow(row: any): CreditWallet {
  return {
    buyer_user_id: row.buyer_user_id,
    balance_micros: Number(row.balance_micros),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function creditLedgerFromRow(row: any): CreditLedgerEntry {
  return {
    id: row.id,
    buyer_user_id: row.buyer_user_id,
    type: row.type,
    amount_micros: Number(row.amount_micros),
    balance_after_micros: Number(row.balance_after_micros),
    request_id: row.request_id ?? "",
    note: row.note ?? "",
    created_at: row.created_at,
  };
}

function requestFillFromInput(input: RequestFillInput, createdAt: string): RequestFill {
  return {
    request_id: trim(input.request_id),
    buyer_user_id: trim(input.buyer_user_id),
    buyer_api_key_id: trim(input.buyer_api_key_id),
    seller_node_id: trim(input.seller_node_id),
    path: trim(input.path),
    status: input.status_code,
    stream: Boolean(input.stream),
    duration_ms: input.duration_ms,
    time_to_first_chunk_ms: input.time_to_first_chunk_ms,
    bytes_out: input.bytes_out,
    cost_micros: input.cost_micros,
    seller_earning_micros: input.seller_earning_micros,
    platform_fee_micros: input.platform_fee_micros,
    reserve_micros: input.reserve_micros,
    error: trim(input.error),
    created_at: createdAt,
  };
}

function requestFillFromRow(row: any): RequestFill {
  return {
    request_id: row.request_id,
    buyer_user_id: row.buyer_user_id,
    buyer_api_key_id: row.buyer_api_key_id,
    seller_node_id: row.seller_node_id,
    path: row.path,
    status: Number(row.status_code),
    stream: Boolean(row.stream),
    duration_ms: Number(row.duration_ms),
    time_to_first_chunk_ms: Number(row.time_to_first_chunk_ms),
    bytes_out: Number(row.bytes_out),
    cost_micros: Number(row.cost_micros),
    seller_earning_micros: Number(row.seller_earning_micros),
    platform_fee_micros: Number(row.platform_fee_micros),
    reserve_micros: Number(row.reserve_micros),
    error: row.error ?? "",
    created_at: row.created_at,
  };
}

function sellerEarningFromRow(row: any): SellerEarningLedgerEntry {
  return {
    id: row.id,
    seller_user_id: row.seller_user_id,
    seller_node_id: row.seller_node_id,
    type: row.type,
    amount_micros: Number(row.amount_micros),
    balance_after_micros: Number(row.balance_after_micros),
    request_id: row.request_id ?? "",
    note: row.note ?? "",
    created_at: row.created_at,
  };
}

function emptySellerEarning(): SellerEarningLedgerEntry {
  return { id: "", seller_user_id: "", seller_node_id: "", type: "", amount_micros: 0, balance_after_micros: 0, request_id: "", note: "", created_at: "" };
}

export function storeErrorStatus(error: unknown): { status: number; message: string } {
  if (!isStoreError(error)) return { status: 500, message: "internal error" };
  switch (error.code) {
    case "conflict":
      return { status: 409, message: error.message };
    case "insufficient_credits":
      return { status: 402, message: "insufficient credits" };
    case "invalid":
      return { status: 400, message: error.message };
    case "not_found":
      return { status: 404, message: error.message };
    case "unauthorized":
      return { status: 401, message: error.message };
  }
}

const migrationStatements = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS buyer_profiles (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS seller_profiles (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS credit_wallets (
    buyer_user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    balance_micros INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS seller_earning_wallets (
    seller_user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    balance_micros INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS web_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_web_sessions_user ON web_sessions(user_id)`,
  `CREATE TABLE IF NOT EXISTS buyer_api_keys (
    id TEXT PRIMARY KEY,
    buyer_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    key_prefix TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_buyer_api_keys_user ON buyer_api_keys(buyer_user_id)`,
  `CREATE TABLE IF NOT EXISTS credit_orders (
    id TEXT PRIMARY KEY,
    buyer_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount_micros INTEGER NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    paid_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_credit_orders_user ON credit_orders(buyer_user_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS credit_ledger_entries (
    id TEXT PRIMARY KEY,
    buyer_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    amount_micros INTEGER NOT NULL,
    balance_after_micros INTEGER NOT NULL,
    request_id TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_credit_ledger_user ON credit_ledger_entries(buyer_user_id, created_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_ledger_debit_request ON credit_ledger_entries(request_id) WHERE type = 'debit' AND request_id <> ''`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_ledger_refund_request ON credit_ledger_entries(request_id) WHERE type = 'refund' AND request_id <> ''`,
  `CREATE TABLE IF NOT EXISTS seller_nodes (
    id TEXT PRIMARY KEY,
    seller_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL UNIQUE,
    node_token_hash TEXT,
    status TEXT NOT NULL,
    provider TEXT NOT NULL,
    max_concurrency INTEGER NOT NULL,
    last_seen_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_seller_nodes_user ON seller_nodes(seller_user_id)`,
  `CREATE TABLE IF NOT EXISTS seller_setup_tokens (
    id TEXT PRIMARY KEY,
    seller_node_id TEXT NOT NULL REFERENCES seller_nodes(id) ON DELETE CASCADE,
    setup_token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS request_fills (
    request_id TEXT PRIMARY KEY,
    buyer_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    buyer_api_key_id TEXT NOT NULL DEFAULT '',
    seller_node_id TEXT NOT NULL DEFAULT '',
    path TEXT NOT NULL DEFAULT '',
    status_code INTEGER NOT NULL,
    stream INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    time_to_first_chunk_ms INTEGER NOT NULL DEFAULT -1,
    bytes_out INTEGER NOT NULL DEFAULT 0,
    cost_micros INTEGER NOT NULL DEFAULT 0,
    seller_earning_micros INTEGER NOT NULL DEFAULT 0,
    platform_fee_micros INTEGER NOT NULL DEFAULT 0,
    reserve_micros INTEGER NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_request_fills_buyer ON request_fills(buyer_user_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_request_fills_seller_node ON request_fills(seller_node_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS seller_earning_ledger_entries (
    id TEXT PRIMARY KEY,
    seller_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    seller_node_id TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL,
    amount_micros INTEGER NOT NULL,
    balance_after_micros INTEGER NOT NULL,
    request_id TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_seller_earning_ledger_user ON seller_earning_ledger_entries(seller_user_id, created_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_seller_earning_request ON seller_earning_ledger_entries(request_id) WHERE type = 'earning' AND request_id <> ''`,
  `INSERT OR IGNORE INTO credit_wallets (buyer_user_id, balance_micros, created_at, updated_at) SELECT id, 0, created_at, created_at FROM users`,
  `INSERT OR IGNORE INTO seller_earning_wallets (seller_user_id, balance_micros, created_at, updated_at) SELECT id, 0, created_at, created_at FROM users`,
];
