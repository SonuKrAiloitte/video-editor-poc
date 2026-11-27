/**
 * Three export engines for the same edit JSON:
 *   1. Mediabunny  - WebCodecs in the browser (hardware encoder)
 *   2. ffmpeg.wasm - FFmpeg compiled to WebAssembly, in the browser
 *   3. Server      - native FFmpeg behind an HTTP endpoint (a queue worker in production)
 */
import {
  ALL_FORMATS, AudioBufferSink, AudioBufferSource, BlobSource, BufferTarget, CanvasSink, CanvasSource,
  Input, Mp4OutputFormat, Output, QUALITY_HIGH,
} from "mediabunny";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import coreURL from "@ffmpeg/core?url";
import wasmURL from "@ffmpeg/core/wasm?url";
import { buildFfmpegArgs } from "../../shared/ffmpeg-graph.js";
import { FONTS, type FontId } from "../../shared/fonts";
import { drawCover, drawOverlays, loadImage, preloadOverlayAssets, rasterizeText } from "./compose";
import { clipLen, clipStarts, frameSize, isPhoto, totalDuration, type Overlay, type Project } from "./project";

export interface ExportResult {
  engine: string;
  url: string;
  ms: number;
  bytes: number;
  width: number;
  height: number;
  duration: number;
}
type Progress = (fraction: number) => void;

const FPS = 30;
const fetchBlob = (src: string) => fetch(src).then((r) => r.blob());

// ---------------------------------------------------------------- 1. Mediabunny
export async function exportMediabunny(p: Project, height: 720 | 1080, onProgress: Progress): Promise<ExportResult> {
  const t0 = performance.now();
  const [W, H] = frameSize(p.aspect, height);
  const total = totalDuration(p);
  await preloadOverlayAssets(p);

  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext("2d")!;
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: new BufferTarget() });
  const video = new CanvasSource(canvas, { codec: "avc", bitrate: QUALITY_HIGH });
  const audio = new AudioBufferSource({ codec: "aac", bitrate: QUALITY_HIGH });
  output.addVideoTrack(video, { frameRate: FPS });
  output.addAudioTrack(audio);
  await output.start();

  // audio is mixed offline with Web Audio, then handed over as one buffer
  const mix = new OfflineAudioContext(2, Math.ceil(total * 48000), 48000);
  const schedule = async (blob: Blob, from: number, to: number, at: number, gain: number) => {
    const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
    const track = await input.getPrimaryAudioTrack();
    if (!track || gain === 0) return;
    const g = mix.createGain();
    g.gain.value = gain;
    g.connect(mix.destination);
    for await (const { buffer, timestamp } of new AudioBufferSink(track).buffers(from, to)) {
      const s = Math.max(timestamp, from);
      const e = Math.min(timestamp + buffer.duration, to);
      if (e <= s) continue;
      const node = mix.createBufferSource();
      node.buffer = buffer;
      node.connect(g);
      node.start(at + (s - from), s - timestamp, e - s);
    }
  };

  const starts = clipStarts(p);
  let frame = 0;
  const totalFrames = Math.round(total * FPS);
  for (const [i, clip] of p.clips.entries()) {
    const start = starts[i] ?? 0;
    const n = Math.round(clipLen(clip) * FPS);
    if (isPhoto(clip)) {
      // a photo: the same still, cropped to fill, for every frame of the clip
      const img = await loadImage(clip.src);
      for (let k = 0; k < n; k++) {
        const t = frame / FPS;
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, W, H);
        drawCover(ctx, img, img.naturalWidth, img.naturalHeight, W, H);
        drawOverlays(ctx, p, t, W, H);
        await video.add(t, 1 / FPS);
        onProgress(++frame / totalFrames);
      }
      continue;
    }
    const blob = await fetchBlob(clip.src);
    await schedule(blob, clip.in, clip.out, start, clip.muted ? 0 : p.originalVolume);

    const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error(`${clip.name}: no video track`);
    if (!(await track.canDecode())) throw new Error(`${clip.name}: this browser cannot decode ${track.codec}`);
    const sink = new CanvasSink(track, { width: W, height: H, fit: "cover" });
    const stamps = Array.from({ length: n }, (_, k) => clip.in + k / FPS);
    for await (const wrapped of sink.canvasesAtTimestamps(stamps)) {
      const t = frame / FPS;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, W, H);
      if (wrapped) ctx.drawImage(wrapped.canvas, 0, 0);
      drawOverlays(ctx, p, t, W, H);
      await video.add(t, 1 / FPS);
      onProgress(++frame / totalFrames);
    }
  }
  for (const m of p.audio) if (m.start < total) await schedule(await fetchBlob(m.src), m.in, m.out, m.start, m.volume);
  await audio.add(await mix.startRendering());
  await output.finalize();

  const blob = new Blob([output.target.buffer!], { type: "video/mp4" });
  return { engine: "Mediabunny (WebCodecs)", url: URL.createObjectURL(blob), ms: performance.now() - t0, bytes: blob.size, width: W, height: H, duration: total };
}

