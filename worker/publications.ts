import { AwsV4Signer } from "aws4fetch";
import { Hono } from "hono";
import { z } from "zod";
import type { Env, MediaRow, PublicationType } from "./types";
import { getMediaFetchUrl } from "./instagram";
import { HttpError, mediaCapability, recordAudit, requireCsrf, requirePrincipal, requireRateLimit, safeFilename, sha256, verifyMediaCapability } from "./security";

const photoMimeTypes = ["image/jpeg"] as const;
const videoMimeTypes = ["video/mp4", "video/quicktime"] as const;
const acceptedMimeTypes = [...photoMimeTypes, ...videoMimeTypes] as const;
const createPublicationSchema = z.object({
  idempotencyKey: z.string().uuid(),
  type: z.enum(["post", "reel", "story", "carousel"]),
  caption: z.string().max(2200),
  media: z.array(z.object({
    name: z.string().min(1).max(180),
    mimeType: z.enum(acceptedMimeTypes),
    sizeBytes: z.number().int().positive(),
  })).min(1).max(10),
});

function maxForMime(env: Env, mime: string): number {
  if (mime.startsWith("video/")) return parsePositiveInteger(env.MAX_VIDEO_BYTES, 200 * 1024 * 1024);
  return parsePositiveInteger(env.MAX_IMAGE_BYTES, 8 * 1024 * 1024);
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

async function issueUploads(env: Env, ownerId: string, publicationId: string): Promise<Array<{ mediaId: string; url: string }>> {
  const result = await env.DB.prepare(
    "SELECT id, staging_key, mime_type, size_bytes FROM publication_media WHERE publication_id = ? ORDER BY position ASC",
  ).bind(publicationId).all<{ id: string; staging_key: string; mime_type: string; size_bytes: number }>();
  const uploads = [];
  for (const media of result.results) {
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
    if (input.media.some((item) => item.sizeBytes > maxForMime(c.env, item.mimeType))) {
      throw new HttpError(413, "file_too_large", "A selected file is over the maximum size for Instagram publishing.");
    }
    const totalBytes = input.media.reduce((sum, item) => sum + item.sizeBytes, 0);
    if (totalBytes > 400 * 1024 * 1024) throw new HttpError(413, "submission_too_large", "This publication exceeds the total upload size limit.");
    const canonical = JSON.stringify({ type: input.type, caption, media: input.media.map((item) => ({ name: safeFilename(item.name), mimeType: item.mimeType, sizeBytes: item.sizeBytes })) });
    const requestHash = await sha256(canonical);
    const existing = await c.env.DB.prepare(
      "SELECT id, status, request_hash FROM publications WHERE created_by = ? AND idempotency_key = ? LIMIT 1",
    ).bind(principal.id, input.idempotencyKey).first<{ id: string; status: string; request_hash: string }>();
    if (existing) {
      if (existing.request_hash !== requestHash) throw new HttpError(409, "idempotency_conflict", "The submission changed. Refresh the form and submit it again.");
      if (existing.status !== "uploading") throw new HttpError(409, "already_submitted", "This submission is already being processed. Check My submissions before trying again.");
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
        `INSERT INTO publications (id, created_by, type, caption, status, idempotency_key, request_hash, media_count, updated_at)
         VALUES (?, ?, ?, ?, 'uploading', ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
      ).bind(id, principal.id, input.type, caption, input.idempotencyKey, requestHash, media.length),
      ...media.map(({ id: mediaId, key, item, index }) => c.env.DB.prepare(
        `INSERT INTO publication_media (id, publication_id, object_key, staging_key, original_name, mime_type, size_bytes, position)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(mediaId, id, `pending/${id}/${mediaId}`, key, safeFilename(item.name), item.mimeType, item.sizeBytes, index)),
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
    for (const item of media) {
      if (item.staging_key) {
        if (!item.upload_url_expires_at || item.upload_url_expires_at < Math.floor(Date.now() / 1000) - 300) {
          throw new HttpError(410, "upload_expired", "The upload permission expired. Submit this publication again.");
        }
        const staged = await c.env.MEDIA.head(item.staging_key);
        if (!staged || staged.size !== item.size_bytes || staged.httpMetadata?.contentType !== item.mime_type) {
          throw new HttpError(400, "uploaded_object_invalid", "An uploaded file is missing or does not match its approved type and size.");
        }
        const prefix = await objectPrefix(c.env, item.staging_key);
        if (!prefix || !hasValidSignature(item.mime_type, prefix)) throw new HttpError(400, "invalid_file_signature", "An uploaded file does not match its declared media type.");
        const source = await c.env.MEDIA.get(item.staging_key);
        if (!source) throw new HttpError(400, "uploaded_object_missing", "An uploaded file could not be read. Upload it again.");
        const stableKey = `media/${publicationId}/${item.id}`;
        await c.env.MEDIA.put(stableKey, source.body, {
          httpMetadata: { contentType: item.mime_type, cacheControl: "no-store" },
          customMetadata: { publicationId, mediaId: item.id },
        });
        await c.env.DB.prepare(
          "UPDATE publication_media SET object_key = ?, staging_key = NULL, upload_url_expires_at = NULL, media_url_expires_at = ? WHERE id = ? AND publication_id = ?",
        ).bind(stableKey, urlExpiry, item.id, publicationId).run();
        await c.env.MEDIA.delete(item.staging_key).catch(() => undefined);
        item.object_key = stableKey;
        item.media_url_expires_at = urlExpiry;
      } else {
        const accepted = await c.env.MEDIA.head(item.object_key);
        if (!accepted || accepted.size !== item.size_bytes || accepted.httpMetadata?.contentType !== item.mime_type) {
          throw new HttpError(400, "uploaded_object_invalid", "An uploaded file could not be verified. Upload it again.");
        }
        await c.env.DB.prepare("UPDATE publication_media SET media_url_expires_at = ? WHERE id = ? AND publication_id = ?")
          .bind(urlExpiry, item.id, publicationId).run();
        item.media_url_expires_at = urlExpiry;
      }
    }
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
    "Accept-Ranges": "none",
  });
}

export function buildMediaUrl(env: Env, mediaId: string, expiry: number): Promise<string> {
  return mediaCapability(env, mediaId, expiry).then((token) => getMediaFetchUrl(env, token));
}
