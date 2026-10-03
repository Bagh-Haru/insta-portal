import type { Env, MediaRow, PublicationRow } from "./types";

export class InstagramApiError extends Error {
  constructor(readonly code: string, readonly httpStatus: number) {
    super("Instagram API request failed.");
    this.name = "InstagramApiError";
  }
}

type MetaObject = { id?: string; status_code?: string; status?: string; permalink?: string; error?: { code?: number | string } };
type PublicationWithMediaUrls = PublicationRow & { mediaUrls: string[] };

function apiRoot(env: Env): string {
  return `https://graph.instagram.com/${env.META_API_VERSION || "v26.0"}`;
}

async function requestMeta(env: Env, path: string, init: RequestInit = {}): Promise<MetaObject> {
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
  const result = await response.json().catch(() => ({})) as MetaObject;
  if (!response.ok || result.error) {
    const code = result.error?.code === undefined ? `http_${response.status}` : String(result.error.code);
    throw new InstagramApiError(code, response.status);
  }
  return result;
}

export function getMediaFetchUrl(env: Env, rawToken: string): string {
  return `${env.APP_ORIGIN}/media/${encodeURIComponent(rawToken)}`;
}

export async function createInstagramContainers(env: Env, publication: PublicationWithMediaUrls, media: MediaRow[]): Promise<string> {
  if (media.some((item) => !item.media_url_expires_at || item.media_url_expires_at <= Math.floor(Date.now() / 1000))) {
    throw new InstagramApiError("media_link_expired", 0);
  }
  // The one-time media capability itself is added by the queue handler before this call.
  // Store links only in the job's temporary data, never in a browser response or audit record.
  const urls = publication.mediaUrls;
  if (!urls || urls.length !== media.length) throw new InstagramApiError("media_link_missing", 0);
  const rootId = env.META_IG_USER_ID.trim();
  const create = async (fields: Record<string, string>): Promise<string> => {
    const body = new URLSearchParams(fields);
    const result = await requestMeta(env, `${rootId}/media`, { method: "POST", body });
    if (!result.id || typeof result.id !== "string") throw new InstagramApiError("container_id_missing", 502);
    return result.id;
  };

  if (publication.type === "carousel") {
    const children: string[] = [];
    for (let index = 0; index < media.length; index++) {
      const item = media[index];
      const isVideo = item.mime_type.startsWith("video/");
      const fields: Record<string, string> = { is_carousel_item: "true" };
      if (isVideo) {
        fields.media_type = "VIDEO";
        fields.video_url = urls[index];
      } else {
        fields.image_url = urls[index];
      }
      children.push(await create(fields));
    }
    return create({ media_type: "CAROUSEL", children: children.join(","), caption: publication.caption });
  }

  const item = media[0];
  const url = urls[0];
  switch (publication.type) {
    case "post":
      return create({ image_url: url, caption: publication.caption });
    case "reel":
      return create({ media_type: "REELS", video_url: url, caption: publication.caption, share_to_feed: "true" });
    case "story":
      return create(item.mime_type.startsWith("video/") ? { media_type: "STORIES", video_url: url } : { media_type: "STORIES", image_url: url });
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
