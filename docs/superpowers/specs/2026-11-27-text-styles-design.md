# Instagram-style text: design

Date: 2026-11-27. Approved in conversation (option B).

## Intent
Titles should offer what Instagram's text tool offers, so a non-technical user can make a readable, good-looking title: a background box, alignment, effects, several lines.

## Goals
- Background: None / Solid / See-through, a rounded box per line, any box colour; picking a box colour switches the text to black or white for contrast.
- Alignment: left / centre / right (matters for several lines).
- Effect: None / Outline / Shadow / Neon glow.
- Several lines: Enter in the text box.
- Preview, Mediabunny, ffmpeg.wasm and the server export look the same.
- Old drafts keep their look (no box, centred, no effect).

## Non-goals
Text animations; per-word colours; custom fonts beyond the five we ship.

## Approaches
- A. Teach FFmpeg `drawtext` each style: one square box around the whole block, no glow; server export differs from the preview.
- **B. (picked) One renderer, in the browser.** `compose.ts` draws text (used by the preview and Mediabunny as today). For the server and ffmpeg.wasm, the browser rasterises each title to a transparent PNG at export resolution and the edit sent to FFmpeg carries it as an image overlay sized and placed to the pixel. `drawtext` stays only as a fallback for renders made without a browser (the server scripts).

## Design
- `TextOverlay` gains optional `bg` ("none" | "solid" | "soft"), `bgColor` (#RRGGBB), `align` ("left" | "center" | "right"), `effect` ("none" | "outline" | "shadow" | "neon"). Text may contain `\n`.
- `compose.ts`: `layoutText` (lines, widths, line height, block box) and `drawText`; `drawOverlays`, `overlayBox` and a new `rasterizeText(o, W, H)` all use them.
- Exporters: `exportServer` and `exportFfmpegWasm` replace text overlays with image overlays (`width = pngW / W`, centre = box centre). Server uploads go to `PUT /api/render-asset/:name` → `out/render-assets/` (not listed in My media).
- Easy editor: text toolbar gets **Style** (a sheet with Background + box colour, Align, Effect); the text field becomes a multi-line box. Advanced editor: three dropdowns and a box colour picker in the inspector.

## Testing
UI checks: each Style control changes the draft; a styled multi-line title exported by the server and by Mediabunny match in the title region (SSIM); a see-through box lets the moving video show through while a solid one does not; Advanced dropdown works; all existing checks still pass.
