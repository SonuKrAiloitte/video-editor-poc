export type FontId = "jakarta" | "bebas" | "anton" | "playfair" | "pacifico";
export const FONTS: Record<FontId, { label: string; file: string }>;
export const DEFAULT_FONT: FontId;
export function fontOf(id: string | undefined): FontId;
