import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import * as oauth from "oauth4webapi";
import { Hono } from "hono";
import type { Env } from "./types";
import { cookieOptions, getPrincipal, HttpError, randomToken, recordAudit, required, requireCsrf, requireRateLimit, sessionCookieName, sha256 } from "./security";

type AppContext = import("hono").Context<{ Bindings: Env }>;

const googleIssuer = new URL("https://accounts.google.com");
let googleMetadata: Promise<oauth.AuthorizationServer> | undefined;

function getGoogleMetadata(): Promise<oauth.AuthorizationServer> {
  if (!googleMetadata) {
    googleMetadata = oauth.discoveryRequest(googleIssuer)
      .then((response) => oauth.processDiscoveryResponse(googleIssuer, response))
      .catch((error: unknown) => { googleMetadata = undefined; throw error; });
  }
  return googleMetadata;
}

function callbackUrl(env: Env): string {
  return `${env.APP_ORIGIN}/api/auth/google/callback`;
}

export function attachSession(c: AppContext, token: string, csrfToken: string): void {
  setCookie(c, sessionCookieName(c.env), token, cookieOptions(c.env, 7 * 24 * 60 * 60, true));
  setCookie(c, "bh_csrf", csrfToken, cookieOptions(c.env, 7 * 24 * 60 * 60, false));
}

export function clearSession(c: AppContext): void {
  deleteCookie(c, sessionCookieName(c.env), { path: "/", secure: c.env.APP_ORIGIN.startsWith("https://"), sameSite: "Lax" });
  deleteCookie(c, "bh_csrf", { path: "/", secure: c.env.APP_ORIGIN.startsWith("https://"), sameSite: "Lax" });
}

