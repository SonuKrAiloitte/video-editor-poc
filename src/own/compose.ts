/**
 * Frame compositor. The live preview and the Mediabunny exporter both call these,
 * so what the user sees while editing is drawn by the same code that draws the export.
 */
import { FONTS, fontOf, type FontId } from "../../shared/fonts";
import { contrastOn, type Overlay, type Project, type TextOverlay } from "./project";

/** Canvas family name for a font id. Prefixed so it never clashes with a font installed on the machine. */
export const fontFamily = (id: FontId) => `ve-${id}`;

let fontsReady: Promise<unknown> | null = null;
/** Loads every title font from public/fonts, the same .ttf files FFmpeg uses. */
export function loadFonts() {
  fontsReady ??= Promise.all(
    (Object.keys(FONTS) as FontId[]).map((id) =>
      new FontFace(fontFamily(id), `url(/fonts/${FONTS[id].file})`).load().then((f) => document.fonts.add(f)),
    ),
  );
  return fontsReady;
}

const images = new Map<string, HTMLImageElement>();
const pending = new Map<string, Promise<HTMLImageElement>>();
export function loadImage(src: string): Promise<HTMLImageElement> {
  const hit = images.get(src);
  if (hit) return Promise.resolve(hit);
  let p = pending.get(src);
  if (!p) {
    p = new Promise<HTMLImageElement>((ok, fail) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => (images.set(src, img), ok(img));
      img.onerror = () => fail(new Error(`could not load image ${src}`));
      img.src = src;
    }).finally(() => pending.delete(src));
    pending.set(src, p);
  }
  return p;
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

export function drawOverlays(ctx: Ctx, p: Project, t: number, W: number, H: number) {
  for (const o of p.overlays) {
    if (t < o.start || t > o.end) continue;
    if (o.kind === "text") drawText(ctx, o, W, H);
    else {
      const img = images.get(o.src);
      if (!img) continue;
      const w = o.width * W;
      const h = (w * img.naturalHeight) / img.naturalWidth;
      ctx.drawImage(img, o.x * W - w / 2, o.y * H - h / 2, w, h);
    }
  }
}

/** Fonts, overlay pictures and photo clips, so the first frame that needs one can draw it. */
export async function preloadOverlayAssets(p: Project) {
  await loadFonts();
  const pics = new Set([...p.overlays.flatMap((o) => (o.kind === "image" ? [o.src] : [])), ...p.clips.filter((c) => c.kind === "image").map((c) => c.src)]);
  await Promise.all([...pics].map((src) => loadImage(src)));
}

/** an image already loaded by loadImage, or undefined */
export const cachedImage = (src: string) => images.get(src);

// ---------------------------------------------------------------- titles
// One renderer for titles. The preview and the Mediabunny export draw with it directly; the server and
// ffmpeg.wasm exports get its output as a transparent picture (rasterizeText), so every engine matches.

type Box = { x: number; y: number; w: number; h: number };
interface TextLayout {
  size: number;
  lineH: number;
  lines: { text: string; x: number; y: number; w: number }[];
  /** the text block, without box padding or effects */
  block: Box;
  /** padding of the background box around each line */
  padX: number;
  padY: number;
}

/** Lines, their widths and positions for a title centred at (x*W, y*H). */
export function layoutText(ctx: Ctx, o: TextOverlay, W: number, H: number): TextLayout {
  const size = Math.round(o.fontSize * (Math.min(W, H) / 720));
  const lineH = Math.round(size * 1.25);
  const padX = Math.round(size * 0.35);
  ctx.save();
  ctx.font = `${size}px "${fontFamily(fontOf(o.font))}"`;
  // like Instagram: a line wider than the frame wraps (box included), so a title never runs off the video
  const maxW = Math.max(size, W * 0.9 - ((o.bg ?? "none") !== "none" ? padX * 2 : 0));
  const raw = wrapLines(o.text, maxW, (t) => ctx.measureText(t).width);
  const widths = raw.map((l) => ctx.measureText(l).width);
  ctx.restore();
  const blockW = Math.max(0, ...widths);
  const blockH = raw.length * lineH;
  const cx = o.x * W;
  const top = o.y * H - blockH / 2;
  const left = cx - blockW / 2;
  const align = o.align ?? "center";
  const lines = raw.map((text, i) => {
    const w = widths[i] ?? 0;
    const x = align === "left" ? left : align === "right" ? left + blockW - w : cx - w / 2;
    return { text, x, y: top + i * lineH + lineH / 2, w };
  });
  return { size, lineH, lines, block: { x: left, y: top, w: blockW, h: blockH }, padX, padY: Math.round((lineH - size) / 2 + size * 0.08) };
}

/**
 * Split text into lines no wider than maxW: the user's own line breaks first, then word wrap,
 * and a single word too wide for the frame is broken by letters. Text that fits is kept exactly as typed.
 */
export function wrapLines(text: string, maxW: number, width: (t: string) => number): string[] {
  const fits = (t: string) => width(t) <= maxW;
  const out: string[] = [];
  for (const para of text.split("\n")) {
    if (fits(para)) {
      out.push(para);
      continue;
    }
    let line = "";
    for (const word of para.split(" ")) {
      const next = line ? `${line} ${word}` : word;
      if (fits(next)) {
        line = next;
        continue;
      }
      if (line) out.push(line);
      let rest = word;
      while (rest.length > 1 && !fits(rest)) {
        let k = rest.length - 1;
        while (k > 1 && !fits(rest.slice(0, k))) k--;
        out.push(rest.slice(0, k));
        rest = rest.slice(k);
      }
      line = rest;
    }
    out.push(line);
  }
  return out;
}

