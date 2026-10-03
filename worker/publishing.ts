import type { MessageBatch } from "@cloudflare/workers-types";
import type { Env, MediaRow, PublicationRow, PublishJob } from "./types";
import { buildMediaUrl } from "./publications";
import { createInstagramContainers, getContainerStatus, getInstagramPermalink, instagramErrorMessage, InstagramApiError, publishInstagramContainer } from "./instagram";
import { recordAudit } from "./security";

type PublishData = { containerId?: string };

async function loadMedia(env: Env, publicationId: string): Promise<MediaRow[]> {
  const result = await env.DB.prepare(
    `SELECT id, publication_id, object_key, original_name, mime_type, size_bytes, position, media_url_expires_at
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
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND status = 'publishing'`,
  ).bind(code.slice(0, 80), message.slice(0, 240), publication.id).run();
  await recordAudit(env.DB, publication.created_by, "publication_failed", "publication", publication.id, { code: code.slice(0, 80) });
}

async function runOne(env: Env, publicationId: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const claimed = await env.DB.prepare(
    `UPDATE publications SET lease_until = ?,
       status = CASE WHEN status = 'queued' THEN 'publishing' ELSE status END,
       publish_step = CASE WHEN status = 'queued' THEN 'create' ELSE publish_step END,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ? AND status IN ('queued','publishing') AND (lease_until IS NULL OR lease_until <= ?) RETURNING *`,
  ).bind(now + 55, publicationId, now).first<PublicationRow & { lease_until: number | null }>();
  if (!claimed) return;
  const publication = claimed;
  if (publication.publish_attempted_at !== null || publication.publish_step === "publishing_request") {
    await env.DB.prepare("UPDATE publications SET lease_until = NULL WHERE id = ?").bind(publication.id).run();
    return;
  }

  try {
    if (publication.publish_step === "create") {
      const media = await loadMedia(env, publication.id);
      if (!media.length || media.length !== publication.media_count || media.some((item) => !item.media_url_expires_at || item.media_url_expires_at <= now + 60)) {
        throw new InstagramApiError("media_link_expired", 0);
      }
      const mediaUrls = await Promise.all(media.map((item) => buildMediaUrl(env, item.id, item.media_url_expires_at!)));
      const parentId = await createInstagramContainers(env, { ...publication, mediaUrls }, media);
      const data: PublishData = { containerId: parentId };
      await env.DB.prepare(
        `UPDATE publications SET publish_step = 'poll', publish_data_json = ?, poll_attempts = 0, lease_until = NULL,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND status = 'publishing'`,
      ).bind(JSON.stringify(data), publication.id).run();
      await sendNext(env, publication.id, 15);
      return;
    }

    const data = JSON.parse(publication.publish_data_json || "{}") as PublishData;
    if (publication.publish_step === "poll") {
      if (!data.containerId) throw new InstagramApiError("container_id_missing", 0);
      const status = await getContainerStatus(env, data.containerId);
      if (status === "FINISHED") {
        await env.DB.prepare(
          `UPDATE publications SET publish_step = 'ready', lease_until = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE id = ? AND status = 'publishing' AND publish_step = 'poll'`,
        ).bind(publication.id).run();
        await sendNext(env, publication.id, 1);
        return;
      }
      if (status === "ERROR" || status === "EXPIRED") {
        await failPublication(env, publication, `container_${status.toLowerCase()}`, "Instagram could not prepare this media. Check the file format and account restrictions.");
        return;
      }
      if (publication.poll_attempts >= 24) {
        await failPublication(env, publication, "processing_timeout", "Instagram did not finish preparing this media in time. Ask an administrator to check its status.");
        return;
      }
      await env.DB.prepare(
        `UPDATE publications SET poll_attempts = poll_attempts + 1, lease_until = NULL,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND status = 'publishing' AND publish_step = 'poll'`,
      ).bind(publication.id).run();
      await sendNext(env, publication.id, 20);
      return;
    }

    if (publication.publish_step === "ready") {
      if (!data.containerId) throw new InstagramApiError("container_id_missing", 0);
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
        return;
      }
      const permalink = await getInstagramPermalink(env, mediaId);
      await env.DB.prepare(
        `UPDATE publications SET status = 'published', ig_media_id = ?, permalink = ?, error_code = NULL, error_message = NULL,
           published_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), lease_until = NULL,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND status = 'publishing' AND publish_attempted_at = ?`,
      ).bind(mediaId, permalink, publication.id, attemptAt).run();
      await recordAudit(env.DB, publication.created_by, "publication_published", "publication", publication.id, { mediaId });
      await removePublicationObjects(env, publication.id);
      return;
    }

    await failPublication(env, publication, "invalid_publish_state", "This publication reached an unexpected processing state. Ask an administrator to review it.");
  } catch (error) {
    const code = error instanceof InstagramApiError ? error.code : "publish_processing_error";
    await failPublication(env, publication, code, instagramErrorMessage(code));
  }
}

async function removePublicationObjects(env: Env, publicationId: string): Promise<void> {
  const media = await env.DB.prepare(
    "SELECT id, object_key, staging_key FROM publication_media WHERE publication_id = ?",
  ).bind(publicationId).all<{ id: string; object_key: string; staging_key: string | null }>();
  for (const item of media.results) {
    await env.MEDIA.delete(item.object_key).catch(() => undefined);
    if (item.staging_key) await env.MEDIA.delete(item.staging_key).catch(() => undefined);
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
    } catch {
      // Never retry an uncertain media_publish call. D1 state and the recovery cron decide what is safe.
    } finally {
      message.ack();
    }
  }
}

export async function runScheduled(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare("DELETE FROM oauth_transactions WHERE expires_at <= ?").bind(now).run();
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now).run();
  await env.DB.prepare("DELETE FROM rate_limits WHERE window_ends_at <= ?").bind(now).run();

  const expiredStage = await env.DB.prepare(
    "SELECT id, staging_key FROM publication_media WHERE staging_key IS NOT NULL AND upload_url_expires_at <= ?",
  ).bind(now).all<{ id: string; staging_key: string }>();
  for (const item of expiredStage.results) {
    await env.MEDIA.delete(item.staging_key).catch(() => undefined);
    // Retain the staging destination so an unfinished upload can receive a fresh URL.
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
       (status = 'publishing' AND publish_attempted_at IS NULL AND publish_step IN ('create','poll','ready')))
       AND updated_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 seconds')
     ORDER BY updated_at ASC LIMIT 100`,
  ).all<{ id: string }>();
  for (const publication of recoverable.results) {
    const reserved = await env.DB.prepare(
      `UPDATE publications SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND (lease_until IS NULL OR lease_until <= ?)
         AND (status = 'queued' OR (status = 'publishing' AND publish_attempted_at IS NULL AND publish_step IN ('create','poll','ready'))) RETURNING id`,
    ).bind(publication.id, now).first<{ id: string }>();
    if (reserved) await env.PUBLISH_QUEUE.send({ publicationId: publication.id }).catch(() => undefined);
  }

  const stalePublished = await env.DB.prepare(
    `SELECT id FROM publications WHERE status IN ('published','failed')
       AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day') LIMIT 100`,
  ).all<{ id: string }>();
  for (const publication of stalePublished.results) await removePublicationObjects(env, publication.id);
}
