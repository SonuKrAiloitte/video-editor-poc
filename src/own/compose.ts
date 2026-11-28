/**
 * Frame compositor. The live preview and the Mediabunny exporter both call these,
 * so what the user sees while editing is drawn by the same code that draws the export.
 */
import { FONTS, fontFor } from "../../shared/fonts.js";
import { fx, transitionDef } from "../../shared/fx.js";
import { layers } from "../../shared/model.js";
import type { EffectOverlay, Project, TextOverlay, VideoOverlay } from "./project";

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

/** the current frame of a video item, or of an effect's own video (the light leak) */
export type VideoFrameFor = (o: VideoOverlay | EffectOverlay) => { src: CanvasImageSource; w: number; h: number } | null;

// ------------------------------------------------------------------ transitions and effects
// These copy FFmpeg's own maths (vf_xfade.c, vf_vignette.c, vf_eq.c in FFmpeg 6.1) so the preview shows what the
// server export will contain. Numbers that both sides use live in shared/fx.js.
const scratch = new Map<string, OffscreenCanvas>();
/** a reusable offscreen canvas of this size */
function pad(key: string, W: number, H: number) {
  let c = scratch.get(key);
  if (!c) scratch.set(key, (c = new OffscreenCanvas(W, H)));
  if (c.width !== W || c.height !== H) (c.width = W), (c.height = H);
  return c;
}
const ctx2d = (c: OffscreenCanvas) => c.getContext("2d", { willReadFrequently: false })!;
const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const even2 = (x: number) => Math.max(2, Math.round(x / 2) * 2);
/** a radial gradient centred on the frame whose opacity at distance r (0..radius) is alphaAt(r / radius) */
function radial(ctx: Ctx, W: number, H: number, radius: number, rgb: string, alphaAt: (r: number) => number) {
  const g = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, radius);
  for (let k = 0; k <= 24; k++) g.addColorStop(k / 24, `rgba(${rgb}, ${Math.min(1, Math.max(0, alphaAt(k / 24)))})`);
  return g;
}
/** the pixels of a picture drawn at W x H */
function pixels(src: CanvasImageSource, W: number, H: number) {
  const c = pad("read", W, H);
  const x = c.getContext("2d", { willReadFrequently: true })!;
  x.globalCompositeOperation = "copy";
  x.globalAlpha = 1;
  x.drawImage(src, 0, 0, W, H);
  return x.getImageData(0, 0, W, H);
}
/** a new picture whose pixel (x, y) is the source's (cols[x], rows[y]) */
function remap(img: ImageData, cols: Int32Array, rows: Int32Array) {
  const W = img.width;
  const out = new ImageData(W, img.height);
  const s = new Uint32Array(img.data.buffer);
  const d = new Uint32Array(out.data.buffer);
  for (let y = 0; y < img.height; y++) {
    const from = rows[y]! * W;
    const to = y * W;
    for (let x = 0; x < W; x++) d[to + x] = s[from + cols[x]!]!;
  }
  return out;
}
/** a mask video frame turned into opacity: white = fully shown */
function maskToAlpha(mask: CanvasImageSource, W: number, H: number) {
  const sw = 320;
  const sh = Math.max(2, Math.round((320 * H) / W));
  const c = pad("mask", sw, sh);
  const x = c.getContext("2d", { willReadFrequently: true })!;
  x.globalCompositeOperation = "copy";
  x.drawImage(mask, 0, 0, sw, sh);
  const img = x.getImageData(0, 0, sw, sh);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) (d[i + 3] = d[i]!), (d[i] = d[i + 1] = d[i + 2] = 0);
  x.putImageData(img, 0, 0);
  return c;
}

/**
 * Draw transition `id` between frame A (outgoing clip) and frame B (incoming clip), both W x H with their black
 * background. `p` is FFmpeg's progress: 1 at the start (all A), falling to 0 (all B). `mask` is the mask video's frame.
 */
