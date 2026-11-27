/**
 * The edit document. Plain JSON, a few hundred bytes, owned by us.
 * The preview, all three exporters and the server read this same shape,
 * and it is what gets autosaved (localStorage here, a Postgres JSONB column in production).
 */
import type { FontId } from "../../shared/fonts";

export type Aspect = "16:9" | "9:16" | "1:1";

export interface Clip {
  id: string;
  /** "image": a photo shown for out - in seconds (in is 0); missing in older drafts, which means "video" */
  kind?: "video" | "image";
  name: string;
  src: string;
  /** trim points inside the source file, seconds */
  in: number;
  out: number;
  srcDuration: number;
  muted: boolean;
  hasAudio: boolean;
  /** audio channel count of the source (1 = mono); the server needs it to match browser loudness */
  channels?: number;
}

interface OverlayBase {
  id: string;
  /** centre of the overlay as a fraction of the frame (0..1) */
  x: number;
  y: number;
  /** when it is visible on the timeline, seconds */
  start: number;
  end: number;
}
export interface TextOverlay extends OverlayBase {
  kind: "text";
  text: string;
  /** px when the short side of the frame is 720; scaled for 1080p */
  fontSize: number;
  color: string;
  /** one of shared/fonts.js; missing in older drafts, which means the default font */
  font?: FontId;
  /** Instagram-style look; all missing in older drafts, which means plain centred text */
  bg?: TextBg;
  /** colour of the background box, #RRGGBB */
  bgColor?: string;
  align?: TextAlign;
  effect?: TextEffect;
}
export type TextBg = "none" | "solid" | "soft";
export type TextAlign = "left" | "center" | "right";
export type TextEffect = "none" | "outline" | "shadow" | "neon";

/** black or white, whichever reads better on `hex` */
export const contrastOn = (hex: string) => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return "#FFFFFF";
  const [r, g, b] = [m[1], m[2], m[3]].map((v) => parseInt(v!, 16) / 255) as [number, number, number];
  return 0.299 * r + 0.587 * g + 0.114 * b > 0.6 ? "#111111" : "#FFFFFF";
};
export interface ImageOverlay extends OverlayBase {
  kind: "image";
  src: string;
  /** file name shown on the timeline; older drafts derive it from src */
  name?: string;
  /** set only on title pictures made for an export: exact top-left in the export frame, placed without rescaling */
  pixel?: { left: number; top: number };
  /** width as a fraction of the frame width */
  width: number;
}
export type Overlay = TextOverlay | ImageOverlay;

export interface Project {
  aspect: Aspect;
  originalVolume: number;
  clips: Clip[];
  overlays: Overlay[];
  /** music pieces: each plays [in, out] of its file, starting at `start` on the timeline; they may overlap */
  audio: AudioClip[];
}

export interface AudioClip {
  id: string;
  name: string;
  src: string;
  /** where it starts on the timeline, seconds */
  start: number;
  /** the part of the file that plays, seconds */
  in: number;
  out: number;
  srcDuration: number;
  volume: number;
  /** audio channel count of the source (1 = mono); the server needs it to match browser loudness */
  channels?: number;
}

/** A blank edit: what "New project" starts from. */
export const emptyProject = (aspect: Aspect = "9:16"): Project => ({ aspect, originalVolume: 1, clips: [], overlays: [], audio: [] });

/** A photo on the video track lasts this long when added, and can be stretched up to PHOTO_MAX. */
export const PHOTO_SECONDS = 5;
export const PHOTO_MAX = 60;
export const isPhoto = (c: Clip) => c.kind === "image";
export const audioLen = (a: AudioClip) => a.out - a.in;

/**
 * Bring a saved draft up to the current shape. Drafts from before music pieces had one `music`
 * that played from 0 for the whole video; it becomes one piece doing the same.
 */
export function normalizeProject(raw: Project & { music?: { src: string; name: string; volume: number; channels?: number } | null }): Project {
  if (Array.isArray(raw.audio) && !("music" in raw)) return raw;
  const { music, ...rest } = raw;
  const total = (rest.clips ?? []).reduce((s, c) => s + (c.out - c.in), 0);
  const audio: AudioClip[] = Array.isArray(rest.audio) ? rest.audio : [];
  if (music && !audio.length) {
    const len = Math.max(total, 1);
    audio.push({ id: uid(), name: music.name, src: music.src, start: 0, in: 0, out: len, srcDuration: len, volume: music.volume, channels: music.channels });
  }
  return { ...rest, audio } as Project;
}

