import type { MessageBatch } from "@cloudflare/workers-types";
import type { Env, MediaRow, PublicationRow, PublishJob } from "./types";
import { buildMediaUrl } from "./publications";
import { createCarouselContainer, createInstagramContainer, isRetryableInstagramError, getContainerStatus, getInstagramPermalink, instagramErrorMessage, InstagramApiError, publishInstagramContainer } from "./instagram";
import { recordAudit } from "./security";

type PublishData = { containerId?: string; children?: string[]; childIndex?: number };

async function loadMedia(env: Env, publicationId: string): Promise<MediaRow[]> {
  const result = await env.DB.prepare(
    `SELECT id, publication_id, object_key, original_name, mime_type, size_bytes, position, media_url_expires_at, creative_json
       FROM publication_media WHERE publication_id = ? ORDER BY position ASC`,
  ).bind(publicationId).all<MediaRow>();
  return result.results;
}

async function sendNext(env: Env, publicationId: string, delaySeconds = 5): Promise<void> {
  await env.PUBLISH_QUEUE.send({ publicationId }, { delaySeconds });
}

async function failPublication(env: Env, publication: PublicationRow, code: string, message: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE publications SET status = 'failed', error_code = ?, error_message = ?, lease_until = NULL,
       next_attempt_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND status = 'publishing'`,
  ).bind(code.slice(0, 80), message.slice(0, 240), publication.id).run();
  await recordAudit(env.DB, publication.created_by, "publication_failed", "publication", publication.id, { code: code.slice(0, 80) });
}

// Every delivery makes a bounded amount of progress, persisted before the next message.
async function runOne(env: Env, publicationId: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const publication = await env.DB.prepare(
    `UPDATE publications SET lease_until = ?,
       status = CASE WHEN status = 'queued' THEN 'publishing' ELSE status END,
       publish_step = CASE WHEN status = 'queued' THEN 'create' ELSE publish_step END,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ? AND status IN ('queued','publishing') AND (lease_until IS NULL OR lease_until <= ?)
       AND (next_attempt_at IS NULL OR next_attempt_at <= ?) RETURNING *`,
  ).bind(now + 120, publicationId, now, now).first<PublicationRow>();
  if (!publication) return;

  const advance = async (step: string, data: PublishData, delay = 15) => {
    await env.DB.prepare(
      `UPDATE publications SET publish_step = ?, publish_data_json = ?, poll_attempts = 0,
         retry_attempts = 0, next_attempt_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND status = 'publishing'`,
    ).bind(step, JSON.stringify(data), Math.floor(Date.now() / 1000) + delay, publication.id).run();
    await sendNext(env, publication.id, delay);
  };

  try {
    // A lost response to media_publish must never trigger another publish request.
    if (publication.publish_attempted_at !== null || publication.publish_step === "publishing_request") return;
    let data: PublishData;
    try { data = JSON.parse(publication.publish_data_json || "{}") as PublishData; }
    catch { throw new InstagramApiError("invalid_publish_state", 400); }

    if (publication.publish_step === "create") {
      const media = await loadMedia(env, publication.id);
      if (!media.length || media.length !== publication.media_count) throw new InstagramApiError("media_link_missing", 400);
      const children = data.children ?? [];
      const index = publication.type === "carousel" ? children.length : 0;
      if (index >= media.length) {
        await advance("poll_children", { children, childIndex: 0 }, 1);
        return;
      }
      const item = media[index];
      if (!item.media_url_expires_at || item.media_url_expires_at <= now + 60) throw new InstagramApiError("media_link_expired", 400);
      const url = await buildMediaUrl(env, item.id, item.media_url_expires_at);
      const containerId = await createInstagramContainer(env, publication, item, url);
      if (publication.type === "carousel") {
        children.push(containerId);
        await advance(children.length === media.length ? "poll_children" : "create", { children, childIndex: 0 }, 1);
      } else {
        await advance("poll", { containerId });
      }
      return;
    }

    if (publication.publish_step === "create_parent") {
      if (!data.children || data.children.length !== publication.media_count) throw new InstagramApiError("container_id_missing", 400);
      const containerId = await createCarouselContainer(env, publication, data.children);
      await advance("poll", { ...data, containerId });
      return;
    }

    if (publication.publish_step === "poll" || publication.publish_step === "poll_children") {
      const childIndex = data.childIndex ?? 0;
      const containerId = publication.publish_step === "poll_children" ? data.children?.[childIndex] : data.containerId;
      if (!containerId) throw new InstagramApiError("container_id_missing", 400);
      const status = await getContainerStatus(env, containerId);
      if (status === "FINISHED") {
        if (publication.publish_step === "poll_children") {
          const nextIndex = childIndex + 1;
          await advance(nextIndex === data.children!.length ? "create_parent" : "poll_children", { ...data, childIndex: nextIndex }, 1);
        } else {
          await advance("ready", data, 1);
        }
        return;
      }
      if (status === "ERROR" || status === "EXPIRED") {
        await failPublication(env, publication, `container_${status.toLowerCase()}`, "Instagram could not prepare this media. Check the file format and account restrictions.");
        return;
      }
      if (publication.poll_attempts >= 59) {
        await failPublication(env, publication, "processing_timeout", "Instagram did not finish preparing this media in time. Ask an administrator to check its status.");
        return;
      }
      await env.DB.prepare(
        `UPDATE publications SET poll_attempts = poll_attempts + 1, retry_attempts = 0, next_attempt_at = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND status = 'publishing'`,
      ).bind(Math.floor(Date.now() / 1000) + 60, publication.id).run();
      await sendNext(env, publication.id, 60);
      return;
    }

    if (publication.publish_step === "ready") {
      if (!data.containerId) throw new InstagramApiError("container_id_missing", 400);
      const attemptAt = Math.floor(Date.now() / 1000);
      const started = await env.DB.prepare(
        `UPDATE publications SET publish_attempted_at = ?, publish_step = 'publishing_request',
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ? AND status = 'publishing' AND publish_step = 'ready' AND publish_attempted_at IS NULL RETURNING id`,
      ).bind(attemptAt, publication.id).first<{ id: string }>();
      if (!started) return;
      let mediaId: string;
      try {
        mediaId = await publishInstagramContainer(env, data.containerId);
      } catch (error) {
        const code = error instanceof InstagramApiError ? error.code : "publish_request_failed";
        await failPublication(env, publication, "publish_outcome_unknown", `${instagramErrorMessage(code)} Do not retry until an admin checks the Instagram account.`);
        if (error instanceof InstagramApiError) await recordProviderError(env, publication, error);
        return;
      }
      // Save success before optional permalink, audit and storage operations.
      await env.DB.prepare(
        `UPDATE publications SET status = 'published', ig_media_id = ?, error_code = NULL, error_message = NULL,
           published_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), next_attempt_at = NULL,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND status = 'publishing' AND publish_attempted_at = ?`,
      ).bind(mediaId, publication.id, attemptAt).run();
      const permalink = await getInstagramPermalink(env, mediaId);
      await env.DB.prepare("UPDATE publications SET permalink = ? WHERE id = ? AND status = 'published'").bind(permalink, publication.id).run();
      await recordAudit(env.DB, publication.created_by, "publication_published", "publication", publication.id, { mediaId });
      await removePublicationObjects(env, publication.id);
      return;
    }

    await failPublication(env, publication, "invalid_publish_state", "This publication reached an unexpected processing state. Ask an administrator to review it.");
  } catch (error) {
    // Infrastructure failures go back to the Queue, rather than becoming a failed post.
    if (!(error instanceof InstagramApiError)) throw error;
    if (isRetryableInstagramError(error) && publication.retry_attempts < 5) {
      const delay = Math.min(900, 30 * 2 ** publication.retry_attempts);
      await env.DB.prepare(
        `UPDATE publications SET retry_attempts = retry_attempts + 1, next_attempt_at = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND status = 'publishing' AND publish_attempted_at IS NULL`,
      ).bind(Math.floor(Date.now() / 1000) + delay, publication.id).run();
      await sendNext(env, publication.id, delay);
      await recordProviderError(env, publication, error);
    } else {
      await failPublication(env, publication, error.code, instagramErrorMessage(error.code));
      await recordProviderError(env, publication, error);
    }
  } finally {
    await env.DB.prepare("UPDATE publications SET lease_until = NULL WHERE id = ?").bind(publication.id).run();
  }
}

async function recordProviderError(env: Env, publication: PublicationRow, error: InstagramApiError): Promise<void> {
  await recordAudit(env.DB, publication.created_by, "instagram_request_failed", "publication", publication.id, {
    code: error.code.slice(0, 80), httpStatus: error.httpStatus, subcode: error.subcode ?? null,
    traceId: error.traceId?.slice(0, 100) ?? null, step: publication.publish_step,
  });
}

async function removePublicationObjects(env: Env, publicationId: string): Promise<void> {
  const media = await env.DB.prepare(
    "SELECT id, object_key, staging_key FROM publication_media WHERE publication_id = ?",
  ).bind(publicationId).all<{ id: string; object_key: string; staging_key: string | null }>();
  for (const item of media.results) {
    await env.MEDIA.delete(item.object_key);
    if (item.staging_key) await env.MEDIA.delete(item.staging_key);
    await env.DB.prepare("UPDATE publication_media SET staging_key = NULL, upload_url_expires_at = NULL, media_url_expires_at = NULL WHERE id = ?").bind(item.id).run();
  }
}

export async function consumeQueue(batch: MessageBatch<PublishJob>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    const publicationId = message.body?.publicationId;
    if (typeof publicationId !== "string" || publicationId.length > 50) {
      message.ack();
      continue;
    }
    try {
      await runOne(env, publicationId);
      message.ack();
    } catch (error) {
      // Persisted publish_attempted_at prevents repeating media_publish on redelivery.
      console.error("Publication processing deferred", publicationId, error instanceof Error ? error.name : "unknown");
      message.retry({ delaySeconds: 60 });
    }
  }
}

export async function runScheduled(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare("DELETE FROM oauth_transactions WHERE expires_at <= ?").bind(now).run();
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now).run();
  await env.DB.prepare("DELETE FROM rate_limits WHERE window_ends_at <= ?").bind(now).run();

  const expiredStage = await env.DB.prepare(
    `SELECT m.id, m.staging_key FROM publication_media m JOIN publications p ON p.id = m.publication_id
       WHERE m.staging_key IS NOT NULL AND m.upload_url_expires_at <= ? AND p.status IN ('published','failed')`,
  ).bind(now).all<{ id: string; staging_key: string }>();
  for (const item of expiredStage.results) {
    await env.MEDIA.delete(item.staging_key).catch(() => undefined);
    // URL expiry only prevents new PUTs; an in-flight PUT can finish later.
    // Keep active uploads until finalization or the two-hour abandonment limit.
    // A null staging_key is reserved for media that passed finalization.
    await env.DB.prepare("UPDATE publication_media SET upload_url_expires_at = NULL WHERE id = ?").bind(item.id).run();
  }

  const abandoned = await env.DB.prepare(
    `SELECT id, created_by FROM publications WHERE status = 'uploading'
      AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 hours') LIMIT 100`,
  ).all<{ id: string; created_by: string }>();
  for (const publication of abandoned.results) {
    await env.DB.prepare(
      `UPDATE publications SET status = 'failed', error_code = 'upload_abandoned',
        error_message = 'This upload expired. Please submit it again.', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND status = 'uploading'`,
    ).bind(publication.id).run();
    await recordAudit(env.DB, publication.created_by, "upload_expired", "publication", publication.id);
  }

  const uncertain = await env.DB.prepare(
    `SELECT id, created_by FROM publications WHERE status = 'publishing' AND publish_attempted_at IS NOT NULL
      AND publish_attempted_at <= ? LIMIT 100`,
  ).bind(now - 5 * 60).all<{ id: string; created_by: string }>();
  for (const publication of uncertain.results) {
    await env.DB.prepare(
      `UPDATE publications SET status = 'failed', error_code = 'publish_outcome_unknown',
        error_message = 'Instagram may have received this publication. An administrator must check the account before retrying.',
        lease_until = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND status = 'publishing' AND publish_attempted_at IS NOT NULL`,
    ).bind(publication.id).run();
    await recordAudit(env.DB, publication.created_by, "publish_outcome_unknown", "publication", publication.id);
  }

  const recoverable = await env.DB.prepare(
    `SELECT id FROM publications WHERE (status = 'queued' OR
       (status = 'publishing' AND publish_attempted_at IS NULL AND publish_step IN ('create','poll_children','create_parent','poll','ready')))
       AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       AND updated_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 seconds')
     ORDER BY updated_at ASC LIMIT 100`,
  ).bind(now).all<{ id: string }>();
  for (const publication of recoverable.results) {
    const reserved = await env.DB.prepare(
      `UPDATE publications SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND (lease_until IS NULL OR lease_until <= ?)
         AND (status = 'queued' OR (status = 'publishing' AND publish_attempted_at IS NULL AND publish_step IN ('create','poll_children','create_parent','poll','ready'))) RETURNING id`,
    ).bind(publication.id, now).first<{ id: string }>();
    if (reserved) await env.PUBLISH_QUEUE.send({ publicationId: publication.id }).catch(() => undefined);
  }

  const stalePublished = await env.DB.prepare(
    `SELECT id FROM publications WHERE status IN ('published','failed')
       AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')
       AND EXISTS (SELECT 1 FROM publication_media m WHERE m.publication_id = publications.id
         AND (m.media_url_expires_at IS NOT NULL OR m.staging_key IS NOT NULL)) LIMIT 100`,
  ).all<{ id: string }>();
  for (const publication of stalePublished.results) {
    try { await removePublicationObjects(env, publication.id); }
    catch { console.error("Publication cleanup deferred", publication.id); }
  }
}
