/**
 * Three export engines for the same edit JSON:
 *   1. Mediabunny  - WebCodecs in the browser (hardware encoder)
 *   2. ffmpeg.wasm - FFmpeg compiled to WebAssembly, in the browser
 *   3. Server      - native FFmpeg behind an HTTP endpoint (a queue worker in production)
 */
import {
  ALL_FORMATS, AudioBufferSink, AudioBufferSource, BlobSource, BufferTarget, CanvasSink, CanvasSource,
  Input, Mp4OutputFormat, Output, QUALITY_HIGH, type WrappedCanvas,
} from "mediabunny";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import coreURL from "@ffmpeg/core?url";
import wasmURL from "@ffmpeg/core/wasm?url";
import { buildFfmpegArgs } from "../../shared/ffmpeg-graph.js";
import { fontFor, needsRaster } from "../../shared/fonts.js";
import { drawMain, drawOverlays, drawTurned, getImage, isPlain, mainRect, preloadOverlayAssets, rasteriseTitle } from "./compose";
import { applyTrackStates } from "../../shared/model.js";
import { clipLen, clipStarts, frameSize, overlayOut, totalDuration, type Project, type VideoOverlay } from "./project";

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

/**
 * Titles FFmpeg cannot shape (Hindi and other joining scripts) become pictures: each is drawn to a PNG here
 * in the browser and swapped for an image overlay at the same place and time. `store` says where the PNG goes.
 */
async function withRasterTitles(p: Project, height: 720 | 1080, store: (png: Blob) => Promise<string>): Promise<Project> {
  const [W, H] = frameSize(p, height);
  const overlays = await Promise.all(p.overlays.map(async (o) => {
    if (o.kind !== "text" || (!needsRaster(o.text) && !o.rotation)) return o;
    const { blob, width } = await rasteriseTitle(o, W, H);
    return { id: o.id, track: o.track, kind: "image" as const, src: await store(blob), width: width / W, x: o.x, y: o.y, start: o.start, end: o.end, rotation: o.rotation };
  }));
  return { ...p, overlays };
}
const fetchBlob = (src: string) => fetch(src).then((r) => r.blob());

// ---------------------------------------------------------------- 1. Mediabunny
/** one decoder per video on the timeline, read forward one frame per output frame */
interface FrameStream {
  iter: AsyncIterator<WrappedCanvas | null>;
  cur: WrappedCanvas | null;
  /** where a main-track clip with its own size, position or turn is drawn */
  rect?: { cx: number; cy: number; w: number; h: number };
}

