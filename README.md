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

Picture and sound match across the three engines of the own-core demo: frame comparison against the server render scores 0.99 for ffmpeg.wasm and 0.97 for Mediabunny (1.0 is identical), and sound levels agree within 0.1 dB. The Mediabunny gap is a different scaler and encoder, not colour: averaged over the frame, the two exports differ by about 1 level in 255.

Why not Twick: its browser export fails on WebM, hung on an HEVC MOV clip, and is several times slower; it has had no release since May 2026; and its server render depends on headless Chrome instead of plain FFmpeg. Its editor UI is the more polished of the two.

## Real-file test

The numbers above come from generated clips. The own-core demo was then run on 20 real files: 13 videos found on the test laptop (AI-generated clips, screen recordings up to 4 minutes at 1080p 60 fps, a render) and 7 downloaded samples (MP4, WebM VP8, MOV, AVI, MP3, WAV, OGG).

| Check | Result |
| --- | --- |
| Server FFmpeg, each of 13 videos alone | 13 of 13 exported, right length, no black frames |
| Server FFmpeg, one 39 s edit of all 13 | 720p 7.7 to 9.7 s; 1080p 11.7 to 12.8 s |
| Server FFmpeg, a whole 4-minute file at 1080p | 69 to 80 s |
| Import in Chrome | Every file usable. AVI cannot be opened by the browser, so the server converts it to MP4 (1.8 s for a 30 s clip) |
| MP3, WAV, OGG as music | All three; sound level within 0.2 dB across engines |
| Preview against export | On the clip checked frame by frame, both show the same source frame |
| Mediabunny, 60 s of 1080p 60 fps | 28 to 32 s (it was 81 to 86 s before canvases were pooled) |
| Mediabunny, the whole 4-minute file | 472 to 661 s. Pooling did not help here and the cause was not found; the server took 57 to 83 s including the upload |
| ffmpeg.wasm, a 12-clip edit | One clip came out 0.1 s long, so every later cut is 3 frames late. Cause not found; kept for comparison only |

What the real files turned up, and what was done:

- **Slow seek.** A clip taken from the end of a long file made FFmpeg decode the file from its start: 17.3 s for a 5 s clip. The graph now seeks on the input: 2.1 s, same output frame for frame.
- **Files the browser cannot open.** AVI, codecs the browser cannot decode and HDR video are sent to the server, which returns a plain H.264 MP4 that the editor then uses.
- **Long exports in the browser.** Each frame allocated a new canvas. With a small canvas pool a 60 s export is about three times faster, but a 4-minute export is still several times slower than real time. Edits over 60 s therefore go to the server automatically, whichever export button is pressed.
- **Hindi text.** FFmpeg 6.1 `drawtext` draws Hindi with the vowel signs in the wrong place. Titles in scripts that join or reorder letters are now drawn to a PNG in the browser and FFmpeg overlays the picture, so the export matches the preview. Latin, Greek and Cyrillic titles still use `drawtext`.
- **Fonts.** A font picker with four fonts; the same `.ttf` files are used by the preview, the browser export and FFmpeg.
- **Uploads and concurrency.** Uploads are streamed to disk instead of held in memory, and the render server runs at most two FFmpeg jobs at once and queues the rest (5 exports asked for together all completed).
- **Colour tag.** The server export now states its colour standard (BT.709). Without it a source with no colour tag gave an untagged export that players read differently.

## Timeline: CapCut-style tracks

Both demos follow the same track rules, like CapCut:

| Track | Takes | Placement |
| --- | --- | --- |
| Main | video and images | Clips stay joined end to end. Remove or move one out and the rest close the gap. |
| Tracks above Main | video, images and text | Anywhere in time, gaps allowed. Upper tracks are drawn over lower ones. |
| Audio tracks | audio only | Anywhere in time. |

A drop on the wrong kind of track is refused with a message. A clip dropped where it would cover another goes on a new track. Tracks left empty are removed.

- **Own core:** drag from the Library onto any track or onto "New", drag clips sideways and between tracks, trim any clip by its edges. The edit JSON has `clips` (Main), `tracks`, `overlays` (items on tracks above) and `audios` (`shared/model.js`); older edits with one `music` field are converted on load. All three export engines handle videos on upper tracks (picture in picture), images on Main and several audio clips. Library drags use pointer events, not HTML5 drag, so they also work on touch screens.
- **Twick:** Twick already lets you drop Library items on its timeline, but it only lets an element move onto a track of type "element", and never lets a video, image or audio element out onto a new track. `scripts/patch-twick.mjs` (run by `npm install`) adds a hook at those three places; `src/twick-track-rules.tsx` supplies the rules, joins up the Main track after each change and removes empty tracks. If a Twick update changes that code, the patch script stops with an error instead of patching blindly. Twick still refuses some moves on its own: it will not let a clip overlap another on the same track, and it ignores a drop that would run past the end of the timeline.

