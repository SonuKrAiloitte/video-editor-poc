/**
 * The easy editor: a phone-editor style screen for non-technical users (patterns from Instagram Edits / CapCut:
 * big preview, filmstrip timeline under a fixed playhead, a bottom toolbar that follows the selection, option sheets).
 * Same draft, undo history, preview engine and exporters as the advanced editor (src/own/core).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { imageRatio, layoutText, loadImage, overlayBox } from "../compose";
import type { LibraryItem } from "../exporters";
import {
  audioLen, clipAt, clipLen, emptyProject, frameSize, isPhoto, splitAt, totalDuration, uid,
  type AudioClip, type Clip, type ImageOverlay, type Overlay, type Project, type TextOverlay,
} from "../project";
import { cur, historyDepth, sampleProject, takeDroppedOnLoad, useHistory } from "../core/history";
import { usePreview } from "../core/player";
import { thumbJobs } from "../core/thumbs";
import { addMediaTo, importFiles, useLibrary, type Kind } from "../core/media";
import { clock, FORMATS, type Sel, type SheetName } from "./common";
import { FormatShape, Icon } from "./icons";
import {
  ColourSheet, FontSheet, FormatSheet, LengthSheet, LOGO_SPOTS, StyleSheet, MediaSheet, PositionSheet, SizeSheet, TEXT_SPOTS, TextSheet, VolumeSheet, type Spot,
} from "./Sheets";
import { ExportSheet, type ExportOutcome } from "./ExportSheet";
import { Timeline } from "./Timeline";
import { Toolbar, type ToolbarName } from "./Toolbars";
import "./easy.css";

const TEXT_INPUTS = ["text", "number", "search"];
const isTyping = (el: EventTarget | null) =>
  el instanceof HTMLElement && ((el instanceof HTMLInputElement && TEXT_INPUTS.includes(el.type)) || el.tagName === "TEXTAREA" || el.isContentEditable);
/** the core reports problems in engineering terms; say them plainly here */
const plain = (msg: string) => {
  if (/decode|codec/i.test(msg)) return "This video can't be played in this browser. Try an MP4 file.";
  const failed = /^(.*) could not be uploaded/.exec(msg);
  if (failed) return `${failed[1]} couldn't be saved to My media, so it will disappear if you reload the page. Check your connection and add it again.`;
  return msg;
};

