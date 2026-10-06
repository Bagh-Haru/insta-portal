import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import worker from "../worker/index";
import type { Env, MediaRow, PublicationRow, PublicationType } from "../worker/types";
import { sha256 } from "../worker/security";
import { createCarouselContainer, createInstagramContainer, requestMeta } from "../worker/instagram";
import { hasCatalogMusic, loadEncrypted, resolveMetaEnv, saveEncrypted } from "../worker/meta-connection";
const testEnv = env as unknown as Env;
const origin = "https://baghharu.neerrn.com";
async function user(role = "member") {
  await testEnv.DB.prepare("INSERT INTO users(id,email,display_name,role) VALUES ('creative','creative@example.test','Creative',?)").bind(role).run();
  await testEnv.DB.prepare("INSERT INTO sessions VALUES (?,'creative','creative-csrf',?,?,?)").bind(await sha256("creative-session"), 1, 4_102_444_800, 1).run();
}
async function call(path: string, body?: object, csrf = true, cookie = "__Host-bh_session=creative-session", environment = testEnv) {
  return worker.fetch(new Request(origin + path, { method: body ? "POST" : "GET", headers: { Cookie: cookie, Origin: origin, ...(csrf ? { "X-CSRF-Token": "creative-csrf" } : {}), "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), environment, createExecutionContext());
}
const input = (type: PublicationType = "story") => ({ idempotencyKey: crypto.randomUUID(), type, caption: "", media: [{ name: "photo.jpg", mimeType: "image/jpeg", sizeBytes: 100, options: { tags: [{ username: "classmate", x: .25, y: .7 }] } }] });
const publication = (type: PublicationType, options = {}): PublicationRow => ({ id: "pub", created_by: "creative", type, caption: "Hello @friend", status: "publishing", media_count: 1, publish_step: "create", publish_data_json: "{}", poll_attempts: 0, publish_attempted_at: null, retry_attempts: 0, next_attempt_at: null, creative_json: JSON.stringify(options) });
const media: MediaRow = { id: "media", publication_id: "pub", object_key: "media/pub/media", original_name: "photo.jpg", mime_type: "image/jpeg", size_bytes: 100, position: 0, media_url_expires_at: 4_102_444_800, creative_json: JSON.stringify({ tags: [{ username: "classmate", x: .25, y: .7 }], altText: "Friends outside the classroom" }) };
describe("creative publishing metadata", () => {
  it("persists real Story mentions and detects changes to idempotent requests", async () => {
    await user(); const body = input(); const first = await call("/api/publications", body); expect(first.status).toBe(201);
    const { id } = await first.json() as { id: string };
    const row = await testEnv.DB.prepare("SELECT creative_json FROM publication_media WHERE publication_id=?").bind(id).first<{ creative_json: string }>();
    expect(JSON.parse(row!.creative_json).tags[0]).toEqual({ username: "classmate", x: .25, y: .7 });
    body.media[0].options.tags[0].username = "different";
    expect((await call("/api/publications", body)).status).toBe(409);
  });
  it.each(["http://evil", "friend name", "@friend"])("rejects invalid username %s", async username => {
    await user(); const body = input(); body.media[0].options.tags[0].username = username;
    expect((await call("/api/publications", body)).status).toBe(400);
  });
  it("rejects out-of-bounds tag coordinates", async () => { await user(); const body = input(); body.media[0].options.tags[0].x = 2; expect((await call("/api/publications", body)).status).toBe(400); });
  it("rejects unsupported Story collaborator invitations", async () => { await user(); expect((await call("/api/publications", { ...input(), options: { collaborators: ["friend"] } })).status).toBe(400); });
  it("rejects catalog attachment with the Instagram Login connection", async () => { await user(); const body = input("reel"); body.media[0].mimeType = "video/mp4"; expect((await call("/api/publications", { ...body, options: { audio: { id: "123", volume: 100, videoVolume: 100 } } })).status).toBe(400); });
  it("sends coordinate mentions on a Story without unsupported alt text", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ id: "container" }));
    try {
      await createInstagramContainer(testEnv, publication("story"), media, "https://example.test/photo");
      const fields = new URLSearchParams(fetcher.mock.calls[0][1]?.body as URLSearchParams);
      expect(JSON.parse(fields.get("user_tags")!)).toEqual([{ username: "classmate", x: .25, y: .7 }]);
      expect(fields.get("media_type")).toBe("STORIES"); expect(fields.has("alt_text")).toBe(false); expect(fields.has("caption")).toBe(false);
    } finally { fetcher.mockRestore(); }
  });
  it("sends feed alt text and JSON collaborator usernames", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ id: "container" }));
    try { await createInstagramContainer(testEnv, publication("post", { collaborators: ["friend"] }), media, "https://example.test/photo"); const fields = new URLSearchParams(fetcher.mock.calls[0][1]?.body as URLSearchParams); expect(fields.get("alt_text")).toBe("Friends outside the classroom"); expect(JSON.parse(fields.get("collaborators")!)).toEqual(["friend"]); } finally { fetcher.mockRestore(); }
  });
  it("sends Reel music identity, cover and feed settings through Facebook Login", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ id: "container" }));
    try {
      await createInstagramContainer({ ...testEnv, META_LOGIN_MODE: "facebook" }, publication("reel", { audio: { id: "123", volume: 75, videoVolume: 20 }, coverFrameMs: 1234, shareToFeed: false }), media, "https://example.test/video");
      const [url, init] = fetcher.mock.calls[0]; const fields = new URLSearchParams(init?.body as URLSearchParams);
      expect(String(url)).toContain("graph.facebook.com"); expect(fields.get("thumb_offset")).toBe("1234"); expect(fields.get("share_to_feed")).toBe("false"); expect(JSON.parse(fields.get("audio_configuration")!)).toEqual({ audio_id: "123", audio_volume: 75, video_volume: 20 }); expect(JSON.parse(fields.get("user_tags")!)).toEqual([{ username: "classmate" }]);
    } finally { fetcher.mockRestore(); }
  });
  it("puts collaborators on the carousel parent", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ id: "container" }));
    try { await createCarouselContainer(testEnv, publication("carousel", { collaborators: ["friend"] }), ["child1", "child2"]); const fields = new URLSearchParams(fetcher.mock.calls[0][1]?.body as URLSearchParams); expect(fields.get("children")).toBe("child1,child2"); expect(JSON.parse(fields.get("collaborators")!)).toEqual(["friend"]); } finally { fetcher.mockRestore(); }
  });
});
describe("music connection access and encryption", () => {
  it("removes web credential writes and never returns server secrets", async () => {
    await user("admin");
    expect((await call("/api/admin/meta-connection/app", { appId: "123456789", secret: "a-secret-long-enough" })).status).toBe(404);
    const status = await call("/api/admin/meta-connection", undefined, true, "__Host-bh_session=creative-session", { ...testEnv, META_FACEBOOK_APP_ID: "123456789", META_FACEBOOK_APP_SECRET: "private-app-secret" });
    const body = await status.text(); expect(body).not.toContain("private-app-secret"); expect(body).not.toContain("123456789");
  });
  it("does not enable catalog UI without a working connection", async () => { await user(); expect(await (await call("/api/creative/capabilities")).json()).toMatchObject({ catalogMusic: false, storyMentions: true }); expect((await call("/api/music?q=hello")).status).toBe(409); });
  it("requires authentication for music search and preview", async () => { expect((await call("/api/music", undefined, true, "")).status).toBe(401); expect((await call("/api/music/123/preview", undefined, true, "")).status).toBe(401); });
  it.each([200, 302, 503])("streams approved music previews and rejects redirects or upstream errors: %s", async status => {
    await user();
    await saveEncrypted(testEnv, "meta_facebook_connection", { token: "fb-token", userId: "class-account", expiresAt: 4_102_444_800 });
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).includes("graph.facebook.com")) return Response.json({ download_url: "https://scontent.fbcdn.net/preview.mp4" });
      expect(String(input)).toBe("https://scontent.fbcdn.net/preview.mp4");
      expect(init?.redirect).toBe("manual");
      return new Response(status === 200 ? "preview-bytes" : null, { status, headers: { "Content-Type": "video/mp4", ...(status === 302 ? { Location: "https://untrusted.example/audio" } : {}) } });
    });
    try {
      const response = await call("/api/music/123/preview");
      expect(response.status).toBe(status === 200 ? 200 : 502);
      if (status === 200) { expect(await response.text()).toBe("preview-bytes"); expect(response.headers.get("Content-Type")).toBe("video/mp4"); }
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally { fetcher.mockRestore(); }
  });
  it("uses the connected account id and token for publishing calls", async () => {
    await saveEncrypted(testEnv, "meta_facebook_connection", { token: "fb-secret-token", userId: "fb-account", username: "class", expiresAt: 4_102_444_800 });
    expect(await hasCatalogMusic(testEnv)).toBe(true); expect((await resolveMetaEnv(testEnv)).META_IG_USER_ID).toBe("fb-account");
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ id: "container" }));
    try { await createInstagramContainer(testEnv, publication("post"), media, "https://example.test/photo"); expect(String(fetcher.mock.calls[0][0])).toContain("graph.facebook.com/v26.0/fb-account/media"); expect(new Headers(fetcher.mock.calls[0][1]?.headers).get("Authorization")).toBe("Bearer fb-secret-token"); } finally { fetcher.mockRestore(); }
  });
  it("blocks expired saved tokens without silently switching accounts", async () => { await saveEncrypted(testEnv, "meta_facebook_connection", { token: "expired", userId: "fb-account", username: "class", expiresAt: 1 }); expect(await hasCatalogMusic(testEnv)).toBe(false); await expect(requestMeta(testEnv, "me")).rejects.toMatchObject({ code: "credentials_missing" }); });
  it("blocks atomically switching connections while publishing is active", async () => {
    await user(); await testEnv.DB.prepare("INSERT INTO publications(id,created_by,type,status,idempotency_key,request_hash) VALUES ('active','creative','post','queued','key','hash')").run();
    expect(await saveEncrypted(testEnv, "meta_facebook_connection", { token: "new" }, true)).toBe(false); expect(await loadEncrypted(testEnv, "meta_facebook_connection")).toBeUndefined();
  });
  it("rejects an OAuth callback without matching browser state", async () => { await user("admin"); const response = await call("/api/auth/meta/callback?state=forged&code=forged"); expect(response.status).toBe(303); expect(response.headers.get("Location")).toContain("meta=failed"); expect(await loadEncrypted(testEnv, "meta_facebook_connection")).toBeUndefined(); });
  it("does not permit tampering with encrypted settings", async () => { await saveEncrypted(testEnv, "meta_facebook_app", { secret: "secret" }); await testEnv.DB.prepare("UPDATE app_settings SET value=substr(value,1,length(value)-4)||'AAAA' WHERE key='meta_facebook_app'").run(); await expect(loadEncrypted(testEnv, "meta_facebook_app")).rejects.toMatchObject({ code: "connection_unreadable" }); });
  it.each([true, false])("OAuth verifies the existing class account before connecting: same account %s", async sameAccount => {
    await user("admin");
    const facebookEnv = { ...testEnv, META_FACEBOOK_APP_ID: "123456789", META_FACEBOOK_APP_SECRET: "test-app-secret" };
    const start = await call("/api/admin/meta-connection/start", {}, true, "__Host-bh_session=creative-session", facebookEnv); expect(start.status).toBe(200); const { url } = await start.json() as { url: string }; const state = new URL(url).searchParams.get("state")!;
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async value => {
      const url = new URL(String(value));
      if (url.pathname.endsWith("oauth/access_token")) return Response.json({ access_token: "new-token", expires_in: 60 * 86400 });
      if (url.hostname === "graph.instagram.com") return Response.json({ username: "class_account" });
      if (url.pathname.endsWith("me/accounts")) return Response.json({ data: [{ instagram_business_account: { id: "17840000000001", username: sameAccount ? "class_account" : "someone_else" } }] });
      if (url.pathname.endsWith("ig_audio")) return Response.json({ audio: [] });
      return Response.json({ data: [{ quota_usage: 0 }] });
    });
    try {
      const response = await call(`/api/auth/meta/callback?state=${state}&code=test-code`, undefined, true, `__Host-bh_session=creative-session; bh_meta_state=${state}`, facebookEnv);
      expect(response.status).toBe(303); expect(response.headers.get("Location")).toContain(sameAccount ? "meta=connected" : "meta=wrong-account");
      expect(await hasCatalogMusic(testEnv)).toBe(sameAccount);
      if (sameAccount) expect((await resolveMetaEnv(testEnv)).META_IG_USER_ID).toBe("17840000000001"); else expect(await loadEncrypted(testEnv, "meta_facebook_connection")).toBeUndefined();
      const replay = await call(`/api/auth/meta/callback?state=${state}&code=test-code`, undefined, true, `__Host-bh_session=creative-session; bh_meta_state=${state}`, facebookEnv); expect(replay.headers.get("Location")).toContain("meta=failed");
    } finally { fetcher.mockRestore(); }
  });
});
