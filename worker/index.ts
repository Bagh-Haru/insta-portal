import { Hono } from "hono";
import { z } from "zod";
import { registerAuthRoutes } from "./auth";
import { registerPublicationRoutes } from "./publications";
import { registerCreativeRoutes } from "./creative";
import { registerMetaConnection } from "./meta-connection";
import { consumeQueue, runScheduled } from "./publishing";
import { constantTimeEqual, getPrincipal, HttpError, jsonError, recordAudit, requireAdmin, requireCsrf, requirePrincipal, requireRateLimit } from "./security";
import type { Env, PublishJob } from "./types";

const app = new Hono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  await next();
  c.res.headers.set("X-Content-Type-Options", "nosniff");
  c.res.headers.set("X-Frame-Options", "DENY");
  c.res.headers.set("Referrer-Policy", "no-referrer");
  c.res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  c.res.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  c.res.headers.set("Content-Security-Policy", "default-src 'none'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' https://*.r2.cloudflarestorage.com");
  if (c.req.path.startsWith("/api/") || c.req.path.startsWith("/media/")) c.res.headers.set("Cache-Control", "no-store");
});

app.onError((error, c) => {
  const result = jsonError(error);
  if (result.status >= 500) {
    // Keep diagnostics deliberately generic; request bodies and provider credentials must not enter logs.
    console.error("Bagh Haru Studio request failed", c.req.path, error instanceof Error ? error.name : "unknown",
      error instanceof Error ? error.stack?.split("\n").slice(1, 5).join("\n") : "");
  }
  return c.json(result.body, result.status as 400 | 401 | 403 | 404 | 405 | 409 | 410 | 413 | 429 | 500 | 503);
});

app.get("/api/session", async (c) => {
  const principal = await getPrincipal(c);
  let bootstrapAvailable = false;
  if (!principal && c.env.BOOTSTRAP_ADMIN_EMAIL?.trim() && c.env.BOOTSTRAP_ADMIN_TOKEN?.trim()) {
    const count = await c.env.DB.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").first<{ count: number }>();
    const completed = await c.env.DB.prepare("SELECT value FROM app_settings WHERE key = 'bootstrap_complete'").first<{ value: string }>();
    bootstrapAvailable = count?.count === 0 && !completed;
  }
  return c.json({
    user: principal ? { id: principal.id, email: principal.email, name: principal.display_name, role: principal.role } : null,
    csrfToken: principal?.csrfToken ?? null,
    bootstrapAvailable,
  });
});

registerAuthRoutes(app);
registerPublicationRoutes(app);
registerCreativeRoutes(app);
registerMetaConnection(app);

