/**
 * Frame compositor. The live preview and the Mediabunny exporter both call these,
 * so what the user sees while editing is drawn by the same code that draws the export.
 */
import { FONTS, fontFor } from "../../shared/fonts.js";
import { layers } from "../../shared/model.js";
import type { Project, TextOverlay, VideoOverlay } from "./project";

/** CSS family name for a font from shared/fonts.js (the same .ttf FFmpeg reads on the server) */
export const family = (id: string) => `poc-${id}`;
const fontReady = new Map<string, Promise<unknown>>();
export function loadFont(id: string) {
  const def = FONTS.find((f) => f.id === id);
  if (!def) return Promise.resolve();
  if (!fontReady.has(id)) {
    fontReady.set(id, new FontFace(family(id), `url(/fonts/${def.file})`).load().then((f) => document.fonts.add(f)));
  }
  return fontReady.get(id)!;
}

const images = new Map<string, HTMLImageElement>();
/** an image already loaded with loadImage, or undefined */
export const getImage = (src: string) => images.get(src);
export function loadImage(src: string): Promise<HTMLImageElement> {
  const hit = images.get(src);
  if (hit?.complete) return Promise.resolve(hit);
  return new Promise((ok, fail) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => (images.set(src, img), ok(img));
    img.onerror = fail;
    img.src = src;
  });
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Crop-to-fit: scale the source until it covers the frame, centre it, cut the overflow. */
export function drawCover(ctx: Ctx, src: CanvasImageSource, sw: number, sh: number, W: number, H: number) {
  if (!sw || !sh) return;
  const scale = Math.max(W / sw, H / sh);
  const dw = sw * scale;
  const dh = sh * scale;
  ctx.drawImage(src, (W - dw) / 2, (H - dh) / 2, dw, dh);
}

/** Fit: scale the source until it fits inside the frame, centre it; the rest stays as it is (black). */
export function drawContain(ctx: Ctx, src: CanvasImageSource, sw: number, sh: number, W: number, H: number) {
  if (!sw || !sh) return;
  const scale = Math.min(W / sw, H / sh);
  const dw = sw * scale;
  const dh = sh * scale;
  ctx.drawImage(src, (W - dw) / 2, (H - dh) / 2, dw, dh);
}
type MainPlacement = { fit?: "fit" | "fill"; scale?: number; x?: number; y?: number; rotation?: number };
/** a main-track clip as it is fitted (or filled), with no size, position or turn of its own */
export const isPlain = (c: MainPlacement) => (c.scale ?? 1) === 1 && (c.x ?? 0.5) === 0.5 && (c.y ?? 0.5) === 0.5 && !c.rotation;
/** Where a main-track clip sits: its fitted (or filled) box, times its scale, centred on (x, y). */
export function mainRect(c: MainPlacement, sw: number, sh: number, W: number, H: number) {
  const base = c.fit === "fill" ? Math.max(W / sw, H / sh) : Math.min(W / sw, H / sh);
  const s = c.scale ?? 1;
  return { cx: (c.x ?? 0.5) * W, cy: (c.y ?? 0.5) * H, w: sw * base * s, h: sh * base * s };
}
/** a picture w x h centred on (cx, cy), turned by `deg` degrees clockwise */
export function drawTurned(ctx: Ctx, src: CanvasImageSource, cx: number, cy: number, w: number, h: number, deg = 0) {
  ctx.save();
  ctx.translate(cx, cy);
  if (deg) ctx.rotate((deg * Math.PI) / 180);
  ctx.drawImage(src, -w / 2, -h / 2, w, h);
  ctx.restore();
}
/** A main-track picture: fit (default) or fill, then its own size, position and turn. */
export function drawMain(ctx: Ctx, c: MainPlacement, src: CanvasImageSource, sw: number, sh: number, W: number, H: number) {
  if (!sw || !sh) return;
  if (isPlain(c)) return void (c.fit === "fill" ? drawCover : drawContain)(ctx, src, sw, sh, W, H);
  const r = mainRect(c, sw, sh, W, H);
  drawTurned(ctx, src, r.cx, r.cy, r.w, r.h, c.rotation);
}

