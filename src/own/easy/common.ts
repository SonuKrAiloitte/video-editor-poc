/** Types and helpers shared by the easy editor's parts. */
import type { Aspect } from "../project";

export type Sel = { type: "clip" | "overlay" | "audio"; id: string } | null;
export type SheetName = "format" | "media-video" | "media-image" | "media-audio" | "font" | "colour" | "size" | "position" | "volume" | "text" | "length" | "style" | "export";

export const FORMATS: { aspect: Aspect; label: string; hint: string; w: number; h: number }[] = [
  { aspect: "9:16", label: "Reel / Story", hint: "Tall, for phones", w: 9, h: 16 },
  { aspect: "16:9", label: "YouTube", hint: "Wide, for screens", w: 16, h: 9 },
  { aspect: "1:1", label: "Square", hint: "For feed posts", w: 1, h: 1 },
];

/** m:ss, for people rather than editors */
export const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
