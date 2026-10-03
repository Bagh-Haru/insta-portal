import { getCookie } from "hono/cookie";
import type { Context } from "hono";
import type { Env, Principal, UserRow } from "./types";

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

export function required(value: string | undefined, name: string): string {
  if (!value || !value.trim()) throw new HttpError(503, "configuration_missing", `The app owner must configure ${name} before this feature is available.`);
  return value;
}

export function randomToken(bytes = 32): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function sha256(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function mediaCapability(env: Env, mediaId: string, expiry: number): Promise<string> {
  const keyValue = new TextEncoder().encode(required(env.MEDIA_URL_SECRET, "MEDIA_URL_SECRET"));
  const key = await crypto.subtle.importKey("raw", keyValue, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const message = new TextEncoder().encode(`${mediaId}.${expiry}`);
  const signature = await crypto.subtle.sign("HMAC", key, message);
  let binary = "";
  for (const byte of new Uint8Array(signature)) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return `${mediaId}.${expiry}.${encoded}`;
}

export async function verifyMediaCapability(env: Env, token: string): Promise<{ mediaId: string; expiry: number } | null> {
  if (token.length > 180) return null;
  const match = /^([0-9a-f-]{36})\.(\d{10})\.([A-Za-z0-9_-]{43})$/i.exec(token);
  if (!match) return null;
  const [, mediaId, expiryText, signatureText] = match;
  const expiry = Number(expiryText);
  if (!Number.isSafeInteger(expiry) || expiry <= Math.floor(Date.now() / 1000)) return null;
  const keyValue = new TextEncoder().encode(required(env.MEDIA_URL_SECRET, "MEDIA_URL_SECRET"));
  const key = await crypto.subtle.importKey("raw", keyValue, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const signature = Uint8Array.from(atob(signatureText.replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0));
  const message = new TextEncoder().encode(`${mediaId}.${expiry}`);
  const valid = await crypto.subtle.verify("HMAC", key, signature, message);
  return valid ? { mediaId, expiry } : null;
}

export function constantTimeEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export function sessionCookieName(env: Env): string {
  return env.APP_ORIGIN.startsWith("https://") ? "__Host-bh_session" : "bh_session";
}

export function csrfCookieName(env: Env): string {
  return env.APP_ORIGIN.startsWith("https://") ? "bh_csrf" : "bh_csrf";
}

export function cookieOptions(env: Env, maxAge: number, httpOnly = true) {
  return {
    httpOnly,
    secure: env.APP_ORIGIN.startsWith("https://"),
    sameSite: "Lax" as const,
    path: "/",
    maxAge,
  };
}

export async function getPrincipal(c: Context<{ Bindings: Env }>): Promise<Principal | null> {
  const token = getCookie(c, sessionCookieName(c.env));
  if (!token) return null;
  const tokenHash = await sha256(token);
  const now = Math.floor(Date.now() / 1000);
  const result = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.google_sub, u.display_name, u.role, u.enabled,
            s.token_hash AS session_token_hash, s.csrf_token
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND u.enabled = 1 LIMIT 1`,
  ).bind(tokenHash, now).first<UserRow & { session_token_hash: string; csrf_token: string }>();
  if (!result) return null;
  return { ...result, sessionTokenHash: result.session_token_hash, csrfToken: result.csrf_token };
}

export async function requirePrincipal(c: Context<{ Bindings: Env }>): Promise<Principal> {
  const principal = await getPrincipal(c);
  if (!principal) throw new HttpError(401, "not_authenticated", "Sign in again to continue.");
  if (principal.role === "pending_bootstrap") throw new HttpError(403, "bootstrap_required", "Complete administrator setup before using the workspace.");
  return principal;
}

export function requireAdmin(user: Principal): void {
  if (user.role !== "admin") throw new HttpError(403, "admin_required", "An administrator account is required for this action.");
}

export function requireSameOrigin(c: Context<{ Bindings: Env }>): void {
  const origin = c.req.header("Origin");
  if (origin !== c.env.APP_ORIGIN) throw new HttpError(403, "bad_origin", "This request did not come from the workspace.");
  const fetchSite = c.req.header("Sec-Fetch-Site");
  if (fetchSite && fetchSite !== "same-origin") throw new HttpError(403, "cross_site_request", "Cross-site requests are not allowed.");
}

export function requireCsrf(c: Context<{ Bindings: Env }>, principal: Principal): void {
  requireSameOrigin(c);
  const supplied = c.req.header("X-CSRF-Token") ?? "";
  if (!constantTimeEqual(supplied, principal.csrfToken)) throw new HttpError(403, "csrf_failed", "Refresh the page and try again.");
}

export async function requireRateLimit(db: D1Database, key: string, limit: number, windowSeconds: number): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const row = await db.prepare(
    `INSERT INTO rate_limits (bucket_key, count, window_ends_at) VALUES (?, 1, ?)
     ON CONFLICT(bucket_key) DO UPDATE SET
       count = CASE WHEN rate_limits.window_ends_at <= ? THEN 1 ELSE rate_limits.count + 1 END,
       window_ends_at = CASE WHEN rate_limits.window_ends_at <= ? THEN excluded.window_ends_at ELSE rate_limits.window_ends_at END
     RETURNING count`,
  ).bind(key, now + windowSeconds, now, now).first<{ count: number }>();
  if (!row || row.count > limit) throw new HttpError(429, "rate_limited", "Too many attempts. Wait a little and try again.");
}

export async function recordAudit(db: D1Database, actorId: string | null, action: string, targetType: string, targetId: string | null, details: Record<string, string | number | boolean | null> = {}): Promise<void> {
  await db.prepare(
    "INSERT INTO audit_log (actor_id, action, target_type, target_id, details_json) VALUES (?, ?, ?, ?, ?)",
  ).bind(actorId, action, targetType, targetId, JSON.stringify(details)).run();
}

export function safeFilename(input: string): string {
  return input.normalize("NFKC").replace(/[\u0000-\u001f\u007f/\\]/g, "_").trim().slice(0, 180) || "upload";
}

export function jsonError(error: unknown): { status: number; body: { error: string; message: string } } {
  if (error instanceof HttpError) return { status: error.status, body: { error: error.code, message: error.message } };
  return { status: 500, body: { error: "internal_error", message: "The request could not be completed. Try again later." } };
}