/** extra room effects need around the block, so a glow or outline is never cut off */
const effectMargin = (o: TextOverlay, size: number) => (o.effect === "neon" ? size * 0.9 : o.effect === "shadow" ? size * 0.4 : o.effect === "outline" ? size * 0.15 : 2);

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, h / 2, w / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Draw a title the Instagram way: optional rounded box per line, alignment, outline / shadow / neon. */
export function drawText(ctx: Ctx, o: TextOverlay, W: number, H: number) {
  const L = layoutText(ctx, o, W, H);
  if (!L.lines.some((l) => l.w > 0)) return;
  ctx.save();
  const bg = o.bg ?? "none";
  if (bg !== "none") {
    ctx.fillStyle = o.bgColor ?? "#000000";
    ctx.globalAlpha = bg === "soft" ? 0.55 : 1;
    for (const l of L.lines) {
      if (!l.w) continue;
      roundRect(ctx, l.x - L.padX, l.y - L.lineH / 2 - (L.padY - (L.lineH - L.size) / 2) / 2, l.w + L.padX * 2, L.lineH + (L.padY - (L.lineH - L.size) / 2), L.size * 0.28);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  ctx.font = `${L.size}px "${fontFamily(fontOf(o.font))}"`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  const effect = o.effect ?? "none";
  for (const l of L.lines) {
    if (effect === "outline") {
      ctx.lineWidth = Math.max(2, L.size * 0.12);
      ctx.strokeStyle = contrastOn(o.color) === "#111111" ? "#111111" : "#FFFFFF";
      ctx.strokeText(l.text, l.x, l.y);
    }
    if (effect === "shadow") {
      ctx.shadowColor = "rgba(0,0,0,0.65)";
      ctx.shadowBlur = L.size * 0.18;
      ctx.shadowOffsetX = L.size * 0.05;
      ctx.shadowOffsetY = L.size * 0.07;
    }
    if (effect === "neon") {
      // a coloured glow in a few passes, then a bright core
      ctx.shadowColor = o.color;
      ctx.fillStyle = o.color;
      for (const blur of [L.size * 0.6, L.size * 0.3, L.size * 0.12]) {
        ctx.shadowBlur = blur;
        ctx.fillText(l.text, l.x, l.y);
      }
      ctx.shadowBlur = 0;
      ctx.fillStyle = "#FFFFFF";
      ctx.globalAlpha = 0.85;
      ctx.fillText(l.text, l.x, l.y);
      ctx.globalAlpha = 1;
      continue;
    }
    ctx.fillStyle = o.color;
    ctx.fillText(l.text, l.x, l.y);
    ctx.shadowColor = "transparent";
  }
  ctx.restore();
}

/** the area a title paints, including its box and effects */
function textBounds(ctx: Ctx, o: TextOverlay, W: number, H: number): Box {
  const L = layoutText(ctx, o, W, H);
  const m = effectMargin(o, L.size) + ((o.bg ?? "none") !== "none" ? L.padX : 0);
  return { x: L.block.x - m, y: L.block.y - m, w: L.block.w + m * 2, h: L.block.h + m * 2 };
}

/**
 * A title as a transparent PNG at export size, with where it goes in the W x H frame.
 * Null when it paints nothing (empty text).
 */
export async function rasterizeText(o: TextOverlay, W: number, H: number): Promise<{ blob: Blob; left: number; top: number; w: number; h: number } | null> {
  await loadFonts();
  const probe = new OffscreenCanvas(1, 1).getContext("2d")!;
  if (!layoutText(probe, o, W, H).lines.some((l) => l.w > 0)) return null;
  const b = textBounds(probe, o, W, H);
  const left = Math.floor(b.x);
  const top = Math.floor(b.y);
  const w = Math.ceil(b.x + b.w) - left;
  const h = Math.ceil(b.y + b.h) - top;
  const cv = new OffscreenCanvas(w, h);
  const ctx = cv.getContext("2d")!;
  ctx.translate(-left, -top);
  drawText(ctx, o, W, H);
  return { blob: await cv.convertToBlob({ type: "image/png" }), left, top, w, h };
}

/** Where an overlay sits in a W x H frame, for the preview's selection box and hit testing (not used by exports). */
export function overlayBox(ctx: Ctx, o: Overlay, W: number, H: number): { x: number; y: number; w: number; h: number } | null {
  if (o.kind === "text") {
    const L = layoutText(ctx, o, W, H);
    const pad = (o.bg ?? "none") !== "none" ? L.padX : 0;
    return { x: L.block.x - pad, y: L.block.y, w: L.block.w + pad * 2, h: L.block.h };
  }
  const img = images.get(o.src);
  if (!img) return null;
  const w = o.width * W;
  const h = (w * img.naturalHeight) / img.naturalWidth;
  return { x: o.x * W - w / 2, y: o.y * H - h / 2, w, h };
}

/** height / width of a loaded image, or null if it has not loaded yet */
export const imageRatio = (src: string) => {
  const img = images.get(src);
  return img ? img.naturalHeight / img.naturalWidth : null;
};
