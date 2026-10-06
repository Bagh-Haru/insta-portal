import { api, ApiError, uploadFile } from "./api";
import type { PublicationStatus, PublicationType } from "./types";
import type { CreativeOptions, MediaOptions } from "../shared/creative";

type SubmissionInput = { idempotencyKey: string; type: PublicationType; caption: string; files: File[]; options?: CreativeOptions; mediaOptions?: MediaOptions[] };
type Draft = { id: string; status: PublicationStatus; uploads: Array<{ mediaId: string; url: string | null }> };

const pause = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
const retryable = (error: unknown) => error instanceof TypeError
  || (error instanceof ApiError && (error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500));

// All writes retried here have an idempotent server contract. Keep the same draft and files.
async function retry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (attempt >= 2 || !retryable(error)) throw error;
      await pause(1000 * 2 ** attempt);
    }
  }
}

export async function submitPublication(input: SubmissionInput, onProgress: (percent: number) => void): Promise<PublicationStatus> {
  const draft = await retry(() => api<Draft>("/api/publications", {
    method: "POST",
    body: JSON.stringify({ idempotencyKey: input.idempotencyKey, type: input.type,
      caption: input.type === "story" ? "" : input.caption,
      options: input.options,
      media: input.files.map((file, index) => ({ name: file.name, mimeType: file.type, sizeBytes: file.size, options: input.mediaOptions?.[index] })) }),
  }));
  if (draft.status !== "uploading") return draft.status;
  if (draft.uploads.length !== input.files.length) throw new Error("The upload does not match the selected files. Check My posts before retrying.");
  let completedBytes = 0;
  const totalBytes = input.files.reduce((sum, file) => sum + file.size, 0);
  for (let index = 0; index < input.files.length; index++) {
    const file = input.files[index];
    await retry(async () => {
      const permission = await api<{ url: string | null; uploaded: boolean }>(
        `/api/publications/${encodeURIComponent(draft.id)}/uploads/${encodeURIComponent(draft.uploads[index].mediaId)}`,
        { method: "POST", body: "{}" },
      );
      if (permission.uploaded) return;
      if (!permission.url) throw new Error("Could not get permission to upload this file.");
      try {
        await uploadFile(permission.url, file, (loaded) => onProgress(Math.min(99, Math.round((completedBytes + loaded) / totalBytes * 100))));
      } catch (error) {
        // An expired R2 signature needs a fresh permission, rather than the old URL.
        if (error instanceof ApiError && error.status === 403) throw new ApiError("Upload permission expired. Renewing it…", 0);
        throw error;
      }
    });
    await retry(() => api(`/api/publications/${encodeURIComponent(draft.id)}/uploads/${encodeURIComponent(draft.uploads[index].mediaId)}/complete`, {
      method: "POST", body: "{}",
    }));
    completedBytes += file.size;
    onProgress(Math.min(99, Math.round(completedBytes / totalBytes * 100)));
  }
  const result = await retry(() => api<{ status: PublicationStatus }>(`/api/publications/${encodeURIComponent(draft.id)}/complete`, {
    method: "POST", body: JSON.stringify({ mediaIds: draft.uploads.map((upload) => upload.mediaId) }),
  }));
  onProgress(100);
  return result.status;
}
