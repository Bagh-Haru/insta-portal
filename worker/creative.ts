import type { Hono } from "hono";
import type { Env } from "./types";
import { HttpError, requirePrincipal, requireRateLimit } from "./security";
import { requestMeta } from "./instagram";
import { hasCatalogMusic, resolveMetaEnv } from "./meta-connection";

type AudioAsset = { audio_id?: string; title?: string; display_artist?: string; duration_in_ms?: number; download_url?: string; preview_url?: string };
export function registerCreativeRoutes(app: Hono<{ Bindings: Env }>): void {
  app.get("/api/creative/capabilities", async (c) => {
    await requirePrincipal(c);
    return c.json({ catalogMusic: await hasCatalogMusic(c.env), storyMentions: true, peopleTags: true, collaborators: true });
  });
  app.get("/api/music", async (c) => {
    const user = await requirePrincipal(c);
    if (!await hasCatalogMusic(c.env)) throw new HttpError(409, "music_connection_required", "Instagram catalog music for Reels needs a Facebook Page and Facebook Login.");
    await requireRateLimit(c.env.DB, `music_search:${user.id}`, 30, 60);
    const query = (c.req.query("q") ?? "").trim();
    if (query.length > 100) throw new HttpError(400, "search_too_long", "Search with 100 characters or fewer.");
    const connection = await resolveMetaEnv(c.env);
    const result = await requestMeta<{ audio?: AudioAsset[] }>(connection, `ig_audio?${new URLSearchParams({ audio_type: "music", user_id: connection.META_IG_USER_ID, search_query: query })}`);
    return c.json({ items: (result.audio ?? []).slice(0, 30).filter(a => /^\d{1,30}$/.test(a.audio_id ?? "")).map(a => ({ id: a.audio_id!, title: a.title ?? "Untitled", artist: a.display_artist ?? "", durationMs: a.duration_in_ms ?? 0, hasPreview: Boolean(a.download_url || a.preview_url) })) });
  });
  app.get("/api/music/:id/preview", async (c) => {
    const user = await requirePrincipal(c);
    if (!await hasCatalogMusic(c.env)) throw new HttpError(409, "music_connection_required", "Instagram music needs Facebook Login.");
    const id = c.req.param("id");
    if (!/^\d{1,30}$/.test(id)) throw new HttpError(400, "invalid_audio_id", "This audio selection is invalid.");
    await requireRateLimit(c.env.DB, `music_preview:${user.id}`, 30, 60);
    const connection = await resolveMetaEnv(c.env);
    const track = await requestMeta<AudioAsset>(connection, `${id}?${new URLSearchParams({ user_id: connection.META_IG_USER_ID })}`);
    const preview = track.download_url || track.preview_url;
    if (!preview) throw new HttpError(404, "preview_unavailable", "This track has no preview.");
    const url = new URL(preview);
    if (url.protocol !== "https:" || !["fbcdn.net", "cdninstagram.com"].some(domain => url.hostname.endsWith(`.${domain}`))) throw new HttpError(502, "invalid_preview", "The music preview is unavailable.");
    let response: Response;
    try {
      // Workers supports manual redirects. Never follow a provider URL to another host.
      response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
    } catch { throw new HttpError(502, "preview_unavailable", "The music preview is unavailable. Try again."); }
    if (!response.ok) throw new HttpError(502, "preview_unavailable", "The music preview has expired. Search again.");
    return new Response(response.body, { headers: { "Content-Type": response.headers.get("Content-Type") ?? "audio/mpeg", "Cache-Control": "no-store" } });
  });
}
