export type AppUser = {
  id: string;
  email: string;
  name: string;
  role: "member" | "admin" | "pending_bootstrap";
};

export type PublicationStatus = "uploading" | "queued" | "publishing" | "published" | "failed";
export type PublicationType = "post" | "reel" | "story" | "carousel";

export type Publication = {
  id: string;
  type: PublicationType;
  caption: string;
  status: PublicationStatus;
  createdAt: string;
  publishedAt: string | null;
  permalink: string | null;
  errorMessage: string | null;
  media: Array<{ name: string; mimeType: string; sizeBytes: number }>;
};

export type ApiSession = {
  user: AppUser | null;
  csrfToken: string | null;
  bootstrapAvailable: boolean;
};