export async function exportMediabunny(edit: Project, height: 720 | 1080, onProgress: Progress): Promise<ExportResult> {
  const t0 = performance.now();
  const p = applyTrackStates(edit);
  const [W, H] = frameSize(p, height);
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
  const blobs = new Map<string, Promise<Blob>>();
  const blobOf = (src: string) => {
    if (!blobs.has(src)) blobs.set(src, fetchBlob(src));
    return blobs.get(src)!;
  };
  const mix = new OfflineAudioContext(2, Math.max(1, Math.ceil(total * 48000)), 48000);
  const schedule = async (src: string, from: number, to: number, at: number, gain: number) => {
    if (gain === 0) return;
    const input = new Input({ source: new BlobSource(await blobOf(src)), formats: ALL_FORMATS });
    const track = await input.getPrimaryAudioTrack();
    if (!track) return;
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
  for (const [i, c] of p.clips.entries()) {
    if (c.kind !== "image") await schedule(c.src, c.in, c.out, starts[i] ?? 0, c.muted ? 0 : p.originalVolume);
  }
  for (const o of p.overlays) {
    if (o.kind === "video" && !o.muted && o.hasAudio) await schedule(o.src, o.in, overlayOut(o), o.start, p.originalVolume);
  }
  for (const a of p.audios) await schedule(a.src, a.in, a.out, a.start, a.volume);

  // video: every output frame is drawn from scratch: main track, then each visual track from the lowest up
  const streams = new Map<string, FrameStream>();
  type Size = { width: number; height?: number; fit?: "cover" | "contain" | "fill" };
  const open = async (id: string, name: string, src: string, from: number, frames: number, sizeFor: (sw: number, sh: number) => Size & { rect?: FrameStream["rect"] }) => {
    const input = new Input({ source: new BlobSource(await blobOf(src)), formats: ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error(`${name}: no video track`);
    if (!(await track.canDecode())) throw new Error(`${name}: this browser cannot decode ${track.codec}`);
    const { rect, ...size } = sizeFor(track.displayWidth, track.displayHeight);
    // poolSize: reuse a few canvases instead of allocating one per frame (matters on long exports)
    const sink = new CanvasSink(track, { ...size, poolSize: 3 });
    const stamps = Array.from({ length: frames }, (_, k) => from + k / FPS);
    streams.set(id, { iter: sink.canvasesAtTimestamps(stamps)[Symbol.asyncIterator](), cur: null, rect });
  };
  const next = async (id: string) => {
    const s = streams.get(id);
    if (!s) return null;
    const r = await s.iter.next();
    if (!r.done && r.value) s.cur = r.value;
    return s.cur;
  };
  const close = async (id: string) => {
    await streams.get(id)?.iter.return?.();
    streams.delete(id);
  };
  const F = (sec: number) => Math.round(sec * FPS);
  const main = p.clips.map((c, i) => ({ c, from: F(starts[i] ?? 0), to: F((starts[i] ?? 0) + clipLen(c)) }));
  const pips = p.overlays.filter((o): o is VideoOverlay => o.kind === "video" && !o.hidden).map((o) => ({ o, from: F(o.start), to: F(o.end) }));

  const totalFrames = F(total);
  for (let f = 0; f < totalFrames; f++) {
    const t = f / FPS;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    const m = main.find((x) => f >= x.from && f < x.to);
    if (m && !m.c.hidden) {
      if (m.c.kind === "image") {
        const img = getImage(m.c.src);
        if (img) drawMain(ctx, m.c, img, img.naturalWidth, img.naturalHeight, W, H);
      } else {
        const c = m.c;
        if (!streams.has(c.id)) await open(c.id, c.name, c.src, c.in + (f - m.from) / FPS, m.to - f, (sw, sh) => {
          if (isPlain(c)) return { width: W, height: H, fit: c.fit === "fill" ? "cover" : "contain" };
          // its own size, position or turn: decode at the size it is drawn, then place and turn it
          const rect = mainRect(c, sw, sh, W, H);
          return { width: Math.max(2, Math.round(rect.w)), height: Math.max(2, Math.round(rect.h)), fit: "fill", rect };
        });
        const fr = await next(c.id);
        const rect = streams.get(c.id)?.rect;
        if (fr && rect) drawTurned(ctx, fr.canvas, rect.cx, rect.cy, rect.w, rect.h, c.rotation);
        else if (fr) ctx.drawImage(fr.canvas, 0, 0);
        if (f === m.to - 1) await close(m.c.id);
      }
    }
    const frames = new Map<string, WrappedCanvas>();
    for (const x of pips) {
      if (f < x.from || f >= x.to) continue;
      if (!streams.has(x.o.id)) await open(x.o.id, x.o.name, x.o.src, x.o.in + (f - x.from) / FPS, x.to - f, () => ({ width: Math.max(2, Math.round((x.o.width * W) / 2) * 2) }));
      const fr = await next(x.o.id);
      if (fr) frames.set(x.o.id, fr);
      if (f === x.to - 1) await close(x.o.id);
    }
    drawOverlays(ctx, p, t, W, H, (o) => {
      const fr = frames.get(o.id);
      return fr ? { src: fr.canvas, w: fr.canvas.width, h: fr.canvas.height } : null;
    });
    await video.add(t, 1 / FPS);
    onProgress((f + 1) / totalFrames);
  }
  for (const id of [...streams.keys()]) await close(id);
  await audio.add(await mix.startRendering());
  await output.finalize();

  const blob = new Blob([output.target.buffer!], { type: "video/mp4" });
  return { engine: "Mediabunny (WebCodecs)", url: URL.createObjectURL(blob), ms: performance.now() - t0, bytes: blob.size, width: W, height: H, duration: total };
}

// ---------------------------------------------------------------- 2. ffmpeg.wasm
let wasm: FFmpeg | null = null;
export async function exportFfmpegWasm(original: Project, height: 720 | 1080, onProgress: Progress): Promise<ExportResult> {
  const t0 = performance.now();
  const p = await withRasterTitles(original, height, async (png) => {
    const url = URL.createObjectURL(png);
    blobNames.set(url, "title.png");
    return url;
  });
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
  const { args, width, height: h, duration } = buildFfmpegArgs(p, { height, resolve, font: (file) => file, output: "out.mp4", preset: "ultrafast", seek: (globalThis as { __wasmSeek?: "input" | "filter" }).__wasmSeek });
  const put = async (name: string, src: string) => ff.writeFile(name, new Uint8Array(await (await fetch(src)).arrayBuffer()));
  const fontFiles = new Set(p.overlays.flatMap((o) => (o.kind === "text" ? [fontFor(o.text, o.font).file] : [])));
  for (const file of fontFiles) await put(file, `/fonts/${file}`);
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
export async function exportServer(p: Project, height: 720 | 1080, onProgress: Progress): Promise<ExportResult> {
  const t0 = performance.now();
  // files the user imported from disk only exist in this tab; push them to the server first
  const uploaded = new Map<string, string>();
  const remote = async (src: string) => {
    if (!src.startsWith("blob:")) return src;
    if (!uploaded.has(src)) {
      const r = await fetch(`/api/upload/${encodeURIComponent(blobNames.get(src) ?? "upload.bin")}`, { method: "PUT", body: await fetchBlob(src) });
      uploaded.set(src, ((await r.json()) as { src: string }).src);
    }
    return uploaded.get(src)!;
  };
  const upload = async (body: Blob, name: string) =>
    ((await (await fetch(`/api/upload/${encodeURIComponent(name)}`, { method: "PUT", body })).json()) as { src: string }).src;
  p = await withRasterTitles(p, height, (png) => upload(png, "title.png"));
  const project: Project = {
    ...p,
    clips: await Promise.all(p.clips.map(async (c) => ({ ...c, src: await remote(c.src) }))),
    overlays: await Promise.all(p.overlays.map(async (o) => (o.kind === "text" ? o : { ...o, src: await remote(o.src) }))),
    audios: await Promise.all(p.audios.map(async (a) => ({ ...a, src: await remote(a.src) }))),
  };
  onProgress(0.2);
  const r = await fetch("/api/render", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project, height }) });
  const body = (await r.json()) as { error?: string; url: string; ms: number; bytes: number; width: number; height: number; duration: number };
  if (!r.ok || body.error) throw new Error(body.error ?? `render server returned ${r.status}`);
  onProgress(1);
  return { engine: `Server FFmpeg (encode ${body.ms} ms)`, url: body.url, ms: performance.now() - t0, bytes: body.bytes, width: body.width, height: body.height, duration: body.duration };
}

/** blob URL -> original file name, so server uploads keep their extension */
export const blobNames = new Map<string, string>();
