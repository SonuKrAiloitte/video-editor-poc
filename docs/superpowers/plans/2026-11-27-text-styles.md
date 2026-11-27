# Instagram-style Text Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (the user chose native execution). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Background box, alignment, effects and multi-line titles, identical in the preview and all three export engines.

**Architecture:** One text renderer in `src/own/compose.ts`; server and ffmpeg.wasm exports receive titles as browser-rasterised PNG overlays.

**Tech Stack:** Canvas 2D, existing exporters, Express render server, `scripts/ui-check.mjs`.

**Spec:** `docs/superpowers/specs/2026-11-27-text-styles-design.md`

## Global Constraints
- Old drafts (no `bg`/`align`/`effect`) render as plain centred text with no box.
- No technical words on the easy screen. Labels: "Style", "None", "Solid", "See-through", "Left", "Centre", "Right", "Outline", "Shadow", "Neon".
- Title PNGs never appear in My media.
- Do not commit (user rule).

## Review Focus
1. Text that is only spaces or empty: no crash; an empty title exports as nothing.
2. Very long single line wider than the frame: renders (clipped) without errors in every engine.
3. A title whose `start` is after the video ends: skipped by every engine.
4. Glow/outline near the frame edge: the PNG keeps its margin so the effect is not cut off.
5. Undo of a Style change restores the previous look in one step.

---

### Task 1: Renderer + model
**Files:** `src/own/project.ts`, `src/own/compose.ts`
- [ ] Checks first (ui-check easy): Style sheet sets `bg`, `bgColor` (+ auto text contrast), `align`, `effect`; multi-line text via the text box. Run: FAIL.
- [ ] Add the optional fields; `layoutText`, `drawText`, `rasterizeText(o, W, H): Promise<{ blob, left, top, w, h } | null>`; `drawOverlays`/`overlayBox` use them.

### Task 2: Exports carry rasterised titles
**Files:** `src/own/exporters.ts`, `server/render-server.mjs`
- [ ] Checks first: server vs Mediabunny SSIM on a styled multi-line title ≥ 0.95; see-through box shows motion behind it, solid does not. Run: FAIL.
- [ ] `withRasterTitles(p, W, H)`; server uploads to `/api/render-asset/:name` (`out/render-assets/`, allowed in `resolve`, not listed).

### Task 3: Easy Style sheet, Advanced dropdowns, docs
**Files:** `src/own/easy/Sheets.tsx`, `Toolbars.tsx`, `EasyEditor.tsx`, `easy.css`, `src/own/editor.tsx`, `DEMO.md`, `CLAUDE.md`
- [ ] Advanced check first: Background dropdown sets `bg`. Run: FAIL. Implement. `npm run ui-check` all green; build passes.
