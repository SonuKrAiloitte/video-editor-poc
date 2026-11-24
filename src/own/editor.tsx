/**
 * Candidate B: our own editor core.
 * No editor SDK. React + canvas for the UI, one JSON edit document, and three interchangeable exporters.
 * Covers every row of the v1 requirement table so the effort of owning it can be judged honestly.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ALL_FORMATS, BlobSource, Input } from "mediabunny";
import sample from "../../shared/sample-project.json";
import { drawCover, drawOverlays, loadImage, preloadOverlayAssets } from "./compose";
import { blobNames, exportFfmpegWasm, exportMediabunny, exportServer, type ExportResult } from "./exporters";
import {
  clipAt, clipLen, clipStarts, frameSize, moveClip, splitAt, totalDuration, uid,
  type Aspect, type Clip, type Overlay, type Project,
} from "./project";

const STORAGE_KEY = "poc-own-editor-draft-v1";
const LIBRARY = [
  { name: "clipA_h264_16x9.mp4", kind: "video" },
  { name: "clipB_h264_9x16.mp4", kind: "video" },
  { name: "clipC_vp9.webm", kind: "video" },
  { name: "clipD_hevc.mov", kind: "video" },
  { name: "music.mp3", kind: "audio" },
  { name: "logo.png", kind: "image" },
] as const;

const loadDraft = (): Project => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as Project;
  } catch {
    /* storage unavailable: fall through to the sample */
  }
  return sample as Project;
};

/** Undo / redo: the edit is immutable JSON, so history is just a stack of previous documents. */
function useHistory() {
  const [project, setProject] = useState<Project>(loadDraft);
  const past = useRef<Project[]>([]);
  const future = useRef<Project[]>([]);
  const [, bump] = useState(0);
  const current = useRef(project);
  current.current = project;

  const checkpoint = useCallback(() => {
    past.current.push(current.current);
    if (past.current.length > 100) past.current.shift();
    future.current = [];
    bump((n) => n + 1);
  }, []);
  const apply = useCallback((next: Project) => setProject(next), []);
  const commit = useCallback((next: Project) => (checkpoint(), setProject(next)), [checkpoint]);
  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push(current.current);
    setProject(prev);
  }, []);
  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(current.current);
    setProject(next);
  }, []);

  // autosave: debounce, then write the JSON
  const [savedAt, setSavedAt] = useState<string | null>(null);
  useEffect(() => {
    const id = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
        setSavedAt(new Date().toLocaleTimeString());
      } catch {
        /* ignore */
      }
    }, 400);
    return () => clearTimeout(id);
  }, [project]);

  return { project, checkpoint, apply, commit, undo, redo, canUndo: past.current.length > 0, canRedo: future.current.length > 0, savedAt };
}

async function probe(blob: Blob) {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  const video = await input.getPrimaryVideoTrack();
  const audio = await input.getPrimaryAudioTrack();
  return {
    duration: await input.computeDuration(),
    hasAudio: !!audio,
    channels: audio?.numberOfChannels,
    codec: video?.codec ?? null,
    decodable: video ? await video.canDecode() : false,
  };
}

const fmt = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;