/** Display name for a media URL: last path part, without the upload timestamp prefix. */
export const fileLabel = (src: string) => decodeURIComponent(src.split("?")[0]?.split("/").pop() ?? src).replace(/^\d{10,}_/, "");

export const MIN_CLIP = 0.2;

/**
 * Keep trim points valid whatever the user types: 0 <= in < out <= srcDuration, at least MIN_CLIP long.
 * A non-number (an emptied field) keeps the previous value.
 */
export function clampTrim(c: Clip, patch: { in?: number; out?: number }): { in: number; out: number } {
  const ok = (x: number | undefined, fallback: number) => (x === undefined || !Number.isFinite(x) ? fallback : x);
  const max = c.srcDuration;
  let i = Math.min(Math.max(0, ok(patch.in, c.in)), Math.max(0, max - MIN_CLIP));
  let o = Math.min(max, Math.max(i + MIN_CLIP, ok(patch.out, c.out)));
  if (o - i < MIN_CLIP) i = Math.max(0, o - MIN_CLIP);
  return { in: i, out: o };
}

/** Where a new 3-second overlay goes: at the playhead, pulled back so it fits inside the video. */
export function newOverlayRange(p: Project, t: number, len = 3): { start: number; end: number } {
  const total = totalDuration(p);
  if (total <= 0) return { start: 0, end: len };
  const l = Math.min(len, total);
  const start = Math.max(0, Math.min(t, total - l));
  return { start, end: start + l };
}

/**
 * Drafts from before uploads went to the server hold blob: URLs, which die with the tab.
 * Drop those items so a reopened draft never points at media that no longer exists.
 */
export function dropDeadMedia(p: Project): { project: Project; removed: number } {
  const dead = (src: string) => src.startsWith("blob:");
  const clips = p.clips.filter((c) => !dead(c.src));
  const overlays = p.overlays.filter((o) => o.kind !== "image" || !dead(o.src));
  const audio = p.audio.filter((a) => !dead(a.src));
  const removed = p.clips.length - clips.length + (p.overlays.length - overlays.length) + (p.audio.length - audio.length);
  return { project: removed ? { ...p, clips, overlays, audio } : p, removed };
}

export const uid = () => Math.random().toString(36).slice(2, 9);
export const clipLen = (c: Clip) => c.out - c.in;
export const totalDuration = (p: Project) => p.clips.reduce((s, c) => s + clipLen(c), 0);

/** Where each clip starts on the timeline (clips are packed end to end, so reorder = array move). */
export function clipStarts(p: Project): number[] {
  const starts: number[] = [];
  let t = 0;
  for (const c of p.clips) {
    starts.push(t);
    t += clipLen(c);
  }
  return starts;
}

export function clipAt(p: Project, t: number): { clip: Clip; index: number; start: number } | null {
  const starts = clipStarts(p);
  for (let i = p.clips.length - 1; i >= 0; i--) {
    const clip = p.clips[i];
    const start = starts[i];
    if (clip && start !== undefined && t >= start) return { clip, index: i, start };
  }
  return null;
}

/** Split the clip under the playhead into two clips that share the same source file. */
export function splitAt(p: Project, t: number): Project {
  const hit = clipAt(p, t);
  if (!hit) return p;
  const cut = hit.clip.in + (t - hit.start);
  if (cut - hit.clip.in < 0.1 || hit.clip.out - cut < 0.1) return p;
  const a: Clip = { ...hit.clip, out: cut };
  const b: Clip = { ...hit.clip, id: uid(), in: cut };
  const clips = [...p.clips];
  clips.splice(hit.index, 1, a, b);
  return { ...p, clips };
}

export function moveClip(p: Project, from: number, to: number): Project {
  const clips = [...p.clips];
  const [c] = clips.splice(from, 1);
  if (!c) return p;
  clips.splice(to, 0, c);
  return { ...p, clips };
}

export const frameSize = (aspect: Aspect, height: 720 | 1080): [number, number] =>
  aspect === "16:9" ? [(height * 16) / 9, height] : aspect === "9:16" ? [height, (height * 16) / 9] : [height, height];