app.post("/api/bootstrap", async (c) => {
  const principal = await getPrincipal(c);
  if (!principal) throw new HttpError(401, "not_authenticated", "Sign in with the configured administrator account first.");
  requireCsrf(c, principal);
  if (principal.role === "admin") return c.json({ ok: true });
  if (principal.role !== "pending_bootstrap") throw new HttpError(403, "bootstrap_not_available", "Administrator setup is not available for this account.");
  if (!c.env.BOOTSTRAP_ADMIN_TOKEN || !c.env.BOOTSTRAP_ADMIN_EMAIL) throw new HttpError(503, "bootstrap_not_configured", "The app owner must configure the one-time administrator setup first.");
  const parsed = z.object({ token: z.string().min(32).max(256) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new HttpError(400, "invalid_bootstrap", "Enter the one-time administrator setup code.");
  await requireRateLimit(c.env.DB, `bootstrap:${principal.sessionTokenHash}`, 5, 60 * 60);
  const matches = constantTimeEqual(parsed.data.token, c.env.BOOTSTRAP_ADMIN_TOKEN)
    && constantTimeEqual(principal.email.toLowerCase(), c.env.BOOTSTRAP_ADMIN_EMAIL.trim().toLowerCase());
  if (!matches) throw new HttpError(403, "invalid_bootstrap", "The setup code is not valid for this account.");
  const nowAdmin = await c.env.DB.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").first<{ id: string }>();
  const done = await c.env.DB.prepare("SELECT value FROM app_settings WHERE key = 'bootstrap_complete'").first<{ value: string }>();
  if (nowAdmin || done) throw new HttpError(409, "bootstrap_already_complete", "Administrator setup has already been completed.");
  const result = await c.env.DB.prepare(
    `UPDATE users SET role = 'admin' WHERE id = ? AND role = 'pending_bootstrap' AND enabled = 1
       AND NOT EXISTS (SELECT id FROM users WHERE role = 'admin') RETURNING id`,
  ).bind(principal.id).first<{ id: string }>();
  if (!result) throw new HttpError(409, "bootstrap_already_complete", "Administrator setup has already been completed.");
  await c.env.DB.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('bootstrap_complete', '1')").run();
  await recordAudit(c.env.DB, principal.id, "admin_bootstrap_completed", "user", principal.id);
  return c.json({ ok: true });
});

app.get("/api/admin/users", async (c) => {
  const principal = await requirePrincipal(c);
  requireAdmin(principal);
  const result = await c.env.DB.prepare(
    `SELECT id, email, display_name, role, enabled, last_login_at
       FROM users WHERE role IN ('member','admin') ORDER BY role DESC, email COLLATE NOCASE ASC LIMIT 200`,
  ).all<{ id: string; email: string; display_name: string; role: "member" | "admin"; enabled: number; last_login_at: string | null }>();
  return c.json({ items: result.results.map((user) => ({ id: user.id, email: user.email, name: user.display_name, role: user.role, enabled: user.enabled === 1, lastLoginAt: user.last_login_at })) });
});

app.post("/api/admin/users", async (c) => {
  const principal = await requirePrincipal(c);
  requireAdmin(principal);
  requireCsrf(c, principal);
  const parsed = z.object({ email: z.email().max(254) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new HttpError(400, "invalid_email", "Enter a valid Google account email address.");
  await requireRateLimit(c.env.DB, `admin_add_user:${principal.id}`, 30, 60 * 60);
  const email = parsed.data.email.trim().toLowerCase();
  const existing = await c.env.DB.prepare("SELECT id, role, enabled FROM users WHERE email = ? COLLATE NOCASE LIMIT 1")
    .bind(email).first<{ id: string; role: string; enabled: number }>();
  if (existing) {
    if (existing.role === "pending_bootstrap") throw new HttpError(409, "user_pending_bootstrap", "This account is completing workspace setup.");
    if (existing.enabled) throw new HttpError(409, "already_approved", "This Google account is already on the approved list.");
    await c.env.DB.prepare("UPDATE users SET enabled = 1, created_by = ? WHERE id = ? AND role = 'member'").bind(principal.id, existing.id).run();
    await recordAudit(c.env.DB, principal.id, "user_enabled", "user", existing.id, { email });
    return c.json({ ok: true, reenabled: true });
  }
  const id = crypto.randomUUID();
  const displayName = email.split("@")[0].replace(/[._+-]+/g, " ").slice(0, 80);
  await c.env.DB.prepare(
    "INSERT INTO users (id, email, display_name, role, enabled, created_by) VALUES (?, ?, ?, 'member', 1, ?)",
  ).bind(id, email, displayName, principal.id).run();
  await recordAudit(c.env.DB, principal.id, "user_added", "user", id, { email });
  return c.json({ ok: true, id }, 201);
});

app.patch("/api/admin/users/:id", async (c) => {
  const principal = await requirePrincipal(c);
  requireAdmin(principal);
  requireCsrf(c, principal);
  const parsed = z.object({ enabled: z.boolean() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new HttpError(400, "invalid_user_update", "The account update is invalid.");
  const targetId = c.req.param("id");
  if (targetId === principal.id && !parsed.data.enabled) throw new HttpError(400, "cannot_disable_self", "You cannot disable your own administrator account.");
  const target = await c.env.DB.prepare("SELECT id, email, role FROM users WHERE id = ? AND role IN ('member','admin') LIMIT 1")
    .bind(targetId).first<{ id: string; email: string; role: "member" | "admin" }>();
  if (!target) throw new HttpError(404, "user_not_found", "This approved account was not found.");
  if (target.role === "admin" && !parsed.data.enabled) {
    const count = await c.env.DB.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND enabled = 1").first<{ count: number }>();
    if ((count?.count ?? 0) <= 1) throw new HttpError(400, "last_admin", "At least one enabled administrator must remain.");
  }
  await c.env.DB.prepare("UPDATE users SET enabled = ? WHERE id = ?").bind(parsed.data.enabled ? 1 : 0, target.id).run();
  if (!parsed.data.enabled) await c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(target.id).run();
  await recordAudit(c.env.DB, principal.id, parsed.data.enabled ? "user_enabled" : "user_disabled", "user", target.id, { email: target.email });
  return c.json({ ok: true });
});

app.get("/api/admin/activity", async (c) => {
  const principal = await requirePrincipal(c);
  requireAdmin(principal);
  const requested = Number(c.req.query("limit") ?? "20");
  const limit = Number.isInteger(requested) ? Math.max(1, Math.min(100, requested)) : 20;
  const result = await c.env.DB.prepare(
    `SELECT a.id, u.email AS actor_email, a.action, a.target_type, a.target_id, a.created_at
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
      ORDER BY a.created_at DESC LIMIT ?`,
  ).bind(limit).all<{ id: number; actor_email: string | null; action: string; target_type: string; target_id: string | null; created_at: string }>();
  return c.json({ items: result.results.map((event) => ({ id: event.id, actorEmail: event.actor_email ?? "", action: event.action, targetType: event.target_type, createdAt: event.created_at })) });
});

app.get("/api/admin/integrations", async (c) => {
  const principal = await requirePrincipal(c);
  requireAdmin(principal);
  return c.json({ instagramConfigured: Boolean(c.env.META_ACCESS_TOKEN && c.env.META_IG_USER_ID), googleConfigured: Boolean(c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_CLIENT_SECRET), uploadsConfigured: Boolean(c.env.R2_ACCOUNT_ID && c.env.R2_ACCESS_KEY_ID && c.env.R2_SECRET_ACCESS_KEY) });
});

app.notFound(async (c) => {
  if (c.req.path.startsWith("/api/") || c.req.path.startsWith("/media/")) return c.json({ error: "not_found", message: "This resource was not found." }, 404);
  return c.env.ASSETS.fetch(c.req.raw);
});

export default {
  fetch: app.fetch,
  queue: (batch: MessageBatch<PublishJob>, env: Env) => consumeQueue(batch, env),
  scheduled: (_event: ScheduledController, env: Env, ctx: ExecutionContext) => ctx.waitUntil(runScheduled(env)),
};