/** One title, centred on (cx, cy). Preview, browser export and the PNG handed to FFmpeg all use this. */
/** padding of the box behind a text, in pixels, for a font of this size (FFmpeg's boxborderw uses the same number) */
export const boxPad = (size: number) => Math.round(size * 0.3);
const rgba = (hex: string, a: number) => {
  const n = parseInt(hex.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};
/** the box a title takes up (with its background box), in pixels, before any turn */
export function measureTitle(o: TextOverlay, W: number, H: number) {
  const size = Math.round(o.fontSize * (Math.min(W, H) / 720));
  const ctx = new OffscreenCanvas(8, 8).getContext("2d")!;
  ctx.font = `${size}px ${family(fontFor(o.text, o.font).id)}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const m = ctx.measureText(o.text || " ");
  const pad = o.bg ? boxPad(size) : 2;
  return { w: m.actualBoundingBoxLeft + m.actualBoundingBoxRight + 2 * pad, h: Math.max(m.actualBoundingBoxAscent + m.actualBoundingBoxDescent, size * 0.7) + 2 * pad };
}
function drawTitle(ctx: Ctx, o: TextOverlay, x: number, y: number, W: number, H: number) {
  const size = Math.round(o.fontSize * (Math.min(W, H) / 720));
  ctx.save();
  ctx.translate(x, y);
  if (o.rotation) ctx.rotate((o.rotation * Math.PI) / 180);
  const cx = 0, cy = 0;
  ctx.font = `${size}px ${family(fontFor(o.text, o.font).id)}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if (o.bg) {
    const m = ctx.measureText(o.text);
    const pad = boxPad(size);
    ctx.fillStyle = rgba(o.bg, o.bgOpacity ?? 0.6);
    ctx.fillRect(cx - m.actualBoundingBoxLeft - pad, cy - m.actualBoundingBoxAscent - pad, m.actualBoundingBoxLeft + m.actualBoundingBoxRight + 2 * pad, m.actualBoundingBoxAscent + m.actualBoundingBoxDescent + 2 * pad);
  }
  ctx.fillStyle = o.color;
  ctx.fillText(o.text, cx, cy);
  ctx.restore();
}

/**
 * Draw one title to a transparent PNG at export size. Used for scripts FFmpeg cannot shape (see needsRaster):
 * the server then overlays this picture, centred on the same point, instead of drawing the text itself.
 */
export async function rasteriseTitle(o: TextOverlay, W: number, H: number): Promise<{ blob: Blob; width: number }> {
  await loadFont(fontFor(o.text, o.font).id);
  const probe = new OffscreenCanvas(8, 8).getContext("2d")!;
  probe.font = `${Math.round(o.fontSize * (Math.min(W, H) / 720))}px ${family(fontFor(o.text, o.font).id)}`;
  probe.textAlign = "center";
  probe.textBaseline = "middle";
  const m = probe.measureText(o.text);
  const pad = 8 + (o.bg ? boxPad(Math.round(o.fontSize * (Math.min(W, H) / 720))) : 0);
  // even sizes, symmetric about the centre point, so the overlay lands exactly where the preview draws it
  const width = 2 * Math.ceil(Math.max(m.actualBoundingBoxLeft, m.actualBoundingBoxRight) + pad);
  const height = 2 * Math.ceil(Math.max(m.actualBoundingBoxAscent, m.actualBoundingBoxDescent) + pad);
  const canvas = new OffscreenCanvas(width, height);
  drawTitle(canvas.getContext("2d")!, { ...o, rotation: 0 }, width / 2, height / 2, W, H);
  return { blob: await canvas.convertToBlob({ type: "image/png" }), width };
}

/** A picture of known size, centred on (x, y) as fractions of the frame, `width` as a fraction of the frame width. */
function drawPlaced(ctx: Ctx, src: CanvasImageSource, sw: number, sh: number, o: { x: number; y: number; width: number; rotation?: number }, W: number, H: number) {
  if (!sw || !sh) return;
  const w = o.width * W;
  drawTurned(ctx, src, o.x * W, o.y * H, w, (w * sh) / sw, o.rotation);
}

export type VideoFrameFor = (o: VideoOverlay) => { src: CanvasImageSource; w: number; h: number } | null;

/** Everything on the visual tracks at time t, lowest track first. `frameOf` supplies the current frame of each video. */
export function drawOverlays(ctx: Ctx, p: Project, t: number, W: number, H: number, frameOf?: VideoFrameFor) {
  for (const o of layers(p)) {
    if (o.kind === "video") {
      if (t < o.start || t >= o.end) continue;
      const fr = frameOf?.(o);
      if (fr) drawPlaced(ctx, fr.src, fr.w, fr.h, o, W, H);
      continue;
    }
    if (t < o.start || t > o.end) continue;
    if (o.kind === "text") {
      drawTitle(ctx, o, o.x * W, o.y * H, W, H);
    } else {
      const img = images.get(o.src);
      if (img) drawPlaced(ctx, img, img.naturalWidth, img.naturalHeight, o, W, H);
    }
  }
}

export async function preloadOverlayAssets(p: Project) {
  await Promise.all(p.overlays.flatMap((o) => (o.kind === "text" ? [loadFont(fontFor(o.text, o.font).id)] : [])));
  await Promise.all(p.overlays.flatMap((o) => (o.kind === "image" ? [loadImage(o.src)] : [])));
  await Promise.all(p.clips.flatMap((c) => (c.kind === "image" ? [loadImage(c.src)] : [])));
}
