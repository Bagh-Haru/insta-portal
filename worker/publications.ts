import { AwsV4Signer } from "aws4fetch";
import { Hono } from "hono";
import { z } from "zod";
import type { Env, MediaRow, PublicationType } from "./types";
import { getMediaFetchUrl } from "./instagram";
import { hasCatalogMusic } from "./meta-connection";
import { HttpError, mediaCapability, recordAudit, requireCsrf, requirePrincipal, requireRateLimit, safeFilename, sha256, verifyMediaCapability } from "./security";

const photoMimeTypes = ["image/jpeg"] as const;
const videoMimeTypes = ["video/mp4", "video/quicktime"] as const;
const acceptedMimeTypes = [...photoMimeTypes, ...videoMimeTypes] as const;
const usernameSchema = z.string().regex(/^[A-Za-z0-9._]{1,30}$/);
const mediaOptionsSchema = z.object({
  tags: z.array(z.object({ username: usernameSchema, x: z.number().min(0).max(1), y: z.number().min(0).max(1) })).max(20).default([]),
  altText: z.string().trim().max(1000).optional(),
});
const creativeOptionsSchema = z.object({
  collaborators: z.array(usernameSchema).max(3).optional(),
  shareToFeed: z.boolean().optional(),
  coverFrameMs: z.number().int().min(0).max(900_000).optional(),
  audio: z.object({ id: z.string().regex(/^\d{1,30}$/), volume: z.number().int().min(1).max(100), videoVolume: z.number().int().min(1).max(100) }).optional(),
});
const createPublicationSchema = z.object({
  idempotencyKey: z.string().uuid(),
  type: z.enum(["post", "reel", "story", "carousel"]),
  caption: z.string().max(2200),
  options: creativeOptionsSchema.optional(),
  media: z.array(z.object({
    name: z.string().min(1).max(180),
    mimeType: z.enum(acceptedMimeTypes),
    sizeBytes: z.number().int().positive(),
    options: mediaOptionsSchema.optional(),
  })).min(1).max(10),
});