export function drawTransition(ctx: Ctx, id: string, p: number, A: CanvasImageSource, B: CanvasImageSource, W: number, H: number, mask?: CanvasImageSource | null) {
  const def = transitionDef(id) ?? transitionDef("fade")!;
  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  if (def.kind === "mask") {
    ctx.drawImage(A, 0, 0, W, H);
    if (mask) {
      const b = pad("tb", W, H);
      const bx = ctx2d(b);
      bx.globalCompositeOperation = "copy";
      bx.drawImage(B, 0, 0, W, H);
      bx.globalCompositeOperation = "destination-in";
      bx.drawImage(maskToAlpha(mask, W, H), 0, 0, W, H);
      ctx.drawImage(b, 0, 0);
    }
    return void ctx.restore();
  }
  switch (def.xfade) {
    case "fade":
      ctx.drawImage(A, 0, 0, W, H);
      ctx.globalAlpha = 1 - p;
      ctx.drawImage(B, 0, 0, W, H);
      break;
    case "fadeblack":
    case "fadewhite": {
      // mix(mix(A, bg, s1), mix(bg, B, s2), p): A * p*s1 + B * (1-p)*(1-s2) + bg * the rest
      const s1 = smoothstep(0.8, 1, p);
      const s2 = smoothstep(0.2, 1, p);
      const wA = p * s1;
      const wB = (1 - p) * (1 - s2);
      ctx.globalAlpha = wA;
      ctx.drawImage(A, 0, 0, W, H);
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = wB;
      ctx.drawImage(B, 0, 0, W, H);
      if (def.xfade === "fadewhite") {
        ctx.globalAlpha = Math.max(0, 1 - wA - wB);
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, W, H);
      }
      break;
    }
    case "wipeleft": {
      const z = Math.trunc(W * p); // x > z shows B
      ctx.drawImage(A, 0, 0, W, H);
      if (W - z - 1 > 0) ctx.drawImage(B, z + 1, 0, W - z - 1, H, z + 1, 0, W - z - 1, H);
      break;
    }
    case "wiperight": {
      const z = Math.trunc(W * (1 - p)); // x > z shows A
      ctx.drawImage(A, 0, 0, W, H);
      ctx.drawImage(B, 0, 0, z + 1, H, 0, 0, z + 1, H);
      break;
    }
    case "slideleft": {
      const o = Math.floor(p * W);
      ctx.drawImage(A, o - W, 0, W, H);
      ctx.drawImage(B, o, 0, W, H);
      break;
    }
    case "slideright": {
      const z = Math.floor(p * W);
      ctx.drawImage(B, -z, 0, W, H);
      ctx.drawImage(A, W - z, 0, W, H);
      break;
    }
    case "slideup": {
      const o = Math.floor(p * H);
      ctx.drawImage(A, 0, o - H, W, H);
      ctx.drawImage(B, 0, o, W, H);
      break;
    }
    case "slidedown": {
      const z = Math.floor(p * H);
      ctx.drawImage(B, 0, -z, W, H);
      ctx.drawImage(A, 0, H - z, W, H);
      break;
    }
    case "circleopen": {
      // A's weight is smoothstep(0, 1, distance / Z + (p - 0.5) * 3): B shows inside a growing soft circle
      const Z = Math.hypot(Math.trunc(W / 2), Math.trunc(H / 2));
      const P = (p - 0.5) * 3;
      ctx.drawImage(A, 0, 0, W, H);
      const b = pad("tb", W, H);
      const bx = ctx2d(b);
      bx.globalCompositeOperation = "copy";
      bx.drawImage(B, 0, 0, W, H);
      bx.globalCompositeOperation = "destination-in";
      bx.fillStyle = radial(bx, W, H, Z, "0, 0, 0", (r) => 1 - smoothstep(0, 1, r + P));
      bx.fillRect(0, 0, W, H);
      ctx.drawImage(b, 0, 0);
      break;
    }
    case "zoomin": {
      // A enlarged about the centre (zf falls to 0 at p = 0.5: one pixel fills the frame), then B fades in.
      // Each output pixel takes the source pixel FFmpeg takes: ceil(u * (w - 1)) with u = 0.5 + (x / w - 0.5) * zf
      const zf = smoothstep(0.5, 1, p);
      const cols = new Int32Array(W);
      const rows = new Int32Array(H);
      for (let x = 0; x < W; x++) cols[x] = Math.ceil((0.5 + (x / W - 0.5) * zf) * (W - 1));
      for (let y = 0; y < H; y++) rows[y] = Math.ceil((0.5 + (y / H - 0.5) * zf) * (H - 1));
      ctx.putImageData(remap(pixels(A, W, H), cols, rows), 0, 0);
      ctx.globalAlpha = 1 - smoothstep(0, 0.5, p);
      ctx.drawImage(B, 0, 0, W, H);
      break;
    }
    case "pixelize": {
      // crossfade, then squares that grow to the middle of the transition and shrink again; each square shows the
      // pixel at its centre, worked out exactly as FFmpeg does
      // in 32-bit floats like FFmpeg: at some frames ceil(d * 50) differs by one between float and double
      const f32 = Math.fround;
      const pf = f32(p);
      const d = Math.min(pf, f32(1 - pf));
      const dist = f32(Math.ceil(f32(d * 50)) / 50);
      const sq = f32(f32(2 * dist * Math.min(W, H)) / 20);
      const m = pad("tm", W, H);
      const mx = ctx2d(m);
      mx.globalCompositeOperation = "copy";
      mx.globalAlpha = 1;
      mx.drawImage(A, 0, 0, W, H);
      mx.globalCompositeOperation = "source-over";
      mx.globalAlpha = 1 - p;
      mx.drawImage(B, 0, 0, W, H);
      if (dist > 0) {
        const cols = new Int32Array(W);
        const rows = new Int32Array(H);
        for (let x = 0; x < W; x++) cols[x] = Math.trunc(Math.min((Math.floor(x / sq) + 0.5) * sq, W - 1));
        for (let y = 0; y < H; y++) rows[y] = Math.trunc(Math.min((Math.floor(y / sq) + 0.5) * sq, H - 1));
        ctx.putImageData(remap(pixels(m, W, H), cols, rows), 0, 0);
      } else ctx.drawImage(m, 0, 0);
      break;
    }
    default:
      ctx.drawImage(B, 0, 0, W, H);
  }
  ctx.restore();
}