export async function createSession(c: AppContext, userId: string): Promise<void> {
  const token = randomToken();
  const csrfToken = randomToken();
  const now = Math.floor(Date.now() / 1000);
  const expiry = now + 7 * 24 * 60 * 60;
  await c.env.DB.prepare(
    "INSERT INTO sessions (token_hash, user_id, csrf_token, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(await sha256(token), userId, csrfToken, now, expiry, now).run();
  attachSession(c, token, csrfToken);
}

export function registerAuthRoutes(app: Hono<{ Bindings: Env }>): void {
  app.get("/api/auth/google", async (c) => {
    required(c.env.GOOGLE_CLIENT_ID, "GOOGLE_CLIENT_ID");
    required(c.env.GOOGLE_CLIENT_SECRET, "GOOGLE_CLIENT_SECRET");
    const clientId = c.env.GOOGLE_CLIENT_ID;
    const as = await getGoogleMetadata();
    const ipHash = await sha256(c.req.header("CF-Connecting-IP") ?? "unknown");
    await requireRateLimit(c.env.DB, `google_start:${ipHash}`, 20, 600);
    const state = randomToken();
    const codeVerifier = oauth.generateRandomCodeVerifier();
    const codeChallenge = await oauth.calculatePKCECodeChallenge(codeVerifier);
    const nonce = oauth.generateRandomNonce();
    const now = Math.floor(Date.now() / 1000);
    await c.env.DB.prepare("DELETE FROM oauth_transactions WHERE expires_at <= ?").bind(now).run();
    await c.env.DB.prepare(
      "INSERT INTO oauth_transactions (state_hash, code_verifier, nonce, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(await sha256(state), codeVerifier, nonce, now, now + 600).run();
    const authorizationUrl = new URL(as.authorization_endpoint!);
    authorizationUrl.searchParams.set("client_id", clientId);
    authorizationUrl.searchParams.set("redirect_uri", callbackUrl(c.env));
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("scope", "openid email profile");
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("nonce", nonce);
    authorizationUrl.searchParams.set("code_challenge", codeChallenge);
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    authorizationUrl.searchParams.set("prompt", "select_account");
    setCookie(c, "bh_oauth_state", state, { ...cookieOptions(c.env, 600), httpOnly: true });
    return c.redirect(authorizationUrl.toString(), 302);
  });

  app.get("/api/auth/google/callback", async (c) => {
    const state = c.req.query("state") ?? "";
    const code = c.req.query("code") ?? "";
    const storedState = getCookie(c, "bh_oauth_state") ?? "";
    deleteCookie(c, "bh_oauth_state", { path: "/", secure: c.env.APP_ORIGIN.startsWith("https://"), sameSite: "Lax" });
    if (!state || !code || state.length > 256 || state !== storedState) return c.redirect(`${c.env.APP_ORIGIN}/?login=failed`, 303);

    const stateHash = await sha256(state);
    const transaction = await c.env.DB.prepare(
      "SELECT state_hash, code_verifier, nonce, expires_at FROM oauth_transactions WHERE state_hash = ? LIMIT 1",
    ).bind(stateHash).first<{ state_hash: string; code_verifier: string; nonce: string; expires_at: number }>();
    await c.env.DB.prepare("DELETE FROM oauth_transactions WHERE state_hash = ?").bind(stateHash).run();
    if (!transaction || transaction.expires_at <= Math.floor(Date.now() / 1000)) return c.redirect(`${c.env.APP_ORIGIN}/?login=failed`, 303);

    try {
      required(c.env.GOOGLE_CLIENT_ID, "GOOGLE_CLIENT_ID");
      required(c.env.GOOGLE_CLIENT_SECRET, "GOOGLE_CLIENT_SECRET");
      const as = await getGoogleMetadata();
      const client: oauth.Client = { client_id: c.env.GOOGLE_CLIENT_ID };
      const parameters = oauth.validateAuthResponse(as, client, new URL(c.req.url), state);
      const tokenResponse = await oauth.authorizationCodeGrantRequest(
        as,
        client,
        oauth.ClientSecretPost(c.env.GOOGLE_CLIENT_SECRET),
        parameters,
        callbackUrl(c.env),
        transaction.code_verifier,
      );
      let tokens: Awaited<ReturnType<typeof oauth.processAuthorizationCodeResponse>>;
      try {
        tokens = await oauth.processAuthorizationCodeResponse(as, client, tokenResponse, {
          expectedNonce: transaction.nonce,
          requireIdToken: true,
        });
      } catch {
        return c.redirect(`${c.env.APP_ORIGIN}/?login=failed`, 303);
      }
      try {
        await oauth.validateApplicationLevelSignature(as, tokenResponse);
      } catch {
        return c.redirect(`${c.env.APP_ORIGIN}/?login=failed`, 303);
      }
      const claims = oauth.getValidatedIdTokenClaims(tokens);
      if (!claims || claims.email_verified !== true || typeof claims.email !== "string" || typeof claims.sub !== "string" || typeof claims.name !== "string") {
        throw new HttpError(401, "invalid_google_identity", "Google did not return a verified account identity.");
      }
      const email = claims.email.trim().toLowerCase();
      const user = await c.env.DB.prepare(
        "SELECT id, email, google_sub, display_name, role, enabled FROM users WHERE email = ? COLLATE NOCASE LIMIT 1",
      ).bind(email).first<{ id: string; email: string; google_sub: string | null; display_name: string; role: "member" | "admin" | "pending_bootstrap"; enabled: number }>();
      let userId: string;

      if (!user) {
        const adminCount = await c.env.DB.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").first<{ count: number }>();
        const bootstrapped = await c.env.DB.prepare("SELECT value FROM app_settings WHERE key = 'bootstrap_complete'").first<{ value: string }>();
        const expectedBootstrapEmail = (c.env.BOOTSTRAP_ADMIN_EMAIL ?? "").trim().toLowerCase();
        if (adminCount?.count !== 0 || bootstrapped || !expectedBootstrapEmail || email !== expectedBootstrapEmail || !c.env.BOOTSTRAP_ADMIN_TOKEN) {
          return c.redirect(`${c.env.APP_ORIGIN}/?login=denied`, 303);
        }
        userId = crypto.randomUUID();
        await c.env.DB.prepare(
          "INSERT INTO users (id, email, google_sub, display_name, role, enabled) VALUES (?, ?, ?, ?, 'pending_bootstrap', 1)",
        ).bind(userId, email, claims.sub, claims.name.slice(0, 120)).run();
        await recordAudit(c.env.DB, userId, "bootstrap_signin", "user", userId);
      } else {
        if (!user.enabled || (user.google_sub && user.google_sub !== claims.sub)) return c.redirect(`${c.env.APP_ORIGIN}/?login=denied`, 303);
        userId = user.id;
        if (!user.google_sub) {
          const linked = await c.env.DB.prepare("UPDATE users SET google_sub = ? WHERE id = ? AND google_sub IS NULL AND enabled = 1")
            .bind(claims.sub, userId).run();
          if (!linked.success) throw new HttpError(503, "identity_link_failed", "Could not link this Google account. Contact an administrator.");
        }
        await c.env.DB.prepare("UPDATE users SET display_name = ?, last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
          .bind(claims.name.slice(0, 120), userId).run();
      }

      await createSession(c, userId);
      return c.redirect(`${c.env.APP_ORIGIN}/`, 303);
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) return c.redirect(`${c.env.APP_ORIGIN}/?login=failed`, 303);
      throw error;
    }
  });

  app.post("/api/auth/logout", async (c) => {
    const principal = await getPrincipal(c);
    if (principal) {
      requireCsrf(c, principal);
      await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(principal.sessionTokenHash).run();
      await recordAudit(c.env.DB, principal.id, "logout", "session", null);
    }
    clearSession(c);
    return c.json({ ok: true });
  });
}
