# Easy Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second, phone-editor-style "Easy editor" screen for non-technical users, sharing the draft, undo history and engines with the unchanged Advanced editor.

**Architecture:** Extract the Advanced editor's draft/undo store, preview playback loop and media import into `src/own/core/` without behaviour change, then build `src/own/easy/` on top of them. Tests are headless-Chrome checks driven over CDP through `window.__poc`, kept in the repo as `scripts/ui-check.mjs`.

**Tech Stack:** React 19, TypeScript, Vite, Mediabunny (thumbnails, probing), existing exporters, Node 22 (built-in WebSocket) + local Chrome for UI checks.

**Spec:** `docs/superpowers/specs/2026-11-27-easy-editor-design.md`

## Global Constraints

- Advanced editor behaviour does not change; `node scripts/ui-check.mjs advanced` must pass all 18 checks after every task.
- Routes: `#easy` (default), `#own` (Advanced editor), `#twick` (comparison only).
- No technical words on the easy screen: no "codec", "FFmpeg", "Mediabunny", "wasm", "px", seconds number fields (except inside "Technical details").
- Format labels: "Reel / Story" (9:16), "YouTube" (16:9), "Square" (1:1). Quality labels: "Standard (720p)", "High (1080p)".
- New text and logo overlays on the easy screen last the whole video.
- No new dependencies. Icons are inline SVG.
- Do not commit; the user commits when they ask (global user rule).

## Review Focus

1. Empty draft (no clips) on the easy screen: shows "Add your first video", no crash, Export disabled. Test in Task 3.
2. Switching `#easy` → `#own` → `#easy` mid-edit keeps the edit and the undo stack. Test in Task 3.
3. Very long clip (minutes) on the timeline: thumbnail generation must not block the UI or fetch every frame; cap at one thumb per ~80 px of strip, generated lazily. Test in Task 4 (an 18 s edit generates ≤ 40 thumbnails).
4. Upload while the render server is down: a clear plain-words message, item still usable this session. Covered by existing fallback in `core/media.ts`; asserted in Task 5 by message text.
5. Deleting the selected item resets the toolbar to the main tools (no toolbar pointing at a deleted item). Test in Task 5.

---

### Task 1: Move the UI checks into the repo

