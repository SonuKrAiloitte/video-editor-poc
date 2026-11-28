export interface FontDef {
  id: string;
  label: string;
  file: string;
  devanagari: boolean;
}
export const FONTS: FontDef[];
export const DEFAULT_FONT: string;
export function fontFor(text: string, id?: string): FontDef;
export function needsRaster(text: string): boolean;
