export type PublicationType = "post" | "reel" | "story" | "carousel";
export type PublicationStatus = "uploading" | "queued" | "publishing" | "published" | "failed";

export type Env = {
  DB: D1Database;
  MEDIA: R2Bucket;
  PUBLISH_QUEUE: Queue<PublishJob>;
  ASSETS: Fetcher;
  APP_ORIGIN: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  BOOTSTRAP_ADMIN_EMAIL: string;
  BOOTSTRAP_ADMIN_TOKEN: string;
  META_ACCESS_TOKEN: string;
  META_IG_USER_ID: string;
  META_API_VERSION: string;
  META_FACEBOOK_APP_ID?: string;
  META_FACEBOOK_APP_SECRET?: string;
  META_LOGIN_MODE?: "instagram" | "facebook";
  MEDIA_URL_SECRET: string;
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  MEDIA_BUCKET: string;
  MAX_VIDEO_BYTES: string;
  MAX_IMAGE_BYTES: string;
};

export type PublishJob = { publicationId: string };

export type UserRow = {
  id: string;
  email: string;
  google_sub: string | null;
  display_name: string;
  role: "member" | "admin" | "pending_bootstrap";
  enabled: number;
};

export type Principal = UserRow & { sessionTokenHash: string; csrfToken: string };

export type MediaRow = {
  id: string;
  publication_id: string;
  object_key: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  position: number;
  media_url_expires_at: number | null;
  creative_json?: string;
};

export type PublicationRow = {
  id: string;
  created_by: string;
  type: PublicationType;
  caption: string;
  status: PublicationStatus;
  media_count: number;
  publish_step: string | null;
  publish_data_json: string;
  poll_attempts: number;
  publish_attempted_at: number | null;
  retry_attempts: number;
  next_attempt_at: number | null;
  creative_json?: string;
};