// ---------------------------------------------------------------- titles for FFmpeg
/**
 * FFmpeg does not draw titles itself: each one is drawn by the same canvas code as the preview, as a transparent
 * picture at export size, and placed as an image overlay to the pixel (width = picture width / frame width).
 * `revoke` frees the pictures once the export is done.
 */
async function withRasterTitles(p: Project, height: 720 | 1080): Promise<{ project: Project; titles: Set<string>; revoke: () => void }> {
  const [W, H] = frameSize(p.aspect, height);
  const titles = new Set<string>();
  const overlays: Overlay[] = [];
  for (const o of p.overlays) {
    if (o.kind !== "text") {
      overlays.push(o);
      continue;
    }
    const r = await rasterizeText(o, W, H);
    if (!r) continue; // an empty title paints nothing
    const url = URL.createObjectURL(r.blob);
    blobNames.set(url, `title_${o.id}.png`);
    titles.add(url);
    overlays.push({ id: o.id, kind: "image", name: "title", src: url, width: r.w / W, x: (r.left + r.w / 2) / W, y: (r.top + r.h / 2) / H, pixel: { left: r.left, top: r.top }, start: o.start, end: o.end });
  }
  return { project: { ...p, overlays }, titles, revoke: () => titles.forEach((u) => URL.revokeObjectURL(u)) };
}

// ---------------------------------------------------------------- 2. ffmpeg.wasm
let wasm: FFmpeg | null = null;
export async function exportFfmpegWasm(edit: Project, height: 720 | 1080, onProgress: Progress): Promise<ExportResult> {
  const t0 = performance.now();
  const { project: p, revoke } = await withRasterTitles(edit, height);
  try {
    return await runWasm(p, height, onProgress, t0);
  } finally {
    revoke();
  }
}
async function runWasm(p: Project, height: 720 | 1080, onProgress: Progress, t0: number): Promise<ExportResult> {
  if (!wasm) {
    wasm = new FFmpeg();
    await wasm.load({ coreURL, wasmURL });
  }
  const ff = wasm;
  const names = new Map<string, string>();
  const resolve = (src: string) => {
    // imported files are blob: URLs with no extension, so take it from the original file name
    const ext = ((blobNames.get(src) ?? src.split("?")[0] ?? "").split(".").pop() ?? "bin").replace(/[^a-z0-9]/gi, "") || "bin";
    if (!names.has(src)) names.set(src, `in${names.size}.${ext}`);
    return names.get(src)!;
  };
  const fonts = new Set<FontId>();
  const fontPath = (id: FontId) => (fonts.add(id), `font_${id}.ttf`);
  const { args, width, height: h, duration } = buildFfmpegArgs(p, { height, resolve, fontPath, output: "out.mp4", preset: "ultrafast" });
  const put = async (name: string, src: string) => ff.writeFile(name, new Uint8Array(await (await fetch(src)).arrayBuffer()));
  for (const id of fonts) await put(`font_${id}.ttf`, `/fonts/${FONTS[id].file}`);
  for (const [src, name] of names) await put(name, src);

  const onProg = ({ progress }: { progress: number }) => onProgress(Math.min(1, Math.max(0, progress)));
  ff.on("progress", onProg);
  let log = "";
  const onLog = ({ message }: { message: string }) => (log = (log + "\n" + message).slice(-1500));
  ff.on("log", onLog);
  const code = await ff.exec(args);
  ff.off("progress", onProg);
  ff.off("log", onLog);
  if (code !== 0) throw new Error("ffmpeg.wasm failed:\n" + log);
  const data = (await ff.readFile("out.mp4")) as Uint8Array;
  const blob = new Blob([data.slice().buffer], { type: "video/mp4" });
  return { engine: "ffmpeg.wasm (browser)", url: URL.createObjectURL(blob), ms: performance.now() - t0, bytes: blob.size, width, height: h, duration };
}