function maxForMime(env: Env, mime: string): number {
  if (mime.startsWith("video/")) return parsePositiveInteger(env.MAX_VIDEO_BYTES, 200 * 1024 * 1024);
  return Math.min(parsePositiveInteger(env.MAX_IMAGE_BYTES, 8_000_000), 8_000_000);
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function validateMediaType(type: PublicationType, media: Array<{ mimeType: string }>): void {
  if (type === "post" && (media.length !== 1 || !media[0].mimeType.startsWith("image/"))) {
    throw new HttpError(400, "invalid_media_for_type", "A post needs one JPEG photo.");
  }
  if (type === "reel" && (media.length !== 1 || !media[0].mimeType.startsWith("video/"))) {
    throw new HttpError(400, "invalid_media_for_type", "A Reel needs one MP4 or MOV video.");
  }
  if (type === "story" && media.length !== 1) throw new HttpError(400, "invalid_media_for_type", "A Story needs one photo or video.");
  if (type === "carousel" && (media.length < 2 || media.length > 10)) throw new HttpError(400, "invalid_media_for_type", "A carousel needs 2 to 10 items.");
}

function validateCaption(type: PublicationType, caption: string): string {
  if (type === "story" && caption.trim()) throw new HttpError(400, "caption_not_supported", "Instagram Stories published through the API do not accept a caption.");
  return caption.trim();
}

async function createUploadUrl(env: Env, key: string, mimeType: string, sizeBytes: number): Promise<string> {
  const accountId = env.R2_ACCOUNT_ID?.trim();
  const accessKeyId = env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY?.trim();
  if (!accountId || !accessKeyId || !secretAccessKey) throw new HttpError(503, "upload_not_configured", "Direct media uploads are not configured yet.");
  const bucket = encodeURIComponent(env.MEDIA_BUCKET || "insta-portal-media");
  const objectPath = key.split("/").map(encodeURIComponent).join("/");
  // Use Web Crypto rather than the AWS SDK's Node runtime in the production bundle.
  const signer = new AwsV4Signer({
    url: `https://${accountId}.r2.cloudflarestorage.com/${bucket}/${objectPath}?X-Amz-Expires=300`,
    method: "PUT",
    headers: { "Content-Type": mimeType, "Content-Length": String(sizeBytes) },
    accessKeyId,
    secretAccessKey,
    service: "s3",
    region: "auto",
    signQuery: true,
    allHeaders: true,
  });
  return (await signer.sign()).url.toString();
}

async function issueUploads(env: Env, ownerId: string, publicationId: string): Promise<Array<{ mediaId: string; url: string | null }>> {
  const result = await env.DB.prepare(
    "SELECT id, staging_key, mime_type, size_bytes FROM publication_media WHERE publication_id = ? ORDER BY position ASC",
  ).bind(publicationId).all<{ id: string; staging_key: string | null; mime_type: string; size_bytes: number }>();
  const uploads = [];
  for (const media of result.results) {
    if (!media.staging_key) { uploads.push({ mediaId: media.id, url: null }); continue; }
    if (!media.staging_key.startsWith(`staging/${ownerId}/${publicationId}/`)) throw new HttpError(409, "upload_already_finalized", "This submission has already left the upload stage.");
    const expires = Math.floor(Date.now() / 1000) + 300;
    await env.DB.prepare("UPDATE publication_media SET upload_url_expires_at = ? WHERE id = ? AND publication_id = ?")
      .bind(expires, media.id, publicationId).run();
    uploads.push({ mediaId: media.id, url: await createUploadUrl(env, media.staging_key, media.mime_type, media.size_bytes) });
  }
  return uploads;
}

async function objectPrefix(env: Env, key: string): Promise<Uint8Array | null> {
  const object = await env.MEDIA.get(key, { range: { offset: 0, length: 16 } });
  if (!object) return null;
  const bytes = await object.arrayBuffer();
  return new Uint8Array(bytes);
}

function hasValidSignature(mimeType: string, prefix: Uint8Array): boolean {
  if (mimeType === "image/jpeg") return prefix.length >= 3 && prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff;
  if (mimeType === "video/mp4" || mimeType === "video/quicktime") {
    return prefix.length >= 12 && new TextDecoder().decode(prefix.subarray(4, 8)) === "ftyp";
  }
  return false;
}

type UploadMediaRow = MediaRow & { staging_key: string | null; upload_url_expires_at: number | null };

async function finalizeMedia(env: Env, publicationId: string, item: UploadMediaRow, urlExpiry: number): Promise<void> {
  if (item.staging_key) {
    // A PUT started with valid permission may finish after its URL expires.
    // Accept its validated bytes while the publication is still in the upload stage.
    const staged = await env.MEDIA.head(item.staging_key);
    if (!staged || staged.size !== item.size_bytes || staged.httpMetadata?.contentType !== item.mime_type) {
      throw new HttpError(400, "uploaded_object_invalid", "An uploaded file is missing or does not match its approved type and size.");
    }
    const prefix = await objectPrefix(env, item.staging_key);
    if (!prefix || !hasValidSignature(item.mime_type, prefix)) throw new HttpError(400, "invalid_file_signature", "An uploaded file does not match its declared media type.");
    const source = await env.MEDIA.get(item.staging_key);
    if (!source) throw new HttpError(400, "uploaded_object_missing", "An uploaded file could not be read. Upload it again.");
    const stableKey = `media/${publicationId}/${item.id}`;
    await env.MEDIA.put(stableKey, source.body, {
      httpMetadata: { contentType: item.mime_type, cacheControl: "no-store" },
      customMetadata: { publicationId, mediaId: item.id },
    });
    await env.DB.prepare(
      "UPDATE publication_media SET object_key = ?, staging_key = NULL, upload_url_expires_at = NULL, media_url_expires_at = ? WHERE id = ? AND publication_id = ?",
    ).bind(stableKey, urlExpiry, item.id, publicationId).run();
    await env.MEDIA.delete(item.staging_key).catch(() => undefined);
    item.object_key = stableKey;
    item.media_url_expires_at = urlExpiry;
  } else {
    const accepted = await env.MEDIA.head(item.object_key);
    if (!accepted || accepted.size !== item.size_bytes || accepted.httpMetadata?.contentType !== item.mime_type) {
      throw new HttpError(400, "uploaded_object_invalid", "An uploaded file could not be verified. Upload it again.");
    }
    await env.DB.prepare("UPDATE publication_media SET media_url_expires_at = ? WHERE id = ? AND publication_id = ?")
      .bind(urlExpiry, item.id, publicationId).run();
    item.media_url_expires_at = urlExpiry;
  }
}

function serializePublication(row: Record<string, unknown>, media: Array<{ original_name: string; mime_type: string; size_bytes: number }>) {
  return {
    id: row.id as string,
    type: row.type as PublicationType,
    caption: row.caption as string,
    status: row.status as string,
    createdAt: row.created_at as string,
    publishedAt: (row.published_at as string | null) ?? null,
    permalink: (row.permalink as string | null) ?? null,
    errorMessage: (row.error_message as string | null) ?? null,
    media: media.map((item) => ({ name: item.original_name, mimeType: item.mime_type, sizeBytes: item.size_bytes })),
  };
}

export function registerPublicationRoutes(app: Hono<{ Bindings: Env }>): void {
  app.get("/api/publications", async (c) => {
    const principal = await requirePrincipal(c);
    const requested = Number(c.req.query("limit") ?? "20");
    const limit = Number.isInteger(requested) ? Math.max(1, Math.min(50, requested)) : 20;
    const result = await c.env.DB.prepare(
      `SELECT id, type, caption, status, created_at, published_at, permalink, media_count, error_message
         FROM publications WHERE created_by = ? ORDER BY created_at DESC LIMIT ?`,
    ).bind(principal.id, limit).all<Record<string, unknown>>();
    const items = [];
    for (const publication of result.results) {
      const mediaResult = await c.env.DB.prepare(
        "SELECT original_name, mime_type, size_bytes FROM publication_media WHERE publication_id = ? ORDER BY position ASC",
      ).bind(publication.id as string).all<{ original_name: string; mime_type: string; size_bytes: number }>();
      items.push(serializePublication(publication, mediaResult.results));
    }
    return c.json({ items });
  });

  app.post("/api/publications", async (c) => {
    const principal = await requirePrincipal(c);
    requireCsrf(c, principal);
    const parsed = createPublicationSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "invalid_submission", "Check the publication type, caption and selected files.");
    const input = parsed.data;
    validateMediaType(input.type, input.media);
    const caption = validateCaption(input.type, input.caption);
    if (input.type === "story" && input.options?.collaborators?.length) throw new HttpError(400, "unsupported_collaborators", "Stories do not support collaborator invitations.");
    if (input.type !== "reel" && (input.options?.audio || input.options?.coverFrameMs !== undefined || input.options?.shareToFeed !== undefined)) throw new HttpError(400, "reel_options_only", "Music catalog, cover frame and feed sharing options are for Reels.");
    if (input.options?.audio && !await hasCatalogMusic(c.env)) throw new HttpError(400, "music_connection_required", "Instagram catalog music requires the Facebook Login connection. You can use your own audio in the editor.");
    if (input.media.some((m) => m.options?.altText && (input.type === "story" || input.type === "reel" || !m.mimeType.startsWith("image/")))) throw new HttpError(400, "alt_text_images_only", "Alt text is supported for feed photos.");
    if (input.media.some((item) => item.sizeBytes > Math.min(maxForMime(c.env, item.mimeType),
      input.type === "story" && item.mimeType.startsWith("video/") ? 100_000_000 : Infinity))) {
      throw new HttpError(413, "file_too_large", "A selected file is over the maximum size for Instagram publishing.");
    }
    const totalBytes = input.media.reduce((sum, item) => sum + item.sizeBytes, 0);
    if (totalBytes > 400 * 1024 * 1024) throw new HttpError(413, "submission_too_large", "This publication exceeds the total upload size limit.");
    const canonical = JSON.stringify({ type: input.type, caption, media: input.media.map((item) => ({ name: safeFilename(item.name), mimeType: item.mimeType, sizeBytes: item.sizeBytes, ...(item.options ? { options: item.options } : {}) })), ...(input.options ? { options: input.options } : {}) });
    const requestHash = await sha256(canonical);
    const existing = await c.env.DB.prepare(
      "SELECT id, status, request_hash FROM publications WHERE created_by = ? AND idempotency_key = ? LIMIT 1",
    ).bind(principal.id, input.idempotencyKey).first<{ id: string; status: string; request_hash: string }>();
    if (existing) {
      if (existing.request_hash !== requestHash) throw new HttpError(409, "idempotency_conflict", "The submission changed. Refresh the form and submit it again.");
      if (existing.status !== "uploading") return c.json({ id: existing.id, status: existing.status, uploads: [] });
      const active = await c.env.DB.prepare("SELECT COUNT(*) AS count FROM publications WHERE created_by = ? AND status IN ('uploading','queued','publishing')")
        .bind(principal.id).first<{ count: number }>();
      if (!active || active.count > 3) throw new HttpError(429, "too_many_active", "Finish or wait for an earlier upload before starting another.");
      return c.json({ id: existing.id, status: existing.status, uploads: await issueUploads(c.env, principal.id, existing.id) });
    }

    await requireRateLimit(c.env.DB, `publication_create:${principal.id}`, 5, 24 * 60 * 60);
    await requireRateLimit(c.env.DB, `publication_hour:${principal.id}`, 3, 60 * 60);
    const active = await c.env.DB.prepare("SELECT COUNT(*) AS count FROM publications WHERE created_by = ? AND status IN ('uploading','queued','publishing')")
      .bind(principal.id).first<{ count: number }>();
    if ((active?.count ?? 0) >= 3) throw new HttpError(429, "too_many_active", "Finish or wait for an earlier upload before starting another.");
    const id = crypto.randomUUID();
    const media = input.media.map((item, index) => ({ id: crypto.randomUUID(), key: `staging/${principal.id}/${id}/${crypto.randomUUID()}`, item, index }));
    const statements = [
      c.env.DB.prepare(
        `INSERT INTO publications (id, created_by, type, caption, status, idempotency_key, request_hash, media_count, creative_json, updated_at)
         VALUES (?, ?, ?, ?, 'uploading', ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
      ).bind(id, principal.id, input.type, caption, input.idempotencyKey, requestHash, media.length, JSON.stringify(input.options ?? {})),
      ...media.map(({ id: mediaId, key, item, index }) => c.env.DB.prepare(
        `INSERT INTO publication_media (id, publication_id, object_key, staging_key, original_name, mime_type, size_bytes, position, creative_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(mediaId, id, `pending/${id}/${mediaId}`, key, safeFilename(item.name), item.mimeType, item.sizeBytes, index, JSON.stringify(item.options ?? {}))),
    ];
    try {
      await c.env.DB.batch(statements);
    } catch {
      const duplicate = await c.env.DB.prepare("SELECT id, status, request_hash FROM publications WHERE created_by = ? AND idempotency_key = ? LIMIT 1")
        .bind(principal.id, input.idempotencyKey).first<{ id: string; status: string; request_hash: string }>();
      if (duplicate) throw new HttpError(409, "already_submitted", "This submission already exists. Check My submissions before trying again.");
      throw new HttpError(503, "submission_unavailable", "Could not prepare this publication. Please try again.");
    }
    await recordAudit(c.env.DB, principal.id, "publication_created", "publication", id, { type: input.type, mediaCount: media.length });
    const uploads = await issueUploads(c.env, principal.id, id);
    return c.json({ id, status: "uploading", uploads }, 201);
  });

  // Renew each file immediately before its PUT, and keep already uploaded files on retries.
  app.post("/api/publications/:id/uploads/:mediaId", async (c) => {
    const principal = await requirePrincipal(c);
    requireCsrf(c, principal);
    const media = await c.env.DB.prepare(
      `SELECT m.id, m.staging_key, m.object_key, m.mime_type, m.size_bytes FROM publication_media m
       JOIN publications p ON p.id = m.publication_id
       WHERE p.id = ? AND p.created_by = ? AND p.status = 'uploading' AND m.id = ?`,
    ).bind(c.req.param("id"), principal.id, c.req.param("mediaId")).first<{
      id: string; staging_key: string | null; object_key: string; mime_type: string; size_bytes: number;
    }>();
    if (!media) throw new HttpError(404, "upload_not_found", "This upload is unavailable. Check My posts before retrying.");
    if (media.staging_key && !media.staging_key.startsWith(`staging/${principal.id}/${c.req.param("id")}/`)) {
      throw new HttpError(409, "invalid_upload_destination", "This upload cannot be renewed.");
    }
    if (media.staging_key) {
      await c.env.DB.prepare("UPDATE publication_media SET upload_url_expires_at = ? WHERE id = ?")
        .bind(Math.floor(Date.now() / 1000) + 300, media.id).run();
    }
    const object = await c.env.MEDIA.head(media.staging_key ?? media.object_key);
    if (object && object.size === media.size_bytes && object.httpMetadata?.contentType === media.mime_type) {
      return c.json({ url: null, uploaded: true });
    }
    if (!media.staging_key) throw new HttpError(409, "finalized_media_missing", "An accepted file is missing. Ask an administrator to check this upload.");
    return c.json({ url: await createUploadUrl(c.env, media.staging_key, media.mime_type, media.size_bytes), uploaded: false });
  });

  // Finalize one file per request so ten-item carousels stay within Worker subrequest limits.
  app.post("/api/publications/:id/uploads/:mediaId/complete", async (c) => {
    const principal = await requirePrincipal(c);
    requireCsrf(c, principal);
    const publicationId = c.req.param("id");
    const item = await c.env.DB.prepare(
      `SELECT m.* FROM publication_media m JOIN publications p ON p.id = m.publication_id
       WHERE p.id = ? AND p.created_by = ? AND p.status = 'uploading' AND m.id = ?`,
    ).bind(publicationId, principal.id, c.req.param("mediaId")).first<UploadMediaRow>();
    if (!item) throw new HttpError(404, "upload_not_found", "This upload is unavailable. Check My posts before retrying.");
    await finalizeMedia(c.env, publicationId, item, Math.floor(Date.now() / 1000) + 6 * 60 * 60);
    return c.json({ ok: true });
  });

  app.post("/api/publications/:id/complete", async (c) => {
    const principal = await requirePrincipal(c);
    requireCsrf(c, principal);
    const publicationId = c.req.param("id");
    const body = await c.req.json().catch(() => null) as { mediaIds?: unknown } | null;
    if (!body || !Array.isArray(body.mediaIds) || body.mediaIds.length > 10 || body.mediaIds.some((item) => typeof item !== "string")) {
      throw new HttpError(400, "invalid_completion", "The upload completion request is invalid.");
    }
    const submittedMediaIds = body.mediaIds as string[];
    const publication = await c.env.DB.prepare(
      "SELECT id, created_by, type, status FROM publications WHERE id = ? AND created_by = ? LIMIT 1",
    ).bind(publicationId, principal.id).first<{ id: string; created_by: string; type: PublicationType; status: string }>();
    if (!publication) throw new HttpError(404, "publication_not_found", "This submission was not found.");
    if (publication.status !== "uploading") return c.json({ ok: true, status: publication.status });
    const rows = await c.env.DB.prepare(
      `SELECT id, publication_id, object_key, staging_key, upload_url_expires_at, original_name, mime_type, size_bytes, position, media_url_expires_at
         FROM publication_media WHERE publication_id = ? ORDER BY position ASC`,
    ).bind(publicationId).all<MediaRow & { staging_key: string | null; upload_url_expires_at: number | null }>();
    const media = rows.results;
    if (media.length !== submittedMediaIds.length || media.some((item, index) => item.id !== submittedMediaIds[index])) {
      throw new HttpError(400, "media_mismatch", "The uploaded files do not match this submission.");
    }
    validateMediaType(publication.type, media.map((item) => ({ mimeType: item.mime_type })));
    const urlExpiry = Math.floor(Date.now() / 1000) + 6 * 60 * 60;
    for (const item of media) await finalizeMedia(c.env, publicationId, item, urlExpiry);
    const update = await c.env.DB.prepare(
      `UPDATE publications SET status = 'queued', publish_step = 'create', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND created_by = ? AND status = 'uploading' RETURNING id`,
    ).bind(publicationId, principal.id).first<{ id: string }>();
    if (update) {
      await recordAudit(c.env.DB, principal.id, "publication_submitted", "publication", publicationId, { type: publication.type, mediaCount: media.length });
      try { await c.env.PUBLISH_QUEUE.send({ publicationId }); } catch { /* D1 is authoritative; the scheduled recovery task re-enqueues this record. */ }
    }
    const current = await c.env.DB.prepare("SELECT status FROM publications WHERE id = ?").bind(publicationId).first<{ status: string }>();
    return c.json({ ok: true, status: current?.status ?? "queued" }, 202);
  });

  app.get("/api/publications/:id", async (c) => {
    const principal = await requirePrincipal(c);
    const publicationId = c.req.param("id");
    const publication = await c.env.DB.prepare(
      `SELECT id, type, caption, status, created_at, published_at, permalink, media_count, error_message
         FROM publications WHERE id = ? AND created_by = ? LIMIT 1`,
    ).bind(publicationId, principal.id).first<Record<string, unknown>>();
    if (!publication) throw new HttpError(404, "publication_not_found", "This submission was not found.");
    const result = await c.env.DB.prepare(
      "SELECT original_name, mime_type, size_bytes FROM publication_media WHERE publication_id = ? ORDER BY position ASC",
    ).bind(publicationId).all<{ original_name: string; mime_type: string; size_bytes: number }>();
    return c.json({ publication: serializePublication(publication, result.results) });
  });

  app.get("/media/:token", async (c) => {
    const method = c.req.method;
    if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "method_not_allowed", "Method not allowed.");
    const capability = await verifyMediaCapability(c.env, c.req.param("token"));
    if (!capability) throw new HttpError(404, "media_not_found", "Media not found.");
    const media = await c.env.DB.prepare(
      `SELECT m.id, m.publication_id, m.object_key, m.original_name, m.mime_type, m.size_bytes, m.position, m.media_url_expires_at
         FROM publication_media m JOIN publications p ON p.id = m.publication_id
        WHERE m.id = ? AND m.media_url_expires_at = ? AND p.status = 'publishing' LIMIT 1`,
    ).bind(capability.mediaId, capability.expiry).first<MediaRow>();
    if (!media) throw new HttpError(404, "media_not_found", "Media not found.");
    if (method === "HEAD") {
      const object = await c.env.MEDIA.head(media.object_key);
      if (!object) throw new HttpError(404, "media_not_found", "Media not found.");
      return new Response(null, { headers: mediaHeaders(media.mime_type, object.size) });
    }
    const rangeHeader = c.req.header("Range");
    if (rangeHeader) {
      const metadata = await c.env.MEDIA.head(media.object_key);
      if (!metadata) throw new HttpError(404, "media_not_found", "Media not found.");
      const range = parseByteRange(rangeHeader, metadata.size);
      if (!range) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${metadata.size}`, "Cache-Control": "no-store" } });
      const object = await c.env.MEDIA.get(media.object_key, { range });
      if (!object) throw new HttpError(404, "media_not_found", "Media not found.");
      const headers = mediaHeaders(media.mime_type, range.length);
      headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${metadata.size}`);
      return new Response(object.body, { status: 206, headers });
    }
    const object = await c.env.MEDIA.get(media.object_key);
    if (!object) throw new HttpError(404, "media_not_found", "Media not found.");
    const headers = mediaHeaders(media.mime_type, object.size);
    object.writeHttpMetadata(headers);
    headers.set("Cache-Control", "private, no-store, max-age=0");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "no-referrer");
    headers.delete("Content-Disposition");
    return new Response(object.body, { headers });
  });
}

function mediaHeaders(contentType: string, size: number): Headers {
  return new Headers({
    "Content-Type": contentType,
    "Content-Length": String(size),
    "Cache-Control": "private, no-store, max-age=0",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Accept-Ranges": "bytes",
  });
}

function parseByteRange(value: string, size: number): { offset: number; length: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || size <= 0) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const offset = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(end) || offset >= size || end < offset) return null;
  return { offset, length: end - offset + 1 };
}

export function buildMediaUrl(env: Env, mediaId: string, expiry: number): Promise<string> {
  return mediaCapability(env, mediaId, expiry).then((token) => getMediaFetchUrl(env, token));
}