Checked with mouse drags in Chrome: `scripts/timeline-dnd-check.mjs` (own core, 9 drags plus server and browser export) and `scripts/twick-dnd-check.mjs` (Twick, 8 checks). Twick's Library cards use the browser's built-in drag, which the test tool cannot perform with the mouse, so those drops are sent as the same drag events Chrome would send.

## Editing (own core)

- **Library:** a click plays the file in the player; nothing goes on the timeline until it is dragged there or its **+** is pressed. **+** puts video and images into Main at the playhead (the clip under the playhead is split there) and audio on a free audio track at the playhead.
- **Selecting:** Ctrl, Shift or Cmd + click adds clips to the selection; dragging over empty timeline draws a box; Ctrl+A selects everything. Delete removes every selected clip.
- **Track buttons:** each track header has lock, hide and mute (audio tracks: lock and mute). Locked: nothing on it can be moved, trimmed, deleted or dropped onto it. Hidden: its pictures are not drawn (a hidden Main shows black) but its sound plays. Muted: silent. Hide and mute apply to the preview and to all three exports.
- **Playhead:** a handle on top of the playhead line can be dragged.
- **Imported files are kept.** A file picked from the computer is a `blob:` link that dies when the page reloads; an edit saved with it then failed to export with "Failed to fetch". Imports are now stored on the render server (`/api/upload`) as soon as they are picked, and the Library list is saved too. While a file is checked, converted or saved, its own row in the Library says so; there is no pop-up. A clip still pointing at a lost file is marked red, and export stops with a message naming the file. Checked by `scripts/reload-check.mjs`.
- **Library and timeline stay in step.** A Library file used on the timeline shows "Added". An imported file can be removed from the Library (it asks first if the timeline uses it); its clips then turn red and export stops until the file is imported again, which relinks them. Picking the same file twice in a row now imports it (the file input is cleared after each pick). Checked by `scripts/library-check.mjs`.
- **Play** on an export result starts that video.
- Messages float in the top-right corner instead of pushing the page down. (A message used to shift the timeline under the pointer, so the next click could land on a different clip.)

Checked by `scripts/editing-check.mjs` (14 checks, mouse and keyboard in Chrome, including a server export with Main hidden and every track muted: black under the overlays, silent).

## Resize, move and rotate on the preview (own core)

Like CapCut: a click on the preview selects what is under the pointer (the top item first, then the main-track clip) and draws a box around it. Drag inside the box to move it (it snaps to the centre lines), a corner to resize it (keeping its shape), and the round handle below it to rotate it (snaps to 0° and 90°; hold Shift for 15° steps). A click on empty frame clears the selection. The Inspector has the same as sliders, and "Reset size, position and rotation" for main-track clips.

This works for images, videos and titles on tracks, and for main-track clips (whose size and turn apply on top of Fit or Fill). All export engines draw the same: FFmpeg scales, rotates (`rotate` with transparent corners) and places the picture on black; a turned title is drawn by the browser and turned by FFmpeg, because `drawtext` cannot turn text. Checked by `scripts/transform-check.mjs`: preview against the server export 0.956, against Mediabunny 0.961, with a resized and turned logo, a smaller turned video and a larger turned title.

## Text and captions (own core)

- **Titles:** "+ Text" adds a title at the playhead. Font (four), size, colour, an optional background box (colour and opacity), and position by dragging on the preview or with Top / Middle / Bottom.
- **Captions:** "+ Caption" adds a line at the playhead on a Captions track, after any caption already showing, white on a dark box near the bottom. The Captions panel lists every line with its time: type to change a line, click its time to jump there. "Apply this style to all captions" copies font, size, colours, box and position from the selected caption. An .srt or .vtt file can be imported; it replaces the captions after asking, and keeps their style.
- Captions are one line each; a line break in an .srt becomes a space.
- The background box is drawn the same way by the preview, Mediabunny, and FFmpeg (`drawtext` box, or the browser-drawn picture for Hindi). Checked by `scripts/captions-check.mjs`: caption area of the exports against the preview 0.907 to 0.978, English and Hindi.
- The side panels stop at the height of the player and scroll inside, so a long Inspector or captions list no longer pushes the timeline down.

## Player and frame ratio

Under the preview, like CapCut: the time as HH:MM:SS:FF, Play, a ratio menu and full screen. The ratio menu offers Original (the shape of the first clip on Main), 16:9, 9:16, 1:1, 4:3, 3:4, 4:5, 2.35:1, 2:1 and 1.85:1; any `W:H` ratio works in the edit JSON and in all export engines (the short side is 720 or 1080 pixels).