let grainTile: OffscreenCanvas | null = null;
/** Apply an effect strip to everything drawn so far on ctx (its canvas is W x H), at timeline time t. */
export function applyEffect(ctx: Ctx, o: EffectOverlay, t: number, W: number, H: number, asset?: { src: CanvasImageSource } | null) {
  const a = o.amount ?? 0.5;
  const s = Math.min(W, H) / 720;
  const tau = t - o.start;
  const copy = pad("fx", W, H);
  const cx = ctx2d(copy);
  cx.globalCompositeOperation = "copy";
  cx.globalAlpha = 1;
  cx.filter = "none";
  cx.drawImage(ctx.canvas, 0, 0, W, H);
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  switch (o.effect) {
    case "blur":
      ctx.filter = `blur(${fx.blurSigma(a, s)}px)`;
      ctx.drawImage(copy, 0, 0);
      break;
    case "pixelate": {
      const b = fx.pixelBlock(a, s);
      const cw = Math.ceil(W / b);
      const ch = Math.ceil(H / b);
      const sm = pad("pix", cw, ch);
      const sx = ctx2d(sm);
      sx.imageSmoothingEnabled = true;
      sx.imageSmoothingQuality = "high";
      sx.globalCompositeOperation = "copy";
      sx.drawImage(copy, 0, 0, cw * b, ch * b, 0, 0, cw, ch);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(sm, 0, 0, cw, ch, 0, 0, cw * b, ch * b);
      break;
    }
    case "bw":
      ctx.filter = "grayscale(1)";
      ctx.drawImage(copy, 0, 0);
      break;
    case "flash": {
      // FFmpeg's eq adds `brightness` to luma (0..1 of the 16..235 range); in RGB that is about 1.164 times more
      const b = fx.flash(a, tau);
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = Math.min(1, b * 1.164);
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, W, H);
      break;
    }
    case "shake": {
      const z = fx.shakeZoom(a);
      const cw = even2(W / z);
      const ch = even2(H / z);
      // FFmpeg's crop rounds the corner down to even pixels for 4:2:0 video
      const x = Math.floor((((W - cw) / 2) * (1 + fx.shakeX(tau))) / 2) * 2;
      const y = Math.floor((((H - ch) / 2) * (1 + fx.shakeY(tau))) / 2) * 2;
      ctx.globalCompositeOperation = "copy";
      ctx.drawImage(copy, x, y, cw, ch, 0, 0, W, H);
      break;
    }
    case "zoompulse": {
      const z = fx.pulse(a, tau);
      const sw = W / z;
      const sh = H / z;
      ctx.globalCompositeOperation = "copy";
      ctx.drawImage(copy, Math.floor(W / 2 - sw / 2), Math.floor(H / 2 - sh / 2), sw, sh, 0, 0, W, H);
      break;
    }
    case "glitch": {
      // red moved right, blue moved left, green in place (FFmpeg's rgbashift rh / bh)
      const g = fx.glitchShift(a, s);
      const chan = (key: string, color: string) => {
        const c = pad(key, W, H);
        const x = ctx2d(c);
        x.globalCompositeOperation = "copy";
        x.drawImage(copy, 0, 0);
        x.globalCompositeOperation = "multiply";
        x.fillStyle = color;
        x.fillRect(0, 0, W, H);
        return c;
      };
      const r = chan("gr", "#f00");
      const gg = chan("gg", "#0f0");
      const bb = chan("gb", "#00f");
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = "lighter";
      ctx.drawImage(r, g, 0);
      ctx.drawImage(r, 0, 0, 1, H, 0, 0, g, H); // FFmpeg repeats the edge column into the gap ("smear")
      ctx.drawImage(gg, 0, 0);
      ctx.drawImage(bb, -g, 0);
      ctx.drawImage(bb, W - 1, 0, 1, H, W - g, 0, g, H);
      break;
    }
    case "grain": {
      // random grain like FFmpeg's noise filter; the pattern differs, the amount is the same
      if (!grainTile) {
        grainTile = new OffscreenCanvas(256, 256);
        const x = grainTile.getContext("2d")!;
        const img = x.createImageData(256, 256);
        for (let i = 0; i < img.data.length; i += 4) {
          const v = 128 + (Math.random() - 0.5) * 255;
          img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
          img.data[i + 3] = 255;
        }
        x.putImageData(img, 0, 0);
      }
      ctx.globalCompositeOperation = "overlay";
      ctx.globalAlpha = fx.grain(a) / 100;
      const pat = ctx.createPattern(grainTile, "repeat")!;
      const ox = Math.floor(Math.random() * 256);
      const oy = Math.floor(Math.random() * 256);
      ctx.translate(-ox, -oy);
      ctx.fillStyle = pat;
      ctx.fillRect(ox, oy, W, H);
      break;
    }
    case "vignette": {
      // FFmpeg: the picture times cos(angle * r)^4, r = distance / half the diagonal
      const angle = fx.vignetteAngle(a);
      ctx.fillStyle = radial(ctx, W, H, Math.hypot(W / 2, H / 2), "0, 0, 0", (r) => 1 - Math.cos(angle * r) ** 4);
      ctx.fillRect(0, 0, W, H);
      break;
    }
    case "leak":
      if (asset) {
        ctx.globalCompositeOperation = "screen";
        ctx.globalAlpha = fx.leakOpacity(a);
        ctx.drawImage(asset.src, 0, 0, W, H);
      }
      break;
  }
  ctx.restore();
}

/** Everything on the visual tracks at time t, lowest track first. `frameOf` supplies the current frame of each video. */
export function drawOverlays(ctx: Ctx, p: Project, t: number, W: number, H: number, frameOf?: VideoFrameFor) {
  for (const o of layers(p)) {
    if (o.kind === "effect") {
      if (t >= o.start && t <= o.end) applyEffect(ctx, o, t, W, H, frameOf?.(o));
      continue;
    }
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