// ---------------------------------------------------------------- 3. Server FFmpeg
export async function exportServer(edit: Project, height: 720 | 1080, onProgress: Progress): Promise<ExportResult> {
  const t0 = performance.now();
  const { project: p, titles, revoke } = await withRasterTitles(edit, height);
  // files that only exist in this tab (imports that failed to upload, title pictures) are pushed to the server first;
  // title pictures go to a render-only folder, never to My media
  const uploaded = new Map<string, string>();
  const remote = async (src: string) => {
    if (!src.startsWith("blob:")) return src;
    if (!uploaded.has(src)) {
      const where = titles.has(src) ? "render-asset" : "upload";
      const r = await fetch(`/api/${where}/${encodeURIComponent(blobNames.get(src) ?? "upload.bin")}`, { method: "PUT", body: await fetchBlob(src) });
      const body = (await r.json().catch(() => ({}))) as { src?: string; error?: string };
      if (!r.ok || !body.src) throw new Error(body.error ?? `upload failed (${r.status})`);
      uploaded.set(src, body.src);
    }
    return uploaded.get(src)!;
  };
  const project: Project = {
    ...p,
    clips: await Promise.all(p.clips.map(async (c) => ({ ...c, src: await remote(c.src) }))),
    overlays: await Promise.all(p.overlays.map(async (o) => (o.kind === "image" ? { ...o, src: await remote(o.src) } : o))),
    audio: await Promise.all(p.audio.map(async (m) => ({ ...m, src: await remote(m.src) }))),
  };
  revoke();
  onProgress(0.2);
  const r = await fetch("/api/render", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project, height }) });
  const body = (await r.json()) as { error?: string; url: string; ms: number; bytes: number; width: number; height: number; duration: number };
  if (!r.ok || body.error) throw new Error(body.error ?? `render server returned ${r.status}`);
  onProgress(1);
  return { engine: `Server FFmpeg (encode ${body.ms} ms)`, url: body.url, ms: performance.now() - t0, bytes: body.bytes, width: body.width, height: body.height, duration: body.duration };
}

/** blob URL -> original file name, so server uploads keep their extension */
export const blobNames = new Map<string, string>();

// ---------------------------------------------------------------- library
export interface LibraryItem {
  src: string;
  name: string;
  kind: "video" | "audio" | "image";
  group: "export" | "upload" | "sample";
}

export async function listLibrary(): Promise<LibraryItem[]> {
  const r = await fetch("/api/library");
  if (!r.ok) throw new Error(`library returned ${r.status}`);
  return (await r.json()) as LibraryItem[];
}

/** Upload a file the user picked, so it has a lasting URL (a blob: URL dies with the tab). */
export async function uploadFile(file: File): Promise<string> {
  const r = await fetch(`/api/upload/${encodeURIComponent(file.name)}`, { method: "PUT", body: file });
  const body = (await r.json().catch(() => ({}))) as { src?: string; error?: string };
  if (!r.ok || !body.src) throw new Error(body.error ?? `upload failed (${r.status})`);
  return body.src;
}

/** Save a finished export into the library: a server render is copied there, a browser render is uploaded. */
export async function saveToLibrary(r: ExportResult, name: string): Promise<LibraryItem> {
  const res = r.url.startsWith("/out/")
    ? await fetch("/api/library", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ src: r.url, name }) })
    : await fetch(`/api/library/${encodeURIComponent(name)}`, { method: "PUT", body: await fetchBlob(r.url) });
  const body = (await res.json().catch(() => ({}))) as LibraryItem & { error?: string };
  if (!res.ok || body.error) throw new Error(body.error ?? `save failed (${res.status})`);
  return body;
}
