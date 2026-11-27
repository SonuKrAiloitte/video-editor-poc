# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A proof of concept comparing two in-browser video editor stacks on the same test clips:

- **Own core** (`src/own/`): our own editor over a small JSON edit document, exporting three ways (server FFmpeg, Mediabunny/WebCodecs in the browser, ffmpeg.wasm in the browser). This is the selected stack: server FFmpeg as default export, Mediabunny as fast browser export. It has two screens over the same draft:
  - **Easy editor** (`#easy`, the default route, `src/own/easy/`): phone-editor style for non-technical users. Filmstrip timeline under a fixed centre playhead, a bottom toolbar that follows the selection (`Toolbars.tsx`), one-choice option sheets (`Sheets.tsx`), plain-words export (`ExportSheet.tsx`; engines only under "Technical details"). No technical words on this screen: `plain()` in `EasyEditor.tsx` rewords core errors, and `ui-check` asserts it.
  - **Advanced editor** (`#own`, `src/own/editor.tsx`): full timeline, inspector with number fields, all three engines side by side.
- **Twick** (`#twick`, `src/twick-demo.tsx`): Twick Studio mounted as shipped, kept for comparison only. Installed from npm under its Sustainable Use Licence; do not copy its code into this repo.

`src/main.tsx` lazy-loads each demo as its own chunk so one candidate's bundle size never hides inside the other's.

## Commands

Node 20+. FFmpeg comes from the `ffmpeg-static` npm package; nothing else to install.

```
npm install
npm run media          # generate test clips into public/media (gitignored; required before anything else works)
npm run twick-assets   # copy Twick's audio-export assets into public/ (gitignored)
npm run server         # render server on :5181
npm run dev            # Vite app on :5180 (proxies /api and /out to :5181)
npm run typecheck      # tsc --noEmit (covers src/ and shared/)
npm run build
```

`DEMO.md` is the click-by-click CEO demo script; keep it in step with UI changes.

There is no unit test suite or linter. UI checks drive a throwaway headless Chrome over CDP through each screen's `window.__poc` hook (needs `npm run server` and `npm run dev` running; Chrome path from `CHROME` env, macOS default otherwise):

```
npm run ui-check              # both screens, ~5 min; exits non-zero on any FAIL
npm run ui-check advanced     # or: easy, layout (long titles, narrow windows; ~30 s)
```

Checks click buttons by visible label / aria-label (`b.click(label, container)`), so renaming a button means updating `scripts/ui-check.mjs`. Upload failure is simulated by CDP `Fetch` interception, not an app flag. Files the checks upload/save are tracked and deleted; screenshots land in `out/ui-check/`.

Headless checks of the server render path (outputs land in `out/`):

```
node scripts/bench-server.mjs     # 720p/1080p timings + codec matrix (H.264 MP4, VP9 WebM, HEVC MOV)
node scripts/aspect-check.mjs     # all three aspect ratios at both heights, verified via ffmpeg probe
node scripts/audio-check.mjs out/bench_720.mp4 0.2-3.8 4.2-6.8 7.2-9.8   # which sounds are present in time ranges
```

`node scripts/timeline-check.mjs` checks photo clips (frame counts) and placed music pieces (tone levels per time range) on the server path in a few seconds; run it after touching the graph.

These import `render()` from `server/render-server.mjs` (the server only calls `listen` when run as the entry point) and use `shared/sample-project.json` as input.

## Architecture

**One edit document, many consumers.** `src/own/project.ts` defines `Project` — plain JSON (aspect, clips with in/out trim points, overlays, `audio` music pieces). A clip with `kind: "image"` is a photo shown for `out - in` seconds (FFmpeg loops it with `-loop 1`; it has no sound). Each `AudioClip` plays `[in, out]` of its file starting at `start` on the timeline; pieces may overlap and are mixed. Drafts saved with the older single `music` field are converted by `normalizeProject` on load (and `audioOf` in `ffmpeg-graph.js` accepts the old shape on the server). Clips are packed end to end, so timeline position is derived (`clipStarts`) and reorder is an array move. Overlay positions are frame fractions (0..1, centre-anchored); text `fontSize` is in px at a 720 short side and scaled for 1080. The editor keeps history as a stack of immutable documents and autosaves to localStorage.

