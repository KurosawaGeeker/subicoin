import { createHash, randomBytes } from "node:crypto";

export function trim(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashSecret(secret: string): string {
  return sha256Hex(trim(secret));
}

export function newID(prefix: string): string {
  return `${prefix}_${randomHex(12)}`;
}

export function newSecret(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export function randomHex(size: number): string {
  return randomBytes(size).toString("hex");
}

export function secretPrefix(secret: string): string {
  const value = trim(secret);
  return value.length <= 12 ? value : value.slice(0, 12);
}

export function isoNow(): string {
  return new Date().toISOString();
}

export function addMillis(date: Date, millis: number): string {
  return new Date(date.getTime() + millis).toISOString();
}

export function envBool(key: string, fallback = false): boolean {
  const value = trim(Bun.env[key]).toLowerCase();
  if (value === "") return fallback;
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function envInt(key: string, fallback: number): number {
  const parsed = Number.parseInt(trim(Bun.env[key]), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function envString(key: string, fallback = ""): string {
  const value = trim(Bun.env[key]);
  return value === "" ? fallback : value;
}

export function parseJSON<T = unknown>(body: string | Uint8Array): T {
  const text = typeof body === "string" ? body : new TextDecoder().decode(body);
  return JSON.parse(text) as T;
}

export function safeJSONParse<T = unknown>(body: string | Uint8Array): T | undefined {
  try {
    return parseJSON<T>(body);
  } catch {
    return undefined;
  }
}

export function jsonResponse(payload: unknown, status = 200, headers?: HeadersInit): Response {
  const out = new Headers(headers);
  out.set("Content-Type", "application/json");
  return new Response(JSON.stringify(payload), { status, headers: out });
}

export function apiError(status: number, message: string): Response {
  return jsonResponse({ error: { message } }, status);
}

export function openAIError(path: string, status: number, type: string, message: string): Response {
  if (isOpenAIPath(path)) {
    return jsonResponse({ error: { type, message } }, status);
  }
  return jsonResponse({ type: "error", error: { type, message } }, status);
}

export function isOpenAIPath(path: string): boolean {
  return path.includes("/responses") || path.includes("/chat/completions") || path.includes("/backend-api/codex");
}

export function normalizeLimit(value: string | null | undefined, fallback = 50): number {
  const parsed = Number.parseInt(trim(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, 200);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseAddr(addr: string): { hostname: string; port: number } {
  const cleaned = trim(addr);
  const idx = cleaned.lastIndexOf(":");
  if (idx < 0) return { hostname: cleaned || "0.0.0.0", port: 18080 };
  const hostname = cleaned.slice(0, idx) || "0.0.0.0";
  const port = Number.parseInt(cleaned.slice(idx + 1), 10);
  return { hostname, port: Number.isFinite(port) ? port : 18080 };
}

export function requestBaseURL(req: Request): string {
  const headers = req.headers;
  const scheme = trim(headers.get("x-forwarded-proto")) || new URL(req.url).protocol.replace(":", "");
  const host = trim(headers.get("x-forwarded-host")) || trim(headers.get("host")) || new URL(req.url).host;
  return `${scheme}://${host}`;
}

export function requestWSURL(req: Request): string {
  const headers = req.headers;
  const url = new URL(req.url);
  const proto = trim(headers.get("x-forwarded-proto"));
  const scheme = proto.toLowerCase() === "https" || url.protocol === "https:" ? "wss" : "ws";
  const host = trim(headers.get("x-forwarded-host")) || trim(headers.get("host")) || url.host;
  return `${scheme}://${host}/api/v1/subi/seller/agent/ws`;
}

export function cookieValue(cookieHeader: string | null, name: string): string {
  if (!cookieHeader) return "";
  for (const part of cookieHeader.split(";")) {
    const [rawKey, ...rest] = part.split("=");
    if (trim(rawKey) === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

export function setCookieHeader(name: string, value: string, expiresAt: string, secure = false): string {
  const attrs = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    `Expires=${new Date(expiresAt).toUTCString()}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function clearCookieHeader(name: string): string {
  return `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
}
