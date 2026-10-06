import type { Env, MediaRow, PublicationRow } from "./types";
import type { CreativeOptions, MediaOptions } from "../shared/creative";
import { resolveMetaEnv } from "./meta-connection";
import { HttpError } from "./security";

export class InstagramApiError extends Error {
  constructor(readonly code: string, readonly httpStatus: number, readonly subcode?: number, readonly traceId?: string, readonly isTransient = false) {
    super("Instagram API request failed.");
    this.name = "InstagramApiError";
  }
}

type MetaObject = { id?: string; status_code?: string; status?: string; permalink?: string; error?: { code?: number | string; error_subcode?: number; fbtrace_id?: string; is_transient?: boolean } };

function apiRoot(env: Env): string {
  return `https://${env.META_LOGIN_MODE === "facebook" ? "graph.facebook.com" : "graph.instagram.com"}/${env.META_API_VERSION || "v26.0"}`;
}
async function publishingEnv(env: Env): Promise<Env> {
  try { return await resolveMetaEnv(env); }
  catch (error) {
    if (error instanceof HttpError && ["instagram_reconnect_required", "connection_unreadable", "connection_not_configured"].includes(error.code)) throw new InstagramApiError("credentials_missing", 503);
    throw error;
  }
}

export async function requestMeta<T extends object = MetaObject>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  env = await publishingEnv(env);
  const token = env.META_ACCESS_TOKEN?.trim();
  if (!token || !env.META_IG_USER_ID?.trim()) throw new InstagramApiError("credentials_missing", 503);
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/x-www-form-urlencoded;charset=UTF-8");
  let response: Response;
  try {
    response = await fetch(`${apiRoot(env)}/${path}`, { ...init, headers, signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new InstagramApiError("network_error", 0);
  }
  const result = await response.json().catch(() => null) as MetaObject | null;
  if (!result || typeof result !== "object") throw new InstagramApiError("invalid_response", response.ok ? 502 : response.status);
  if (!response.ok || result.error) {
    const code = result.error?.code === undefined ? `http_${response.status}` : String(result.error.code);
    throw new InstagramApiError(code, response.status, result.error?.error_subcode, result.error?.fbtrace_id, result.error?.is_transient === true);
  }
  return result as T;
}

export function getMediaFetchUrl(env: Env, rawToken: string): string {
  return `${env.APP_ORIGIN}/media/${encodeURIComponent(rawToken)}`;
}

async function create(env: Env, fields: Record<string, string>): Promise<string> {
  env = await publishingEnv(env);
  const result = await requestMeta(env, `${env.META_IG_USER_ID.trim()}/media`, { method: "POST", body: new URLSearchParams(fields) });
  if (!result.id || typeof result.id !== "string") throw new InstagramApiError("container_id_missing", 502);
  return result.id;
}

export function createCarouselContainer(env: Env, publication: PublicationRow, children: string[]): Promise<string> {
  const options = JSON.parse(publication.creative_json || "{}") as CreativeOptions;
  return create(env, { media_type: "CAROUSEL", children: children.join(","), caption: publication.caption,
    ...(options.collaborators?.length ? { collaborators: JSON.stringify(options.collaborators) } : {}) });
}

export function createInstagramContainer(env: Env, publication: PublicationRow, item: MediaRow, url: string): Promise<string> {
  if (!item.media_url_expires_at || item.media_url_expires_at <= Math.floor(Date.now() / 1000)) throw new InstagramApiError("media_link_expired", 0);
  const options = JSON.parse(publication.creative_json || "{}") as CreativeOptions;
  const mediaOptions = JSON.parse(item.creative_json || "{}") as MediaOptions;
  const tags: Record<string, string> = mediaOptions.tags?.length ? { user_tags: JSON.stringify(mediaOptions.tags.map((tag) => publication.type === "reel" || (publication.type === "carousel" && item.mime_type.startsWith("video/")) ? { username: tag.username } : tag)) } : {};
  const alt: Record<string, string> = mediaOptions.altText ? { alt_text: mediaOptions.altText } : {};
  const collab: Record<string, string> = options.collaborators?.length ? { collaborators: JSON.stringify(options.collaborators) } : {};
  switch (publication.type) {
    case "post":
      return create(env, { image_url: url, caption: publication.caption, ...tags, ...alt, ...collab });
    case "reel":
      return create(env, { media_type: "REELS", video_url: url, caption: publication.caption, share_to_feed: String(options.shareToFeed ?? true), ...tags, ...collab,
        ...(options.coverFrameMs !== undefined ? { thumb_offset: String(options.coverFrameMs) } : {}),
        ...(options.audio ? { audio_configuration: JSON.stringify({ audio_id: options.audio.id, audio_volume: options.audio.volume, video_volume: options.audio.videoVolume }) } : {}) });
    case "story":
      return create(env, { media_type: "STORIES", ...(item.mime_type.startsWith("video/") ? { video_url: url } : { image_url: url }), ...tags });
    case "carousel":
      return create(env, item.mime_type.startsWith("video/") ? { is_carousel_item: "true", media_type: "VIDEO", video_url: url, ...tags } : { is_carousel_item: "true", image_url: url, ...tags, ...alt });
    default:
      throw new InstagramApiError("unsupported_publication_type", 400);
  }
}

export async function getContainerStatus(env: Env, containerId: string): Promise<string> {
  const fields = new URLSearchParams({ fields: "status_code,status" });
  const result = await requestMeta(env, `${encodeURIComponent(containerId)}?${fields.toString()}`, { method: "GET" });
  return result.status_code ?? "UNKNOWN";
}

export async function publishInstagramContainer(env: Env, containerId: string): Promise<string> {
  env = await publishingEnv(env);
  const result = await requestMeta(env, `${env.META_IG_USER_ID.trim()}/media_publish`, {
    method: "POST",
    body: new URLSearchParams({ creation_id: containerId }),
  });
  if (!result.id || typeof result.id !== "string") throw new InstagramApiError("published_media_id_missing", 502);
  return result.id;
}

export async function getInstagramPermalink(env: Env, mediaId: string): Promise<string | null> {
  try {
    const fields = new URLSearchParams({ fields: "id,permalink" });
    const result = await requestMeta(env, `${encodeURIComponent(mediaId)}?${fields.toString()}`, { method: "GET" });
    return typeof result.permalink === "string" ? result.permalink : null;
  } catch {
    return null;
  }
}

export function instagramErrorMessage(code: string): string {
  if (code === "credentials_missing" || code === "190" || code === "463") return "Instagram publishing is not connected. An administrator must check the Instagram API credentials.";
  if (code === "media_link_expired" || code === "media_link_missing") return "The temporary media link expired before Instagram could download the file. Submit it again.";
  if (code === "network_error") return "Instagram could not be reached. An administrator should check the publication before retrying.";
  if (code === "http_429" || code === "4" || code === "17") return "Instagram is temporarily limiting publishing. An administrator should check the publication before retrying.";
  return "Instagram could not publish this media. Check the file format and Instagram requirements, then ask an administrator before submitting it again.";
}

export function isRetryableInstagramError(error: InstagramApiError): boolean {
  if (["190", "463", "credentials_missing", "media_link_expired", "media_link_missing"].includes(error.code)) return false;
  return error.isTransient || error.code === "network_error" || error.httpStatus === 429 || error.httpStatus >= 500
    || ["1", "2", "4", "17", "32", "613"].includes(error.code);
}