**Shared core** (`src/own/core/`), used by both screens so neither duplicates editing logic:
- `history.ts`: draft load/autosave and the undo store, at module level so switching screens keeps the edit and its history. `cur()` is the latest project even before React re-renders; read it in handlers instead of a closed-over `project`. Use `commit(next)` for a discrete edit; for a gesture (drag, typing, slider) call `begin()` on pointer-down/focus and `apply(next)` on every change. The first `apply` after `begin` records one undo step, and a click that changes nothing records none.
- `player.ts`: `usePreview(canvasRef, project, { drawExtra })`, the rAF playback loop (master clock is wall time; `<video>` elements are re-seeked when they drift). `drawExtra` draws preview-only marks such as the easy screen's selection box; never draw those in `compose.ts`, which exports share.
- `media.ts`: probing, upload-on-import with blob fallback (`importFiles`), the library hook, and `addMediaTo` (Advanced puts new images at the playhead for 3 s, Easy for the whole video).
- `thumbs.ts`: filmstrip thumbnails, decoded with Mediabunny over range requests, cached and queued one at a time.

**Two parity seams keep exports identical:**

1. `shared/ffmpeg-graph.js` (plain JS + `.d.ts`) builds the FFmpeg `filter_complex` args from a `Project`. It is used by both the Node render server and ffmpeg.wasm in the browser; only the `resolve(src)` callback and font path differ per runtime. Change filter logic here, not in either caller.
2. `src/own/compose.ts` draws a frame (crop-to-fit cover, text, logo). Both the live canvas preview and the Mediabunny exporter call it.

So a visual change usually needs to be made in **both** `compose.ts` (canvas path) and `ffmpeg-graph.js` (FFmpeg path), and they must agree. Known parity details already encoded: mono sources are explicitly panned to both channels in FFmpeg (FFmpeg otherwise drops them 3 dB vs browsers), which is why `Clip.channels` / `music.channels` exist; output is 30 fps, yuv420p, 48 kHz stereo AAC. The reference for parity is the server render (frame comparison evidence in `evidence/`).

**Titles have one renderer**: `drawText` / `layoutText` in `compose.ts` (rounded box per line `bg`/`bgColor`, `align`, `effect` outline/shadow/neon, `\n` for lines; `wrapLines` wraps anything wider than 90% of the frame, by words then letters, and leaves text that fits untouched). The preview and Mediabunny call it directly. For the server and ffmpeg.wasm, `withRasterTitles` in `exporters.ts` draws each title to a transparent PNG at export size (`rasterizeText`) and sends it as an image overlay with `pixel: { left, top }`, which `ffmpeg-graph.js` places exactly and blends in RGB (`overlay=...:format=rgb`, needed for edges to match the canvas). Server title PNGs go to `PUT /api/render-asset/:name` → `out/render-assets/`, never listed in the library. `drawtext` remains only as a fallback for renders made without a browser (the server scripts) and ignores the Instagram-style fields. Change title looks in `drawText` only.

**Fonts**: `shared/fonts.js` is the single list of title fonts (`.ttf` in `public/fonts`). `TextOverlay.font` is optional (old drafts) and always goes through `fontOf()`. Canvas uses family `ve-<id>` (`compose.ts`); FFmpeg gets a path from the `fontPath(id)` callback passed to `buildFfmpegArgs`.

**Media sources and the library** (`src/own/exporters.ts`, `server/render-server.mjs`):
- Samples are `/media/...` (served from `public/media`). Imported files are uploaded on import with `PUT /api/upload/:name` to `out/uploads/`, so the draft keeps a server URL that survives a reload. If the server is down the editor falls back to a `blob:` URL (tab-only); `dropDeadMedia` strips those from a draft on load.
- `GET /api/library` lists saved exports (`out/library/`), uploads and samples. Saving an export uses `POST /api/library {src}` (server render, copied) or `PUT /api/library/:name` (browser render, uploaded).
- The server's `resolve` maps a src to a file only under `public/media`, `out/uploads`, `out/library` or `out/`, after `path.resolve`, so `..` cannot escape. `ffmpeg-graph.js` only lets a `#RRGGBB` colour into the filter graph. Keep both properties when changing them: the render API takes client JSON.
- The server `chdir`s to the repo root at import time so filter graphs use relative paths (avoids escaping Windows drive colons).

The render server is a PoC stand-in; production intent (noted in comments) is a queue worker reading/writing object storage, with the edit JSON stored in Postgres JSONB.

## Known limits (from README)

Tested only in Chrome (Windows laptop, and headless Chrome on macOS) with generated clips. Untested: Safari, Firefox, mobile, videos over ~16 s, concurrent exports, non-Latin text. Fonts are SIL OFL. Which FFmpeg build to ship in production (ffmpeg-static is GPL) is an open decision.
