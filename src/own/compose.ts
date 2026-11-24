/**
 * Frame compositor. The live preview and the Mediabunny exporter both call these,
 * so what the user sees while editing is drawn by the same code that draws the export.
 */
import type { Project } from "./project";

export const FONT = "PJS";
let fontReady: Promise<unknown> | null = null;
export function loadFont() {
  fontReady ??= new FontFace(FONT, "url(/fonts/PlusJakartaSans.ttf)").load().then((f) => document.fonts.add(f));
  return fontReady;
}

const images = new Map<string, HTMLImageElement>();
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

export function drawOverlays(ctx: Ctx, p: Project, t: number, W: number, H: number) {
  for (const o of p.overlays) {
    if (t < o.start || t > o.end) continue;
    if (o.kind === "text") {
      ctx.font = `${Math.round(o.fontSize * (Math.min(W, H) / 720))}px ${FONT}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = o.color;
      ctx.fillText(o.text, o.x * W, o.y * H);
    } else {
      const img = images.get(o.src);
      if (!img) continue;
      const w = o.width * W;
      const h = (w * img.naturalHeight) / img.naturalWidth;
      ctx.drawImage(img, o.x * W - w / 2, o.y * H - h / 2, w, h);
    }
  }
}

export async function preloadOverlayAssets(p: Project) {
  await loadFont();
  await Promise.all(p.overlays.flatMap((o) => (o.kind === "image" ? [loadImage(o.src)] : [])));
}