**Files:**
- Create: `scripts/ui-check.mjs` (from the session's `browser-check.mjs`)
- Modify: `package.json` (script `"ui-check": "node scripts/ui-check.mjs"`)

**Interfaces:**
- Produces: `node scripts/ui-check.mjs <advanced|easy|all>`; exits non-zero on any FAIL; writes screenshots to `out/ui-check/`; deletes the uploads/library files it created (by the exact paths it created).

- [ ] **Step 1:** Port the 18 existing checks as suite `advanced` (URL `#own`). Chrome path from `CHROME` env or the macOS default.
- [ ] **Step 2:** Run `node scripts/ui-check.mjs advanced` with servers up. Expected: 18 PASS, exit 0.

### Task 2: Extract the shared core (no behaviour change)

**Files:**
- Create: `src/own/core/history.ts`, `src/own/core/player.ts`, `src/own/core/media.ts`
- Modify: `src/own/editor.tsx` (imports only; delete moved code)

**Interfaces:**
- Produces:
  - `history.ts`: `useHistory(): { project, begin(), apply(p), commit(p), undo(), redo(), canUndo, canRedo, savedAt }`, `cur(): Project`, `takeDroppedOnLoad(): number`, `historyDepth(): number`.
  - `player.ts`: `usePreview(canvasRef, opts?: { drawSelection?: (ctx, W, H, t) => void }): { t, playing, setPlaying, seek(t), tRef, media() }`.
  - `media.ts`: `probe(src | Blob)`, `useLibrary(): { library, serverUp, refresh() }`, `FALLBACK_LIBRARY`, `importFiles(files, add, setNotice): Promise<void>`, `addMediaTo(project, item, t, opts: { overlayRange: "playhead3s" | "whole" }): Promise<{ project, select? , error? }>`.
- [ ] **Step 1:** Move code verbatim, parameterising only the overlay default range (advanced: `playhead3s`).
- [ ] **Step 2:** `npm run typecheck` passes; `node scripts/ui-check.mjs advanced` → 18 PASS.

### Task 3: Routing and the easy screen shell

**Files:**
- Create: `src/own/easy/EasyEditor.tsx`, `src/own/easy/icons.tsx`, `src/own/easy/easy.css`
- Modify: `src/main.tsx` (default `#easy`; nav: "Easy editor", "Advanced editor", "Comparison only: Twick (not chosen)")

**Interfaces:**
- Consumes: Task 2 core.
- Produces: `window.__poc` on `#easy` with the advanced hook's members plus `screen: "easy"`, `select(kind, id)`, `toolbar(): string` (current toolbar name: `main|clip|text|logo|music`), `sheet(): string | null`.

- [ ] **Step 1: Write checks (suite `easy`):** opens as default route; `__poc.screen === "easy"`; New project → text "Add your first video" visible and Export button disabled; format sheet → choose "YouTube" → `getProject().aspect === "16:9"`; undo restores; `#own` then `#easy` keeps `getProject()` and `canUndo()` unchanged.
- [ ] **Step 2:** Run → FAIL (no screen).
- [ ] **Step 3:** Build: dark top bar (← Advanced, format chip, undo/redo, "Saved ✓", Export), large preview (click toggles play), time + play button, bottom toolbar container, sheet container, empty state.
- [ ] **Step 4:** Run easy + advanced suites → PASS.

### Task 4: Filmstrip timeline with a fixed centre playhead

**Files:**
- Create: `src/own/easy/Timeline.tsx`, `src/own/core/thumbs.ts`

**Interfaces:**
- Produces: `thumbs.ts`: `getThumbs(src: string, inSec: number, outSec: number, count: number, height: number): Promise<string[]>` (object URLs, cached by `src|time|height`).
- Timeline: scrollLeft ↔ time (`t = scrollLeft / pxPerSec`, half-width padding each side); playing sets scrollLeft; user scroll seeks. Clip cards with thumbnails; selected clip shows 14 px trim handles (snap 0.1 s, min 0.2 s via `clampTrim`); drag a card to reorder; text/logo lane bars draggable with trimmable ends; music lane bar selectable. Zoom: fixed default 80 px/s with − / + buttons.

- [ ] **Step 1: Checks:** `__poc.seek(5)` → strip scrollLeft ≈ 5 × pxPerSec (±2 px); thumbnails rendered for the sample (count between 6 and 40); clicking a clip card sets `toolbar() === "clip"`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run both suites → PASS.

### Task 5: Context toolbars and sheets

**Files:**
- Create: `src/own/easy/Toolbars.tsx`, `src/own/easy/Sheets.tsx`

**Interfaces:**
- Toolbars: `main` (Add video, Text, Logo, Music, Format), `clip` (Split, Mute/Unmute, Delete, Done), `text` (Edit, Font, Colour, Size, Position, Delete, Done), `logo` (Size, Position, Delete, Done), `music` (Volume, Replace, Remove, Done).
- Sheets: `media(kind)` (Upload from computer + My media grid filtered by kind), `font` ("Aa" chips per font in that font), `colour` (8 swatches + custom), `size` (slider), `position` (text: Top/Middle/Bottom → y = 0.15/0.5/0.85, x = 0.5; logo: 4 corners + centre at 0.12/0.88 insets), `volume` ("Video sound", "Music"), `format`, `edit text` (text field).
- Preview shows a dashed box around the selected text/logo (drawn only in preview via `drawSelection`); drag on preview moves it.

- [ ] **Step 1: Checks:** upload a real file via the media sheet's file input → new clip with `/out/uploads/` src, `toolbar() === "clip"`; Split at 1 s into the selected clip → clip count +1; Delete → count −1 and `toolbar() === "main"`; Text → overlay added spanning 0–total, font chip "Bebas Neue" → `font === "bebas"`; Position "Bottom" → `y === 0.85`; logo via media sheet → `name` set, spans whole video; server down message text contains "will be gone after a reload" (simulated by a forced failed upload hook).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run both suites → PASS.

### Task 6: Export sheet

**Files:**
- Create: `src/own/easy/ExportSheet.tsx`

**Interfaces:**
- Consumes: `exportServer`, `exportMediabunny`, `exportFfmpegWasm`, `saveToLibrary`.
- Quality radio (Standard/High), Export button (server engine by default), progress bar with plain text ("Making your video…"), result: big player, Download, "Save to my media" → "Saved to My media". "Technical details" link reveals engine select and the timing line.

- [ ] **Step 1: Checks:** export at High → result 1080 px short side; Save → library has 1 export; Technical details → Mediabunny export succeeds; no page errors overall.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run `all` → PASS. Review screenshots by eye.

### Task 7: Docs

**Files:**
- Modify: `DEMO.md` (walkthrough on the easy screen; Advanced and Twick as follow-ups), `README.md` (routes, `npm run ui-check`), `CLAUDE.md` (core/ + easy/ structure, ui-check command).

- [ ] **Step 1:** Update; `npm run build` passes; `npm run ui-check all` passes.
