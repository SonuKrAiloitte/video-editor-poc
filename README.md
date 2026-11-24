# Video Editor PoC

A proof of concept for a basic in-browser video editor, built to compare open source stacks and pick one.

It contains two working demos fed the same test clips:

| Demo | What it is |
| --- | --- |
| **Own core** (`#own`) | Our own timeline, canvas preview and inspector over a small JSON edit file. The same edit exports three ways: FFmpeg on a server, Mediabunny in the browser, ffmpeg.wasm in the browser. |
| **Twick** (`#twick`) | Twick Studio 0.15.31 mounted as shipped, with its own browser renderer wired to Export. |

## Result

Selected: **own editor core + FFmpeg on the server (default export) + Mediabunny (fast browser export)**.

Same 10-second vertical edit (3 clips, title, logo, music), browser tab visible, one Windows laptop:

| Export engine | 720p | 1080p |
| --- | --- | --- |
| FFmpeg on the server | 1.7 to 2.9 s | 2.7 to 3.7 s |
| Mediabunny (browser) | 4.1 to 4.7 s | 4.7 to 5.6 s |
| ffmpeg.wasm (browser) | 15 to 17 s | 31 s |
| Twick browser export | 32 to 48 s for a 7 s MP4 edit; WebM fails; HEVC MOV hung | not run |

Picture and sound match across the three engines of the own-core demo: frame comparison against the server render scores 0.99 for ffmpeg.wasm and 0.97 for Mediabunny (1.0 is identical), and sound levels agree within 0.1 dB.

Why not Twick: its browser export fails on WebM, hung on an HEVC MOV clip, and is several times slower; it has had no release since May 2026; and its server render depends on headless Chrome instead of plain FFmpeg. Its editor UI is the more polished of the two.

## Run it

Needs Node 20 or newer. FFmpeg is downloaded by `npm install` (the `ffmpeg-static` package); nothing else to install.

```
npm install
npm run media          # generates the six test clips into public/media
npm run twick-assets   # copies the files Twick needs for audio export
npm run server         # render server on http://localhost:5181
npm run dev            # app on http://localhost:5180
```

Open `http://localhost:5180/#own` for the own-core editor and `http://localhost:5180/#twick` for Twick.

On Linux, the FFmpeg build that `ffmpeg-static` downloads has no `drawtext` filter, so the test clips and any export with text fail. Point the scripts and the render server at a system FFmpeg instead: `export FFMPEG_BIN=/usr/bin/ffmpeg` before `npm run media` and `npm run server`.

To reproduce Twick's WebM failure: in Twick press **New Project**, add the WebM clip with **Add to timeline**, then **Export**.

## Checks without a browser

```
node scripts/bench-server.mjs                       # server export timings, and which formats it reads
node scripts/aspect-check.mjs                       # all three aspect ratios at 720p and 1080p
node scripts/audio-check.mjs out/bench_720.mp4 0.2-3.8 4.2-6.8 7.2-9.8   # which sounds are in an export
```

## Where things are

| Path | What |
| --- | --- |
| `src/own/project.ts` | The edit JSON: types, split, reorder |
| `src/own/editor.tsx` | Timeline, preview, inspector, undo/redo, autosave |
| `src/own/compose.ts` | Draws a frame (crop-to-fit, text, logo); shared by preview and browser export |
| `src/own/exporters.ts` | The three export engines |
| `shared/ffmpeg-graph.js` | Edit JSON to FFmpeg arguments; shared by the server and ffmpeg.wasm |
| `server/render-server.mjs` | PoC render server (a queue worker in production) |
| `src/twick-demo.tsx` | The Twick demo |
| `evidence/` | Frame comparison of the three engines |

## Limits of this PoC

- Tested only in Chrome on one Windows laptop, with generated test clips (not real phone footage).
- Not tested: Safari, Firefox, mobile, videos longer than 16 seconds, concurrent exports, cloud storage, Hindi or other non-Latin text.
- The own-core editor has no font picker yet.
- The initial timeline in the Twick demo is hand-written data and its second clip does not show; build a project with Twick's own buttons for a fair test.

## Third-party notes

- **Twick** is installed from npm under its Sustainable Use Licence; none of its code is copied into this repository.
- **Plus Jakarta Sans** (`public/fonts`) is under the SIL Open Font Licence.
- **ffmpeg-static** downloads a GPL build of FFmpeg at install time. Which build to ship in production is an open decision.
