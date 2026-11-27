/**
 * Media in and out of the edit, shared by both editor screens: reading a file's facts, uploading files the
 * user picks, the library list, and turning a picked item into a change to the project.
 */
import { useCallback, useEffect, useState } from "react";
import { ALL_FORMATS, BlobSource, Input, UrlSource } from "mediabunny";
import { loadImage } from "../compose";
import { blobNames, listLibrary, uploadFile, type LibraryItem } from "../exporters";
import { newOverlayRange, PHOTO_MAX, PHOTO_SECONDS, totalDuration, uid, type AudioClip, type Clip, type Overlay, type Project } from "../project";

export type Kind = LibraryItem["kind"];
export type Selection = { type: "clip" | "overlay" | "audio"; id: string };

/** Shown when the render server is not running, so the sample clips can still be picked. */
export const FALLBACK_LIBRARY: LibraryItem[] = (
  [
    ["clipA_h264_16x9.mp4", "video"], ["clipB_h264_9x16.mp4", "video"], ["clipC_vp9.webm", "video"],
    ["clipD_hevc.mov", "video"], ["music.mp3", "audio"], ["logo.png", "image"],
  ] as const
).map(([name, kind]) => ({ src: `/media/${name}`, name, kind, group: "sample" }));

/** Read a media file's facts. Library items are read with range requests, so a big file is not downloaded whole. */
export async function probe(source: Blob | string) {
  const input = new Input({
    source: typeof source === "string" ? new UrlSource(new URL(source, location.href)) : new BlobSource(source),
    formats: ALL_FORMATS,
  });
  const video = await input.getPrimaryVideoTrack();
  const audio = await input.getPrimaryAudioTrack();
  return {
    duration: await input.computeDuration(),
    hasAudio: !!audio,
    channels: audio?.numberOfChannels,
    codec: video?.codec ?? null,
    decodable: video ? await video.canDecode() : false,
  };
}

export function useLibrary() {
  const [library, setLibrary] = useState<LibraryItem[]>(FALLBACK_LIBRARY);
  const [serverUp, setServerUp] = useState(true);
  const refresh = useCallback(async () => {
    try {
      setLibrary(await listLibrary());
      setServerUp(true);
    } catch {
      setLibrary(FALLBACK_LIBRARY);
      setServerUp(false);
    }
  }, []);
  useEffect(() => void refresh(), [refresh]);
  return { library, serverUp, refresh };
}

export const kindOfFile = (f: File): Kind => (f.type.startsWith("video") ? "video" : f.type.startsWith("audio") ? "audio" : "image");

/**
 * Upload each picked file (a server URL survives a reload; a blob: URL would not), then hand it to `add`.
 * If the upload fails the file is still usable this session through a blob: URL, and `notify` says so.
 */
export async function importFiles(
  files: File[],
  add: (src: string, name: string, kind: Kind, file: File) => Promise<void>,
  notify: (msg: string | null) => void,
) {
  for (const f of files) {
    notify(`Uploading ${f.name} (${(f.size / 1024 / 1024).toFixed(1)} MB)...`);
    let src: string;
    let warn: string | null = null;
    try {
      src = await uploadFile(f);
    } catch (e) {
      src = URL.createObjectURL(f);
      blobNames.set(src, f.name);
      warn = `${f.name} could not be uploaded (${e instanceof Error ? e.message : e}). It is usable now but will be gone after a reload. Is the render server running?`;
    }
    await add(src, f.name, kindOfFile(f), f);
    if (warn) notify(warn);
  }
}

export interface AddResult {
  project: Project;
  select?: Selection;
  /** where the new item starts, for screens that move the playhead to it */
  at?: number;
  /** a plain-words reason the item could not be added */
  error?: string;
}

/**
 * The project with a media item added. Videos go to the end of the clips, audio becomes the music,
 * images become an overlay: for 3 s at the playhead ("playhead3s") or for the whole video ("whole").
 * `get` is read after the file is probed, so edits made meanwhile are kept.
 */
export async function addMediaTo(
  get: () => Project,
  item: { src: string; name: string; kind: Kind },
  t: number,
  opts: { overlayRange: "playhead3s" | "whole"; imageAs?: "overlay" | "clip"; file?: Blob },
): Promise<AddResult> {
  const { src, name, kind } = item;
  if (kind === "video") {
    const info = await probe(opts.file ?? src);
    if (!info.decodable) {
      return {
        project: get(),
        error: `${name}: this browser cannot decode ${info.codec ?? "the video"}. Server export can still read it; in production we transcode on upload.`,
      };
    }
    const p = get();
    const clip: Clip = { id: uid(), name, src, in: 0, out: info.duration, srcDuration: info.duration, muted: false, hasAudio: info.hasAudio, channels: info.channels };
    return { project: { ...p, clips: [...p.clips, clip] }, select: { type: "clip", id: clip.id }, at: totalDuration(p) };
  }
  if (kind === "audio") {
    const info = await probe(opts.file ?? src);
    const p = get();
    const total = totalDuration(p);
    // a new piece starts at the playhead (or at 0 if the playhead is at the very end) and stops where the video does
    const start = total > 0 && t < total - 0.5 ? +t.toFixed(2) : 0;
    const len = Math.min(info.duration, total > 0 ? total - start : info.duration);
    const piece: AudioClip = { id: uid(), name, src, start, in: 0, out: +len.toFixed(3), srcDuration: info.duration, volume: 0.4, channels: info.channels };
    return { project: { ...p, audio: [...p.audio, piece] }, select: { type: "audio", id: piece.id }, at: start };
  }
  await loadImage(src);
  const p = get();
  if (opts.imageAs === "clip") {
    // a photo on the video track, e.g. for a story made of pictures
    const clip: Clip = { id: uid(), kind: "image", name, src, in: 0, out: PHOTO_SECONDS, srcDuration: PHOTO_MAX, muted: false, hasAudio: false };
    return { project: { ...p, clips: [...p.clips, clip] }, select: { type: "clip", id: clip.id }, at: totalDuration(p) };
  }
  const range = opts.overlayRange === "whole" ? { start: 0, end: Math.max(totalDuration(p), 3) } : newOverlayRange(p, t);
  const o: Overlay = { id: uid(), kind: "image", src, name, width: 0.25, x: 0.5, y: 0.5, ...range };
  return { project: { ...p, overlays: [...p.overlays, o] }, select: { type: "overlay", id: o.id }, at: range.start };
}
