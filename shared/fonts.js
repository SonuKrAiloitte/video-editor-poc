// Fonts a title can use. One list for the browser preview, the browser export and FFmpeg on the server,
// so all three draw the same glyphs from the same .ttf files (public/fonts).
export const FONTS = [
  { id: "jakarta", label: "Plus Jakarta Sans", file: "PlusJakartaSans.ttf", devanagari: false },
  { id: "poppins", label: "Poppins", file: "Poppins-Regular.ttf", devanagari: true },
  { id: "playfair", label: "Playfair Display", file: "PlayfairDisplay-Regular.ttf", devanagari: false },
  { id: "noto-deva", label: "Noto Sans Devanagari", file: "NotoSansDevanagari-Regular.ttf", devanagari: true },
];
export const DEFAULT_FONT = "jakarta";

const DEVANAGARI = /\p{Script=Devanagari}/u;

/**
 * The font a title is really drawn with. Hindi text in a font without Devanagari letters would show
 * empty boxes in FFmpeg while the browser quietly substitutes a system font, so the two would differ.
 * Deciding the substitute here keeps preview and export identical.
 */
export function fontFor(text, id) {
  const chosen = FONTS.find((f) => f.id === id) ?? FONTS[0];
  if (DEVANAGARI.test(String(text)) && !chosen.devanagari) return FONTS.find((f) => f.id === "noto-deva");
  return chosen;
}

/**
 * FFmpeg's drawtext (6.1) cannot shape scripts whose letters join or reorder: Hindi comes out with its
 * vowel signs in the wrong place. The browser shapes them correctly, so a title in such a script is drawn
 * to a PNG in the browser and FFmpeg only overlays the picture. Latin, Greek and Cyrillic stay on drawtext.
 */
const COMPLEX = /[^\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Common}\p{Script=Inherited}]|\p{Extended_Pictographic}/u;
export const needsRaster = (text) => COMPLEX.test(String(text));