export function EasyEditor() {
  const h = useHistory();
  const p = h.project;
  const total = totalDuration(p);
  const empty = p.clips.length === 0;

  const [sel, setSel] = useState<Sel>(null);
  const [sheet, setSheetNow] = useState<SheetName | null>(null);
  // while an export runs its sheet must stay open: closing it would throw the result away
  const exporting = useRef(false);
  const setSheet = useCallback((s: SheetName | null | ((now: SheetName | null) => SheetName | null)) => {
    if (!exporting.current) setSheetNow(s);
  }, []);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(() => {
    const n = takeDroppedOnLoad();
    return n ? `${n} item(s) from an earlier session were removed because they were never uploaded. Please add them again.` : null;
  });

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const selRef = useRef<Sel>(null);
  selRef.current = sel;
  // dashed box around the selected title or logo, in the preview only
  const drawExtra = useCallback((ctx: CanvasRenderingContext2D, W: number, H: number, time: number, proj: Project) => {
    const s = selRef.current;
    const o = s?.type === "overlay" ? proj.overlays.find((v) => v.id === s.id) : undefined;
    if (!o || time < o.start || time > o.end) return;
    const b = overlayBox(ctx, o, W, H);
    if (!b) return;
    ctx.save();
    ctx.setLineDash([10, 8]);
    ctx.lineWidth = Math.max(2, W / 240);
    ctx.strokeStyle = "#fff";
    ctx.shadowColor = "rgba(0,0,0,0.7)";
    ctx.shadowBlur = 4;
    const pad = W / 60;
    ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
    ctx.restore();
  }, []);
  const { t, playing, setPlaying, seek, tRef, media } = usePreview(canvasRef, p, { emptyText: ["", ""], drawExtra });
  const [W, H] = frameSize(p.aspect, 720);
  const lib = useLibrary();
  const [pps, setPps] = useState(80); // timeline pixels per second
  const tlState = useRef({ scrollLeft: 0, pps: 80, thumbs: 0 });
  const results = useRef<ExportOutcome[]>([]);

  // the selected thing, looked up fresh (it may have been undone away)
  const selClip: Clip | undefined = sel?.type === "clip" ? p.clips.find((c) => c.id === sel.id) : undefined;
  const selOverlay: Overlay | undefined = sel?.type === "overlay" ? p.overlays.find((o) => o.id === sel.id) : undefined;
  const selText = selOverlay?.kind === "text" ? selOverlay : undefined;
  const selLogo = selOverlay?.kind === "image" ? selOverlay : undefined;
  const selAudio: AudioClip | undefined = sel?.type === "audio" ? p.audio.find((a) => a.id === sel.id) : undefined;
  const toolbar: ToolbarName = selClip ? "clip" : selText ? "text" : selLogo ? "logo" : selAudio ? "music" : "main";
  const format = FORMATS.find((f) => f.aspect === p.aspect) ?? FORMATS[0]!;

  // a selection that no longer exists (deleted, undone) falls back to the main tools
  useEffect(() => {
    if (sel && toolbar === "main") setSel(null);
  }, [sel, toolbar]);

  const closeSheet = () => setSheet(null);
  const openSheet = (s: SheetName) => setSheet((now) => (now === s ? null : s));

  // ------------------------------------------------------------------ edits
  const patchClip = (id: string, patch: Partial<Clip>) => h.commit({ ...cur(), clips: cur().clips.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
  /** live = part of a gesture started with h.begin() (slider, typing); otherwise one undo step */
  const patchOverlay = (id: string, patch: Partial<Overlay>, live = false) => {
    const next = { ...cur(), overlays: cur().overlays.map((o) => (o.id === id ? ({ ...o, ...patch } as Overlay) : o)) };
    live ? h.apply(next) : h.commit(next);
  };

  const newPost = () => {
    setPlaying(false);
    h.commit(emptyProject(cur().aspect));
    setSel(null);
    setSheet(null);
    seek(0);
  };
  const loadSample = () => {
    setPlaying(false);
    h.commit(sampleProject());
    setSel(null);
    setSheet(null);
    seek(0);
  };

  /** add a library item or an uploaded file; titles and logos last the whole video */
  // a picture picked from "Add video" goes on the video track as a photo clip; from "Logo" it is an overlay
  const add = async (item: { src: string; name: string; kind: Kind }, imageAs: "clip" | "overlay", file?: File) => {
    const r = await addMediaTo(cur, item, tRef.current, { overlayRange: "whole", imageAs, file });
    if (r.error) return setNotice(plain(r.error));
    h.commit(r.project);
    setSel(r.select ?? null);
    if (r.select?.type === "clip") seek(r.at ?? 0);
    setSheet(null);
    setNotice(null);
  };
  const imageAs = (): "clip" | "overlay" => (sheet === "media-video" ? "clip" : "overlay");
  const pick = (item: LibraryItem) => {
    setBusy(`Adding ${item.name}...`);
    void add(item, imageAs())
      .catch((e) => setNotice(plain(e instanceof Error ? e.message : String(e))))
      .finally(() => setBusy(null));
  };
  const upload = (files: File[]) => {
    setBusy("Uploading...");
    const as = imageAs();
    void importFiles(files, (src, name, kind, file) => add({ src, name, kind }, as, file), (msg) => {
      if (msg?.startsWith("Uploading")) setBusy(msg);
      else setNotice(msg && plain(msg));
    })
      .catch((e) => setNotice(plain(e instanceof Error ? e.message : String(e))))
      .finally(() => {
        setBusy(null);
        void lib.refresh();
      });
  };

  const addText = () => {
    const o: TextOverlay = { id: uid(), kind: "text", text: "Your text", fontSize: 56, color: "#FFFFFF", font: "jakarta", x: 0.5, y: 0.5, start: 0, end: Math.max(totalDuration(cur()), 1) };
    h.commit({ ...cur(), overlays: [...cur().overlays, o] });
    setSel({ type: "overlay", id: o.id });
    setSheet("text");
  };
  const canSplit = (() => {
    if (selAudio) return t > selAudio.start + 0.1 && t < selAudio.start + audioLen(selAudio) - 0.1;
    if (!selClip) return false;
    const hit = clipAt(p, t);
    return !!hit && hit.clip.id === selClip.id && splitAt(p, t) !== p;
  })();
  /** split the selected clip, or the selected music piece, at the playhead */
  const split = () => {
    if (!selAudio) return h.commit(splitAt(cur(), tRef.current));
    const now = cur();
    const a = now.audio.find((x) => x.id === selAudio.id);
    const time = tRef.current;
    if (!a || time <= a.start + 0.1 || time >= a.start + audioLen(a) - 0.1) return;
    const cut = a.in + (time - a.start);
    const i = now.audio.indexOf(a);
    const audio = [...now.audio];
    audio.splice(i, 1, { ...a, out: cut }, { ...a, id: uid(), start: time, in: cut });
    h.commit({ ...now, audio });
  };
  const removeSelected = () => {
    if (!sel) return;
    const now = cur();
    if (sel.type === "clip") h.commit({ ...now, clips: now.clips.filter((c) => c.id !== sel.id) });
    else if (sel.type === "overlay") h.commit({ ...now, overlays: now.overlays.filter((o) => o.id !== sel.id) });
    else h.commit({ ...now, audio: now.audio.filter((a) => a.id !== sel.id) });
    setSel(null);
    setSheet(null);
  };

  /** put a title or logo at a named spot, keeping a logo fully inside the frame with a small margin */
  const placeAt = async (o: Overlay, s: Spot) => {
    const m = 0.05;
    if (o.kind === "text") return patchOverlay(o.id, { x: 0.5, y: s.y === "t" ? 0.15 : s.y === "b" ? 0.85 : 0.5 });
    await loadImage(o.src);
    const halfW = o.width / 2;
    const halfH = (o.width * W * (imageRatio(o.src) ?? 1)) / H / 2;
    const x = s.x === "l" ? m + halfW : s.x === "r" ? 1 - m - halfW : 0.5;
    const y = s.y === "t" ? m + halfH : s.y === "b" ? 1 - m - halfH : 0.5;
    patchOverlay(o.id, { x: +x.toFixed(4), y: +y.toFixed(4) });
  };

  // ------------------------------------------------------------------ preview: select / drag titles and logos, click to play
  const onPreviewDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (empty) return;
    const cv = e.currentTarget;
    const rect = cv.getBoundingClientRect();
    const at = (ev: { clientX: number; clientY: number }) => [(ev.clientX - rect.left) / rect.width, (ev.clientY - rect.top) / rect.height] as const;
    const [fx, fy] = at(e);
    const ctx = cv.getContext("2d")!;
    const time = tRef.current;
    const hit = [...cur().overlays].reverse().find((o) => {
      if (time < o.start || time > o.end) return false;
      const b = overlayBox(ctx, o, cv.width, cv.height);
      const pad = cv.width / 40;
      return !!b && fx * cv.width >= b.x - pad && fx * cv.width <= b.x + b.w + pad && fy * cv.height >= b.y - pad && fy * cv.height <= b.y + b.h + pad;
    });
    if (!hit) {
      if (sel) setSel(null);
      else setPlaying((v) => !v);
      return;
    }
    setPlaying(false);
    setSel({ type: "overlay", id: hit.id });
    const [ox, oy] = [hit.x - fx, hit.y - fy];
    h.begin();
    const move = (ev: PointerEvent) => {
      const [mx, my] = at(ev);
      const x = Math.min(1, Math.max(0, mx + ox));
      const y = Math.min(1, Math.max(0, my + oy));
      h.apply({ ...cur(), overlays: cur().overlays.map((v) => (v.id === hit.id ? { ...v, x, y } : v)) });
    };
    const up = () => (window.removeEventListener("pointermove", move), window.removeEventListener("pointerup", up));
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // keyboard: space plays, Cmd/Ctrl+Z undoes, Delete removes the selection (never while typing)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      if (e.code === "Space" && !empty) {
        e.preventDefault();
        if (e.target instanceof HTMLElement && e.target !== document.body) e.target.blur();
        setPlaying((v) => !v);
      } else if (e.key.toLowerCase() === "z" && (e.ctrlKey || e.metaKey)) (e.preventDefault(), e.shiftKey ? h.redo() : h.undo());
      else if ((e.key === "Delete" || e.key === "Backspace") && sel && !sheet) (e.preventDefault(), removeSelected());
      else if (e.key === "Escape") (sheet ? closeSheet() : setSel(null));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // hook for automated checks (same shape as the advanced editor's, plus the easy screen's own state)
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__poc = {
      screen: "easy",
      getProject: () => cur(),
      setProject: (next: Project) => h.commit(next),
      newProject: newPost,
      loadSample,
      seek,
      undo: h.undo,
      redo: h.redo,
      canUndo: historyDepth,
      library: () => lib.library,
      media,
      select: (type: NonNullable<Sel>["type"] | null, id?: string) => setSel(type && id ? { type, id } : null),
      selected: () => sel?.id ?? null,
      toolbar: () => toolbar,
      sheet: () => sheet,
      timeline: () => tlState.current,
      time: () => tRef.current,
      results: () => results.current,
      // where a title is drawn in the preview frame, for checks
      titleLayout: (id: string) => {
        const o = cur().overlays.find((v) => v.id === id);
        const ctx = canvasRef.current?.getContext("2d");
        if (!o || o.kind !== "text" || !ctx) return null;
        const L = layoutText(ctx, o, W, H);
        const pad = (o.bg ?? "none") !== "none" ? L.padX : 0;
        return { lines: L.lines.length, left: Math.min(...L.lines.map((l) => l.x)) - pad, right: Math.max(...L.lines.map((l) => l.x + l.w)) + pad, W };
      },
      thumbJobs,
    };
  });

  const begin = h.begin;
  const sheetView = (() => {
    switch (sheet) {
      case "format":
        return <FormatSheet aspect={p.aspect} choose={(a) => h.commit({ ...cur(), aspect: a })} close={closeSheet} />;
      case "media-video":
      case "media-image":
      case "media-audio":
        return (
          <MediaSheet
            kind={sheet === "media-video" ? "video" : sheet === "media-image" ? "image" : "audio"}
            library={lib.library} busy={busy} pick={pick} upload={upload} close={closeSheet}
          />
        );
      case "text":
        return selText ? <TextSheet o={selText} begin={begin} set={(text) => patchOverlay(selText.id, { text }, true)} close={closeSheet} /> : null;
      case "font":
        return selText ? <FontSheet o={selText} choose={(font) => patchOverlay(selText.id, { font })} close={closeSheet} /> : null;
      case "colour":
        return selText ? <ColourSheet o={selText} begin={begin} choose={(color, live) => patchOverlay(selText.id, { color }, live)} close={closeSheet} /> : null;
      case "size": {
        const o: TextOverlay | ImageOverlay | undefined = selText ?? selLogo;
        return o ? (
          <SizeSheet o={o} begin={begin} set={(v) => patchOverlay(o.id, o.kind === "text" ? { fontSize: v } : { width: v }, true)} close={closeSheet} />
        ) : null;
      }
      case "position": {
        const o = selText ?? selLogo;
        return o ? <PositionSheet spots={o.kind === "text" ? TEXT_SPOTS : LOGO_SPOTS} current={o} choose={(s) => void placeAt(o, s)} close={closeSheet} /> : null;
      }
      case "volume":
        return (
          <VolumeSheet
            p={p} piece={selAudio} begin={begin} close={closeSheet}
            setVideo={(v) => h.apply({ ...cur(), originalVolume: v })}
            setPiece={(v) => selAudio && h.apply({ ...cur(), audio: cur().audio.map((a) => (a.id === selAudio.id ? { ...a, volume: v } : a)) })}
          />
        );
      case "style":
        return selText ? <StyleSheet o={selText} set={(patch) => patchOverlay(selText.id, patch)} close={closeSheet} /> : null;
      case "length":
        return selClip && isPhoto(selClip) ? (
          <LengthSheet seconds={clipLen(selClip)} choose={(n) => patchClip(selClip.id, { in: 0, out: n })} close={closeSheet} />
        ) : null;
      case "export":
        return (
          <ExportSheet
            project={cur} close={closeSheet} onBusy={(b) => (exporting.current = b)}
            onResult={(r) => results.current.push(r)} onSaved={() => void lib.refresh()}
          />
        );
      default:
        return null;
    }
  })();

  const title = selClip ? selClip.name : selText ? `“${selText.text}”` : selLogo ? selLogo.name ?? "Logo" : selAudio ? selAudio.name : undefined;

  return (
    <div className="easy">
      <header className="e-top">
        <button className="e-ghost" onClick={newPost}><Icon.newPost /> <span>New post</span></button>
        <button className="e-chip" onClick={() => openSheet("format")} aria-label="Change format">
          <FormatShape w={format.w} h={format.h} /> {format.label}
        </button>
        <div className="e-top-right">
          <button className="e-icon" aria-label="Undo" title="Undo" onClick={h.undo} disabled={!h.canUndo}><Icon.undo /></button>
          <button className="e-icon" aria-label="Redo" title="Redo" onClick={h.redo} disabled={!h.canRedo}><Icon.redo /></button>
          <span className="e-saved">{h.savedAt ? "Saved ✓" : ""}</span>
          <button className="e-export" onClick={() => (setPlaying(false), setSel(null), openSheet("export"))} disabled={empty}>Export</button>
        </div>
      </header>

      {notice && (
        <div className="e-notice" role="status">
          <span>{notice}</span>
          <button className="e-link" onClick={() => setNotice(null)}>OK</button>
        </div>
      )}

      <main className="e-stage">
        <div className="e-frame" style={{ aspectRatio: `${W} / ${H}` }}>
          <canvas ref={canvasRef} width={W} height={H} onPointerDown={onPreviewDown} />
          {empty && (
            <div className="e-empty">
              <button className="e-cta" onClick={() => openSheet("media-video")}><Icon.plus /> Add your first video</button>
              <button className="e-link" onClick={loadSample}>or try the sample post</button>
            </div>
          )}
        </div>
      </main>

      <div className="e-transport">
        <span className="e-time">{clock(t)}</span>
        <button className="e-play" aria-label={playing ? "Pause" : "Play"} onClick={() => setPlaying((v) => !v)} disabled={empty}>
          {playing ? <Icon.pause /> : <Icon.play />}
        </button>
        <span className="e-time muted">{clock(total)}</span>
        {!empty && !sel && <span className="e-tip">Tip: click a title or logo on the video to change it</span>}
        <span className="e-zoom">
          <button className="e-icon" aria-label="Zoom out" title="Zoom out" onClick={() => setPps((v) => Math.max(20, Math.round(v / 1.5)))}><Icon.minus /></button>
          <button className="e-icon" aria-label="Zoom in" title="Zoom in" onClick={() => setPps((v) => Math.min(240, Math.round(v * 1.5)))}><Icon.plus /></button>
        </span>
      </div>

      <section className="e-timeline">
        <Timeline
          project={p} t={t} playing={playing} seek={seek} setPlaying={setPlaying} sel={sel} setSel={setSel} h={h} pps={pps}
          onAddVideo={() => openSheet("media-video")} onAddMusic={() => openSheet("media-audio")}
          report={(r) => (tlState.current = r)}
        />
      </section>

      <Toolbar
        name={toolbar} title={title} empty={empty}
        a={{
          open: openSheet, addText, split, canSplit, remove: removeSelected, done: () => (setSel(null), setSheet(null)),
          toggleMute: () => selClip && patchClip(selClip.id, { muted: !selClip.muted }), muted: !!selClip?.muted,
          photo: !!selClip && isPhoto(selClip),
        }}
      />

      {sheetView}
    </div>
  );
}
