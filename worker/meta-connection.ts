import type { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Env } from "./types";
import { cookieOptions, HttpError, randomToken, recordAudit, requireAdmin, requireCsrf, requirePrincipal, requireRateLimit, sha256 } from "./security";

type AppCredentials = { appId: string; secret: string };
type FacebookConnection = { token: string; userId: string; username: string; expiresAt: number; verifiedAt: number };
function appCredentials(env: Env): AppCredentials | undefined {
  if (!env.META_FACEBOOK_APP_ID || !env.META_FACEBOOK_APP_SECRET) return undefined;
  return { appId: env.META_FACEBOOK_APP_ID, secret: env.META_FACEBOOK_APP_SECRET };
}
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const bytes = (value: string) => Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
async function key(env: Env) {
  if (!env.MEDIA_URL_SECRET) throw new HttpError(503, "connection_not_configured", "The connection encryption key is missing.");
  return crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`bagh-haru-meta-v1\0${env.MEDIA_URL_SECRET}`)), "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function saveEncrypted(env: Env, name: string, data: object, requireIdle = false): Promise<boolean> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(name) }, await key(env), new TextEncoder().encode(JSON.stringify(data)));
  const result = await env.DB.prepare(requireIdle
    ? "INSERT OR REPLACE INTO app_settings(key,value) SELECT ?,? WHERE NOT EXISTS (SELECT 1 FROM publications WHERE status IN ('queued','publishing'))"
    : "INSERT OR REPLACE INTO app_settings(key,value) VALUES (?,?)").bind(name, `${b64(iv)}.${b64(new Uint8Array(encrypted))}`).run();
  return (result.meta.changes ?? 0) > 0;
}
export async function loadEncrypted<T>(env: Env, name: string): Promise<T | undefined> {
  const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key=?").bind(name).first<{ value: string }>();
  if (!row) return undefined;
  try {
    const [iv, cipher] = row.value.split(".");
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(iv), additionalData: new TextEncoder().encode(name) }, await key(env), bytes(cipher));
    return JSON.parse(new TextDecoder().decode(plain)) as T;
  } catch { throw new HttpError(503, "connection_unreadable", "The saved Instagram connection needs to be reconnected by an administrator."); }
}
export async function resolveMetaEnv(env: Env): Promise<Env> {
  const connection = await loadEncrypted<FacebookConnection>(env, "meta_facebook_connection");
  if (!connection) return env;
  if (connection.expiresAt <= Math.floor(Date.now() / 1000)) throw new HttpError(503, "instagram_reconnect_required", "Instagram’s connection expired. Ask an admin to reconnect Facebook Login.");
  return { ...env, META_ACCESS_TOKEN: connection.token, META_IG_USER_ID: connection.userId, META_LOGIN_MODE: "facebook" };
}
export async function hasCatalogMusic(env: Env): Promise<boolean> {
  const connection = await loadEncrypted<FacebookConnection>(env, "meta_facebook_connection");
  return connection ? connection.expiresAt > Math.floor(Date.now() / 1000) : env.META_LOGIN_MODE === "facebook";
}
async function facebook<T>(env: Env, path: string, params: Record<string, string>): Promise<T> {
  const response = await fetch(`https://graph.facebook.com/${env.META_API_VERSION || "v26.0"}/${path}?${new URLSearchParams(params)}`, { signal: AbortSignal.timeout(15_000), redirect: "error" });
  const data = await response.json().catch(() => null) as (T & { error?: object }) | null;
  if (!response.ok || !data || data.error) throw new HttpError(502, "facebook_connection_failed", "Facebook did not authorize this connection. Check the app permissions and linked Page, then try again.");
  return data;
}
export function registerMetaConnection(app: Hono<{ Bindings: Env }>) {
  app.get("/api/admin/meta-connection", async c => {
    const user = await requirePrincipal(c); requireAdmin(user);
    const credentials = appCredentials(c.env);
    const connection = await loadEncrypted<FacebookConnection>(c.env, "meta_facebook_connection");
    return c.json({ appConfigured: Boolean(credentials), connected: Boolean(connection), catalogMusic: await hasCatalogMusic(c.env), username: connection?.username ?? "", expiresAt: connection?.expiresAt ?? null, redirectUri: `${c.env.APP_ORIGIN}/api/auth/meta/callback` });
  });
  app.post("/api/admin/meta-connection/start", async c => {
    const user = await requirePrincipal(c); requireAdmin(user); requireCsrf(c, user);
    await requireRateLimit(c.env.DB, `meta_connect:${user.id}`, 10, 600);
    const credentials = appCredentials(c.env);
    if (!credentials) throw new HttpError(409, "meta_app_required", "Configure the Meta app first.");
    const state = randomToken(); const now = Math.floor(Date.now() / 1000);
    await c.env.DB.prepare("DELETE FROM integration_oauth WHERE expires_at<=?").bind(now).run();
    await c.env.DB.prepare("INSERT INTO integration_oauth(state_hash,user_id,expires_at) VALUES (?,?,?)").bind(await sha256(state), user.id, now + 600).run();
    setCookie(c, "bh_meta_state", state, cookieOptions(c.env, 600));
    const url = new URL(`https://www.facebook.com/${c.env.META_API_VERSION || "v26.0"}/dialog/oauth`);
    url.search = new URLSearchParams({ client_id: credentials.appId, redirect_uri: `${c.env.APP_ORIGIN}/api/auth/meta/callback`, state, scope: "instagram_basic,instagram_content_publish,pages_show_list,pages_read_engagement", response_type: "code" }).toString();
    return c.json({ url: url.toString() });
  });
  app.get("/api/auth/meta/callback", async c => {
    const user = await requirePrincipal(c); requireAdmin(user);
    const state = c.req.query("state") ?? "", code = c.req.query("code") ?? "";
    const cookie = getCookie(c, "bh_meta_state"); deleteCookie(c, "bh_meta_state", { path: "/", secure: true, sameSite: "Lax" });
    if (!state || state.length > 256 || state !== cookie || !code || code.length > 4096) return c.redirect(`${c.env.APP_ORIGIN}/admin?meta=failed`, 303);
    const hash = await sha256(state);
    const transaction = await c.env.DB.prepare("DELETE FROM integration_oauth WHERE state_hash=? AND user_id=? AND expires_at>? RETURNING state_hash").bind(hash, user.id, Math.floor(Date.now() / 1000)).first();
    if (!transaction) return c.redirect(`${c.env.APP_ORIGIN}/admin?meta=failed`, 303);
    try {
      const credentials = appCredentials(c.env); if (!credentials) throw new Error("missing app");
      const short = await facebook<{ access_token: string }>(c.env, "oauth/access_token", { client_id: credentials.appId, client_secret: credentials.secret, redirect_uri: `${c.env.APP_ORIGIN}/api/auth/meta/callback`, code });
      const token = await facebook<{ access_token: string; expires_in: number }>(c.env, "oauth/access_token", { grant_type: "fb_exchange_token", client_id: credentials.appId, client_secret: credentials.secret, fb_exchange_token: short.access_token });
      if (!token.access_token || !Number.isFinite(token.expires_in) || token.expires_in < 60) throw new Error("invalid token");
      const saved = await loadEncrypted<FacebookConnection>(c.env, "meta_facebook_connection");
      let username = saved?.username;
      if (!username) {
        const currentResponse = await fetch(`https://${c.env.META_LOGIN_MODE === "facebook" ? "graph.facebook.com" : "graph.instagram.com"}/${c.env.META_API_VERSION}/` + (c.env.META_LOGIN_MODE === "facebook" ? c.env.META_IG_USER_ID : "me") + "?fields=username", { headers: { Authorization: `Bearer ${c.env.META_ACCESS_TOKEN}` }, signal: AbortSignal.timeout(15_000) });
        const current = await currentResponse.json() as { username?: string };
        if (!currentResponse.ok || !current.username) throw new Error("identity unavailable"); username = current.username;
      }
      const pages = await facebook<{ data: Array<{ instagram_business_account?: { id: string; username: string } }> }>(c.env, "me/accounts", { access_token: token.access_token, fields: "instagram_business_account{id,username}", limit: "100" });
      const matches = pages.data.map(p => p.instagram_business_account).filter(a => a?.username.toLowerCase() === username!.toLowerCase());
      if (matches.length !== 1 || !matches[0]) return c.redirect(`${c.env.APP_ORIGIN}/admin?meta=wrong-account`, 303);
      const running = await c.env.DB.prepare("SELECT COUNT(*) AS count FROM publications WHERE status IN ('queued','publishing')").first<{ count: number }>();
      if (running?.count) return c.redirect(`${c.env.APP_ORIGIN}/admin?meta=busy`, 303);
      // Prove publishing permission and audio access before replacing the existing connection.
      await facebook(c.env, `${matches[0].id}/content_publishing_limit`, { access_token: token.access_token, fields: "config,quota_usage" });
      await facebook(c.env, "ig_audio", { access_token: token.access_token, audio_type: "music", user_id: matches[0].id });
      const now = Math.floor(Date.now() / 1000);
      const connected = await saveEncrypted(c.env, "meta_facebook_connection", { token: token.access_token, userId: matches[0].id, username: matches[0].username, expiresAt: now + token.expires_in, verifiedAt: now }, true);
      if (!connected) return c.redirect(`${c.env.APP_ORIGIN}/admin?meta=busy`, 303);
      await recordAudit(c.env.DB, user.id, "meta_facebook_connected", "integration", null).catch(() => console.error("Connection audit deferred"));
      return c.redirect(`${c.env.APP_ORIGIN}/admin?meta=connected`, 303);
    } catch { return c.redirect(`${c.env.APP_ORIGIN}/admin?meta=failed`, 303); }
  });
}
