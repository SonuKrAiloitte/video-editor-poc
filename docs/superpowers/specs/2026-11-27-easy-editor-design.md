# Easy editor: design

Date: 2026-11-27. Approved in conversation.

## Intent

The current editor (`#own`) was built to compare technologies, and it reads that way: engine names, number boxes, small drag handles, everything visible at once. A non-technical person (someone making a social post) should be able to open the editor and finish a post without help, and the CEO demo needs something simple that still looks good.

So we add a second screen, the **Easy editor**, and keep the existing one unchanged as the **Advanced editor**.

## Goals

- Every row of the v1 requirements table can be done on the easy screen, in plain words, without keyboard shortcuts.
- Interaction patterns people already know from phone editors (Instagram Edits, CapCut): dark editing screen, big preview, a filmstrip timeline that scrolls under a fixed centre playhead, a bottom toolbar that changes with what is selected, option sheets.
- Both screens edit the same draft and share undo history, so switching never loses work.
- Easy to test: the easy screen exposes the same kind of `window.__poc` hook as the advanced one.

## Non-goals

- A mobile layout (out of scope in the requirements). The easy screen is desktop, phone-editor style.
- New editing features beyond the requirements table (no transitions, speed, filters, captions-from-speech).
- Copying Edits' branding, icons or visual identity.

## Anti-goals

- Any change in the Advanced editor's behaviour. Its 18 browser checks must still pass.
- Two copies of the editing logic.
- Technical words on the easy screen (codec, FFmpeg, Mediabunny, px, seconds fields).

## Approaches considered

- **A. One friendly screen** (picked, as a new screen): everything on one screen, context toolbar, "Technical details" behind a link. Least risk, all requirement rows on one screen.
- **B. Guided steps**: five steps along the top. Easier for a first-timer but slower for quick edits, about twice the work and more screens to test.
- **C. Simple/Advanced toggle in one screen**: two interfaces tangled in one component; works against "simple to test".

The user chose a new screen and asked for Edits-like navigation, which fits A.

## Design

### Screens and routing
- `#easy` (default): Easy editor. `#own`: Advanced editor (label changes to "Advanced editor", code path unchanged). `#twick`: comparison only.

### Shared core (extracted, not rewritten)
Moved out of `editor.tsx` into `src/own/core/` with no behaviour change:
- `history.ts`: draft load/autosave, module-level undo store, `useHistory()` (commit / begin+apply / undo / redo).
- `player.ts`: `usePreview()`: the rAF playback loop, `<video>` pool, music element, canvas drawing; returns `t`, `playing`, `seek`, `setPlaying`, refs.
- `media.ts`: `probe`, upload-on-import, `useLibrary()`, the add-media logic.

The advanced editor is changed only to import these.

### Easy screen layout (desktop)
```
┌ top bar ───────────────────────────────────────────────────────────┐
│ ← Advanced   [▯ 9:16 ▾]          ↶ ↷   Saved ✓        [ Export ]   │
├────────────────────────────────────────────────────────────────────┤
│                    big preview (click = play/pause)                │
│        selected text/logo shows a dashed box; drag to move         │
│                     0:04 / 0:18      ▶                              │
├ timeline (scrolls; white playhead fixed in the centre) ────────────┤
│   [filmstrip clip 1][filmstrip clip 2][ + ]                        │
│   ▭ Title text ▭           ▭ logo ▭        (text/logo lanes)        │
│   ♪ music ─────────────────────────────                             │
├ bottom toolbar (changes with selection) ───────────────────────────┤
│ nothing selected: Add video · Text · Logo · Music · Format          │
│ clip selected:    Split · Mute/Unmute · Delete · Done               │
│ text selected:    Edit · Font · Colour · Size · Position · Delete   │
│ logo selected:    Size · Position · Delete                          │
│ music selected:   Volume · Replace · Remove                         │
└────────────────────────────────────────────────────────────────────┘
```
- Timeline: scrolling the strip moves the time under the fixed playhead; playing scrolls it. Clips show frame thumbnails (Mediabunny, cached per source). The selected clip shows wide trim handles; dragging a clip reorders it. Text and logo bars can be dragged and their ends trimmed.
- Sheets (a panel that slides up over the toolbar): font picker as "Aa" chips in each font; colour as a row of swatches plus a custom picker; size slider; position buttons (Top / Middle / Bottom for text; four corners and centre for a logo); volume sliders ("Video sound", "Music").
- Add video / Logo / Music open a media sheet: "Upload from computer" plus a grid of My media (library, uploads, saved exports) filtered by kind.
- New text and logos last the whole video by default (most posts want that); the lane bar is how you shorten it.
- Format sheet: Reel / Story (9:16), YouTube (16:9), Square (1:1), each with a shape icon.
- Export sheet: Standard (720p) or High (1080p), one Export button (server render). Progress, then a big player with Download and Save to my media. A small "Technical details" link reveals the engine choice (server / Mediabunny / ffmpeg.wasm) for the demo.
- Empty draft: a single large "Add your first video" call to action.

### Testing
- Re-run the existing 18 headless checks against `#own`.
- New headless checks for `#easy`: loads, upload, split, delete, add text with a font, position preset, format switch, undo, reload keeps the draft, export, save to my media, no page errors. Screenshots reviewed by eye.

## Left to the builder
Icon drawing (inline SVG, simple strokes), exact colours of the dark theme, thumbnail density, sheet animation.
