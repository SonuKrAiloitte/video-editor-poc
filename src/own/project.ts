/**
 * The edit document. Plain JSON, a few hundred bytes, owned by us.
 * The preview, all three exporters and the server read this same shape,
 * and it is what gets autosaved (localStorage here, a Postgres JSONB column in production).
 */
export type Aspect = "16:9" | "9:16" | "1:1";

export interface Clip {
  id: string;
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
  /** id from shared/fonts.js; missing means the default font */
  font?: string;
}
export interface ImageOverlay extends OverlayBase {
  kind: "image";
  src: string;
  /** width as a fraction of the frame width */
  width: number;
}
export type Overlay = TextOverlay | ImageOverlay;

export interface Project {
  aspect: Aspect;
  originalVolume: number;
  clips: Clip[];
  overlays: Overlay[];
  music: { src: string; name: string; volume: number; channels?: number } | null;
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
