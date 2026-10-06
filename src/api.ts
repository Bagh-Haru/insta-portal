import type { ApiSession } from "./types";

let csrfToken: string | null = null;

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  if (options.method && !["GET", "HEAD", "OPTIONS"].includes(options.method.toUpperCase()) && csrfToken) {
    headers.set("X-CSRF-Token", csrfToken);
  }

  const response = await fetch(path, { ...options, headers, credentials: "same-origin" });
  const body = (await response.json().catch(() => ({}))) as { error?: string; message?: string } & T;
  if (!response.ok) {
    throw new ApiError(body.message ?? body.error ?? "The request could not be completed.", response.status);
  }
  return body;
}

export async function getSession(): Promise<ApiSession> {
  const session = await api<ApiSession>("/api/session");
  csrfToken = session.csrfToken;
  return session;
}

export async function uploadFile(url: string, file: File, onProgress: (loaded: number) => void): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", url);
    request.timeout = 15 * 60 * 1000;
    request.setRequestHeader("Content-Type", file.type);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded);
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) resolve();
      else reject(new ApiError("The media upload did not finish. Request a new upload and try again.", request.status));
    };
    request.onerror = () => reject(new ApiError("Network error while uploading. Check your connection and retry.", 0));
    request.ontimeout = () => reject(new ApiError("The upload timed out. Check your connection and retry.", 0));
    request.onabort = () => reject(new ApiError("The upload was cancelled.", 0));
    request.send(file);
  });
}
