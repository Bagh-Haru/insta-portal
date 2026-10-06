import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, uploadFile } from "./api";
import { submitPublication } from "./submission";

vi.mock("./api", async (importOriginal) => {
  const original = await importOriginal<typeof import("./api")>();
  return { ...original, api: vi.fn(), uploadFile: vi.fn() };
});

const apiMock = vi.mocked(api);
const putMock = vi.mocked(uploadFile);
const input = { idempotencyKey: "same-key", type: "post" as const, caption: "Hello", files: [new File(["photo"], "photo.jpg", { type: "image/jpeg" })] };
const draft = { id: "draft", status: "uploading", uploads: [{ mediaId: "first", url: "initial-expired-url" }] };

beforeEach(() => { apiMock.mockReset(); putMock.mockReset().mockResolvedValue(undefined); });

describe("upload recovery", () => {
  it("requests fresh permission for every file in a carousel", async () => {
    const secondFile = new File(["video"], "video.mp4", { type: "video/mp4" });
    apiMock.mockResolvedValueOnce({ ...draft, uploads: [...draft.uploads, { mediaId: "second", url: "another-expired-url" }] })
      .mockResolvedValueOnce({ url: "fresh-first", uploaded: false })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ url: "fresh-second", uploaded: false })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ status: "queued" });
    expect(await submitPublication({ ...input, type: "carousel", files: [...input.files, secondFile] }, vi.fn())).toBe("queued");
    expect(putMock.mock.calls.map(([url]) => url)).toEqual(["fresh-first", "fresh-second"]);
  });

  it("renews an expired storage signature and retries the same file", async () => {
    apiMock.mockResolvedValueOnce(draft).mockResolvedValueOnce({ url: "expired", uploaded: false })
      .mockResolvedValueOnce({ url: "renewed", uploaded: false }).mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ status: "queued" });
    putMock.mockRejectedValueOnce(new ApiError("Expired", 403)).mockResolvedValueOnce(undefined);
    await submitPublication(input, vi.fn());
    expect(putMock.mock.calls.map(([url]) => url)).toEqual(["expired", "renewed"]);
    expect(apiMock.mock.calls.filter(([path]) => path === "/api/publications")).toHaveLength(1);
  });

  it("checks storage after a lost PUT response and avoids sending the file twice", async () => {
    apiMock.mockResolvedValueOnce(draft).mockResolvedValueOnce({ url: "fresh", uploaded: false })
      .mockResolvedValueOnce({ url: null, uploaded: true }).mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ status: "queued" });
    putMock.mockRejectedValueOnce(new ApiError("Response lost", 0));
    await submitPublication(input, vi.fn());
    expect(putMock).toHaveBeenCalledTimes(1);
  });

  it("skips finalized files when retrying a partially completed submission", async () => {
    apiMock.mockResolvedValueOnce({ ...draft, uploads: [{ mediaId: "first", url: null }] })
      .mockResolvedValueOnce({ url: null, uploaded: true }).mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ status: "queued" });
    const progress = vi.fn();
    await submitPublication(input, progress);
    expect(putMock).not.toHaveBeenCalled();
    expect(progress).toHaveBeenLastCalledWith(100);
  });

  it("returns the existing status when the completion response was lost", async () => {
    apiMock.mockResolvedValueOnce({ id: "draft", status: "queued", uploads: [] });
    expect(await submitPublication(input, vi.fn())).toBe("queued");
    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(putMock).not.toHaveBeenCalled();
  });

  it("keeps the idempotency key when the creation response was lost", async () => {
    apiMock.mockRejectedValueOnce(new TypeError("Response lost"))
      .mockResolvedValueOnce({ id: "draft", status: "queued", uploads: [] });
    await submitPublication(input, vi.fn());
    expect(apiMock.mock.calls[0][1]?.body).toBe(apiMock.mock.calls[1][1]?.body);
  });

  it("does not automatically retry an authentication error", async () => {
    apiMock.mockRejectedValue(new ApiError("Sign in again", 401));
    await expect(submitPublication(input, vi.fn())).rejects.toThrow("Sign in again");
    expect(apiMock).toHaveBeenCalledTimes(1);
  });
});
