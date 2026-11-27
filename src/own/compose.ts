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
/** A main-track picture in its clip's mode: fit (default) or fill. */
export function drawMain(ctx: Ctx, fit: "fit" | "fill" | undefined, src: CanvasImageSource, sw: number, sh: number, W: number, H: number) {
  (fit === "fill" ? drawCover : drawContain)(ctx, src, sw, sh, W, H);
}

/** One title, centred on (cx, cy). Preview, browser export and the PNG handed to FFmpeg all use this. */
function drawTitle(ctx: Ctx, o: TextOverlay, cx: number, cy: number, W: number, H: number) {
  ctx.font = `${Math.round(o.fontSize * (Math.min(W, H) / 720))}px ${family(fontFor(o.text, o.font).id)}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = o.color;
  ctx.fillText(o.text, cx, cy);
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
  const pad = 8;
  // even sizes, symmetric about the centre point, so the overlay lands exactly where the preview draws it
  const width = 2 * Math.ceil(Math.max(m.actualBoundingBoxLeft, m.actualBoundingBoxRight) + pad);
  const height = 2 * Math.ceil(Math.max(m.actualBoundingBoxAscent, m.actualBoundingBoxDescent) + pad);
  const canvas = new OffscreenCanvas(width, height);
  drawTitle(canvas.getContext("2d")!, o, width / 2, height / 2, W, H);
  return { blob: await canvas.convertToBlob({ type: "image/png" }), width };
}

/** A picture of known size, centred on (x, y) as fractions of the frame, `width` as a fraction of the frame width. */
function drawPlaced(ctx: Ctx, src: CanvasImageSource, sw: number, sh: number, o: { x: number; y: number; width: number }, W: number, H: number) {
  if (!sw || !sh) return;
  const w = o.width * W;
  const h = (w * sh) / sw;
  ctx.drawImage(src, o.x * W - w / 2, o.y * H - h / 2, w, h);
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
