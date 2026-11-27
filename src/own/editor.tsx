/**
 * Candidate B: our own editor core.
 * No editor SDK. React + canvas for the UI, one JSON edit document, and three interchangeable exporters.
 * Covers every row of the v1 requirement table so the effort of owning it can be judged honestly.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { FONTS, fontOf, type FontId } from "../../shared/fonts";
import { fontFamily } from "./compose";
import { exportFfmpegWasm, exportMediabunny, exportServer, saveToLibrary, type ExportResult, type LibraryItem } from "./exporters";
import {
  audioLen, clampTrim, clipLen, clipStarts, emptyProject, fileLabel, frameSize, isPhoto, moveClip, newOverlayRange, PHOTO_MAX,
  splitAt, totalDuration, uid, type Aspect, type AudioClip, type Clip, type Overlay, type Project, type TextAlign, type TextBg, type TextEffect,
} from "./project";
import { cur, historyDepth, sampleProject, takeDroppedOnLoad, useHistory } from "./core/history";
import { usePreview } from "./core/player";
import { addMediaTo, importFiles, useLibrary, type Kind } from "./core/media";

const GROUPS: [LibraryItem["group"], string][] = [["export", "Your exports"], ["upload", "Your uploads"], ["sample", "Samples"]];

const fmt = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
/** ruler label spacing: the smallest step that leaves room for a label */
const rulerStep = (zoom: number) => [1, 2, 5, 10, 15, 30, 60, 120, 300].find((s) => s * zoom >= 44) ?? 600;
const rulerLabel = (s: number) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`);
const TEXT_INPUTS = ["text", "number", "search", "email", "url", "tel", "password"];
/** true while the user is typing in a field; sliders, checkboxes and colour pickers keep the shortcuts working */
const isTyping = (el: EventTarget | null) =>
  el instanceof HTMLElement &&
  ((el instanceof HTMLInputElement && TEXT_INPUTS.includes(el.type)) || ["SELECT", "TEXTAREA"].includes(el.tagName) || el.isContentEditable);

export function OwnEditor() {
  const h = useHistory();
  const p = h.project;
  const total = totalDuration(p);
  const empty = p.clips.length === 0;

  const [sel, setSel] = useState<{ type: "clip" | "overlay" | "audio"; id: string } | null>(null);
  const [zoom, setZoom] = useState(60); // px per second
  const [notice, setNotice] = useState<string | null>(() => {
    const n = takeDroppedOnLoad(); // said once, not on every return from another screen
    return n ? `${n} item(s) from an earlier session were removed: they were never uploaded and no longer exist.` : null;
  });

  // ------------------------------------------------------------------ preview
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { t, playing, setPlaying, seek, tRef, media } = usePreview(canvasRef, p);
  const [W, H] = frameSize(p.aspect, 720);

  // ------------------------------------------------------------------ library
  const { library, serverUp, refresh: refreshLibrary } = useLibrary();

  // ------------------------------------------------------------------ timeline zoom
  const scrollRef = useRef<HTMLDivElement>(null);
  const [fitTick, setFitTick] = useState(1); // bump to fit the whole edit into view after this render
  const requestFit = () => setFitTick((n) => n + 1);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !fitTick) return;
    const room = el.clientWidth - 64 - 12; // minus the track-label gutter
    setZoom(Math.max(4, Math.min(200, room / Math.max(totalDuration(cur()) + 2, 12))));
  }, [fitTick]);

  // drag the selected overlay around the preview (it keeps its offset from the pointer, so a click does not move it)
  const dragOverlay = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (sel?.type !== "overlay") return;
    const o = cur().overlays.find((x) => x.id === sel.id);
    if (!o) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const at = (ev: { clientX: number; clientY: number }) => [(ev.clientX - rect.left) / rect.width, (ev.clientY - rect.top) / rect.height] as const;
    const [px, py] = at(e);
    const [ox, oy] = [o.x - px, o.y - py];
    h.begin();
    const move = (ev: PointerEvent) => {
      const [mx, my] = at(ev);
      const x = Math.min(1, Math.max(0, mx + ox));
      const y = Math.min(1, Math.max(0, my + oy));
      h.apply({ ...cur(), overlays: cur().overlays.map((v) => (v.id === o.id ? { ...v, x, y } : v)) });
    };
    const up = () => (window.removeEventListener("pointermove", move), window.removeEventListener("pointerup", up));
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // ------------------------------------------------------------------ edit actions
  // live = part of a gesture started with h.begin(); otherwise a discrete edit with its own undo step
  const patchClip = (id: string, patch: Partial<Clip>, live = false) => {
    const next = { ...cur(), clips: cur().clips.map((c) => (c.id === id ? { ...c, ...patch } : c)) };
    live ? h.apply(next) : h.commit(next);
  };
  const trimTo = (c: Clip, patch: { in?: number; out?: number }, live = false) => patchClip(c.id, clampTrim(c, patch), live);
  const patchOverlay = (id: string, patch: Partial<Overlay>, live = false) => {
    const next = { ...cur(), overlays: cur().overlays.map((o) => (o.id === id ? ({ ...o, ...patch } as Overlay) : o)) };
    live ? h.apply(next) : h.commit(next);
  };
  const removeSelected = () => {
    if (!sel) return;
    const now = cur();
    if (sel.type === "clip") h.commit({ ...now, clips: now.clips.filter((c) => c.id !== sel.id) });
    if (sel.type === "overlay") h.commit({ ...now, overlays: now.overlays.filter((o) => o.id !== sel.id) });
    if (sel.type === "audio") h.commit({ ...now, audio: now.audio.filter((a) => a.id !== sel.id) });
    setSel(null);
  };

  /** Add a media item to the edit. `file` is the local file when the user just picked one (probed without a download). */
  const addMedia = async (src: string, name: string, kind: Kind, file?: Blob) => {
    const r = await addMediaTo(cur, { src, name, kind }, tRef.current, { overlayRange: "playhead3s", file });
    if (r.error) return setNotice(r.error);
    h.commit(r.project);
    if (r.select) setSel(r.select);
    if (kind === "video") {
      seek(r.at ?? 0);
      requestFit();
    }
    setNotice(null);
  };

  const [importing, setImporting] = useState(false);
  const onFiles = async (files: FileList | null) => {
    const list = Array.from(files ?? []);
    if (!list.length) return;
    setImporting(true);
    try {
      await importFiles(list, (src, name, kind, file) => addMedia(src, name, kind, file), setNotice);
    } catch (e) {
      setNotice(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setImporting(false);
      void refreshLibrary();
    }
  };
  const addText = () => {
    const o: Overlay = { id: uid(), kind: "text", text: "New title", fontSize: 40, color: "#FFFFFF", font: "jakarta", x: 0.5, y: 0.5, ...newOverlayRange(cur(), tRef.current) };
    h.commit({ ...cur(), overlays: [...cur().overlays, o] });
    setSel({ type: "overlay", id: o.id });
  };
  const newProject = () => {
    setPlaying(false);
    h.commit(emptyProject(cur().aspect));
    setSel(null);
    seek(0);
    requestFit();
    setNotice(null);
  };
  const loadSample = () => {
    setPlaying(false);
    h.commit(sampleProject());
    setSel(null);
    seek(0);
    requestFit();
    setNotice(null);
  };

  // keyboard: space, S, Delete, Ctrl+Z / Ctrl+Shift+Z (ignored while typing in any field)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      if (e.code === "Space") {
        e.preventDefault();
        // a focused button would also be clicked by this Space press
        if (e.target instanceof HTMLElement && e.target !== document.body) e.target.blur();
        setPlaying((v) => !v);
      }
      else if (e.key.toLowerCase() === "z" && (e.ctrlKey || e.metaKey)) (e.preventDefault(), e.shiftKey ? h.redo() : h.undo());
      else if (e.ctrlKey || e.metaKey || e.altKey) return;
      else if (e.key.toLowerCase() === "s") h.commit(splitAt(cur(), tRef.current));
      else if (e.key === "Delete" || e.key === "Backspace") (e.preventDefault(), removeSelected());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ------------------------------------------------------------------ timeline dragging
  const starts = clipStarts(p);
  /** snap a timeline time to the playhead, clip boundaries, then a 0.1 s grid */
  const snap = (time: number) => {
    const tol = 8 / zoom;
    const points = [tRef.current, 0, totalDuration(cur()), ...clipStarts(cur())];
    for (const pt of points) if (Math.abs(pt - time) < tol) return pt;
    return Math.round(time * 10) / 10;
  };
  const drag = (e: React.PointerEvent, onMove: (dxSeconds: number, ev: PointerEvent) => void, onEnd?: (ev: PointerEvent) => void) => {
    e.stopPropagation();
    e.preventDefault();
    const x0 = e.clientX;
    h.begin();
    const move = (ev: PointerEvent) => onMove((ev.clientX - x0) / zoom, ev);
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      onEnd?.(ev);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const trackRef = useRef<HTMLDivElement>(null);
  const timeAtPointer = (clientX: number) => (clientX - (trackRef.current?.getBoundingClientRect().left ?? 0)) / zoom;

  const trimClip = (e: React.PointerEvent, c: Clip, i: number, edge: "in" | "out") => {
    setSel({ type: "clip", id: c.id });
    const start = starts[i] ?? 0;
    drag(e, (dx) => {
      if (edge === "out") trimTo(c, { out: c.in + (snap(start + clipLen(c) + dx) - start) }, true);
      else trimTo(c, { in: Math.round((c.in + dx) * 10) / 10 }, true);
    });
  };
  const reorderClip = (e: React.PointerEvent, i: number) => {
    setSel({ type: "clip", id: p.clips[i]!.id });
    drag(e, () => undefined, (ev) => {
      if (Math.abs(ev.clientX - e.clientX) < 6) return;
      const at = timeAtPointer(ev.clientX);
      const now = cur();
      const st = clipStarts(now);
      let to = now.clips.findIndex((c, k) => at < (st[k] ?? 0) + clipLen(c) / 2);
      if (to === -1) to = now.clips.length;
      if (to > i) to -= 1;
      if (to !== i) h.apply(moveClip(now, i, to));
    });
  };
  const moveOverlay = (e: React.PointerEvent, o: Overlay, mode: "move" | "start" | "end") => {
    setSel({ type: "overlay", id: o.id });
    drag(e, (dx) => {
      const len = o.end - o.start;
      if (mode === "move") {
        const s = Math.max(0, snap(o.start + dx));
        patchOverlay(o.id, { start: s, end: s + len }, true);
      } else if (mode === "start") patchOverlay(o.id, { start: Math.min(o.end - 0.2, Math.max(0, snap(o.start + dx))) }, true);
      else patchOverlay(o.id, { end: Math.max(o.start + 0.2, snap(o.end + dx)) }, true);
    });
  };
  const patchAudio = (id: string, patch: Partial<AudioClip>, live = false) => {
    const next = { ...cur(), audio: cur().audio.map((a) => (a.id === id ? { ...a, ...patch } : a)) };
    live ? h.apply(next) : h.commit(next);
  };
  /** music piece: drag to move; drag an edge to keep less or more of the song (the start edge moves start and song together) */
  const moveAudio = (e: React.PointerEvent, a: AudioClip, mode: "move" | "start" | "end") => {
    setSel({ type: "audio", id: a.id });
    drag(e, (dx) => {
      if (mode === "move") patchAudio(a.id, { start: Math.max(0, snap(a.start + dx)) }, true);
      else if (mode === "end") {
        const end = snap(a.start + audioLen(a) + dx);
        patchAudio(a.id, { out: Math.min(a.srcDuration, Math.max(a.in + 0.2, a.in + (end - a.start))) }, true);
      } else {
        const d = Math.min(audioLen(a) - 0.2, Math.max(-a.in, -a.start, snap(a.start + dx) - a.start));
        patchAudio(a.id, { start: +(a.start + d).toFixed(3), in: +(a.in + d).toFixed(3) }, true);
      }
    });
  };
  const scrub = (e: React.PointerEvent) => {
    seek(timeAtPointer(e.clientX));
    const move = (ev: PointerEvent) => seek(timeAtPointer(ev.clientX));
    const up = () => (window.removeEventListener("pointermove", move), window.removeEventListener("pointerup", up));
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // ------------------------------------------------------------------ export
  const [res, setRes] = useState<720 | 1080>(720);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [results, setResults] = useState<(ExportResult | { engine: string; error: string })[]>([]);
  const [saved, setSaved] = useState<Record<number, string>>({});
  const [lastUrl, setLastUrl] = useState<string | null>(null);
  const engines = { mediabunny: exportMediabunny, wasm: exportFfmpegWasm, server: exportServer } as const;
  const runExport = async (key: keyof typeof engines) => {
    setPlaying(false);
    setBusy(key);
    setProgress(0);
    try {
      const r = await engines[key](cur(), res, setProgress);
      setResults((prev) => [...prev, r]);
      setLastUrl(r.url);
      return r;
    } catch (e) {
      const err = { engine: key, error: e instanceof Error ? e.message : String(e) };
      setResults((prev) => [...prev, err]);
      return err;
    } finally {
      setBusy(null);
    }
  };
  const save = async (r: ExportResult, i: number) => {
    setSaved((s) => ({ ...s, [i]: "Saving..." }));
    try {
      const stampNow = new Date().toTimeString().slice(0, 8).replace(/:/g, "");
      const item = await saveToLibrary(r, `edit_${r.width}x${r.height}_${stampNow}.mp4`);
      setSaved((s) => ({ ...s, [i]: `Saved as ${item.name}` }));
      void refreshLibrary();
    } catch (e) {
      setSaved((s) => ({ ...s, [i]: `Save failed: ${e instanceof Error ? e.message : e}` }));
    }
  };

  // hook for automated checks from the browser console
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__poc = {
      getProject: () => cur(),
      setProject: (next: Project) => h.commit(next),
      run: runExport,
      save: (i: number) => {
        const r = results[i];
        return r && !("error" in r) ? save(r, i) : Promise.reject(new Error("no export at " + i));
      },
      results: () => results,
      library: () => library,
      newProject,
      loadSample,
      seek,
      split: () => h.commit(splitAt(cur(), tRef.current)),
      undo: h.undo,
      redo: h.redo,
      canUndo: historyDepth,
      zoom: () => zoom,
      media,
    };
  });

  const selClip = sel?.type === "clip" ? p.clips.find((c) => c.id === sel.id) : undefined;
  const selOverlay = sel?.type === "overlay" ? p.overlays.find((o) => o.id === sel.id) : undefined;
  const selAudio = sel?.type === "audio" ? p.audio.find((a) => a.id === sel.id) : undefined;
  // music pieces may overlap (they mix): overlapping ones get their own lane
  const audioLane: number[] = [];
  const audioEnds: number[] = [];
  for (const a of p.audio) {
    let lane = audioEnds.findIndex((end) => end <= a.start + 0.001);
    if (lane === -1) lane = audioEnds.length;
    audioEnds[lane] = a.start + audioLen(a);
    audioLane.push(lane);
  }
  const width = Math.max(total + 2, 12) * zoom;
  const step = rulerStep(zoom);
  // overlays that overlap in time get their own lane so none hides another
  const lanes: number[] = [];
  const laneEnds: number[] = [];
  for (const o of p.overlays) {
    let lane = laneEnds.findIndex((end) => end <= o.start);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = o.end;
    lanes.push(lane);
  }
  const laneCount = Math.max(1, laneEnds.length);
  const overlayLabel = (o: Overlay) => (o.kind === "text" ? o.text : o.name ?? fileLabel(o.src));
  // gesture props for an inspector field: one undo step per focus or drag, not per keystroke or slider tick
  const gesture = { onFocus: h.begin, onPointerDown: h.begin };

  return (
    <div className="own">
      <div className="bar">
        <button onClick={() => setPlaying((v) => !v)} disabled={empty}>{playing ? "Pause" : "Play"}</button>
        <span className="time">{fmt(t)} / {fmt(total)}</span>
        <button onClick={() => h.commit(splitAt(p, t))} disabled={empty} title="S">Split at playhead</button>
        <button onClick={removeSelected} disabled={!sel}>Delete</button>
        <button onClick={h.undo} disabled={!h.canUndo} title="Ctrl/Cmd+Z">Undo</button>
        <button onClick={h.redo} disabled={!h.canRedo} title="Ctrl/Cmd+Shift+Z">Redo</button>
        <span className="sep" />
        <label>Aspect{" "}
          <select value={p.aspect} onChange={(e) => h.commit({ ...p, aspect: e.target.value as Aspect })}>
            <option>16:9</option><option>9:16</option><option>1:1</option>
          </select>
        </label>
        <button onClick={addText} disabled={empty}>+ Text</button>
        <label className={`file ${importing ? "busy" : ""}`}>{importing ? "Uploading..." : "Import files"}
          <input type="file" multiple disabled={importing} accept="video/mp4,video/quicktime,video/webm,image/*,audio/*" onChange={(e) => (void onFiles(e.target.files), (e.target.value = ""))} />
        </label>
        <span className="sep" />
        <button onClick={newProject} title="Start from an empty timeline (undoable)">New project</button>
        <button onClick={loadSample} title="Load the sample edit used in the demo (undoable)">Load sample</button>
        <span className="saved">{h.savedAt ? `Draft saved ${h.savedAt}` : "Not saved yet"}</span>
      </div>
      {notice && <div className="notice">{notice} <button className="link" onClick={() => setNotice(null)}>Dismiss</button></div>}

      <div className="stage">
        <aside className="panel">
          <h4>Library</h4>
          {!serverUp && <p className="hint warn">Render server not running: showing samples only. Start it with <code>npm run server</code>.</p>}
          <div className="lib-list">
            {GROUPS.map(([g, title]) => {
              const items = library.filter((m) => m.group === g);
              if (!items.length) return null;
              return (
                <div key={g}>
                  <p className="lib-group">{title}</p>
                  {items.map((m) => (
                    <button key={m.src} className="lib" title={`Add ${m.name} to the edit`} onClick={() => void addMedia(m.src, m.name, m.kind).catch((e) => setNotice(`${m.name}: ${e instanceof Error ? e.message : e}`))}>
                      <span className={`tag ${m.kind}`}>{m.kind}</span> {m.name}
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
          <p className="hint">Stand-in for the platform Library. Click to add to the edit.</p>
        </aside>

        <div className="preview">
          <canvas ref={canvasRef} width={W} height={H} onPointerDown={dragOverlay} style={{ aspectRatio: `${W} / ${H}`, cursor: selOverlay ? "move" : "default" }} />
        </div>

        <aside className="panel">
          <h4>Inspector</h4>
          {selClip && (
            <div className="form">
              <b title={selClip.name}>{selClip.name}</b>
              {isPhoto(selClip) ? (
                <label>Photo shown for (s)<input type="number" step="0.5" min={0.5} max={PHOTO_MAX} value={Number(clipLen(selClip).toFixed(2))} {...gesture} onChange={(e) => trimTo(selClip, { in: 0, out: e.target.valueAsNumber }, true)} /></label>
              ) : (
                <>
                  <span className="hint">Source {selClip.srcDuration.toFixed(1)} s, using {clipLen(selClip).toFixed(1)} s</span>
                  <label>Trim in (s)<input type="number" step="0.1" min={0} max={selClip.out - 0.2} value={Number(selClip.in.toFixed(2))} {...gesture} onChange={(e) => trimTo(selClip, { in: e.target.valueAsNumber }, true)} /></label>
                  <label>Trim out (s)<input type="number" step="0.1" min={selClip.in + 0.2} max={selClip.srcDuration} value={Number(selClip.out.toFixed(2))} {...gesture} onChange={(e) => trimTo(selClip, { out: e.target.valueAsNumber }, true)} /></label>
                  <label className="row"><input type="checkbox" checked={selClip.muted} onChange={(e) => patchClip(selClip.id, { muted: e.target.checked })} /> Mute original sound</label>
                </>
              )}
            </div>
          )}
          {selOverlay?.kind === "text" && (
            <div className="form">
              <label>Text<textarea rows={2} value={selOverlay.text} {...gesture} onChange={(e) => patchOverlay(selOverlay.id, { text: e.target.value }, true)} /></label>
              <label>Font
                <select value={fontOf(selOverlay.font)} onChange={(e) => patchOverlay(selOverlay.id, { font: e.target.value as FontId })} style={{ fontFamily: `"${fontFamily(fontOf(selOverlay.font))}"` }}>
                  {(Object.keys(FONTS) as FontId[]).map((id) => (
                    <option key={id} value={id} style={{ fontFamily: `"${fontFamily(id)}"` }}>{FONTS[id].label}</option>
                  ))}
                </select>
              </label>
              <label>Size {selOverlay.fontSize}<input type="range" min={16} max={120} value={selOverlay.fontSize} {...gesture} onChange={(e) => patchOverlay(selOverlay.id, { fontSize: Number(e.target.value) }, true)} /></label>
              <label>Colour<input type="color" value={selOverlay.color} {...gesture} onChange={(e) => patchOverlay(selOverlay.id, { color: e.target.value.toUpperCase() }, true)} /></label>
              <label>Background
                <select aria-label="Background" value={selOverlay.bg ?? "none"} onChange={(e) => patchOverlay(selOverlay.id, { bg: e.target.value as TextBg, bgColor: selOverlay.bgColor ?? "#000000" })}>
                  <option value="none">None</option><option value="solid">Solid box</option><option value="soft">See-through box</option>
                </select>
              </label>
              {(selOverlay.bg ?? "none") !== "none" && (
                <label>Box colour<input type="color" value={selOverlay.bgColor ?? "#000000"} {...gesture} onChange={(e) => patchOverlay(selOverlay.id, { bgColor: e.target.value.toUpperCase() }, true)} /></label>
              )}
              <label>Align
                <select aria-label="Align" value={selOverlay.align ?? "center"} onChange={(e) => patchOverlay(selOverlay.id, { align: e.target.value as TextAlign })}>
                  <option value="left">Left</option><option value="center">Centre</option><option value="right">Right</option>
                </select>
              </label>
              <label>Effect
                <select aria-label="Effect" value={selOverlay.effect ?? "none"} onChange={(e) => patchOverlay(selOverlay.id, { effect: e.target.value as TextEffect })}>
                  <option value="none">None</option><option value="outline">Outline</option><option value="shadow">Shadow</option><option value="neon">Neon glow</option>
                </select>
              </label>
              <p className="hint">Drag on the preview to position. Drag the bar on the timeline to change when it shows.</p>
            </div>
          )}
          {selOverlay?.kind === "image" && (
            <div className="form">
              <b title={overlayLabel(selOverlay)}>{overlayLabel(selOverlay)}</b>
              <label>Width {Math.round(selOverlay.width * 100)}%<input type="range" min={0.05} max={1} step={0.01} value={selOverlay.width} {...gesture} onChange={(e) => patchOverlay(selOverlay.id, { width: Number(e.target.value) }, true)} /></label>
              <p className="hint">Drag on the preview to position. Drag the bar on the timeline to change when it shows.</p>
            </div>
          )}
          {selAudio && (
            <div className="form">
              <b title={selAudio.name}>{selAudio.name}</b>
              <span className="hint">Plays {audioLen(selAudio).toFixed(1)} s of the song from {selAudio.in.toFixed(1)} s, starting at {selAudio.start.toFixed(1)} s</span>
              <label>Volume {Math.round(selAudio.volume * 100)}%<input type="range" min={0} max={1} step={0.05} value={selAudio.volume} {...gesture} onChange={(e) => patchAudio(selAudio.id, { volume: Number(e.target.value) }, true)} /></label>
              <button onClick={removeSelected}>Remove this music</button>
            </div>
          )}
          {!selClip && !selOverlay && !selAudio && <p className="hint">Select a clip, overlay or music on the timeline.</p>}
          <h4>Audio</h4>
          <div className="form">
            <label>Original sound {Math.round(p.originalVolume * 100)}%<input type="range" min={0} max={1} step={0.05} value={p.originalVolume} {...gesture} onChange={(e) => h.apply({ ...cur(), originalVolume: Number(e.target.value) })} /></label>
            <p className="hint">
              {p.audio.length ? `${p.audio.length} music piece(s). Select one on the timeline to change it; drag to move, drag an edge to trim.` : "No music. Add an audio file from the Library or import one."}
            </p>
          </div>
        </aside>
      </div>

      <div className="tl-head">
        <span>Timeline</span>
        <label>Zoom <input type="range" min={4} max={200} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} /></label>
        <button onClick={requestFit} title="Fit the whole edit in view">Fit</button>
        <span className="hint">Drag clip edges to trim, drag a clip to reorder, edges snap to the playhead.</span>
      </div>
      <div className="tl-scroll" ref={scrollRef}>
        <div className="tl" style={{ width }} ref={trackRef}>
          <div className="ruler" onPointerDown={scrub}>
            {Array.from({ length: Math.ceil(width / zoom / step) }, (_, k) => (
              <span key={k} style={{ left: k * step * zoom }}>{rulerLabel(k * step)}</span>
            ))}
          </div>
          <div className="track" data-label="Video">
            {empty && <span className="track-empty">No clips yet: import a video or pick one from the Library.</span>}
            {p.clips.map((c, i) => (
              <div key={c.id} data-id={c.id} title={c.name} className={`clip video ${sel?.id === c.id ? "sel" : ""}`} style={{ left: (starts[i] ?? 0) * zoom, width: clipLen(c) * zoom }} onPointerDown={(e) => reorderClip(e, i)}>
                <i className="h l" onPointerDown={(e) => trimClip(e, c, i, "in")} />
                <span>{isPhoto(c) ? "(photo) " : c.muted ? "(muted) " : ""}{c.name}</span>
                <i className="h r" onPointerDown={(e) => trimClip(e, c, i, "out")} />
              </div>
            ))}
          </div>
          <div className="track" data-label="Overlay" style={{ height: 6 + laneCount * 34 }}>
            {p.overlays.map((o, i) => (
              <div key={o.id} data-id={o.id} title={overlayLabel(o)} className={`clip ${o.kind} ${sel?.id === o.id ? "sel" : ""}`} style={{ left: o.start * zoom, width: (o.end - o.start) * zoom, top: 5 + (lanes[i] ?? 0) * 34 }} onPointerDown={(e) => moveOverlay(e, o, "move")}>
                <i className="h l" onPointerDown={(e) => moveOverlay(e, o, "start")} />
                {o.kind === "image" && <img className="thumb" src={o.src} alt="" draggable={false} />}
                <span style={o.kind === "text" ? { fontFamily: `"${fontFamily(fontOf(o.font))}"` } : undefined}>{overlayLabel(o)}</span>
                <i className="h r" onPointerDown={(e) => moveOverlay(e, o, "end")} />
              </div>
            ))}
          </div>
          <div className="track" data-label="Audio" style={{ height: 6 + Math.max(1, audioEnds.length) * 34 }}>
            {p.audio.map((a, i) => (
              <div key={a.id} data-id={a.id} title={a.name} className={`clip audio ${sel?.id === a.id ? "sel" : ""}`} style={{ left: a.start * zoom, width: Math.max(6, audioLen(a) * zoom), top: 5 + (audioLane[i] ?? 0) * 34 }} onPointerDown={(e) => moveAudio(e, a, "move")}>
                <i className="h l" onPointerDown={(e) => moveAudio(e, a, "start")} />
                <span>{a.name} ({Math.round(a.volume * 100)}%)</span>
                <i className="h r" onPointerDown={(e) => moveAudio(e, a, "end")} />
              </div>
            ))}
          </div>
          <div className="playhead" style={{ left: t * zoom }} />
        </div>
      </div>

      <div className="export">
        <h4>Export</h4>
        <label>Resolution{" "}
          <select value={res} onChange={(e) => setRes(Number(e.target.value) as 720 | 1080)}>
            <option value={720}>720p</option><option value={1080}>1080p</option>
          </select>
        </label>
        <button className="primary" disabled={!!busy || empty} onClick={() => void runExport("server")}>Export (server FFmpeg)</button>
        <button disabled={!!busy || empty} onClick={() => void runExport("mediabunny")}>Fast browser export (Mediabunny)</button>
        <button disabled={!!busy || empty} onClick={() => void runExport("wasm")}>Browser fallback (ffmpeg.wasm)</button>
        {busy && <span className="prog">{busy} {Math.round(progress * 100)}%<progress value={progress} max={1} /></span>}
        {empty && <span className="hint">Add a video to export.</span>}
      </div>
      {results.length > 0 && (
        <div className="results">
          <table>
            <thead><tr><th>Engine</th><th>Output</th><th>Time</th><th>Speed</th><th>Size</th><th /></tr></thead>
            <tbody>
              {results.map((r, i) => "error" in r ? (
                <tr key={i} className="err"><td>{r.engine}</td><td colSpan={5}>{r.error}</td></tr>
              ) : (
                <tr key={i}>
                  <td>{r.engine}</td><td>{r.width}x{r.height}, {r.duration.toFixed(1)} s</td><td>{(r.ms / 1000).toFixed(2)} s</td>
                  <td>{(r.duration / (r.ms / 1000)).toFixed(1)}x realtime</td><td>{(r.bytes / 1024 / 1024).toFixed(2)} MB</td>
                  <td className="actions">
                    <button onClick={() => setLastUrl(r.url)}>Play</button>
                    <a href={r.url} download={`export-${i}.mp4`}>Download</a>
                    {saved[i] ? <span className="hint">{saved[i]}</span> : <button disabled={!serverUp} onClick={() => void save(r, i)}>Save to library</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {lastUrl && <video key={lastUrl} src={lastUrl} controls className="result-video" />}
        </div>
      )}
    </div>
  );
}