export function OwnEditor() {
  const h = useHistory();
  const p = h.project;
  const total = totalDuration(p);

  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [sel, setSel] = useState<{ type: "clip" | "overlay"; id: string } | null>(null);
  const [zoom, setZoom] = useState(60); // px per second
  const [notice, setNotice] = useState<string | null>(null);

  const tRef = useRef(0);
  const playRef = useRef(false);
  const pRef = useRef(p);
  pRef.current = p;
  playRef.current = playing;

  const seek = useCallback((next: number) => {
    tRef.current = Math.max(0, Math.min(totalDuration(pRef.current), next));
    setT(tRef.current);
  }, []);

  // ------------------------------------------------------------------ preview
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videos = useRef(new Map<string, HTMLVideoElement>());
  const musicEl = useRef<HTMLAudioElement | null>(null);
  const [W, H] = frameSize(p.aspect, 720);

  useEffect(() => void preloadOverlayAssets(p), [p]);

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      // cap the step: if the browser stalls frames (background tab), playback waits instead of jumping ahead
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const proj = pRef.current;
      const dur = totalDuration(proj);
      if (playRef.current) {
        tRef.current = Math.min(dur, tRef.current + dt);
        setT(tRef.current);
        if (tRef.current >= dur) setPlaying(false);
      } else if (tRef.current > dur) {
        // a trim or delete shortened the video: keep the playhead inside it
        tRef.current = dur;
        setT(dur);
      }
      const time = tRef.current;
      const hit = clipAt(proj, Math.min(time, Math.max(0, dur - 0.001)));

      // one <video> per source file; only the clip under the playhead plays
      for (const c of proj.clips) {
        if (videos.current.has(c.src)) continue;
        const v = document.createElement("video");
        v.src = c.src;
        v.preload = "auto";
        v.playsInline = true;
        videos.current.set(c.src, v);
      }
      let active: HTMLVideoElement | null = null;
      for (const [src, v] of videos.current) {
        if (hit && src === hit.clip.src) {
          active = v;
          const target = hit.clip.in + (time - hit.start);
          v.volume = hit.clip.muted ? 0 : Math.min(1, proj.originalVolume);
          if (playRef.current) {
            if (v.paused) {
              v.currentTime = target;
              void v.play().catch(() => undefined);
            } else if (Math.abs(v.currentTime - target) > 0.25) v.currentTime = target;
          } else {
            if (!v.paused) v.pause();
            if (!v.seeking && Math.abs(v.currentTime - target) > 0.03) v.currentTime = target;
          }
        } else if (!v.paused) v.pause();
      }
      if (proj.music) {
        const a = (musicEl.current ??= new Audio());
        if (!a.src.endsWith(proj.music.src)) a.src = proj.music.src;
        a.volume = Math.min(1, proj.music.volume);
        if (playRef.current) {
          if (a.paused) {
            a.currentTime = time;
            void a.play().catch(() => undefined);
          } else if (Math.abs(a.currentTime - time) > 0.3) a.currentTime = time;
        } else if (!a.paused) a.pause();
      } else musicEl.current?.pause();

      const cv = canvasRef.current;
      const ctx = cv?.getContext("2d");
      if (cv && ctx) {
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, cv.width, cv.height);
        if (active && active.readyState >= 2) drawCover(ctx, active, active.videoWidth, active.videoHeight, cv.width, cv.height);
        drawOverlays(ctx, proj, time, cv.width, cv.height);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      for (const v of videos.current.values()) v.pause();
      musicEl.current?.pause();
    };
  }, []);

  // drag the selected overlay around the preview
  const dragOverlay = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (sel?.type !== "overlay") return;
    const rect = e.currentTarget.getBoundingClientRect();
    const id = sel.id;
    h.checkpoint();
    const move = (ev: PointerEvent) => {
      const x = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
      const y = Math.min(1, Math.max(0, (ev.clientY - rect.top) / rect.height));
      h.apply({ ...pRef.current, overlays: pRef.current.overlays.map((o) => (o.id === id ? { ...o, x, y } : o)) });
    };
    move(e.nativeEvent);
    const up = () => (window.removeEventListener("pointermove", move), window.removeEventListener("pointerup", up));
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // ------------------------------------------------------------------ edit actions
  const patchClip = (id: string, patch: Partial<Clip>, live = false) => {
    const next = { ...pRef.current, clips: pRef.current.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)) };
    live ? h.apply(next) : h.commit(next);
  };
  const patchOverlay = (id: string, patch: Partial<Overlay>, live = false) => {
    const next = { ...pRef.current, overlays: pRef.current.overlays.map((o) => (o.id === id ? ({ ...o, ...patch } as Overlay) : o)) };
    live ? h.apply(next) : h.commit(next);
  };
  const removeSelected = () => {
    if (!sel) return;
    if (sel.type === "clip" && p.clips.length > 1) h.commit({ ...p, clips: p.clips.filter((c) => c.id !== sel.id) });
    if (sel.type === "overlay") h.commit({ ...p, overlays: p.overlays.filter((o) => o.id !== sel.id) });
    setSel(null);
  };

  const addMedia = async (src: string, name: string, kind: "video" | "audio" | "image") => {
    if (kind === "video") {
      const info = await probe(await (await fetch(src)).blob());
      if (!info.decodable) {
        setNotice(`${name}: this browser cannot decode ${info.codec ?? "the video"}. Server export can still read it; in production we transcode on upload.`);
        return;
      }
      h.commit({ ...pRef.current, clips: [...pRef.current.clips, { id: uid(), name, src, in: 0, out: info.duration, srcDuration: info.duration, muted: false, hasAudio: info.hasAudio, channels: info.channels }] });
    } else if (kind === "audio") {
      const info = await probe(await (await fetch(src)).blob());
      h.commit({ ...pRef.current, music: { src, name, volume: 0.4, channels: info.channels } });
    } else {
      await loadImage(src);
      const o: Overlay = { id: uid(), kind: "image", src, width: 0.25, x: 0.5, y: 0.5, start: 0, end: totalDuration(pRef.current) };
      h.commit({ ...pRef.current, overlays: [...pRef.current.overlays, o] });
      setSel({ type: "overlay", id: o.id });
    }
    setNotice(null);
  };
  const onFiles = async (files: FileList | null) => {
    for (const f of Array.from(files ?? [])) {
      const url = URL.createObjectURL(f);
      blobNames.set(url, f.name);
      await addMedia(url, f.name, f.type.startsWith("video") ? "video" : f.type.startsWith("audio") ? "audio" : "image");
    }
  };
  const addText = () => {
    const o: Overlay = { id: uid(), kind: "text", text: "New title", fontSize: 40, color: "#FFFFFF", x: 0.5, y: 0.5, start: t, end: Math.min(total, t + 3) };
    h.commit({ ...p, overlays: [...p.overlays, o] });
    setSel({ type: "overlay", id: o.id });
  };

  // keyboard: space, S, Delete, Ctrl+Z / Ctrl+Shift+Z
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === "INPUT") return;
      if (e.code === "Space") (e.preventDefault(), setPlaying((v) => !v));
      else if (e.key.toLowerCase() === "s") h.commit(splitAt(pRef.current, tRef.current));
      else if (e.key === "Delete" || e.key === "Backspace") removeSelected();
      else if (e.key.toLowerCase() === "z" && (e.ctrlKey || e.metaKey)) (e.preventDefault(), e.shiftKey ? h.redo() : h.undo());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ------------------------------------------------------------------ timeline dragging
  const starts = clipStarts(p);
  /** snap a timeline time to the playhead, clip boundaries, then a 0.1 s grid */
  const snap = (time: number) => {
    const tol = 8 / zoom;
    const points = [tRef.current, 0, totalDuration(pRef.current), ...clipStarts(pRef.current)];
    for (const pt of points) if (Math.abs(pt - time) < tol) return pt;
    return Math.round(time * 10) / 10;
  };
  const drag = (e: React.PointerEvent, onMove: (dxSeconds: number, ev: PointerEvent) => void, onEnd?: (ev: PointerEvent) => void) => {
    e.stopPropagation();
    e.preventDefault();
    const x0 = e.clientX;
    h.checkpoint();
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
    const start = starts[i] ?? 0;
    drag(e, (dx) => {
      if (edge === "out") {
        const end = snap(start + clipLen(c) + dx);
        patchClip(c.id, { out: Math.min(c.srcDuration, Math.max(c.in + 0.2, c.in + (end - start))) }, true);
      } else {
        patchClip(c.id, { in: Math.min(c.out - 0.2, Math.max(0, Math.round((c.in + dx) * 10) / 10)) }, true);
      }
    });
  };
  const reorderClip = (e: React.PointerEvent, i: number) => {
    setSel({ type: "clip", id: p.clips[i]!.id });
    drag(e, () => undefined, (ev) => {
      if (Math.abs(ev.clientX - e.clientX) < 6) return;
      const at = timeAtPointer(ev.clientX);
      const cur = pRef.current;
      const st = clipStarts(cur);
      let to = cur.clips.findIndex((c, k) => at < (st[k] ?? 0) + clipLen(c) / 2);
      if (to === -1) to = cur.clips.length;
      if (to > i) to -= 1;
      if (to !== i) h.apply(moveClip(cur, i, to));
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
  const [lastUrl, setLastUrl] = useState<string | null>(null);
  const engines = { mediabunny: exportMediabunny, wasm: exportFfmpegWasm, server: exportServer } as const;
  const runExport = async (key: keyof typeof engines) => {
    setPlaying(false);
    setBusy(key);
    setProgress(0);
    try {
      const r = await engines[key](pRef.current, res, setProgress);
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

  // hook for automated checks from the browser console
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__poc = {
      getProject: () => pRef.current,
      setProject: (next: Project) => h.commit(next),
      run: runExport,
      seek,
      split: () => h.commit(splitAt(pRef.current, tRef.current)),
      undo: h.undo,
      redo: h.redo,
      // state of the real media elements behind the preview, for checks
      media: () => ({
        videos: [...videos.current].map(([src, v]) => ({ src: src.split("/").pop(), paused: v.paused, t: +v.currentTime.toFixed(2), volume: v.volume })),
        music: musicEl.current ? { paused: musicEl.current.paused, t: +musicEl.current.currentTime.toFixed(2), volume: musicEl.current.volume } : null,
      }),
    };
  });

  const selClip = sel?.type === "clip" ? p.clips.find((c) => c.id === sel.id) : undefined;
  const selOverlay = sel?.type === "overlay" ? p.overlays.find((o) => o.id === sel.id) : undefined;
  const width = Math.max(total + 2, 12) * zoom;
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

  return (
    <div className="own">
      <div className="bar">
        <button onClick={() => setPlaying((v) => !v)}>{playing ? "Pause" : "Play"}</button>
        <span className="time">{fmt(t)} / {fmt(total)}</span>
        <button onClick={() => h.commit(splitAt(p, t))} title="S">Split at playhead</button>
        <button onClick={removeSelected} disabled={!sel}>Delete</button>
        <button onClick={h.undo} disabled={!h.canUndo}>Undo</button>
        <button onClick={h.redo} disabled={!h.canRedo}>Redo</button>
        <span className="sep" />
        <label>Aspect{" "}
          <select value={p.aspect} onChange={(e) => h.commit({ ...p, aspect: e.target.value as Aspect })}>
            <option>16:9</option><option>9:16</option><option>1:1</option>
          </select>
        </label>
        <button onClick={addText}>+ Text</button>
        <label className="file">Import files
          <input type="file" multiple accept="video/mp4,video/quicktime,video/webm,image/*,audio/*" onChange={(e) => void onFiles(e.target.files)} />
        </label>
        <span className="saved">{h.savedAt ? `Draft saved ${h.savedAt}` : "Not saved yet"}</span>
      </div>
      {notice && <div className="notice">{notice}</div>}

      <div className="stage">
        <aside className="panel">
          <h4>Library</h4>
          {LIBRARY.map((m) => (
            <button key={m.name} className="lib" onClick={() => void addMedia(`/media/${m.name}`, m.name, m.kind)}>
              <span className={`tag ${m.kind}`}>{m.kind}</span> {m.name}
            </button>
          ))}
          <p className="hint">Stand-in for the platform Library picker. Click to add to the timeline.</p>
        </aside>

        <div className="preview">
          <canvas ref={canvasRef} width={W} height={H} onPointerDown={dragOverlay} style={{ aspectRatio: `${W} / ${H}` }} />
        </div>

        <aside className="panel">
          <h4>Inspector</h4>
          {selClip && (
            <div className="form">
              <b>{selClip.name}</b>
              <label>Trim in (s)<input type="number" step="0.1" min={0} max={selClip.out - 0.2} value={Number(selClip.in.toFixed(2))} onChange={(e) => patchClip(selClip.id, { in: Number(e.target.value) })} /></label>
              <label>Trim out (s)<input type="number" step="0.1" min={selClip.in + 0.2} max={selClip.srcDuration} value={Number(selClip.out.toFixed(2))} onChange={(e) => patchClip(selClip.id, { out: Number(e.target.value) })} /></label>
              <label className="row"><input type="checkbox" checked={selClip.muted} onChange={(e) => patchClip(selClip.id, { muted: e.target.checked })} /> Mute original sound</label>
            </div>
          )}
          {selOverlay?.kind === "text" && (
            <div className="form">
              <label>Text<input value={selOverlay.text} onChange={(e) => patchOverlay(selOverlay.id, { text: e.target.value })} /></label>
              <label>Size<input type="range" min={16} max={120} value={selOverlay.fontSize} onChange={(e) => patchOverlay(selOverlay.id, { fontSize: Number(e.target.value) })} /></label>
              <label>Colour<input type="color" value={selOverlay.color} onChange={(e) => patchOverlay(selOverlay.id, { color: e.target.value.toUpperCase() })} /></label>
              <p className="hint">Drag on the preview to position.</p>
            </div>
          )}
          {selOverlay?.kind === "image" && (
            <div className="form">
              <label>Width<input type="range" min={0.05} max={1} step={0.01} value={selOverlay.width} onChange={(e) => patchOverlay(selOverlay.id, { width: Number(e.target.value) })} /></label>
              <p className="hint">Drag on the preview to position.</p>
            </div>
          )}
          {!selClip && !selOverlay && <p className="hint">Select a clip or an overlay on the timeline.</p>}
          <h4>Audio</h4>
          <div className="form">
            <label>Original sound<input type="range" min={0} max={1} step={0.05} value={p.originalVolume} onChange={(e) => h.commit({ ...p, originalVolume: Number(e.target.value) })} /></label>
            {p.music ? (
              <>
                <label>Music: {p.music.name}<input type="range" min={0} max={1} step={0.05} value={p.music.volume} onChange={(e) => h.commit({ ...p, music: { ...p.music!, volume: Number(e.target.value) } })} /></label>
                <button onClick={() => h.commit({ ...p, music: null })}>Remove music</button>
              </>
            ) : <p className="hint">No music. Add an audio file from the Library.</p>}
          </div>
        </aside>
      </div>

      <div className="tl-head">
        <span>Timeline</span>
        <label>Zoom <input type="range" min={20} max={200} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} /></label>
        <span className="hint">Drag clip edges to trim, drag a clip to reorder, edges snap to the playhead.</span>
      </div>
      <div className="tl-scroll">
        <div className="tl" style={{ width }} ref={trackRef}>
          <div className="ruler" onPointerDown={scrub}>
            {Array.from({ length: Math.ceil(width / zoom) }, (_, s) => (
              <span key={s} style={{ left: s * zoom }}>{s}s</span>
            ))}
          </div>
          <div className="track" data-label="Video">
            {p.clips.map((c, i) => (
              <div key={c.id} className={`clip video ${sel?.id === c.id ? "sel" : ""}`} style={{ left: (starts[i] ?? 0) * zoom, width: clipLen(c) * zoom }} onPointerDown={(e) => reorderClip(e, i)}>
                <i className="h l" onPointerDown={(e) => trimClip(e, c, i, "in")} />
                <span>{c.muted ? "(muted) " : ""}{c.name}</span>
                <i className="h r" onPointerDown={(e) => trimClip(e, c, i, "out")} />
              </div>
            ))}
          </div>
          <div className="track" data-label="Overlay" style={{ height: 6 + laneCount * 34 }}>
            {p.overlays.map((o, i) => (
              <div key={o.id} className={`clip ${o.kind} ${sel?.id === o.id ? "sel" : ""}`} style={{ left: o.start * zoom, width: (o.end - o.start) * zoom, top: 5 + (lanes[i] ?? 0) * 34 }} onPointerDown={(e) => moveOverlay(e, o, "move")}>
                <i className="h l" onPointerDown={(e) => moveOverlay(e, o, "start")} />
                <span>{o.kind === "text" ? o.text : "logo"}</span>
                <i className="h r" onPointerDown={(e) => moveOverlay(e, o, "end")} />
              </div>
            ))}
          </div>
          <div className="track" data-label="Audio">
            {p.music && <div className="clip audio" style={{ left: 0, width: total * zoom }}><span>{p.music.name} ({Math.round(p.music.volume * 100)}%)</span></div>}
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
        <button disabled={!!busy} onClick={() => void runExport("mediabunny")}>Browser: Mediabunny</button>
        <button disabled={!!busy} onClick={() => void runExport("wasm")}>Browser: ffmpeg.wasm</button>
        <button disabled={!!busy} onClick={() => void runExport("server")}>Server: FFmpeg</button>
        {busy && <span className="prog">{busy} {Math.round(progress * 100)}%<progress value={progress} max={1} /></span>}
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
                  <td><button onClick={() => setLastUrl(r.url)}>Play</button> <a href={r.url} download={`export-${i}.mp4`}>Download</a></td>
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
