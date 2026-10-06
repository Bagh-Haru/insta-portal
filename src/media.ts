import type { MediaOptions } from "../shared/creative";

export type UploadedMedia = { id: string; original: File; file: File; options: MediaOptions };

// Format conversion only. Keep the photo's framing and do not burn tags into it.
export async function preparePhoto(file: File): Promise<File> {
  if (!file.type.startsWith("image/") || file.type === "image/jpeg") return file;
  const url = URL.createObjectURL(file);
  try {
    const image = new Image(); image.src = url; await image.decode();
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 1440 / Math.max(image.naturalWidth, image.naturalHeight));
    canvas.width = Math.round(image.naturalWidth * scale); canvas.height = Math.round(image.naturalHeight * scale);
    const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("Photo conversion is unavailable.");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error("Photo conversion failed.")), "image/jpeg", .92));
    return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch { throw new Error("This photo cannot be opened in your browser. Export it as JPEG and choose it again."); }
  finally { URL.revokeObjectURL(url); }
}