A clip whose shape differs from the frame is shown whole with black bars (Fit, CapCut's default). The Inspector can switch a main-track clip to Fill, which crops it to cover the frame. Checked by `scripts/player-check.mjs`: at 9:16, 16:9 and 2.35:1 the preview, the server export and the browser export show the same frame (match 0.955 to 0.965).

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

To reproduce Twick's WebM failure: in Twick press **New Project**, add the WebM clip with **Add to timeline**, then **Export**.

To add your own file to Twick: open **My assets** and press **Upload video**, which opens the file picker. Twick shows this button only when it is given an upload endpoint (`uploadConfig`); here the render server's `/api/twick-upload` stores the file and returns its URL, converting AVI and similar files to MP4 first. Without such an endpoint Twick only accepts a pasted URL, and it checks only the URL's extension, so a URL to a file that does not exist is still added.

## Checks

Without a browser:

```
node scripts/bench-server.mjs                       # server export timings, and which formats it reads
node scripts/aspect-check.mjs                       # all three aspect ratios at 720p and 1080p
node scripts/audio-check.mjs out/bench_720.mp4 0.2-3.8 4.2-6.8 7.2-9.8   # which sounds are in an export
node scripts/text-check.mjs                         # every font, English and Hindi, through FFmpeg drawtext
node scripts/fonts-unit-check.mjs                   # which titles FFmpeg may draw itself
node scripts/probe.mjs <file> ...                   # codec, size, frame rate, rotation of any file
node scripts/real-media-check.mjs <file> ...        # your own video files through the server export
node scripts/make-phone-media.mjs                   # phone-style clips: rotation flag, HEVC MOV, HDR, variable frame rate
```

In Chrome (needs both servers running and Chrome installed at the default Windows path):

```
node scripts/real-browser-check.mjs <file> ...      # import your files, preview, export with every engine, compare
node scripts/real-browser-check.mjs --headed --hold <file> ...   # the same in a visible window
node scripts/title-browser-check.mjs                # Hindi and English titles in every engine; long edit goes to the server
node scripts/font-ui-check.mjs                      # the font picker, with real clicks and typing
node scripts/preview-check.mjs                      # no black frames while pausing and scrubbing
node scripts/reset-check.mjs                        # split, add text, Reset, Undo
node scripts/twick-upload-check.mjs <file> ...      # your files through Twick's Upload video button
node scripts/twick-add-check.mjs [<file>]           # Twick's Add to timeline for a seeded, a URL and an uploaded clip
node scripts/timeline-dnd-check.mjs                 # own core: drags between tracks and from the Library, then export
node scripts/twick-dnd-check.mjs                    # Twick: the same track rules
node scripts/player-check.mjs                       # player bar, ratio menu, Fit vs Fill, preview against exports
node scripts/editing-check.mjs                      # Library click and +, multi-select, box select, lock/hide/mute, playhead handle
```

## Where things are

| Path | What |
| --- | --- |
| `src/own/project.ts` | The edit JSON: types, split, reorder |
| `shared/model.js` | Track rules (what goes where), edit length, drawing order, converting older edits |
| `src/twick-track-rules.tsx`, `scripts/patch-twick.mjs` | The same track rules added to Twick |
| `src/own/editor.tsx` | Timeline, preview, inspector, undo/redo, autosave, import |
| `src/own/compose.ts` | Draws a frame (crop-to-fit, text, logo); shared by preview and browser export |
| `src/own/exporters.ts` | The three export engines |
| `shared/ffmpeg-graph.js` | Edit JSON to FFmpeg arguments; shared by the server and ffmpeg.wasm |
| `shared/fonts.js` | The font list, and which titles are drawn in the browser |
| `server/render-server.mjs` | PoC render server: upload, convert, export, job queue |
| `src/twick-demo.tsx` | The Twick demo |
| `evidence/` | Frame comparison of the three engines |

## Limits of this PoC

- Tested only in Chrome on one Windows laptop. Not tested: Safari, Firefox, mobile.
- **No footage from a real phone camera has been tested.** The phone-style clips (rotation flag, HEVC in MOV, HDR, variable frame rate) are generated. They import, preview and export correctly, but they are not camera files.
- HDR video is converted to standard colour with a common tone-mapping recipe. How faithful the colours are has not been checked against real HDR footage.
- A title in Hindi needs the browser to draw it. A render started on the server alone, with no browser involved, would need another way to draw such text (libass, or a newer FFmpeg).
- ffmpeg.wasm does not shape Hindi either and uses the same PNG route. It is kept for comparison only.
- The job queue lives in the render server's memory and uploads go to local disk. Production needs a real queue and object storage.
- Twick: MP4, WebM, MOV and AVI uploads were checked to reach its library and play; exporting them from Twick was not tested.
- The initial timeline in the Twick demo is hand-written data and its second clip does not show; build a project with Twick's own buttons for a fair test.

## Third-party notes

- **Twick** is installed from npm under its Sustainable Use Licence; none of its code is copied into this repository.
- **Fonts** in `public/fonts` (Plus Jakarta Sans, Poppins, Playfair Display, Noto Sans Devanagari) are under the SIL Open Font Licence 1.1; see `public/fonts/LICENSES.md`.
- **ffmpeg-static** downloads a GPL build of FFmpeg at install time. Which build to ship in production is an open decision.
