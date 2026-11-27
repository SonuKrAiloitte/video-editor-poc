// The fonts a text overlay can use. Shared by the canvas preview, the browser exporters and the
// render server, so every engine draws a title with the same .ttf file.
// All are SIL Open Font Licence fonts from the Google Fonts repository, served from public/fonts.

export const FONTS = {
  jakarta: { label: "Plus Jakarta Sans", file: "PlusJakartaSans.ttf" },
  bebas: { label: "Bebas Neue", file: "BebasNeue.ttf" },
  anton: { label: "Anton", file: "Anton.ttf" },
  playfair: { label: "Playfair Display", file: "PlayfairDisplay.ttf" },
  pacifico: { label: "Pacifico", file: "Pacifico.ttf" },
};

export const DEFAULT_FONT = "jakarta";

/** Older drafts have no font field, and an unknown id must never reach FFmpeg. */
export const fontOf = (id) => (id && Object.hasOwn(FONTS, id) ? id : DEFAULT_FONT);
