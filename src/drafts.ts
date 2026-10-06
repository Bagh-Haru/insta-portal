import { openDB } from "idb";
import type { CreativeOptions } from "../shared/creative";
import type { PublicationType } from "./types";
import type { UploadedMedia } from "./media";
export type LocalDraft = { id: string; owner: string; savedAt: number; type: PublicationType; caption: string; items: UploadedMedia[]; options: CreativeOptions; submissionKey: string };
const db = () => openDB("bagh-haru-drafts", 1, { upgrade(database) { database.createObjectStore("drafts", { keyPath: "id" }); } });
export async function listDrafts(owner: string): Promise<LocalDraft[]> { return (await (await db()).getAll("drafts") as LocalDraft[]).filter(d => d.owner === owner).sort((a, b) => b.savedAt - a.savedAt); }
export async function saveDraft(draft: LocalDraft) {
  const drafts = await listDrafts(draft.owner);
  if (drafts.length >= 10 && !drafts.some(d => d.id === draft.id)) throw new Error("You have 10 saved drafts. Delete an old draft first.");
  if (draft.items.reduce((n, i) => n + i.file.size + (i.original === i.file ? 0 : i.original.size), 0) > 200_000_000) throw new Error("This draft is too large to save on this device. Keep it under 200 MB.");
  try { await (await db()).put("drafts", draft); } catch { throw new Error("Your browser could not save this draft. Free some device storage and try again."); }
}
export async function removeDraft(id: string, owner: string) { const database = await db(); const draft = await database.get("drafts", id) as LocalDraft | undefined; if (draft?.owner === owner) await database.delete("drafts", id); }
