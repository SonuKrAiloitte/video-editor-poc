/**
 * The edit document. Plain JSON, a few kilobytes, owned by us.
 * The preview, all three exporters and the server read this same shape,
 * and it is what gets autosaved (localStorage here, a Postgres JSONB column in production).
 *
 * Tracks work like CapCut (rules in shared/model.js):
 *   main track   video and image clips, joined end to end, no gaps
 *   visual track video, image and text, anywhere in time
 *   audio track  audio only
 */
import { frameSizeFor, mainDuration, mainStarts, projectDuration, resolveAspect, transitionDur } from "../../shared/model.js";

/** "W:H" such as "9:16" or "2.35:1", or "original" (the first main clip's shape) */
export type Aspect = string;
export type TrackKind = "visual" | "audio";

/** A clip on the main track. */
export interface Clip {
  id: string;
  /** "image" clips are stills shown for out - in seconds */
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
  /** picture width / height */
  ratio?: number;
  /** "fit" (default): the whole picture with black bars; "fill": cropped to cover the frame */
  fit?: "fit" | "fill";
  /** size on top of fit/fill (1 = as fitted), centre as fractions of the frame, turn in degrees clockwise */
  scale?: number;
  x?: number;
  y?: number;
  rotation?: number;
  /** set while exporting when the main track is hidden */
  hidden?: boolean;
  /** transition INTO this clip from the one before it: an id from shared/fx.js and its length in seconds */
  transition?: { type: string; duration: number };
}

/** The buttons on a track header. Locked: nothing on it can be moved, trimmed or deleted. */
export interface TrackState {
  locked?: boolean;
  hidden?: boolean;
  muted?: boolean;
}

export interface Track extends TrackState {
  id: string;
  kind: TrackKind;
  /** "captions": the visual track that holds the caption lines */
  role?: "captions" | "effects";
}

interface OverlayBase {
  id: string;
  /** id of the visual track it sits on */
  track: string;
  /** centre of the item as a fraction of the frame (0..1) */
  x: number;
  y: number;
  /** when it is visible on the timeline, seconds */
  start: number;
  end: number;
  /** turn in degrees, clockwise, about its centre */
  rotation?: number;
  /** set while exporting when its track is hidden */
  hidden?: boolean;
}
export interface TextOverlay extends OverlayBase {
  kind: "text";
  text: string;
  /** px when the short side of the frame is 720; scaled for 1080p */
  fontSize: number;
  color: string;
  /** id from shared/fonts.js; missing means the default font */
  font?: string;
  /** colour of a box behind the text ("#RRGGBB"); no box when missing */
  bg?: string;
  /** opacity of that box, 0..1 (default 0.6) */
  bgOpacity?: number;
}
export interface ImageOverlay extends OverlayBase {
  kind: "image";
  src: string;
  /** width as a fraction of the frame width */
  width: number;
}
/** A video on a track above the main track (picture in picture). It plays source time `in` at timeline time `start`. */
export interface VideoOverlay extends OverlayBase {
  kind: "video";
  name: string;
  src: string;
  in: number;
  srcDuration: number;
  /** width as a fraction of the frame width */
  width: number;
  muted: boolean;
  hasAudio: boolean;
  channels?: number;
}
/** An effect strip: while it runs it changes everything drawn below its track (x, y are unused). */
export interface EffectOverlay extends OverlayBase {
  kind: "effect";
  /** an id from shared/fx.js EFFECTS */
  effect: string;
  /** strength 0..1 */
  amount: number;
}
export type Overlay = TextOverlay | ImageOverlay | VideoOverlay | EffectOverlay;
/** overlays that show a file (image or video) */
export const hasFile = (o: Overlay): o is ImageOverlay | VideoOverlay => o.kind === "image" || o.kind === "video";

/** An audio clip on an audio track. It plays source time `in`..`out` starting at timeline time `start`. */
export interface AudioItem {
  id: string;
  track: string;
  name: string;
  src: string;
  start: number;
  in: number;
  out: number;
  srcDuration: number;
  volume: number;
  channels?: number;
}

export interface Project {
  aspect: Aspect;
  /** volume of the sound that comes with video clips */
  originalVolume: number;
  clips: Clip[];
  /** the main track's buttons */
  main?: TrackState;
  tracks: Track[];
  overlays: Overlay[];
  audios: AudioItem[];
}

export const uid = () => Math.random().toString(36).slice(2, 9);
export const clipLen = (c: Clip) => c.out - c.in;
/** length of the whole edit (main track, or longer if another track runs on) */
export const totalDuration = (p: Project): number => projectDuration(p);
export const mainLength = (p: Project): number => mainDuration(p);
/** source time `in`..`out` that a video overlay plays */
export const overlayOut = (o: VideoOverlay) => o.in + (o.end - o.start);

/** Where each clip starts on the main track (packed end to end, overlapping by their transitions). */
export const clipStarts = (p: Project): number[] => mainStarts(p);

/** The transition playing at time t on the main track, if any: progress p goes 1 -> 0, as in FFmpeg's xfade. */
export function transitionAt(p: Project, t: number): { from: Clip; fromStart: number; to: Clip; toStart: number; type: string; duration: number; progress: number } | null {
  const starts = mainStarts(p);
  for (let i = 1; i < p.clips.length; i++) {
    const d = transitionDur(p, i);
    const s = starts[i]!;
    if (d > 0 && t >= s && t < s + d) {
      // whole frames, as in the export (30 fps), and in 32-bit floats like FFmpeg's xfade:
      // progress = 1 - frame / frames in the transition
      const frame = Math.floor((t - s) * 30 + 1e-6);
      const frames = Math.round(d * 30);
      const progress = Math.fround(1 - Math.fround(Math.fround(frame) / Math.fround(frames)));
      return { from: p.clips[i - 1]!, fromStart: starts[i - 1]!, to: p.clips[i]!, toStart: s, type: p.clips[i]!.transition!.type, duration: d, progress: Math.min(1, Math.max(0, progress)) };
    }
  }
  return null;
}

export function clipAt(p: Project, t: number): { clip: Clip; index: number; start: number } | null {
  if (t >= mainDuration(p)) return null;
  const starts = clipStarts(p);
  for (let i = p.clips.length - 1; i >= 0; i--) {
    const clip = p.clips[i];
    const start = starts[i];
    if (clip && start !== undefined && t >= start) return { clip, index: i, start };
  }
  return null;
}

/** Split the main-track clip under the playhead into two clips that share the same source file. */
export function splitAt(p: Project, t: number): Project {
  const hit = clipAt(p, t);
  if (!hit) return p;
  const cut = hit.clip.in + (t - hit.start);
  if (cut - hit.clip.in < 0.1 || hit.clip.out - cut < 0.1) return p;
  const a: Clip = { ...hit.clip, out: cut };
  const { transition: _keep, ...rest } = hit.clip; // the transition stays at the start of the first half
  const b: Clip = { ...rest, id: uid(), in: cut };
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

/** Index on the main track where something dropped at timeline time `at` should go. */
export function insertIndexAt(p: Project, at: number): number {
  const st = clipStarts(p);
  const i = p.clips.findIndex((c, k) => at < (st[k] ?? 0) + clipLen(c) / 2);
  return i === -1 ? p.clips.length : i;
}

/** frame size in pixels for this edit; `height` is the short side, 720 or 1080 */
export const frameSize = (p: Pick<Project, "aspect" | "clips">, height: 720 | 1080): [number, number] =>
  frameSizeFor(resolveAspect(p as Project), height);
