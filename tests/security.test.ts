import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../worker/index";
import { consumeQueue, runScheduled } from "../worker/publishing";
import { mediaCapability, safeFilename, sha256, verifyMediaCapability } from "../worker/security";
import type { MessageBatch } from "@cloudflare/workers-types";
import type { Env, PublicationType, PublishJob } from "../worker/types";

const testEnv = env as unknown as Env;
const origin = "https://baghharu.neerrn.com";
const imageBytes = new Uint8Array([0xff, 0xd8, 0xff, 0x00]);
const googleEnv = { ...testEnv, GOOGLE_CLIENT_ID: "test-google-client.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "test-google-client-secret" } as Env;
let googleKeys: CryptoKeyPair;
let googlePublicJwk: JsonWebKey & { kid: string; alg: string; use: string };

beforeAll(async () => {
  googleKeys = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const exportedJwk = await crypto.subtle.exportKey("jwk", googleKeys.publicKey) as unknown as JsonWebKey;
  googlePublicJwk = { ...exportedJwk, kid: "google-test-key", alg: "RS256", use: "sig" };
});

async function addUser(id: string, role: "member" | "admin" = "member", enabled = true) {
  const email = `${id}@example.test`;
  const sessionToken = `session-${id}-${crypto.randomUUID()}`;
  const csrfToken = `csrf-${id}-${crypto.randomUUID()}`;
  const now = Math.floor(Date.now() / 1000);
  await testEnv.DB.prepare(
    "INSERT INTO users (id, email, display_name, role, enabled) VALUES (?, ?, ?, ?, ?)",
  ).bind(id, email, id, role, enabled ? 1 : 0).run();
  await testEnv.DB.prepare(
    "INSERT INTO sessions (token_hash, user_id, csrf_token, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(await sha256(sessionToken), id, csrfToken, now, now + 3600, now).run();
  return { id, email, sessionToken, csrfToken };
}

async function addPublication(ownerId: string, id: string, status: "uploading" | "publishing" = "uploading", type: PublicationType = "post") {
  await testEnv.DB.prepare(
    `INSERT INTO publications (id, created_by, type, caption, status, idempotency_key, request_hash, media_count)
     VALUES (?, ?, ?, 'class moment', ?, ?, 'request-hash', 1)`,
  ).bind(id, ownerId, type, status, crypto.randomUUID()).run();
  await testEnv.DB.prepare(
    `INSERT INTO publication_media (id, publication_id, object_key, staging_key, upload_url_expires_at,
       original_name, mime_type, size_bytes, position, media_url_expires_at)
     VALUES (?, ?, ?, ?, ?, 'photo.jpg', 'image/jpeg', ?, 0, ?)`,
  ).bind(`media-${id}`, id, `pending/${id}`, `staging/${ownerId}/${id}/source`, 4_102_444_800, imageBytes.length, 4_102_444_800).run();
}

async function call(path: string, options: { method?: string; user?: Awaited<ReturnType<typeof addUser>>; csrf?: string; cookie?: string; body?: unknown; environment?: Env } = {}) {
  const headers = new Headers();
  if (options.cookie) headers.set("Cookie", options.cookie);
  else if (options.user) headers.set("Cookie", `__Host-bh_session=${options.user.sessionToken}`);
  if (options.csrf) headers.set("X-CSRF-Token", options.csrf);
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (options.method && !["GET", "HEAD"].includes(options.method)) headers.set("Origin", origin);
  const request = new Request(`${origin}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return worker.fetch(request, options.environment ?? testEnv, createExecutionContext());
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function encodeJwtPart(value: Record<string, unknown>): string {
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

async function signedGoogleToken(nonce: string, email: string, exp: number, tamperSignature = false): Promise<string> {
  const header = encodeJwtPart({ alg: "RS256", typ: "JWT", kid: "google-test-key" });
  const payload = encodeJwtPart({
    iss: "https://accounts.google.com",
    aud: googleEnv.GOOGLE_CLIENT_ID,
    sub: `google-sub-${email}`,
    iat: Math.floor(Date.now() / 1000) - 10,
    exp,
    nonce,
    email,
    email_verified: true,
    name: "Authorized Student",
  });
  const signed = new TextEncoder().encode(`${header}.${payload}`);
  const signature = encodeBase64Url(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", googleKeys.privateKey, signed)));
  const safeSignature = tamperSignature ? `${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}` : signature;
  return `${header}.${payload}.${safeSignature}`;
}

async function googleCallback(email: string, exp: number, tamperSignature = false): Promise<Response> {
  const state = crypto.randomUUID();
  const nonce = `nonce-${crypto.randomUUID()}`;
  const token = await signedGoogleToken(nonce, email, exp, tamperSignature);
  await testEnv.DB.prepare(
    "INSERT INTO oauth_transactions (state_hash, code_verifier, nonce, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(await sha256(state), "A".repeat(64), nonce, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000) + 600).run();

  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname === "accounts.google.com" && url.pathname === "/.well-known/openid-configuration") {
      return Response.json({
        issuer: "https://accounts.google.com",
        authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        token_endpoint: "https://oauth.example.test/token",
        userinfo_endpoint: "https://oauth.example.test/userinfo",
        jwks_uri: "https://oauth.example.test/jwks",
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["client_secret_post"],
      });
    }
    if (url.hostname === "oauth.example.test" && url.pathname === "/token") {
      return Response.json({ access_token: "mock-access-token", token_type: "Bearer", expires_in: 3600, id_token: token });
    }
    if (url.hostname === "oauth.example.test" && url.pathname === "/jwks") return Response.json({ keys: [googlePublicJwk] });
    return Response.json({ error: "unexpected_mock_request" }, { status: 404 });
  }));
  try {
    return await call(`/api/auth/google/callback?state=${encodeURIComponent(state)}&code=mock-code`, {
      cookie: `bh_oauth_state=${state}`,
      environment: googleEnv,
    });
  } finally {
    vi.unstubAllGlobals();
  }
}

async function approveEmail(email: string): Promise<void> {
  await testEnv.DB.prepare("INSERT INTO users (id, email, display_name, role, enabled) VALUES (?, ?, ?, 'member', 1)")
    .bind(`approved-${email}`, email, "Approved student").run();
}

describe("Google identity verification", () => {
  it("rejects an expired Google ID token", async () => {
    const email = "expired@example.test";
    await approveEmail(email);
    const response = await googleCallback(email, Math.floor(Date.now() / 1000) - 60);
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toContain("login=failed");
    const user = await testEnv.DB.prepare("SELECT google_sub FROM users WHERE email = ?").bind(email).first<{ google_sub: string | null }>();
    expect(user?.google_sub).toBeNull();
  });

  it("rejects a Google ID token with a forged signature", async () => {
    const email = "forged@example.test";
    await approveEmail(email);
    const response = await googleCallback(email, Math.floor(Date.now() / 1000) + 600, true);
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toContain("login=failed");
    const user = await testEnv.DB.prepare("SELECT google_sub FROM users WHERE email = ?").bind(email).first<{ google_sub: string | null }>();
    expect(user?.google_sub).toBeNull();
  });

  it("denies a verified Google account that is not on the approved list", async () => {
    const email = "unapproved@example.test";
    const response = await googleCallback(email, Math.floor(Date.now() / 1000) + 600);
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toContain("login=denied");
    const user = await testEnv.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
    expect(user).toBeNull();
  });

  it("links an approved address to Google's stable subject identifier", async () => {
    const email = "approved@example.test";
    await approveEmail(email);
    const response = await googleCallback(email, Math.floor(Date.now() / 1000) + 600);
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(`${origin}/`);
    const user = await testEnv.DB.prepare("SELECT google_sub FROM users WHERE email = ?").bind(email).first<{ google_sub: string | null }>();
    expect(user?.google_sub).toBe(`google-sub-${email}`);
    expect(response.headers.get("Set-Cookie")).toContain("__Host-bh_session=");
  });
});

describe("session and authorization controls", () => {
  it("rejects requests without a valid session", async () => {
    const response = await call("/api/publications");
    expect(response.status).toBe(401);
  });

  it("rejects a disabled member even when the session token is valid", async () => {
    const user = await addUser("disabled", "member", false);
    const response = await call("/api/publications", { user });
    expect(response.status).toBe(401);
  });

  it("rejects an expired session", async () => {
    const user = await addUser("expired-session");
    await testEnv.DB.prepare("UPDATE sessions SET expires_at = ? WHERE user_id = ?")
      .bind(Math.floor(Date.now() / 1000) - 1, user.id).run();
    const response = await call("/api/publications", { user });
    expect(response.status).toBe(401);
  });

  it("rejects a member attempting to access administrator functions", async () => {
    const user = await addUser("member");
    const response = await call("/api/admin/users", { user });
    expect(response.status).toBe(403);
  });

  it("does not let a normal member promote themselves through bootstrap", async () => {
    const user = await addUser("cannot-promote");
    const bootstrapEnv = { ...testEnv, BOOTSTRAP_ADMIN_EMAIL: user.email, BOOTSTRAP_ADMIN_TOKEN: "test-bootstrap-token-with-enough-entropy" } as Env;
    const response = await call("/api/bootstrap", {
      method: "POST",
      user,
      csrf: user.csrfToken,
      body: { token: "test-bootstrap-token-with-enough-entropy" },
      environment: bootstrapEnv,
    });
    expect(response.status).toBe(403);
    const result = await testEnv.DB.prepare("SELECT role FROM users WHERE id = ?").bind(user.id).first<{ role: string }>();
    expect(result?.role).toBe("member");
  });

  it("ignores a client supplied administrator role when approving an account", async () => {
    const admin = await addUser("admin", "admin");
    const response = await call("/api/admin/users", {
      method: "POST",
      user: admin,
      csrf: admin.csrfToken,
      body: { email: "new-classmate@example.test", role: "admin" },
    });
    expect(response.status).toBe(201);
    const approved = await testEnv.DB.prepare("SELECT role FROM users WHERE email = ?").bind("new-classmate@example.test").first<{ role: string }>();
    expect(approved?.role).toBe("member");
  });

  it("requires the session CSRF token before logout can revoke the session", async () => {
    const user = await addUser("csrf");
    const response = await call("/api/auth/logout", { method: "POST", user, csrf: "forged-token", body: {} });
    expect(response.status).toBe(403);
    const count = await testEnv.DB.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?").bind(user.id).first<{ count: number }>();
    expect(count?.count).toBe(1);
  });

  it("hides another member's publication", async () => {
    const owner = await addUser("owner");
    const viewer = await addUser("viewer");
    await addPublication(owner.id, "owned-publication");
    const response = await call("/api/publications/owned-publication", { user: viewer });
    expect(response.status).toBe(404);
  });

  it("refuses a second submission request with the same idempotency key", async () => {
    const user = await addUser("retry");
    const idempotencyKey = crypto.randomUUID();
    const request = {
      idempotencyKey,
      type: "post",
      caption: "class moment",
      media: [{ name: "photo.jpg", mimeType: "image/jpeg", sizeBytes: imageBytes.length }],
    };
    const requestHash = await sha256(JSON.stringify({
      type: request.type,
      caption: request.caption,
      media: [{ name: safeFilename("photo.jpg"), mimeType: "image/jpeg", sizeBytes: imageBytes.length }],
    }));
    await testEnv.DB.prepare(
      `INSERT INTO publications (id, created_by, type, caption, status, idempotency_key, request_hash, media_count)
       VALUES ('existing-publication', ?, 'post', ?, 'queued', ?, ?, 1)`,
    ).bind(user.id, request.caption, idempotencyKey, requestHash).run();
    const response = await call("/api/publications", { method: "POST", user, csrf: user.csrfToken, body: request });
    expect(response.status).toBe(409);
    const count = await testEnv.DB.prepare("SELECT COUNT(*) AS count FROM publications WHERE created_by = ?").bind(user.id).first<{ count: number }>();
    expect(count?.count).toBe(1);
  });
});

describe("media capabilities and upload finalization", () => {
  it("creates a browser upload permission in the Worker runtime", async () => {
    const user = await addUser("upload-permission");
    const response = await call("/api/publications", {
      method: "POST",
      user,
      csrf: user.csrfToken,
      environment: {
        ...testEnv,
        R2_ACCOUNT_ID: "00000000000000000000000000000000",
        R2_ACCESS_KEY_ID: "test-upload-access-key",
        R2_SECRET_ACCESS_KEY: "test-upload-secret-key",
      },
      body: {
        idempotencyKey: crypto.randomUUID(),
        type: "post",
        caption: "Upload test",
        media: [{ name: "photo.jpg", mimeType: "image/jpeg", sizeBytes: imageBytes.length }],
      },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const draft = await response.json() as { uploads: Array<{ url: string }> };
    const uploadUrl = new URL(draft.uploads[0].url);
    expect(uploadUrl.searchParams.get("X-Amz-Signature")).toBeTruthy();
    expect(uploadUrl.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(uploadUrl.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host");
  });

  it("can renew an expired upload after scheduled cleanup without using more submission quota", async () => {
    const user = await addUser("renew-upload");
    const environment = { ...testEnv, R2_ACCOUNT_ID: "00000000000000000000000000000000", R2_ACCESS_KEY_ID: "renew-key", R2_SECRET_ACCESS_KEY: "renew-secret" };
    const options = {
      method: "POST", user, csrf: user.csrfToken, environment,
      body: { idempotencyKey: crypto.randomUUID(), type: "post", caption: "Renew upload", media: [{ name: "photo.jpg", mimeType: "image/jpeg", sizeBytes: imageBytes.length }] },
    };
    const first = await call("/api/publications", options);
    expect(first.status).toBe(201);
    const draft = await first.json() as { id: string };
    await testEnv.DB.prepare("UPDATE publication_media SET upload_url_expires_at = 1 WHERE publication_id = ?").bind(draft.id).run();
    await runScheduled(environment);
    for (let attempt = 0; attempt < 5; attempt++) {
      const retry = await call("/api/publications", options);
      expect(retry.status, await retry.clone().text()).toBe(200);
      expect((await retry.json() as { id: string }).id).toBe(draft.id);
    }
    const quota = await testEnv.DB.prepare("SELECT count FROM rate_limits WHERE bucket_key = ?").bind(`publication_create:${user.id}`).first<{ count: number }>();
    expect(quota?.count).toBe(1);
  });

  beforeEach(async () => {
    await testEnv.MEDIA.delete("media/replacement-protection/media-media-replacement-protection");
    await testEnv.MEDIA.delete("staging/uploader/replacement-protection/source");
  });

  it("rejects forged, altered, and expired signed media tokens", async () => {
    const expiry = Math.floor(Date.now() / 1000) + 300;
    const token = await mediaCapability(testEnv, "12345678-1234-1234-1234-123456789abc", expiry);
    const [mediaId, expiryText, signature] = token.split(".");
    const alteredSignature = `${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`;
    const altered = `${mediaId}.${expiryText}.${alteredSignature}`;
    expect(await verifyMediaCapability(testEnv, token)).toEqual({ mediaId: "12345678-1234-1234-1234-123456789abc", expiry });
    expect(await verifyMediaCapability(testEnv, altered)).toBeNull();
    expect(await verifyMediaCapability(testEnv, `12345678-1234-1234-1234-123456789abc.${Math.floor(Date.now() / 1000) - 1}.${"A".repeat(43)}`)).toBeNull();
  });

  it("rejects forged upload completion when the approved media object is absent", async () => {
    const user = await addUser("uploader");
    await addPublication(user.id, "missing-upload");
    const response = await call("/api/publications/missing-upload/complete", {
      method: "POST",
      user,
      csrf: user.csrfToken,
      body: { mediaIds: ["media-missing-upload"] },
    });
    expect(response.status, await response.clone().text()).toBe(400);
    const state = await testEnv.DB.prepare("SELECT status FROM publications WHERE id = ?").bind("missing-upload").first<{ status: string }>();
    expect(state?.status).toBe("uploading");
  });

  it("copies accepted media to a stable key so reusing an upload URL cannot replace it", async () => {
    const user = await addUser("uploader");
    await addPublication(user.id, "replacement-protection");
    const stagingKey = "staging/uploader/replacement-protection/source";
    await testEnv.MEDIA.put(stagingKey, imageBytes, { httpMetadata: { contentType: "image/jpeg" } });
    const response = await call("/api/publications/replacement-protection/complete", {
      method: "POST",
      user,
      csrf: user.csrfToken,
      body: { mediaIds: ["media-replacement-protection"] },
    });
    expect(response.status, await response.clone().text()).toBe(202);
    const row = await testEnv.DB.prepare("SELECT object_key, staging_key, upload_url_expires_at FROM publication_media WHERE id = ?")
      .bind("media-replacement-protection").first<{ object_key: string; staging_key: string | null; upload_url_expires_at: number | null }>();
    expect(row?.object_key).toBe("media/replacement-protection/media-replacement-protection");
    expect(row?.staging_key).toBeNull();
    expect(row?.upload_url_expires_at).toBeNull();
    await testEnv.MEDIA.put(stagingKey, new Uint8Array([0x00, 0x00, 0x00, 0x00]), { httpMetadata: { contentType: "image/jpeg" } });
    const stable = await testEnv.MEDIA.get(row!.object_key);
    expect(stable).not.toBeNull();
    expect(new Uint8Array(await stable!.arrayBuffer())).toEqual(imageBytes);
  });

  it("does not call Instagram publish twice when duplicate queue messages arrive", async () => {
    const user = await addUser("publisher");
    const publicationId = "single-publish-attempt";
    await testEnv.DB.prepare(
      `INSERT INTO publications (id, created_by, type, caption, status, idempotency_key, request_hash,
         media_count, publish_step, publish_data_json)
       VALUES (?, ?, 'post', 'class moment', 'publishing', ?, 'request-hash', 1, 'ready', '{"containerId":"container-1"}')`,
    ).bind(publicationId, user.id, crypto.randomUUID()).run();
    const metaEnv = { ...testEnv, META_ACCESS_TOKEN: "test-access-token", META_IG_USER_ID: "17840000000000000", META_API_VERSION: "v26.0" };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/media_publish")) return Response.json({ id: "published-media-1" });
      if (url.includes("published-media-1")) return Response.json({ id: "published-media-1", permalink: "https://www.instagram.com/p/example/" });
      return Response.json({ error: { code: 100 } }, { status: 400 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const message = { body: { publicationId }, ack: vi.fn() };
    const batch = { messages: [message] } as unknown as MessageBatch<PublishJob>;
    try {
      await consumeQueue(batch, metaEnv);
      await consumeQueue(batch, metaEnv);
    } finally {
      vi.unstubAllGlobals();
    }
    const publishRequests = fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/media_publish"));
    expect(publishRequests).toHaveLength(1);
    const state = await testEnv.DB.prepare("SELECT status, ig_media_id FROM publications WHERE id = ?").bind(publicationId).first<{ status: string; ig_media_id: string | null }>();
    expect(state).toEqual({ status: "published", ig_media_id: "published-media-1" });
  });
});
