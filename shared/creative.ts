export type PersonTag = { username: string; x: number; y: number };
export type MediaOptions = { tags: PersonTag[]; altText?: string };
export type CreativeOptions = {
  collaborators?: string[];
  shareToFeed?: boolean;
  coverFrameMs?: number;
  audio?: { id: string; volume: number; videoVolume: number };
};
export type MusicTrack = { id: string; title: string; artist: string; durationMs: number; hasPreview: boolean };
