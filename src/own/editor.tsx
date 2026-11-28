/**
 * Candidate B: our own editor core.
 * No editor SDK. React + canvas for the UI, one JSON edit document, and three interchangeable exporters.
 *
 * Timeline works like CapCut:
 *   - drag from the Library onto any track, at any time; a clip dropped where another sits goes on a new track
 *   - drag clips sideways in time and up or down to another track
 *   - the main track keeps its clips joined end to end; the tracks above take video, image and text anywhere;
 *     the tracks below take audio only. A drop on the wrong kind of track is refused with a reason.
 */
import { memo, startTransition, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ALL_FORMATS, BlobSource, Input } from "mediabunny";
import { DEFAULT_FONT, FONTS, fontFor } from "../../shared/fonts.js";
import { DEFAULT_TRANSITION_SECONDS, EFFECTS, MAX_TRANSITION_SECONDS, TRANSITIONS, effectDef, transitionDef } from "../../shared/fx.js";
import { RATIOS, applyTrackStates, audioLen, canPlace, layers, normalizeProject, overlapsOnTrack, refuseReason, resolveAspect, transitionDur, type ItemKind } from "../../shared/model.js";
import sample from "../../shared/sample-project.json";
import { drawMain, drawOverlays, drawTransition, getImage, loadImage, mainRect, measureTitle, preloadOverlayAssets } from "./compose";
import { blobNames, exportFfmpegWasm, exportMediabunny, exportServer, type ExportResult } from "./exporters";
import {
  clipAt, clipLen, clipStarts, frameSize, insertIndexAt, mainLength, moveClip, splitAt, totalDuration, uid,
  hasFile, transitionAt,
  type AudioItem, type Clip, type EffectOverlay, type ImageOverlay, type Overlay, type Project, type TrackKind, type TrackState,
} from "./project";

const STORAGE_KEY = "poc-own-editor-draft-v1";
/**
 * Edits longer than this are exported on the server, whatever button was pressed.
 * Measured: a browser export of a 60 s 1080p60 recording took 81 to 86 s, and of a 4-minute one 472 s,
 * while the server did the 4-minute one in about a minute. The browser also holds the whole result in memory.
 */
export const BROWSER_EXPORT_MAX_SECONDS = 60;
const IMAGE_SECONDS = 3;
const SAMPLE = normalizeProject(sample);

/** A file in the Library panel, already checked (and converted if the browser could not use it). */
interface Media {
  name: string;
  src: string;
  kind: "video" | "audio" | "image";
  duration: number;
  hasAudio: boolean;
  channels?: number;
  /** width / height of the picture */
  ratio?: number;
  /** a light 720p / 30 fps copy the server made for the preview (exports read `src`) */
  proxy?: string;
}
const BUILT_IN = [
  { name: "clipA_h264_16x9.mp4", kind: "video" },
  { name: "clipB_h264_9x16.mp4", kind: "video" },
  { name: "clipC_vp9.webm", kind: "video" },
  { name: "clipD_hevc.mov", kind: "video" },
  { name: "music.mp3", kind: "audio" },
  { name: "logo.png", kind: "image" },
] as const;

const LIBRARY_KEY = "poc-own-library-v1";
const loadLibrary = (): Media[] => {
  try {
    const raw = localStorage.getItem(LIBRARY_KEY);
    // only entries stored on the server; a blob: link from an earlier page load no longer works
    if (raw) return (JSON.parse(raw) as Media[]).filter((m) => !m.src.startsWith("blob:"));
  } catch {
    /* storage unavailable */
  }
  return [];
};
/**
 * Is a file used on the timeline still available? Built-in test files always are. An imported file is, while it is
 * in the Library. A blob: link (a file the browser holds for this page only) dies when the page reloads; blobNames
 * lists the links made since this page loaded.
 */
const isMissing = (src: string, librarySrcs: Set<string>) =>
  !src.startsWith("/media/") && (src.startsWith("blob:") ? !blobNames.has(src) : !librarySrcs.has(src));
/** the file name an item came from (uploads are saved as "<time>_<name>") */
const fileNameOf = (src: string) => decodeURIComponent(src.split("?")[0]!.split("/").pop() ?? "").replace(/^\d{10,}_/, "");
/** names of the files in an edit that are missing */
const missingFiles = (p: Project, librarySrcs: Set<string>) => [
  ...new Set([
    ...p.clips.filter((c) => isMissing(c.src, librarySrcs)).map((c) => c.name),
    ...p.overlays.flatMap((o) => (hasFile(o) && isMissing(o.src, librarySrcs) ? [o.kind === "video" ? o.name : fileNameOf(o.src)] : [])),
    ...p.audios.filter((a) => isMissing(a.src, librarySrcs)).map((a) => a.name),
  ]),
];
const missingMessage = (names: string[]) =>
  `${names.join(", ")} ${names.length > 1 ? "are" : "is"} not in the Library any more (removed, or imported before imported files were kept), so ${names.length > 1 ? "they are" : "it is"} marked red on the timeline. Import the file again to put it back, or delete the red clip${names.length > 1 ? "s" : ""}.`;

const loadDraft = (): Project => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return normalizeProject(JSON.parse(raw));
  } catch {
    /* storage unavailable: fall through to the sample */
  }
  return SAMPLE;
};

/** Tracks with nothing on them disappear, as in CapCut. */
function prune(p: Project): Project {
  const used = new Set([...p.overlays.map((o) => o.track), ...p.audios.map((a) => a.track)]);
  const tracks = p.tracks.filter((t) => used.has(t.id));
  return tracks.length === p.tracks.length ? p : { ...p, tracks };
}

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
  const apply = useCallback((next: Project) => setProject(prune(next)), []);
  const commit = useCallback((next: Project) => (checkpoint(), setProject(prune(next))), [checkpoint]);
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
    hdr: video ? await video.hasHighDynamicRange() : false,
    ratio: video && video.displayHeight ? video.displayWidth / video.displayHeight : undefined,
  };
}

const VIDEO_EXT = ["mp4", "mov", "webm", "avi", "mkv", "m4v", "3gp", "wmv", "flv", "mpg", "mpeg", "ts"];
const AUDIO_EXT = ["mp3", "wav", "ogg", "m4a", "aac", "flac", "opus"];

/** HH:MM:SS:FF at 30 frames a second, as CapCut shows it */
/** "mm:ss.s" for the captions list */
const short = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
/** Read an .srt or .vtt file into caption lines. Line breaks inside a caption become spaces (captions are one line). */
function parseSubtitles(text: string): { start: number; end: number; text: string }[] {
  const sec = (s: string) => {
    const parts = s.trim().replace(",", ".").split(":").map(Number);
    return parts.reduce((acc, p) => acc * 60 + p, 0);
  };
  return text.replace(/\r/g, "").split(/\n\s*\n/).flatMap((block) => {
    const lines = block.trim().split("\n");
    const at = lines.findIndex((l) => l.includes("-->"));
    if (at < 0) return [];
    const [a, b] = lines[at]!.split("-->");
    const words = lines.slice(at + 1).join(" ").replace(/<[^>]+>/g, "").trim();
    const start = sec(a ?? ""), end = sec((b ?? "").trim().split(" ")[0] ?? "");
    return words && end > start ? [{ start, end, text: words }] : [];
  });
}
const CAPTION_STYLE = { font: "jakarta", fontSize: 34, color: "#FFFFFF", bg: "#000000", bgOpacity: 0.6, x: 0.5, y: 0.86 };

const fmt = (t: number) => {
  const f = Math.round(t * 30);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(Math.floor(f / 108000))}:${two(Math.floor(f / 1800) % 60)}:${two(Math.floor(f / 30) % 60)}:${two(f % 30)}`;
};
/** track header icons (lock, eye, speaker), drawn inline so they follow the text colour */
const Icon = ({ name }: { name: "lock" | "unlock" | "eye" | "eye-off" | "sound" | "mute" }) => {
  const paths: Record<string, string> = {
    lock: "M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z",
    unlock: "M7 11V8a5 5 0 0 1 9.6-2M5 11h14v10H5z",
    eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zm10-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
    "eye-off": "M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.7 6.7C3.8 8.6 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.3-1.6",
    sound: "M4 9v6h4l5 4V5L8 9zM16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12",
    mute: "M4 9v6h4l5 4V5L8 9zM17 9l5 6M22 9l-5 6",
  };
  return <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
};

/** The left-hand header of a track: its name and the lock / hide / mute buttons (audio tracks have no hide). */
function TrackHead({ name, kind, state, onToggle }: { name: string; kind: "visual" | "main" | "audio"; state: TrackState; onToggle: (key: keyof TrackState) => void }) {
  const btn = (key: keyof TrackState, on: boolean, icons: [Parameters<typeof Icon>[0]["name"], Parameters<typeof Icon>[0]["name"]], label: [string, string]) => (
    <button className={`tbtn ${on ? "on" : ""}`} aria-pressed={on} aria-label={`${on ? label[1] : label[0]} ${name}`} title={on ? label[1] : label[0]} onClick={() => onToggle(key)}>
      <Icon name={on ? icons[1] : icons[0]} />
    </button>
  );
  return (
    <div className={`track ${kind} head ${state.locked ? "is-locked" : ""}`}>
      <span className="tname">{name}</span>
      {btn("locked", !!state.locked, ["unlock", "lock"], ["Lock", "Unlock"])}
      {kind !== "audio" ? btn("hidden", !!state.hidden, ["eye", "eye-off"], ["Hide", "Show"]) : <span className="tbtn-space" />}
      {btn("muted", !!state.muted, ["sound", "mute"], ["Mute", "Unmute"])}
    </div>
  );
}

// ------------------------------------------------------------------ speed helpers
/**
 * A value kept outside React state, for things that change every frame (the playhead time) or that only a small part
 * of the page shows (the timeline zoom). Only the components that read it with useValue re-render when it changes.
 */
function createStore<T>(initial: T) {
  let value = initial;
  const subs = new Set<() => void>();
  return {
    get: () => value,
    set: (next: T) => {
      if (Object.is(next, value)) return;
      value = next;
      subs.forEach((f) => f());
    },
    subscribe: (f: () => void) => (subs.add(f), () => void subs.delete(f)),
  };
}
type Store<T> = ReturnType<typeof createStore<T>>;
const useValue = <T,>(s: Store<T>) => useSyncExternalStore(s.subscribe, s.get);

/**
 * Pointer moves come much faster than the screen redraws on a slow laptop. This runs `fn` at most once a frame with the
 * latest event; `flush` runs a waiting one at once (on release, so the drop lands where the pointer was let go).
 */
function perFrame<E>(fn: (e: E) => void) {
  let last: E | null = null;
  let raf = 0;
  const run = () => {
    raf = 0;
    if (!last) return;
    const e = last;
    last = null;
    fn(e);
  };
  const call = (e: E) => {
    last = e;
    if (!raf) raf = requestAnimationFrame(run);
  };
  return Object.assign(call, { flush: () => (raf && cancelAnimationFrame(raf), run()) });
}

/**
 * The same object on every render, whose functions call the latest version of `fns`. Lets the timeline blocks be
 * memoised: their handlers never change, yet always see the current edit.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function useActions<T extends Record<string, (...args: any[]) => any>>(fns: T): T {
  const ref = useRef(fns);
  ref.current = fns;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => Object.fromEntries(Object.keys(fns).map((k) => [k, (...a: unknown[]) => ref.current[k]!(...a)])) as T, []);
}

/** the playhead time as text, HH:MM:SS:FF */
function TimeText({ time, total }: { time: Store<number>; total: number }) {
  const t = useValue(time);
  return <span className="time"><b>{fmt(t)}</b> / {fmt(total)}</span>;
}

/**
 * A text box that does not rebuild the whole editor on every key: it keeps what is typed itself and hands it to the
 * edit a moment after typing pauses (or when it loses focus). A burst of typing is one Undo step.
 */
function LiveText({ value, onStart, onLive, ...rest }: Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
  value: string;
  /** before the first change of a burst (take the Undo checkpoint here) */
  onStart: () => void;
  /** the text so far, applied to the edit without an Undo step */
  onLive: (text: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const typing = useRef(false);
  const timer = useRef(0);
  const idle = useRef(0);
  const latest = useRef(value);
  const live = useRef(onLive);
  live.current = onLive;
  // a change from outside (Undo, another field, a different caption) shows here when not typing
  useEffect(() => {
    if (!typing.current) setDraft(value);
  }, [value]);
  const push = () => {
    window.clearTimeout(timer.current);
    timer.current = 0;
    startTransition(() => live.current(latest.current));
  };
  const end = () => {
    if (timer.current) push();
    typing.current = false;
  };
  useEffect(() => () => end(), []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <input
      {...rest}
      value={draft}
      onChange={(e) => {
        if (!typing.current) (typing.current = true), onStart();
        latest.current = e.target.value;
        setDraft(e.target.value);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(push, 120);
        window.clearTimeout(idle.current);
        idle.current = window.setTimeout(end, 1000); // a pause of a second starts a new Undo step
      }}
      onBlur={(e) => (end(), rest.onBlur?.(e))}
    />
  );
}

// ------------------------------------------------------------------ timeline (memoised: it re-renders only when the edit,
// the selection, the drop target or the zoom changes, and each block only when its own item changes)
type TimelineActions = {
  grabClip: (e: React.PointerEvent, i: number) => void;
  trimClip: (e: React.PointerEvent, c: Clip, i: number, edge: "in" | "out") => void;
  grabOverlay: (e: React.PointerEvent, o: Overlay) => void;
  trimOverlay: (e: React.PointerEvent, o: Overlay, edge: "start" | "end") => void;
  grabAudio: (e: React.PointerEvent, a: AudioItem) => void;
  trimAudio: (e: React.PointerEvent, a: AudioItem, edge: "start" | "end") => void;
  startBox: (e: React.PointerEvent) => void;
  scrub: (e: React.PointerEvent) => void;
  toggleTrack: (row: RowId, key: keyof TrackState) => void;
  /** pick the join before clip `id` on the main track, to give it a transition */
  pickJoin: (id: string) => void;
};
/** a block's place in time; CSS turns it into pixels with the zoom (--z on .tl), so zooming does not re-render blocks */
const at = (start: number, len: number) => ({ "--s": start, "--d": len }) as React.CSSProperties;

const ClipBlock = memo(function ClipBlock({ c, i, start, sel, lost, fade, act }: { c: Clip; i: number; start: number; sel: boolean; lost: boolean; fade: number; act: TimelineActions }) {
  return (
    <div data-ref={`clip:${c.id}`} className={`clip ${c.kind === "image" ? "image" : "video"} ${sel ? "sel" : ""} ${lost ? "lost" : ""}`} style={{ ...at(start, clipLen(c)), "--f": fade } as React.CSSProperties} onPointerDown={(e) => act.grabClip(e, i)}>
      {fade > 0 && <b className="overlap" aria-hidden="true" />}
      <i className="h l" onPointerDown={(e) => act.trimClip(e, c, i, "in")} />
      <span>{c.muted ? "(muted) " : ""}{c.name}</span>
      <i className="h r" onPointerDown={(e) => act.trimClip(e, c, i, "out")} />
    </div>
  );
});
const OverlayBlock = memo(function OverlayBlock({ o, sel, lost, act }: { o: Overlay; sel: boolean; lost: boolean; act: TimelineActions }) {
  return (
    <div data-ref={`overlay:${o.id}`} className={`clip ${o.kind} ${sel ? "sel" : ""} ${lost ? "lost" : ""}`} style={at(o.start, o.end - o.start)} onPointerDown={(e) => act.grabOverlay(e, o)}>
      <i className="h l" onPointerDown={(e) => act.trimOverlay(e, o, "start")} />
      <span>{o.kind === "text" ? o.text : o.kind === "video" ? o.name : o.kind === "effect" ? `✦ ${effectDef(o.effect)?.label ?? o.effect}` : (o as ImageOverlay).src.split("/").pop()}</span>
      <i className="h r" onPointerDown={(e) => act.trimOverlay(e, o, "end")} />
    </div>
  );
});
const AudioBlock = memo(function AudioBlock({ a, sel, lost, act }: { a: AudioItem; sel: boolean; lost: boolean; act: TimelineActions }) {
  return (
    <div data-ref={`audio:${a.id}`} className={`clip audio ${sel ? "sel" : ""} ${lost ? "lost" : ""}`} style={at(a.start, audioLen(a))} onPointerDown={(e) => act.grabAudio(e, a)}>
      <i className="h l" onPointerDown={(e) => act.trimAudio(e, a, "start")} />
      <span>{a.name} ({Math.round(a.volume * 100)}%)</span>
      <i className="h r" onPointerDown={(e) => act.trimAudio(e, a, "end")} />
    </div>
  );
});

/** label spacing: the first step that leaves room for a label at this zoom */
const RULER_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
const rulerLabel = (s: number) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`);
/** Ruler labels only for the part of the timeline on screen, spaced to fit the zoom (1 s, 5 s, 30 s, 1 min, …). */
const Ruler = memo(function Ruler({ zoom, length, left, view, onScrub }: { zoom: number; length: number; left: number; view: number; onScrub: (e: React.PointerEvent) => void }) {
  const step = RULER_STEPS.find((s) => s * zoom >= 56) ?? 600;
  const from = Math.max(0, Math.floor(left / zoom / step) * step);
  const to = Math.min(length, (left + view) / zoom + step);
  const marks: number[] = [];
  for (let s = from; s <= to; s += step) marks.push(s);
  return (
    <div className="ruler" onPointerDown={onScrub}>
      {marks.map((s) => <span key={s} style={{ left: s * zoom }}>{rulerLabel(s)}</span>)}
    </div>
  );
});
/** the red playhead line; it follows the time on its own, without re-rendering the timeline */
function Playhead({ time, zoom, onScrub }: { time: Store<number>; zoom: number; onScrub: (e: React.PointerEvent) => void }) {
  const t = useValue(time);
  return (
    <div className="playhead" style={{ left: t * zoom }}>
      <span className="knob" onPointerDown={onScrub} title="Drag to move the playhead" />
    </div>
  );
}
/** the zoom slider moves at once; the timeline follows at most once a frame */
function ZoomSlider({ store }: { store: Store<number> }) {
  const [v, setV] = useState(store.get());
  const push = useMemo(() => perFrame((n: number) => store.set(n)), [store]);
  return <label>Zoom <input type="range" min={20} max={200} value={v} onChange={(e) => (setV(Number(e.target.value)), push(Number(e.target.value)))} /></label>;
}

const Timeline = memo(function Timeline({ p, selected, join, hover, librarySrcs, zoomStore, time, act, trackRef }: {
  p: Project;
  selected: Ref[];
  /** the join picked for a transition: id of the clip after it */
  join: string | null;
  hover: { row: RowId; ok: boolean } | null;
  librarySrcs: Set<string>;
  zoomStore: Store<number>;
  time: Store<number>;
  act: TimelineActions;
  trackRef: React.RefObject<HTMLDivElement | null>;
}) {
  const zoom = useValue(zoomStore);
  const length = Math.max(totalDuration(p) + 4, 12);
  const width = length * zoom;
  const starts = clipStarts(p);
  const visualTracks = p.tracks.filter((x) => x.kind === "visual");
  const audioTracks = p.tracks.filter((x) => x.kind === "audio");
  const isSel = (id: string) => selected.some((x) => x.id === id);
  const missing = (src: string) => isMissing(src, librarySrcs);
  const rowClass = (row: RowId, extra = "") => `track ${extra} ${hover?.row === row ? (hover.ok ? "drop-ok" : "drop-bad") : ""}`;
  const rowEvents = (row: RowId) => ({ "data-row": row, onPointerDown: act.startBox });
  const stateOf = (row: RowId): TrackState => (row === "main" ? p.main ?? {} : p.tracks.find((x) => x.id === row) ?? {});
  const rowState = (row: RowId) => `${stateOf(row).locked ? "is-locked" : ""} ${stateOf(row).hidden ? "is-hidden" : ""} ${stateOf(row).muted ? "is-muted" : ""}`;
  // which part of the timeline is on screen, for the ruler
  const scrollRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ left: 0, w: 2000 });
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = perFrame(() => setView((v) => (v.left === el.scrollLeft && v.w === el.clientWidth ? v : { left: el.scrollLeft, w: el.clientWidth })));
    update(0);
    el.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => (el.removeEventListener("scroll", update), window.removeEventListener("resize", update));
  }, []);
  return (
    <>
      <div className="tl-head">
        <span>Timeline</span>
        <ZoomSlider store={zoomStore} />
        <span className="hint">Drag from the Library onto any track. Drag clips sideways or onto another track. The main track keeps clips joined; audio goes only on audio tracks.</span>
      </div>
      <div className="tl-wrap">
        <div className="tl-labels">
          <div className="ruler" />
          {visualTracks.map((tr, n) => <TrackHead key={tr.id} name={tr.role === "captions" ? "Captions" : tr.role === "effects" ? "Effects" : `Track ${visualTracks.length - n + 1}`} kind="visual" state={tr} onToggle={(k) => act.toggleTrack(tr.id, k)} />)}
          <TrackHead name="Main" kind="main" state={p.main ?? {}} onToggle={(k) => act.toggleTrack("main", k)} />
          {audioTracks.map((tr, n) => <TrackHead key={tr.id} name={`Audio ${n + 1}`} kind="audio" state={tr} onToggle={(k) => act.toggleTrack(tr.id, k)} />)}
          <div className="track new">New</div>
        </div>
        <div className="tl-scroll" ref={scrollRef}>
          <div className="tl" style={{ width, "--z": zoom } as React.CSSProperties} ref={trackRef}>
            <Ruler zoom={zoom} length={length} left={view.left} view={view.w} onScrub={act.scrub} />
            {visualTracks.map((tr, n) => (
              <div key={tr.id} className={rowClass(tr.id, `visual ${rowState(tr.id)}`)} data-label={`Track ${visualTracks.length - n + 1}`} {...rowEvents(tr.id)}>
                {p.overlays.filter((o) => o.track === tr.id).map((o) => (
                  <OverlayBlock key={o.id} o={o} sel={isSel(o.id)} lost={hasFile(o) && missing(o.src)} act={act} />
                ))}
              </div>
            ))}
            <div className={rowClass("main", `main ${rowState("main")}`)} data-label="Main" {...rowEvents("main")}>
              {p.clips.map((c, i) => <ClipBlock key={c.id} c={c} i={i} start={starts[i] ?? 0} sel={isSel(c.id)} lost={missing(c.src)} fade={transitionDur(p, i)} act={act} />)}
              {/* the joins between clips: click one, then pick a transition (CapCut's button between clips) */}
              {p.clips.slice(1).map((c, k) => {
                const d = transitionDur(p, k + 1);
                const def = c.transition ? transitionDef(c.transition.type) : undefined;
                return (
                  <button key={`join:${c.id}`} data-join={c.id} className={`join ${d > 0 ? "on" : ""} ${join === c.id ? "picked" : ""}`} style={{ "--s": (starts[k + 1] ?? 0) + d / 2 } as React.CSSProperties}
                    title={def ? `${def.label}, ${d.toFixed(1)} s. Click to change` : "Add a transition here"} aria-label={def ? `Transition: ${def.label}` : "Add a transition here"}
                    onPointerDown={(e) => e.stopPropagation()} onClick={() => act.pickJoin(c.id)}>{d > 0 ? "⇄" : "+"}</button>
                );
              })}
              {mainLength(p) === 0 && <span className="empty">Drop video or images here</span>}
            </div>
            {audioTracks.map((tr, n) => (
              <div key={tr.id} className={rowClass(tr.id, `audio ${rowState(tr.id)}`)} data-label={`Audio ${n + 1}`} {...rowEvents(tr.id)}>
                {p.audios.filter((a) => a.track === tr.id).map((a) => <AudioBlock key={a.id} a={a} sel={isSel(a.id)} lost={missing(a.src)} act={act} />)}
              </div>
            ))}
            <div className={rowClass("new", "new")} data-label="New" {...rowEvents("new")}>
              <span className="empty">Drop here for a new track</span>
            </div>
            <Playhead time={time} zoom={zoom} onScrub={act.scrub} />
          </div>
        </div>
      </div>
    </>
  );
});

/** the move / resize / rotate box over the selected item on the preview; follows the playhead on its own */
type SelRect = { left: number; top: number; width: number; height: number; rot: number };
function SelectionBox({ time, rectAt, onPress }: { time: Store<number>; rectAt: (t: number) => SelRect | null; onPress: (e: React.PointerEvent, mode: "move" | "scale" | "turn") => void }) {
  const b = rectAt(useValue(time));
  if (!b) return null;
  return (
    <div className="tbox" style={{ left: b.left, top: b.top, width: b.width, height: b.height, transform: `rotate(${b.rot}deg)` }} onPointerDown={(e) => onPress(e, "move")}>
      {(["nw", "ne", "sw", "se"] as const).map((c) => (
        <span key={c} className={`corner ${c}`} title="Drag to resize" onPointerDown={(e) => onPress(e, "scale")} />
      ))}
      <span className="turn" title="Drag to rotate (hold Shift for 15° steps)" onPointerDown={(e) => onPress(e, "turn")}>⟳</span>
    </div>
  );
}

/** a small box drawn in the shape of a ratio, for the ratio menu */
const RatioIcon = ({ aspect }: { aspect: string }) => {
  const [w, h] = aspect.split(":").map(Number);
  const r = w && h ? w / h : 1;
  return <i className="ratio-icon" style={{ width: r >= 1 ? 22 : Math.round(22 * r), height: r >= 1 ? Math.round(22 / r) : 22 }} />;
};

/** Something on the timeline: a main-track clip, an item on a visual track, or an audio clip. */
type Ref = { type: "clip" | "overlay" | "audio"; id: string };
/** Where a drag would land: a track, the main track, or a new track. */
type RowId = string; // track id, "main" or "new"

export function OwnEditor() {
  /** how many times the whole editor has rendered (read by the speed checks) */
  const renders = useRef(0);
  renders.current++;
  const h = useHistory();
  const p = h.project;
  const total = totalDuration(p);

  /** the playhead time and the timeline zoom (px per second), outside React state; see createStore */
  const clock = useMemo(() => createStore(0), []);
  const zoomStore = useMemo(() => createStore(60), []);
  const [playing, setPlaying] = useState(false);
  /** everything selected on the timeline; the last one picked is the one the Inspector shows */
  const [selected, setSelected] = useState<Ref[]>([]);
  const sel = selected[selected.length - 1] ?? null;
  /** the join picked for a transition (id of the clip after it); selecting an item clears it */
  const [join, setJoin] = useState<string | null>(null);
  const setSel = useCallback((r: Ref | null) => (setSelected(r ? [r] : []), setJoin(null)), []);
  const isSel = (id: string) => selected.some((x) => x.id === id);
  /** box selection: a rectangle dragged over empty timeline */
  const [box, setBox] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  /** a Library file playing in the player, before it is put on the timeline */
  const [libPreview, setLibPreview] = useState<Media | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** row the pointer is over during a drag, and whether the dragged thing may go there */
  const [hover, setHoverState] = useState<{ row: RowId; ok: boolean } | null>(null);
  /** only re-render when the drop target really changes, not on every pointer move */
  const setHover = useCallback((next: { row: RowId; ok: boolean } | null) =>
    setHoverState((cur) => (cur === next || (cur && next && cur.row === next.row && cur.ok === next.ok) ? cur : next)), []);
  const [library, setLibrary] = useState<Media[]>(loadLibrary);
  /** files being imported, by name, with what is happening to them; shown as rows in the Library */
  const [pending, setPending] = useState<Record<string, { kind: Media["kind"]; step: string }>>({});
  const stepOf = (name: string, kind: Media["kind"], step: string | null) =>
    setPending((cur) => {
      const next = { ...cur };
      if (step) next[name] = { kind, step };
      else delete next[name];
      return next;
    });
  const librarySrcs = useMemo(() => new Set(library.map((m) => m.src)), [library]);
  const libRef = useRef(library);
  libRef.current = library;
  /** the file the preview plays: the light proxy once the server has made it, else the original */
  const viewSrc = (src: string) => libRef.current.find((m) => m.src === src)?.proxy ?? src;
  /** ask the server for the preview proxy of an uploaded video and wait for it (it is made in the background) */
  const watchProxy = useCallback(async (src: string) => {
    for (let i = 0; i < 900; i++) {
      const r = (await fetch("/api/proxy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ src }) })
        .then((x) => x.json())
        .catch(() => ({ status: "failed" }))) as { status: string; proxy?: string };
      if (r.status === "ready" && r.proxy) return void setLibrary((lib) => lib.map((m) => (m.src === src ? { ...m, proxy: r.proxy } : m)));
      if (r.status !== "working") return;
      await new Promise((ok) => setTimeout(ok, 1500));
    }
  }, []);
  // files imported before proxies existed (or while the server was making one) get theirs now
  useEffect(() => {
    for (const m of libRef.current) if (m.kind === "video" && !m.proxy && m.src.startsWith("/out/uploads/")) void watchProxy(m.src);
  }, [watchProxy]);
  useEffect(() => {
    try {
      localStorage.setItem(LIBRARY_KEY, JSON.stringify(library));
    } catch {
      /* ignore */
    }
  }, [library]);
  const [libTab, setLibTab] = useState<"media" | "audio" | "transitions" | "effects">("media");
  /** the Library item being dragged, drawn next to the pointer */
  const [ghost, setGhost] = useState<{ name: string; kind: Media["kind"]; x: number; y: number } | null>(null);

  const tRef = useRef(0);
  const playRef = useRef(false);
  const pRef = useRef(p);
  pRef.current = p;
  playRef.current = playing;

  const seek = useCallback((next: number) => {
    tRef.current = Math.max(0, Math.min(totalDuration(pRef.current), next));
    clock.set(tRef.current);
  }, [clock]);

  // ------------------------------------------------------------------ preview
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** one <video> per video item on the timeline (the same file can play at two places at once) */
  const videos = useRef(new Map<string, HTMLVideoElement>());
  const audioEls = useRef(new Map<string, HTMLAudioElement>());
  /** copy of the last main-track frame drawn, shown while the browser is busy seeking */
  const lastFrame = useRef<HTMLCanvasElement | null>(null);
  /** the two clips' pictures during a transition */
  const transA = useRef<HTMLCanvasElement | null>(null);
  const transB = useRef<HTMLCanvasElement | null>(null);
  /** which picture lastFrame holds, so it is copied once per new picture and not on every frame */
  const keepKey = useRef("");
  const [W, H] = frameSize(p, 720);
  const [ratioOpen, setRatioOpen] = useState(false);
  const playerRef = useRef<HTMLDivElement>(null);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void playerRef.current?.requestFullscreen().catch(() => setNotice("This browser did not allow full screen."));
  };
  useEffect(() => {
    if (!ratioOpen) return;
    const close = (e: PointerEvent) => !(e.target as HTMLElement).closest(".ratio") && setRatioOpen(false);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [ratioOpen]);

  useEffect(() => void preloadOverlayAssets(p), [p]);
  useEffect(() => {
    const lost = missingFiles(pRef.current, new Set(libRef.current.map((m) => m.src)));
    if (lost.length) setNotice(missingMessage(lost));
  }, []);

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const sync = (el: HTMLMediaElement, target: number, volume: number) => {
      el.volume = Math.max(0, Math.min(1, volume));
      if (playRef.current) {
        if (el.paused) {
          el.currentTime = target;
          void el.play().catch(() => undefined);
        } else if (Math.abs(el.currentTime - target) > 0.25) el.currentTime = target;
      } else {
        if (!el.paused) el.pause();
        if (!(el as HTMLVideoElement).seeking && Math.abs(el.currentTime - target) > 0.03) el.currentTime = target;
      }
    };
    const videoFor = (key: string, original: string) => {
      const src = viewSrc(original);
      let v = videos.current.get(key);
      if (!v || !v.src.endsWith(src)) {
        v?.pause();
        v = document.createElement("video");
        v.src = src;
        v.preload = "auto";
        v.playsInline = true;
        videos.current.set(key, v);
      }
      return v;
    };
    const tick = (now: number) => {
      // cap the step: if the browser stalls frames (background tab), playback waits instead of jumping ahead
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const proj = applyTrackStates(pRef.current); // hidden and muted tracks
      const dur = totalDuration(proj);
      if (playRef.current) {
        tRef.current = Math.min(dur, tRef.current + dt);
        clock.set(tRef.current);
        if (tRef.current >= dur) setPlaying(false);
      } else if (tRef.current > dur) {
        // a trim or delete shortened the video: keep the playhead inside it
        tRef.current = dur;
        clock.set(dur);
      }
      const time = tRef.current;
      const at = Math.min(time, Math.max(0, dur - 0.001));
      const hit = clipAt(proj, at);
      // during a transition the clip before plays too; its sound fades out as the new clip's fades in
      const tr = transitionAt(proj, at);
      const live = new Set<string>();

      // main track: only the clip under the playhead plays (and the outgoing one during a transition)
      let active: HTMLVideoElement | null = null;
      let outgoing: HTMLVideoElement | null = null;
      for (const c of proj.clips) {
        if (c.kind === "image") continue;
        const v = videoFor(c.id, c.src);
        live.add(c.id);
        const vol = c.muted ? 0 : proj.originalVolume;
        if (hit && hit.clip.id === c.id) {
          active = v;
          sync(v, c.in + (time - hit.start), tr ? vol * (1 - tr.progress) : vol);
        } else if (tr && tr.from.id === c.id) {
          outgoing = v;
          sync(v, c.in + (time - tr.fromStart), vol * tr.progress);
        } else if (!v.paused) v.pause();
      }
      // a mask transition's mask video, stretched to the transition's length
      let mask: HTMLVideoElement | null = null;
      const trDef = tr ? transitionDef(tr.type) : undefined;
      if (tr && trDef?.kind === "mask" && trDef.mask) {
        mask = videoFor("mask", trDef.mask);
        live.add("mask");
        sync(mask, ((time - tr.toStart) / tr.duration) * (trDef.maskLen ?? 1), 0);
      }
      // videos on the visual tracks, and the videos some effects lay over the picture (light leak, looped)
      const pip = new Map<string, HTMLVideoElement>();
      for (const o of proj.overlays) {
        if (o.kind === "effect") {
          const def = effectDef(o.effect);
          if (!def?.asset) continue;
          const v = videoFor(o.id, def.asset);
          live.add(o.id);
          if (time >= o.start && time <= o.end) {
            sync(v, (time - o.start) % (def.assetLen ?? 1), 0);
            pip.set(o.id, v);
          } else if (!v.paused) v.pause();
          continue;
        }
        if (o.kind !== "video") continue;
        const v = videoFor(o.id, o.src);
        live.add(o.id);
        if (time >= o.start && time < o.end) {
          sync(v, o.in + (time - o.start), o.muted ? 0 : proj.originalVolume);
          pip.set(o.id, v);
        } else if (!v.paused) v.pause();
      }
      for (const [key, v] of videos.current) if (!live.has(key)) (v.pause(), videos.current.delete(key));
      // audio tracks
      const liveAudio = new Set<string>();
      for (const a of proj.audios) {
        let el = audioEls.current.get(a.id);
        if (!el || !el.src.endsWith(a.src)) {
          el?.pause();
          el = new Audio(a.src);
          el.preload = "auto";
          audioEls.current.set(a.id, el);
        }
        liveAudio.add(a.id);
        if (time >= a.start && time < a.start + audioLen(a)) sync(el, a.in + (time - a.start), a.volume);
        else if (!el.paused) el.pause();
      }
      for (const [key, el] of audioEls.current) if (!liveAudio.has(key)) (el.pause(), audioEls.current.delete(key));

      const cv = canvasRef.current;
      const ctx = cv?.getContext("2d");
      /** a main-track clip's picture now: "black" when hidden, null while its video is not ready */
      const frameOf = (c: Clip, v: HTMLVideoElement | null): { src: CanvasImageSource; w: number; h: number } | "black" | null => {
        if (c.hidden) return "black";
        if (c.kind === "image") {
          const img = getImage(c.src);
          return img ? { src: img, w: img.naturalWidth, h: img.naturalHeight } : null;
        }
        return v && v.readyState >= 2 ? { src: v, w: v.videoWidth, h: v.videoHeight } : null;
      };
      const fb = hit ? frameOf(hit.clip, active) : null;
      const fa = tr ? frameOf(tr.from, outgoing) : null;
      const showMain = !!hit && (fb !== "black" || !!tr);
      const ready = !!fb && (!tr || !!fa);
      // playing, and the next clip's video is still seeking: keep the picture already on screen for this frame
      // (no copy of every frame is needed for that while playing)
      const hold = playRef.current && showMain && !ready;
      if (cv && ctx && !hold) {
        const keep = (lastFrame.current ??= document.createElement("canvas"));
        const sameSize = keep.width === cv.width && keep.height === cv.height;
        if (ready && showMain) {
          const paint = (x: CanvasRenderingContext2D, c: Clip, fr: { src: CanvasImageSource; w: number; h: number } | "black") => {
            x.fillStyle = "#000";
            x.fillRect(0, 0, cv.width, cv.height);
            if (fr !== "black") drawMain(x, c, fr.src, fr.w, fr.h, cv.width, cv.height);
          };
          if (tr && fa) {
            const pa = (transA.current ??= document.createElement("canvas"));
            const pb = (transB.current ??= document.createElement("canvas"));
            for (const c of [pa, pb]) if (c.width !== cv.width || c.height !== cv.height) (c.width = cv.width), (c.height = cv.height);
            paint(pa.getContext("2d")!, tr.from, fa);
            paint(pb.getContext("2d")!, tr.to, fb!);
            drawTransition(ctx, tr.type, tr.progress, pa, pb, cv.width, cv.height, mask && mask.readyState >= 2 ? mask : null);
          } else paint(ctx, hit!.clip, fb!);
          // paused: keep a copy of this picture for while the next seek is on its way, once per new picture
          const key = `${hit!.clip.id}|${fb !== "black" && fb?.src === active ? active?.currentTime : "still"}|${tr ? `${outgoing?.currentTime}|${mask?.currentTime}|${tr.progress}` : ""}|${cv.width}x${cv.height}|${JSON.stringify(hit!.clip)}`;
          if (!playRef.current && keepKey.current !== key) {
            if (!sameSize) (keep.width = cv.width), (keep.height = cv.height);
            keep.getContext("2d")?.drawImage(cv, 0, 0);
            keepKey.current = key;
          }
        } else if (showMain && sameSize) {
          // mid-seek: hold the previous frame instead of flashing black
          ctx.drawImage(keep, 0, 0);
        } else {
          ctx.fillStyle = "#000";
          ctx.fillRect(0, 0, cv.width, cv.height);
        }
        drawOverlays(ctx, proj, time, cv.width, cv.height, (o) => {
          const v = pip.get(o.id);
          return v && v.readyState >= 2 ? { src: v, w: v.videoWidth, h: v.videoHeight } : null;
        });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      for (const v of videos.current.values()) v.pause();
      for (const a of audioEls.current.values()) a.pause();
    };
  }, []);

  // ------------------------------------------------------------------ select, move, resize and turn on the preview
  type Box = { cx: number; cy: number; w: number; h: number; rot: number }; // in preview canvas pixels
  /** where an item is drawn on the preview at `time`, or null when it is not on screen then */
  const boxOf = (ref: Ref, proj: Project, time: number): Box | null => {
    const [fw, fh] = frameSize(proj, 720);
    if (ref.type === "clip") {
      const hit = clipAt(proj, time);
      if (!hit || hit.clip.id !== ref.id) return null;
      const c = hit.clip;
      const img = c.kind === "image" ? getImage(c.src) : undefined;
      const v = videos.current.get(c.id);
      const sw = img?.naturalWidth || v?.videoWidth || Math.round((c.ratio ?? 16 / 9) * 1000);
      const sh = img?.naturalHeight || v?.videoHeight || 1000;
      return { ...mainRect(c, sw, sh, fw, fh), rot: c.rotation ?? 0 };
    }
    if (ref.type !== "overlay") return null;
    const o = proj.overlays.find((x) => x.id === ref.id);
    if (!o || time < o.start || time > o.end) return null;
    if (o.kind === "text") return { cx: o.x * fw, cy: o.y * fh, ...measureTitle(o, fw, fh), rot: o.rotation ?? 0 };
    if (o.kind === "effect") return null; // an effect has no box of its own on the preview
    let ratio = 16 / 9;
    const img = o.kind === "image" ? getImage(o.src) : undefined;
    const v = o.kind === "video" ? videos.current.get(o.id) : undefined;
    if (img?.naturalWidth) ratio = img.naturalWidth / img.naturalHeight;
    else if (v?.videoWidth) ratio = v.videoWidth / v.videoHeight;
    const w = o.width * fw;
    return { cx: o.x * fw, cy: o.y * fh, w, h: w / ratio, rot: o.rotation ?? 0 };
  };
  const inside = (b: Box, x: number, y: number) => {
    const a = (-b.rot * Math.PI) / 180;
    const dx = x - b.cx, dy = y - b.cy;
    return Math.abs(dx * Math.cos(a) - dy * Math.sin(a)) <= b.w / 2 && Math.abs(dx * Math.sin(a) + dy * Math.cos(a)) <= b.h / 2;
  };
  /** what is under a point of the preview now: the top visible item first, then the main-track clip */
  const itemAt = (x: number, y: number): Ref | null => {
    const proj = applyTrackStates(pRef.current);
    const time = tRef.current;
    for (const o of [...layers(proj)].reverse()) {
      const b = boxOf({ type: "overlay", id: o.id }, proj, time);
      if (b && inside(b, x, y)) return { type: "overlay", id: o.id };
    }
    const hit = clipAt(proj, time);
    if (hit && !hit.clip.hidden) {
      const b = boxOf({ type: "clip", id: hit.clip.id }, proj, time);
      if (b && inside(b, x, y)) return { type: "clip", id: hit.clip.id };
    }
    return null;
  };
  const toCanvas = (ev: { clientX: number; clientY: number }) => {
    const cv = canvasRef.current!;
    const r = cv.getBoundingClientRect();
    return { x: ((ev.clientX - r.left) * cv.width) / r.width, y: ((ev.clientY - r.top) * cv.height) / r.height };
  };
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  /**
   * Move (drag inside the box), resize (drag a corner; keeps the shape) or turn (drag the round handle) an item.
   * Moving snaps to the centre lines; turning snaps to 0 and 90 degrees, and to 15-degree steps with Shift held.
   */
  const transformItem = (e: React.PointerEvent, ref: Ref, mode: "move" | "scale" | "turn") => {
    e.preventDefault();
    e.stopPropagation();
    if (locked(rowOf(ref))) return void setNotice(LOCKED);
    const start = pRef.current;
    const box = boxOf(ref, start, tRef.current);
    if (!box) return;
    const [fw, fh] = frameSize(start, 720);
    const p0 = toCanvas(e);
    const clip0 = ref.type === "clip" ? start.clips.find((c) => c.id === ref.id) : undefined;
    const ov0 = ref.type === "overlay" ? start.overlays.find((o) => o.id === ref.id) : undefined;
    const x0 = clip0 ? clip0.x ?? 0.5 : ov0!.x;
    const y0 = clip0 ? clip0.y ?? 0.5 : ov0!.y;
    const angle = (p: { x: number; y: number }) => (Math.atan2(p.y - box.cy, p.x - box.cx) * 180) / Math.PI;
    h.checkpoint();
    const move = perFrame((ev: PointerEvent) => {
      const p1 = toCanvas(ev);
      let patch: Partial<Clip> & Record<string, number> = {};
      if (mode === "move") {
        let x = clamp(x0 + (p1.x - p0.x) / fw, -0.5, 1.5);
        let y = clamp(y0 + (p1.y - p0.y) / fh, -0.5, 1.5);
        if (Math.abs(x - 0.5) < 0.012) x = 0.5;
        if (Math.abs(y - 0.5) < 0.012) y = 0.5;
        patch = { x, y };
      } else if (mode === "scale") {
        const f = Math.hypot(p1.x - box.cx, p1.y - box.cy) / Math.max(1, Math.hypot(p0.x - box.cx, p0.y - box.cy));
        if (clip0) patch = { scale: clamp((clip0.scale ?? 1) * f, 0.1, 5) };
        else if (ov0!.kind === "text") patch = { fontSize: clamp(Math.round(ov0!.fontSize * f), 8, 400) };
        else patch = { width: clamp((ov0 as { width: number }).width * f, 0.02, 3) };
      } else {
        let deg = box.rot + angle(p1) - angle(p0);
        deg = ((((deg + 180) % 360) + 360) % 360) - 180;
        if (ev.shiftKey) deg = Math.round(deg / 15) * 15;
        else for (const snapTo of [0, 90, -90, 180, -180]) if (Math.abs(deg - snapTo) < 4) deg = snapTo;
        patch = { rotation: Math.round(deg * 10) / 10 };
      }
      const cur = pRef.current;
      h.apply(clip0
        ? { ...cur, clips: cur.clips.map((c) => (c.id === ref.id ? { ...c, ...patch } : c)) }
        : { ...cur, overlays: cur.overlays.map((o) => (o.id === ref.id ? ({ ...o, ...patch } as Overlay) : o)) });
    });
    const up = () => (move.flush(), window.removeEventListener("pointermove", move), window.removeEventListener("pointerup", up));
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  /** a press on the preview selects what is under it (and starts moving it); on empty frame it clears the selection */
  const pressPreview = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { x, y } = toCanvas(e);
    const ref = itemAt(x, y);
    if (!ref) return setSelected([]);
    setSel(ref);
    transformItem(e, ref, "move");
  };
  /** the selection box drawn over the preview at time `at`, in CSS pixels inside .preview */
  const selRectAt = (at: number): SelRect | null => {
    const cv = canvasRef.current;
    if (!sel || !cv || libPreview) return null;
    const b = boxOf(sel, applyTrackStates(p), at);
    if (!b) return null;
    const a = cv.getBoundingClientRect();
    const host = cv.parentElement!.getBoundingClientRect();
    const k = a.width / cv.width;
    return { left: a.left - host.left + (b.cx - b.w / 2) * k, top: a.top - host.top + (b.cy - b.h / 2) * k, width: b.w * k, height: b.h * k, rot: b.rot };
  };

  // ------------------------------------------------------------------ edit helpers
  const patchClip = (id: string, patch: Partial<Clip>, live = false) => {
    const next = { ...pRef.current, clips: pRef.current.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)) };
    live ? h.apply(next) : h.commit(next);
  };
  const patchOverlay = (id: string, patch: Partial<Overlay>, live = false) => {
    const next = { ...pRef.current, overlays: pRef.current.overlays.map((o) => (o.id === id ? ({ ...o, ...patch } as Overlay) : o)) };
    live ? h.apply(next) : h.commit(next);
  };
  const patchAudio = (id: string, patch: Partial<AudioItem>, live = false) => {
    const next = { ...pRef.current, audios: pRef.current.audios.map((a) => (a.id === id ? { ...a, ...patch } : a)) };
    live ? h.apply(next) : h.commit(next);
  };
  /** the row an item sits on */
  const rowOf = (r: Ref): RowId => {
    const cur = pRef.current;
    if (r.type === "clip") return "main";
    if (r.type === "overlay") return cur.overlays.find((o) => o.id === r.id)?.track ?? "main";
    return cur.audios.find((a) => a.id === r.id)?.track ?? "main";
  };
  const locked = (row: RowId) => (row === "main" ? !!pRef.current.main?.locked : !!pRef.current.tracks.find((x) => x.id === row)?.locked);
  const LOCKED = "This track is locked. Unlock it with the lock button on its left to change what is on it.";
  /** Delete everything selected, except what sits on a locked track. */
  const removeSelected = () => {
    if (!selected.length) {
      if (join) setTransition(join, undefined);
      return;
    }
    const cur = pRef.current;
    const gone = new Set(selected.filter((r) => !locked(rowOf(r))).map((r) => r.id));
    const kept = selected.length - gone.size;
    if (gone.size) h.commit({ ...cur, clips: cur.clips.filter((c) => !gone.has(c.id)), overlays: cur.overlays.filter((o) => !gone.has(o.id)), audios: cur.audios.filter((a) => !gone.has(a.id)) });
    setNotice(kept ? `${kept} item${kept > 1 ? "s" : ""} on a locked track ${kept > 1 ? "were" : "was"} kept.` : null);
    setSelected([]);
  };
  const toggleTrack = (row: RowId, key: keyof TrackState) => {
    const cur = pRef.current;
    if (key === "locked") setSelected((list) => list.filter((r) => rowOf(r) !== row));
    if (row === "main") h.commit({ ...cur, main: { ...cur.main, [key]: !cur.main?.[key] } });
    else h.commit({ ...cur, tracks: cur.tracks.map((x) => (x.id === row ? { ...x, [key]: !x[key] } : x)) });
  };
  /** width that fits a picture of this shape inside the frame */
  const fitWidth = (ratio: number | undefined, proj: Project) => {
    if (!ratio) return 1;
    const [fw, fh] = frameSize(proj, 720);
    return Math.min(1, (fh * ratio) / fw);
  };
  /** a new empty track; visual tracks go to the top (drawn over everything), audio tracks to the bottom */
  const newTrack = (proj: Project, kind: TrackKind, near?: string): [Project, string] => {
    const id = uid();
    const tracks = [...proj.tracks];
    const at = near ? tracks.findIndex((x) => x.id === near) : -1;
    if (kind === "visual") tracks.splice(at >= 0 ? at : 0, 0, { id, kind });
    else tracks.splice(at >= 0 ? at + 1 : tracks.length, 0, { id, kind });
    return [{ ...proj, tracks }, id];
  };
  const kindOfRow = (proj: Project, row: RowId): "main" | TrackKind | "new" =>
    row === "main" || row === "new" ? row : proj.tracks.find((x) => x.id === row)?.kind ?? "new";
  const itemsOn = (proj: Project) => [
    ...proj.overlays.map((o) => ({ id: o.id, track: o.track, start: o.start, end: o.end })),
    ...proj.audios.map((a) => ({ id: a.id, track: a.track, start: a.start, end: a.start + audioLen(a) })),
  ];
  /**
   * Put [start, end) on `row`. If the row is a track where it would cover something, a new track of the same kind
   * is made next to it, the way CapCut does. Returns the project with the track ready and the track id to use.
   */
  const landing = (proj: Project, row: RowId, kind: TrackKind, start: number, end: number, ignoreId?: string): [Project, string] => {
    if (row === "new") return newTrack(proj, kind);
    if (overlapsOnTrack(itemsOn(proj), row, start, end, ignoreId)) return newTrack(proj, kind, row);
    return [proj, row];
  };

  // ------------------------------------------------------------------ media
  /**
   * A file the browser cannot work with (AVI, an unsupported codec, HDR phone footage) is sent to the server,
   * which returns a plain H.264 MP4. The editor then uses that copy like any other clip.
   */
  const convertOnServer = async (src: string, name: string, _why: string) => {
    if (pending[name] || src.startsWith("blob:")) stepOf(name, "video", "Converting…");
    let remote = src;
    if (src.startsWith("blob:")) {
      const up = await fetch(`/api/upload/${encodeURIComponent(name)}`, { method: "PUT", body: await (await fetch(src)).blob() });
      remote = ((await up.json()) as { src: string }).src;
    }
    const r = await fetch("/api/convert", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ src: remote }) });
    const body = (await r.json()) as { error?: string; src: string; ms: number };
    if (!r.ok || body.error) throw new Error(body.error ?? `convert returned ${r.status}`);
    return body;
  };

  /** Check a file (converting it if needed) so it can be placed on the timeline. */
  const prepare = async (src: string, name: string, kind: Media["kind"], converted?: string): Promise<Media> => {
    if (kind === "image") {
      const img = await loadImage(src);
      return { name, src, kind, duration: IMAGE_SECONDS, hasAudio: false, ratio: img.naturalWidth / img.naturalHeight };
    }
    const info = await probe(await (await fetch(src)).blob()).catch(() => null);
    if (kind === "audio") {
      if (!info) throw new Error("the browser cannot open this audio file");
      return { name, src, kind, duration: info.duration, hasAudio: true, channels: info.channels };
    }
    const why = !info ? "the browser cannot open this file type" : !info.decodable ? `this browser cannot decode ${info.codec ?? "the video"}` : info.hdr ? "this is HDR video, which needs converting to standard colour" : null;
    if (why) {
      if (converted) throw new Error("the converted copy could not be opened either");
      const done = await convertOnServer(src, name, why);
      const media = await prepare(done.src, name, "video", "x");
      return media;
    }
    return { name, src, kind, duration: info!.duration, hasAudio: info!.hasAudio, channels: info!.channels, ratio: info!.ratio };
  };

  /** Place a Library item at `time` on `row`. Refuses with a reason if the row does not take that kind. */
  const place = (m: Media, row: RowId, time: number): boolean => {
    let proj = pRef.current;
    const rowKind = kindOfRow(proj, row);
    const reason = rowKind === "new" ? null : locked(row) ? LOCKED : refuseReason(m.kind, rowKind);
    if (reason) {
      setNotice(`${m.name}: ${reason}`);
      return false;
    }
    const start = Math.max(0, Math.round(time * 10) / 10);
    let ref: Ref;
    if (rowKind === "main") {
      const clip: Clip = { id: uid(), kind: m.kind === "image" ? "image" : "video", name: m.name, src: m.src, in: 0, out: m.duration, srcDuration: m.kind === "image" ? 3600 : m.duration, muted: false, hasAudio: m.hasAudio, channels: m.channels, ratio: m.ratio };
      const clips = [...proj.clips];
      clips.splice(insertIndexAt(proj, start), 0, clip);
      proj = { ...proj, clips };
      ref = { type: "clip", id: clip.id };
    } else if (m.kind === "audio") {
      const [next, track] = landing(proj, row, "audio", start, start + m.duration);
      const a: AudioItem = { id: uid(), track, name: m.name, src: m.src, start, in: 0, out: m.duration, srcDuration: m.duration, volume: 0.4, channels: m.channels };
      proj = { ...next, audios: [...next.audios, a] };
      ref = { type: "audio", id: a.id };
    } else {
      const [next, track] = landing(proj, row, "visual", start, start + m.duration);
      const o: Overlay = m.kind === "image"
        ? { id: uid(), track, kind: "image", src: m.src, width: Math.min(0.5, fitWidth(m.ratio, next)), x: 0.5, y: 0.5, start, end: start + m.duration }
        : { id: uid(), track, kind: "video", name: m.name, src: m.src, in: 0, srcDuration: m.duration, width: fitWidth(m.ratio, next), x: 0.5, y: 0.5, start, end: start + m.duration, muted: false, hasAudio: m.hasAudio, channels: m.channels };
      proj = { ...next, overlays: [...next.overlays, o] };
      ref = { type: "overlay", id: o.id };
    }
    h.commit(proj);
    setSel(ref);
    return true;
  };

  /**
   * "+" on a Library item: put it at the playhead. Video and images go into the main track at that exact time
   * (the clip under the playhead is split there, as CapCut does); audio goes on a free audio track or a new one.
   */
  const addAtPlayhead = (m: Media) => {
    setLibPreview(null);
    const proj = pRef.current;
    const at = Math.round(tRef.current * 10) / 10;
    if (m.kind === "audio") {
      const free = proj.tracks.find((x) => x.kind === "audio" && !x.locked && !overlapsOnTrack(itemsOn(proj), x.id, at, at + m.duration));
      place(m, free?.id ?? "new", at);
      return;
    }
    if (proj.main?.locked) return void setNotice(LOCKED);
    const split = splitAt(proj, at);
    const st = clipStarts(split);
    let idx = st.findIndex((x) => x >= at - 0.05);
    if (idx === -1) idx = split.clips.length;
    const clip: Clip = { id: uid(), kind: m.kind === "image" ? "image" : "video", name: m.name, src: m.src, in: 0, out: m.duration, srcDuration: m.kind === "image" ? 3600 : m.duration, muted: false, hasAudio: m.hasAudio, channels: m.channels, ratio: m.ratio };
    const clips = [...split.clips];
    clips.splice(idx, 0, clip);
    h.commit({ ...split, clips });
    setSel({ type: "clip", id: clip.id });
    setNotice(idx === split.clips.length && at > mainLength(proj) + 0.05 ? `${m.name} was added at the end of the main track, which has no gaps.` : null);
  };
  /** Clicking a Library item plays it in the player; it goes on the timeline only by dragging it there or with "+". */
  const previewLibrary = (m: Media) => {
    setPlaying(false);
    setLibPreview(m);
  };

  const builtIn = useRef(new Map<string, Promise<Media>>());
  /** `own`: an imported file; otherwise one of the built-in test files (they may share a name) */
  const mediaFor = (name: string, kind: Media["kind"], own = false) => {
    const mine = own ? library.find((m) => m.name === name) : undefined;
    if (mine) return Promise.resolve(mine);
    if (!builtIn.current.has(name)) builtIn.current.set(name, prepare(`/media/${name}`, name, kind));
    return builtIn.current.get(name)!;
  };

  /** files picked in a file input (the input is cleared first, so picking the same file again still imports it) */
  const onFiles = async (files: File[]) => {
    for (const f of files) {
      const url = URL.createObjectURL(f);
      blobNames.set(url, f.name);
      const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
      const kind = f.type.startsWith("video") || VIDEO_EXT.includes(ext) ? "video" : f.type.startsWith("audio") || AUDIO_EXT.includes(ext) ? "audio" : "image";
      stepOf(f.name, kind, "Checking…");
      try {
        const prepared = await prepare(url, f.name, kind);
        // keep the file: a blob: link dies when the page reloads, so store it on the server
        // (production: the browser uploads straight to S3 and the edit keeps the S3 key)
        let src = prepared.src;
        if (src.startsWith("blob:")) {
          stepOf(f.name, kind, "Saving…");
          const up = await fetch(`/api/upload/${encodeURIComponent(f.name)}`, { method: "PUT", body: f });
          if (!up.ok) throw new Error(`the server did not save it (${up.status})`);
          src = ((await up.json()) as { src: string }).src;
        }
        const m = { ...prepared, src };
        setLibrary((lib) => [...lib.filter((x) => x.name !== m.name), m]);
        // the server makes a light preview copy of big or 60 fps video in the background; the preview switches to it
        if (m.kind === "video" && src.startsWith("/out/uploads/")) void watchProxy(src);
        // clips on the timeline that lost this file (same name) point at the new copy again
        const before = new Set(libRef.current.map((x) => x.src));
        const gone = (src: string) => isMissing(src, before);
        const cur = pRef.current;
        let relinked = 0;
        const fix = <T extends { src: string }>(x: T, name: string): T => (name === m.name && gone(x.src) ? (relinked++, { ...x, src: m.src }) : x);
        const next = {
          ...cur,
          clips: cur.clips.map((c) => fix(c, c.name)),
          overlays: cur.overlays.map((o) => (!hasFile(o) ? o : fix(o, o.kind === "video" ? o.name : fileNameOf(o.src)))),
          audios: cur.audios.map((a) => fix(a, a.name)),
        };
        if (relinked) h.commit(next);
        setLibTab(m.kind === "audio" ? "audio" : "media"); // show the tab the new file is in
        // no message for a plain import (the file appears in the Library); only when red clips came back
        if (relinked) setNotice(`${m.name} is back in the Library; ${relinked} red clip${relinked > 1 ? "s use" : " uses"} it again.`);
      } catch (e) {
        const reason = e instanceof Error ? e.message.trim().split(/\r?\n/).pop() : "unknown error";
        setNotice(`${f.name}: could not be imported (${reason}).`);
      } finally {
        stepOf(f.name, kind, null);
      }
    }
  };
  /** how many places on the timeline use this file */
  const usesOf = (src: string, proj = pRef.current) =>
    proj.clips.filter((c) => c.src === src).length + proj.overlays.filter((o) => hasFile(o) && o.src === src).length + proj.audios.filter((a) => a.src === src).length;
  /** Take an imported file out of the Library. Clips that use it stay on the timeline, marked red. */
  const removeFromLibrary = (m: Media) => {
    const n = usesOf(m.src);
    if (n && !window.confirm(`${m.name} is used ${n} time${n > 1 ? "s" : ""} on the timeline. Remove it from the Library? Those clips will be marked red and the edit cannot be exported until you import the file again or delete them.`)) return;
    setLibrary((lib) => lib.filter((x) => x.src !== m.src));
    if (libPreview?.src === m.src) setLibPreview(null);
    setNotice(n ? `${m.name} was removed from the Library; ${n} clip${n > 1 ? "s are" : " is"} now red.` : `${m.name} was removed from the Library.`);
  };
  // ------------------------------------------------------------------ transitions and effects
  /** the join a transition goes on: the picked one, else the one before the selected main-track clip */
  const joinTarget = (): string | null => {
    const clips = pRef.current.clips;
    if (join && clips.some((c, i) => i > 0 && c.id === join)) return join;
    if (sel?.type === "clip") {
      const i = clips.findIndex((c) => c.id === sel.id);
      if (i > 0) return sel.id;
      if (i === 0 && clips[1]) return clips[1].id;
    }
    return null;
  };
  /** set (or with undefined remove) the transition into clip `id` */
  const setTransition = (id: string, t: { type: string; duration: number } | undefined) => {
    if (pRef.current.main?.locked) return void setNotice(LOCKED);
    const cur = pRef.current;
    const next = {
      ...cur,
      clips: cur.clips.map((c) => {
        if (c.id !== id) return c;
        const { transition: _old, ...rest } = c;
        return t ? { ...rest, transition: t } : rest;
      }),
    };
    h.commit(next);
    return next;
  };
  /** a transition picked in the Library: put it on the join, and move the playhead into it so the preview shows it */
  const applyTransition = (type: string) => {
    const id = joinTarget();
    if (!id) return void setNotice("Click the + between two clips on the main track first, then pick a transition.");
    const old = pRef.current.clips.find((c) => c.id === id)?.transition;
    const next = setTransition(id, { type, duration: old?.duration ?? DEFAULT_TRANSITION_SECONDS });
    setSelected([]);
    setJoin(id);
    if (!next) return;
    const i = next.clips.findIndex((c) => c.id === id);
    seek((clipStarts(next)[i] ?? 0) + transitionDur(next, i) / 2);
  };
  const pickJoin = (id: string) => {
    setSelected([]);
    setJoin(id);
    setLibTab("transitions");
  };
  /**
   * An effect from the Library, at the playhead for 3 s, on an Effects track at the top: it changes everything on the
   * tracks below it while it runs (CapCut's effect track).
   */
  const addEffect = (effect: string) => {
    let proj = pRef.current;
    const start = Math.round(tRef.current * 10) / 10;
    const len = totalDuration(proj);
    const end = len - start >= 1 ? Math.min(start + 3, len) : start + 3;
    let track = proj.tracks.find((x) => x.role === "effects" && !x.locked && !overlapsOnTrack(itemsOn(proj), x.id, start, end))?.id;
    if (!track) {
      track = uid();
      proj = { ...proj, tracks: [{ id: track, kind: "visual", role: "effects" }, ...proj.tracks] };
    }
    const o: EffectOverlay = { id: uid(), track, kind: "effect", effect, amount: 0.5, x: 0.5, y: 0.5, start, end };
    h.commit({ ...proj, overlays: [...proj.overlays, o] });
    setSel({ type: "overlay", id: o.id });
  };

  const addText = () => {
    const proj = pRef.current;
    const start = Math.round(tRef.current * 10) / 10;
    const top = proj.tracks.find((x) => x.kind === "visual" && x.role !== "captions");
    const [next, track] = landing(proj, top?.id ?? "new", "visual", start, start + 3);
    const o: Overlay = { id: uid(), track, kind: "text", text: "New title", fontSize: 40, color: "#FFFFFF", x: 0.5, y: 0.5, start, end: start + 3 };
    h.commit({ ...next, overlays: [...next.overlays, o] });
    setSel({ type: "overlay", id: o.id });
  };

  // ------------------------------------------------------------------ captions
  const captionTrack = (proj: Project) => proj.tracks.find((x) => x.role === "captions");
  const captionsOf = (proj: Project) => {
    const tr = captionTrack(proj);
    return tr ? proj.overlays.filter((o): o is Extract<Overlay, { kind: "text" }> => o.track === tr.id && o.kind === "text").sort((a, b) => a.start - b.start) : [];
  };
  /** the Captions track, made (at the top, drawn over everything) if there is none yet */
  const withCaptionTrack = (proj: Project): [Project, string] => {
    const tr = captionTrack(proj);
    if (tr) return [proj, tr.id];
    const id = uid();
    return [{ ...proj, tracks: [{ id, kind: "visual", role: "captions" }, ...proj.tracks] }, id];
  };
  /** the style new captions get: the last caption's, or the default (white on a dark box, near the bottom) */
  const captionStyle = (proj: Project) => {
    const last = captionsOf(proj).at(-1);
    return last ? { font: last.font, fontSize: last.fontSize, color: last.color, bg: last.bg, bgOpacity: last.bgOpacity, x: last.x, y: last.y } : CAPTION_STYLE;
  };
  /** "+ Caption": a line at the playhead, after any caption already showing there, until the next one */
  const addCaption = () => {
    let [proj, track] = withCaptionTrack(pRef.current);
    const lines = captionsOf(proj);
    let start = Math.round(tRef.current * 10) / 10;
    const covering = lines.find((c) => start >= c.start && start < c.end);
    if (covering) start = covering.end;
    const next = lines.find((c) => c.start >= start);
    const end = Math.min(start + 2.5, next ? next.start : Infinity, Math.max(totalDuration(proj), start + 2.5));
    if (end - start < 0.3) return void setNotice("There is no room for a caption here. Move the playhead to a gap between captions.");
    if (proj.tracks.find((x) => x.id === track)?.locked) return void setNotice(LOCKED);
    const o: Overlay = { id: uid(), track, kind: "text", text: "Caption", ...captionStyle(proj), start, end };
    proj = { ...proj, overlays: [...proj.overlays, o] };
    h.commit(proj);
    setSel({ type: "overlay", id: o.id });
    seek(start);
  };
  /** captions from an .srt or .vtt file; they replace the captions already there (after asking) */
  const importSubtitles = async (file: File | undefined) => {
    if (!file) return;
    const lines = parseSubtitles(await file.text());
    if (!lines.length) return void setNotice(`${file.name}: no caption lines found. Use an .srt or .vtt file.`);
    let [proj, track] = withCaptionTrack(pRef.current);
    const old = captionsOf(proj);
    if (old.length && !window.confirm(`Replace the ${old.length} caption${old.length > 1 ? "s" : ""} on the timeline with the ${lines.length} from ${file.name}?`)) return;
    const style = captionStyle(proj);
    const gone = new Set(old.map((c) => c.id));
    const added: Overlay[] = lines.map((l) => ({ id: uid(), track, kind: "text", text: l.text, ...style, start: l.start, end: l.end }));
    proj = { ...proj, overlays: [...proj.overlays.filter((o) => !gone.has(o.id)), ...added] };
    h.commit(proj);
    setSelected([]);
    const past = lines.filter((l) => l.end > totalDuration({ ...proj, overlays: proj.overlays.filter((o) => !added.includes(o)) })).length;
    if (past) setNotice(`${past} caption${past > 1 ? "s run" : " runs"} past the end of the video; the edit is longer now. Trim them or add video.`);
  };
  /** "Apply this style to all captions": font, size, colour, box and position */
  const applyStyleToCaptions = (src: Extract<Overlay, { kind: "text" }>) => {
    const cur = pRef.current;
    const ids = new Set(captionsOf(cur).map((c) => c.id));
    const style = { font: src.font, fontSize: src.fontSize, color: src.color, bg: src.bg, bgOpacity: src.bgOpacity, x: src.x, y: src.y };
    h.commit({ ...cur, overlays: cur.overlays.map((o) => (ids.has(o.id) && o.kind === "text" ? { ...o, ...style } : o)) });
  };

  // keyboard: space, S, Delete, Ctrl+Z / Ctrl+Shift+Z
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (["INPUT", "TEXTAREA", "SELECT"].includes((e.target as HTMLElement).tagName)) return;
      if (e.code === "Space") (e.preventDefault(), setPlaying((v) => !v));
      else if (e.key.toLowerCase() === "s") h.commit(splitAt(pRef.current, tRef.current));
      else if (e.key === "Delete" || e.key === "Backspace") removeSelected();
      else if (e.key.toLowerCase() === "a" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        const cur = pRef.current;
        const all: Ref[] = [
          ...cur.clips.map((c) => ({ type: "clip" as const, id: c.id })),
          ...cur.overlays.map((o) => ({ type: "overlay" as const, id: o.id })),
          ...cur.audios.map((a) => ({ type: "audio" as const, id: a.id })),
        ];
        setSelected(all.filter((r) => !locked(rowOf(r))));
      }
      else if (e.key.toLowerCase() === "z" && (e.ctrlKey || e.metaKey)) (e.preventDefault(), e.shiftKey ? h.redo() : h.undo());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ------------------------------------------------------------------ timeline dragging
  const starts = clipStarts(p);
  /** snap a timeline time to the playhead, item edges, then a 0.1 s grid */
  const snap = (time: number, ignoreId?: string) => {
    const tol = 8 / zoomStore.get();
    const cur = pRef.current;
    const points = [tRef.current, 0, mainLength(cur), ...clipStarts(cur)];
    for (const x of itemsOn(cur)) if (x.id !== ignoreId) points.push(x.start, x.end);
    for (const pt of points) if (Math.abs(pt - time) < tol) return pt;
    return Math.round(time * 10) / 10;
  };
  const trackRef = useRef<HTMLDivElement>(null);
  const timeAtPointer = (clientX: number) => Math.max(0, (clientX - (trackRef.current?.getBoundingClientRect().left ?? 0)) / zoomStore.get());
  const rowAtPointer = (x: number, y: number): RowId | null => {
    for (const el of document.elementsFromPoint(x, y)) {
      const row = (el as HTMLElement).dataset?.row;
      if (row) return row;
    }
    return null;
  };
  const kindOf = (ref: Ref, proj: Project): ItemKind | null => {
    if (ref.type === "clip") return proj.clips.find((c) => c.id === ref.id)?.kind ?? "video";
    if (ref.type === "audio") return "audio";
    return proj.overlays.find((o) => o.id === ref.id)?.kind ?? null;
  };
  const allowed = (kind: ItemKind | null, proj: Project, row: RowId) => {
    const rk = kindOfRow(proj, row);
    return !!kind && (rk === "new" || (canPlace(kind, rk) && !locked(row)));
  };

  /**
   * Ctrl, Shift or Cmd + click adds an item to the selection or takes it out. Items on a locked track can be
   * selected but not moved. Returns true when the press should not start a drag.
   */
  const pick = (e: React.PointerEvent, ref: Ref): boolean => {
    e.stopPropagation();
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      setSelected((cur) => (cur.some((x) => x.id === ref.id) ? cur.filter((x) => x.id !== ref.id) : [...cur, ref]));
      return true;
    }
    if (locked(rowOf(ref))) {
      setSel(ref);
      setNotice(LOCKED);
      return true;
    }
    return false;
  };
  const lockedEdge = (e: React.PointerEvent, row: RowId) => {
    if (!locked(row)) return false;
    e.stopPropagation();
    setNotice(LOCKED);
    return true;
  };

  /** Drag on empty timeline to draw a box; everything it touches is selected (Ctrl/Shift adds to the selection). */
  const startBox = (e: React.PointerEvent) => {
    const el = e.target as HTMLElement;
    if (el !== e.currentTarget && !el.classList.contains("empty")) return;
    const add = e.shiftKey || e.ctrlKey || e.metaKey;
    const base = add ? selected : [];
    const x0 = e.clientX;
    const y0 = e.clientY;
    let moved = false;
    const within = (b: { x0: number; y0: number; x1: number; y1: number }) =>
      [...document.querySelectorAll<HTMLElement>(".tl .clip[data-ref]")]
        .filter((c) => {
          const r = c.getBoundingClientRect();
          return r.right > Math.min(b.x0, b.x1) && r.left < Math.max(b.x0, b.x1) && r.bottom > Math.min(b.y0, b.y1) && r.top < Math.max(b.y0, b.y1);
        })
        .map((c) => {
          const [type, id] = c.dataset.ref!.split(":") as [Ref["type"], string];
          return { type, id };
        })
        .filter((r) => !locked(rowOf(r)));
    const move = perFrame((ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
      moved = true;
      const b = { x0, y0, x1: ev.clientX, y1: ev.clientY };
      setBox(b);
      const hits = within(b);
      setSelected([...base.filter((r) => !hits.some((x) => x.id === r.id)), ...hits]);
    });
    const up = () => {
      move.flush();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setBox(null);
      if (!moved && !add) setSelected([]); // a click on empty timeline clears the selection
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const drag = (e: React.PointerEvent, onMove: (dxSeconds: number, ev: PointerEvent) => void, onEnd?: (ev: PointerEvent, before: Project) => void) => {
    e.stopPropagation();
    e.preventDefault();
    const x0 = e.clientX;
    const before = pRef.current;
    const zoom = zoomStore.get();
    h.checkpoint();
    // once a frame at most: on a slow laptop pointer moves arrive faster than the page can redraw
    const move = perFrame((ev: PointerEvent) => onMove((ev.clientX - x0) / zoom, ev));
    const up = (ev: PointerEvent) => {
      move.flush();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setHover(null);
      onEnd?.(ev, before);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const showHover = (ref: Ref, ev: PointerEvent) => {
    const row = rowAtPointer(ev.clientX, ev.clientY);
    setHover(row ? { row, ok: allowed(kindOf(ref, pRef.current), pRef.current, row) } : null);
  };

  /** Move an item to another row (and convert it between main-track clip and track item when needed). */
  const moveToRow = (ref: Ref, row: RowId, at: number, before: Project) => {
    const cur = pRef.current;
    const kind = kindOf(ref, cur);
    const rk = kindOfRow(cur, row);
    const reason = rk === "new" || !kind ? null : locked(row) ? LOCKED : refuseReason(kind, rk);
    if (reason) {
      h.apply(before); // undo the drag
      setNotice(reason);
      return;
    }
    setNotice(null);
    if (ref.type === "clip") {
      const c = cur.clips.find((x) => x.id === ref.id)!;
      const len = clipLen(c);
      const rest = { ...cur, clips: cur.clips.filter((x) => x.id !== c.id) };
      const [next, track] = landing(rest, row, "visual", at, at + len);
      const o: Overlay = c.kind === "image"
        ? { id: c.id, track, kind: "image", src: c.src, width: 0.5, x: 0.5, y: 0.5, start: at, end: at + len }
        : { id: c.id, track, kind: "video", name: c.name, src: c.src, in: c.in, srcDuration: c.srcDuration, width: 1, x: 0.5, y: 0.5, start: at, end: at + len, muted: c.muted, hasAudio: c.hasAudio, channels: c.channels };
      h.apply({ ...next, overlays: [...next.overlays, o] });
      setSel({ type: "overlay", id: o.id });
    } else if (ref.type === "overlay") {
      const o = cur.overlays.find((x) => x.id === ref.id)!;
      const len = o.end - o.start;
      if (rk === "main") {
        if (o.kind === "text" || o.kind === "effect") return;
        const clip: Clip = o.kind === "video"
          ? { id: o.id, kind: "video", name: o.name, src: o.src, in: o.in, out: o.in + len, srcDuration: o.srcDuration, muted: o.muted, hasAudio: o.hasAudio, channels: o.channels }
          : { id: o.id, kind: "image", name: o.src.split("/").pop() ?? "image", src: o.src, in: 0, out: len, srcDuration: 3600, muted: false, hasAudio: false };
        const rest = { ...cur, overlays: cur.overlays.filter((x) => x.id !== o.id) };
        const clips = [...rest.clips];
        clips.splice(insertIndexAt(rest, at), 0, clip);
        h.apply({ ...rest, clips });
        setSel({ type: "clip", id: clip.id });
      } else {
        const [next, track] = landing(cur, row, "visual", o.start, o.end, o.id);
        h.apply({ ...next, overlays: next.overlays.map((x) => (x.id === o.id ? { ...x, track } : x)) });
      }
    } else {
      const a = cur.audios.find((x) => x.id === ref.id)!;
      const [next, track] = landing(cur, row, "audio", a.start, a.start + audioLen(a), a.id);
      h.apply({ ...next, audios: next.audios.map((x) => (x.id === a.id ? { ...x, track } : x)) });
    }
  };

  /** Main-track clip: drop on the main track to reorder (clips stay joined), or on another track to move it there. */
  const grabClip = (e: React.PointerEvent, i: number) => {
    const ref: Ref = { type: "clip", id: p.clips[i]!.id };
    if (pick(e, ref)) return;
    setSel(ref);
    drag(e, (_dx, ev) => showHover(ref, ev), (ev, before) => {
      if (Math.abs(ev.clientX - e.clientX) < 6 && Math.abs(ev.clientY - e.clientY) < 6) return;
      const row = rowAtPointer(ev.clientX, ev.clientY) ?? "main";
      const at = timeAtPointer(ev.clientX);
      if (row === "main") {
        const cur = pRef.current;
        let to = insertIndexAt(cur, at);
        if (to > i) to -= 1;
        if (to !== i) h.apply(moveClip(cur, i, to));
      } else moveToRow(ref, row, snap(Math.max(0, at - clipLen(p.clips[i]!) / 2)), before);
    });
  };
  /** Item on a visual track: slide in time while dragging; drop on another row to move it there. */
  const grabOverlay = (e: React.PointerEvent, o: Overlay) => {
    const ref: Ref = { type: "overlay", id: o.id };
    if (pick(e, ref)) return;
    setSel(ref);
    const len = o.end - o.start;
    drag(e, (dx, ev) => {
      const s = Math.max(0, snap(o.start + dx, o.id));
      patchOverlay(o.id, { start: s, end: s + len }, true);
      showHover(ref, ev);
    }, (ev, before) => {
      const row = rowAtPointer(ev.clientX, ev.clientY) ?? o.track;
      const now = pRef.current.overlays.find((x) => x.id === o.id);
      if (!now) return;
      if (row !== o.track) moveToRow(ref, row, now.start, before);
      else if (overlapsOnTrack(itemsOn(pRef.current), o.track, now.start, now.end, o.id)) moveToRow(ref, o.track, now.start, before);
    });
  };
  const grabAudio = (e: React.PointerEvent, a: AudioItem) => {
    const ref: Ref = { type: "audio", id: a.id };
    if (pick(e, ref)) return;
    setSel(ref);
    drag(e, (dx, ev) => {
      patchAudio(a.id, { start: Math.max(0, snap(a.start + dx, a.id)) }, true);
      showHover(ref, ev);
    }, (ev, before) => {
      const row = rowAtPointer(ev.clientX, ev.clientY) ?? a.track;
      const now = pRef.current.audios.find((x) => x.id === a.id);
      if (!now) return;
      if (row !== a.track) moveToRow(ref, row, now.start, before);
      else if (overlapsOnTrack(itemsOn(pRef.current), a.track, now.start, now.start + audioLen(now), a.id)) moveToRow(ref, a.track, now.start, before);
    });
  };

  const trimClip = (e: React.PointerEvent, c: Clip, i: number, edge: "in" | "out") => {
    if (lockedEdge(e, "main")) return;
    const start = starts[i] ?? 0;
    drag(e, (dx) => {
      if (edge === "out") {
        const end = snap(start + clipLen(c) + dx);
        patchClip(c.id, { out: Math.min(c.srcDuration, Math.max(c.in + 0.2, c.in + (end - start))) }, true);
      } else if (c.kind === "image") {
        patchClip(c.id, { out: Math.max(0.2, Math.round((c.out - dx) * 10) / 10) }, true);
      } else {
        patchClip(c.id, { in: Math.min(c.out - 0.2, Math.max(0, Math.round((c.in + dx) * 10) / 10)) }, true);
      }
    });
  };
  const trimOverlay = (e: React.PointerEvent, o: Overlay, edge: "start" | "end") => {
    if (lockedEdge(e, o.track)) return;
    setSel({ type: "overlay", id: o.id });
    drag(e, (dx) => {
      if (edge === "start") {
        // a video keeps its picture in place: moving the start edge right skips that much of the source
        const minStart = o.kind === "video" ? o.start - o.in : 0;
        const s = Math.min(o.end - 0.2, Math.max(minStart, snap(o.start + dx, o.id)));
        patchOverlay(o.id, o.kind === "video" ? { start: s, in: o.in + (s - o.start) } : { start: s }, true);
      } else {
        const maxEnd = o.kind === "video" ? o.start + (o.srcDuration - o.in) : Infinity;
        patchOverlay(o.id, { end: Math.min(maxEnd, Math.max(o.start + 0.2, snap(o.end + dx, o.id))) }, true);
      }
    });
  };
  const trimAudio = (e: React.PointerEvent, a: AudioItem, edge: "start" | "end") => {
    if (lockedEdge(e, a.track)) return;
    setSel({ type: "audio", id: a.id });
    drag(e, (dx) => {
      if (edge === "start") {
        const s = Math.min(a.start + audioLen(a) - 0.2, Math.max(a.start - a.in, snap(a.start + dx, a.id)));
        patchAudio(a.id, { start: s, in: a.in + (s - a.start) }, true);
      } else {
        const end = snap(a.start + audioLen(a) + dx, a.id);
        patchAudio(a.id, { out: Math.min(a.srcDuration, Math.max(a.in + 0.2, a.in + (end - a.start))) }, true);
      }
    });
  };
  const scrub = (e: React.PointerEvent) => {
    e.stopPropagation();
    setLibPreview(null);
    seek(timeAtPointer(e.clientX));
    const move = perFrame((ev: PointerEvent) => seek(timeAtPointer(ev.clientX)));
    const up = () => (move.flush(), window.removeEventListener("pointermove", move), window.removeEventListener("pointerup", up));
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /**
   * Drag from the Library: press, move onto a track, release. A press without movement is a click (adds it where
   * it usually goes). Pointer events, not HTML5 drag, so it behaves like the timeline drags and works on touch.
   */
  const grabLibrary = (e: React.PointerEvent, m: { name: string; kind: Media["kind"]; own: boolean }) => {
    e.preventDefault();
    const x0 = e.clientX;
    const y0 = e.clientY;
    let moved = false;
    const move = perFrame((ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
      moved = true;
      setGhost({ ...m, x: ev.clientX, y: ev.clientY });
      const row = rowAtPointer(ev.clientX, ev.clientY);
      setHover(row ? { row, ok: allowed(m.kind, pRef.current, row) } : null);
    });
    const up = async (ev: PointerEvent) => {
      move.flush();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setGhost(null);
      setHover(null);
      try {
        const media = await mediaFor(m.name, m.kind, m.own);
        if (!moved) return previewLibrary(media);
        const row = rowAtPointer(ev.clientX, ev.clientY);
        if (!row) return;
        const at = timeAtPointer(ev.clientX);
        place(media, row, row === "main" ? at : snap(at));
      } catch (err) {
        setNotice(`${m.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // ------------------------------------------------------------------ export
  const [res, setRes] = useState<720 | 1080>(720);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [results, setResults] = useState<(ExportResult | { engine: string; error: string })[]>([]);
  const [lastUrl, setLastUrl] = useState<string | null>(null);
  const resultRef = useRef<HTMLVideoElement>(null);
  const [playNonce, setPlayNonce] = useState(0);
  // "Play" on a result: show that export and start it from the beginning
  useEffect(() => {
    const v = resultRef.current;
    if (!playNonce || !v) return;
    v.currentTime = 0;
    void v.play().catch(() => setNotice("The browser did not start playback; press play on the video."));
  }, [playNonce]);
  const engines = { mediabunny: exportMediabunny, wasm: exportFfmpegWasm, server: exportServer } as const;
  const runExport = async (key: keyof typeof engines, force = false) => {
    const lost = missingFiles(pRef.current, new Set(libRef.current.map((m) => m.src)));
    if (lost.length) {
      const err = { engine: key, error: "Cannot export: " + missingMessage(lost) };
      setResults((prev) => [...prev, err]);
      setNotice(missingMessage(lost));
      return err;
    }
    if (key === "mediabunny" && (pRef.current.clips.some((c) => c.transition) || pRef.current.overlays.some((o) => o.kind === "effect"))) {
      const err = { engine: key, error: "The browser export (Mediabunny) does not draw transitions and effects. Export with Server: FFmpeg." };
      setResults((prev) => [...prev, err]);
      return err;
    }
    const length = totalDuration(pRef.current);
    if (key !== "server" && length > BROWSER_EXPORT_MAX_SECONDS && !force) {
      setNotice(`This edit is ${Math.round(length)} s long. Edits over ${BROWSER_EXPORT_MAX_SECONDS} s are exported on the server, which is several times faster for long videos.`);
      key = "server";
    }
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
      setProject: (next: Project) => h.commit(normalizeProject(next)),
      run: runExport,
      seek,
      split: () => h.commit(splitAt(pRef.current, tRef.current)),
      undo: h.undo,
      redo: h.redo,
      // state of the real media elements behind the preview, for checks
      renders: () => renders.current,
      media: () => {
        const firstAudio = [...audioEls.current.values()][0];
        return {
          videos: [...videos.current].map(([key, v]) => ({ key, src: v.src.split("/").pop(), paused: v.paused, t: +v.currentTime.toFixed(2), volume: v.volume })),
          audios: [...audioEls.current].map(([key, a]) => ({ key, src: a.src.split("/").pop(), paused: a.paused, t: +a.currentTime.toFixed(2), volume: a.volume })),
          music: firstAudio ? { paused: firstAudio.paused, t: +firstAudio.currentTime.toFixed(2), volume: firstAudio.volume } : null,
        };
      },
    };
  });

  const selClip = sel?.type === "clip" ? p.clips.find((c) => c.id === sel.id) : undefined;
  const selOverlay = sel?.type === "overlay" ? p.overlays.find((o) => o.id === sel.id) : undefined;
  const selAudio = sel?.type === "audio" ? p.audios.find((a) => a.id === sel.id) : undefined;
  const joinIndex = !sel && join ? p.clips.findIndex((c, i) => i > 0 && c.id === join) : -1;
  const joinClip = joinIndex > 0 ? p.clips[joinIndex] : undefined;
  const joinLen = joinClip ? transitionDur(p, joinIndex) : 0;
  const targetJoin = joinTarget();
  /** stable handlers for the memoised timeline */
  const act = useActions<TimelineActions>({ grabClip, trimClip, grabOverlay, trimOverlay, grabAudio, trimAudio, startBox, scrub, toggleTrack, pickJoin });
  const pressBox = (e: React.PointerEvent, mode: "move" | "scale" | "turn") => sel && transformItem(e, sel, mode);
  /** typing in a text field: one Undo step per burst, the edit gets the text a moment after the keys stop */
  const typeText = (id: string) => ({ onStart: h.checkpoint, onLive: (text: string) => patchOverlay(id, { text }, true) });
  const libItems: { name: string; kind: Media["kind"]; own: boolean; src: string }[] = [
    ...BUILT_IN.map((m) => ({ name: m.name, kind: m.kind, own: false, src: `/media/${m.name}` })),
    ...library.map((m) => ({ name: m.name, kind: m.kind, own: true, src: m.src })),
  ];

  return (
    <div className="own">
      <div className="bar">
        <button onClick={() => h.commit(splitAt(p, tRef.current))} title="S">Split at playhead</button>
        <button onClick={removeSelected} disabled={!selected.length}>{selected.length > 1 ? `Delete ${selected.length}` : "Delete"}</button>
        <button onClick={h.undo} disabled={!h.canUndo}>Undo</button>
        <button onClick={h.redo} disabled={!h.canRedo}>Redo</button>
        <button onClick={() => (setPlaying(false), setSel(null), h.commit(SAMPLE), seek(0))} title="Back to the sample edit (Undo brings your edit back)">Reset</button>
        <span className="sep" />
        <button onClick={addText}>+ Text</button>
        <button onClick={addCaption} title="A caption line at the playhead, on the Captions track">+ Caption</button>
        <label className="file">Import files
          <input type="file" multiple accept="video/*,image/*,audio/*,.avi,.mkv,.mov,.m4v,.3gp" onChange={(e) => { const picked = [...(e.target.files ?? [])]; e.target.value = ""; void onFiles(picked); }} />
        </label>
        <span className="saved">{h.savedAt ? `Draft saved ${h.savedAt}` : "Not saved yet"}</span>
      </div>
      {/* floats over the page so a message never pushes the timeline down under the pointer */}
      {notice && (
        <div className="notice" role="status">
          <span>{notice}</span>
          <button onClick={() => setNotice(null)} aria-label="Dismiss message">×</button>
        </div>
      )}
      {box && (
        <div className="marquee" style={{ left: Math.min(box.x0, box.x1), top: Math.min(box.y0, box.y1), width: Math.abs(box.x1 - box.x0), height: Math.abs(box.y1 - box.y0) }} />
      )}
      {ghost && (
        <div className={`ghost ${hover && !hover.ok ? "bad" : ""}`} style={{ left: ghost.x + 12, top: ghost.y + 8 }}>
          <span className={`tag ${ghost.kind}`}>{ghost.kind}</span> {ghost.name}
          {hover && !hover.ok && <em> cannot go here</em>}
        </div>
      )}

      <div className="stage">
        <aside className="panel">
          <h4>Library</h4>
          {/* Media (video and images, which share tracks), Audio, Transitions and Effects, as tabs like CapCut */}
          <div className="lib-tabs four" role="tablist">
            {(["media", "audio", "transitions", "effects"] as const).map((tab) => (
              <button key={tab} role="tab" aria-selected={libTab === tab} className={libTab === tab ? "on" : ""} onClick={() => setLibTab(tab)}>
                {tab[0]!.toUpperCase() + tab.slice(1)}{" "}
                <span className="count">{tab === "transitions" ? TRANSITIONS.length : tab === "effects" ? EFFECTS.length : libItems.filter((m) => (m.kind === "audio") === (tab === "audio")).length}</span>
              </button>
            ))}
          </div>
          {libTab === "transitions" && (
            <>
              <p className="hint">{targetJoin ? "Pick a transition for the join that is marked on the timeline." : "First click the + between two clips on the main track, then pick a transition."}</p>
              <div className="lib-list">
                {TRANSITIONS.map((t) => {
                  const on = !!targetJoin && p.clips.find((c) => c.id === targetJoin)?.transition?.type === t.id;
                  return (
                    <div key={t.id} className={`lib fx ${on ? "playing" : ""}`} role="button" tabIndex={0} title={`${t.label}: put it on the picked join`}
                      onClick={() => applyTransition(t.id)} onKeyDown={(e) => e.key === "Enter" && applyTransition(t.id)}>
                      <span className="tag fx">{t.kind === "mask" ? "mask" : "move"}</span> <span className="lib-name">{t.label}</span>
                      {on && <span className="added">On</span>}
                    </div>
                  );
                })}
              </div>
            </>
          )}
          {libTab === "effects" && (
            <>
              <p className="hint">Adds the effect at the playhead for 3 s, on an Effects track. It changes everything on the tracks below it.</p>
              <div className="lib-list">
                {EFFECTS.map((e) => (
                  <div key={e.id} className="lib fx" role="button" tabIndex={0} title={`${e.label}: add at the playhead`}
                    onClick={() => addEffect(e.id)} onKeyDown={(ev) => ev.key === "Enter" && addEffect(e.id)}>
                    <span className="tag effect">effect</span> <span className="lib-name">{e.label}</span>
                    <button className="lib-add" aria-label={`Add ${e.label} at the playhead`} title="Add at the playhead" onClick={(ev) => (ev.stopPropagation(), addEffect(e.id))}>+</button>
                  </div>
                ))}
              </div>
            </>
          )}
          {(libTab === "media" || libTab === "audio") && (
            <>
          <label className="file lib-import">{libTab === "media" ? "+ Import video or image" : "+ Import audio"}
            <input
              type="file"
              multiple
              accept={libTab === "media" ? "video/*,image/*,.avi,.mkv,.mov,.m4v,.3gp" : "audio/*,.mp3,.wav,.ogg,.m4a,.aac,.flac,.opus"}
              onChange={(e) => { const picked = [...(e.target.files ?? [])]; e.target.value = ""; void onFiles(picked); }}
            />
          </label>
          <div className="lib-list">
            {Object.entries(pending).filter(([, x]) => (x.kind === "audio") === (libTab === "audio")).map(([name, x]) => (
              <div key={`pending:${name}`} className="lib pending" aria-busy="true">
                <span className="spinner" aria-hidden="true" /> <span className="lib-name">{name}</span> <span className="step">{x.step}</span>
              </div>
            ))}
            {libItems.filter((m) => (m.kind === "audio") === (libTab === "audio")).map((m) => (
              <div key={`${m.own ? "own" : "builtin"}:${m.name}`} className={`lib ${m.own ? "own" : ""} ${libPreview?.name === m.name ? "playing" : ""}`} role="button" tabIndex={0} title={`${m.name}: click to play, drag onto the timeline`}
                onPointerDown={(e) => grabLibrary(e, m)}
                onKeyDown={(e) => e.key === "Enter" && void mediaFor(m.name, m.kind, m.own).then(previewLibrary)}>
                <span className={`tag ${m.kind}`}>{m.kind}</span> <span className="lib-name">{m.name}</span>
                {usesOf(m.src, p) > 0 && <span className="added" title={`Used ${usesOf(m.src, p)} time(s) on the timeline`}>Added</span>}
                <button className="lib-add" aria-label={`Add ${m.name} at the playhead`} title="Add at the playhead"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => void mediaFor(m.name, m.kind, m.own).then(addAtPlayhead).catch((err: unknown) => setNotice(`${m.name}: ${String(err)}`))}>+</button>
                {m.own && (
                  <button className="lib-remove" aria-label={`Remove ${m.name} from the Library`} title="Remove from the Library"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => { const mine = library.find((x) => x.src === m.src); if (mine) removeFromLibrary(mine); }}>×</button>
                )}
              </div>
            ))}
          </div>
          <p className="hint">Click to play. Drag onto the timeline, or press + to add at the playhead.</p>
            </>
          )}
        </aside>

        <div className="player" ref={playerRef}>
          <div className="preview">
            <canvas ref={canvasRef} width={W} height={H} onPointerDown={pressPreview} style={{ aspectRatio: `${W} / ${H}` }} />
            <SelectionBox time={clock} rectAt={selRectAt} onPress={pressBox} />
            {libPreview && (
              <div className="lib-preview">
                {libPreview.kind === "video" && <video key={libPreview.src} src={libPreview.proxy ?? libPreview.src} controls autoPlay playsInline />}
                {libPreview.kind === "image" && <img src={libPreview.src} alt={libPreview.name} />}
                {libPreview.kind === "audio" && (
                  <div className="audio-prev"><b>{libPreview.name}</b><audio key={libPreview.src} src={libPreview.src} controls autoPlay /></div>
                )}
                <div className="lib-preview-bar">
                  <span />
                  <button onClick={() => addAtPlayhead(libPreview)}>+ Add at playhead</button>
                  <button onClick={() => setLibPreview(null)} aria-label="Close the Library preview">Close</button>
                </div>
              </div>
            )}
          </div>
          <div className="player-bar">
            <TimeText time={clock} total={total} />
            <button className="play" onClick={() => (setLibPreview(null), setPlaying((v) => !v))} aria-label={playing ? "Pause" : "Play"} title="Space">
              {playing ? "❚❚" : "▶"}
            </button>
            <div className="player-right">
              <div className="ratio">
                <button className="ratio-btn" onClick={() => setRatioOpen((v) => !v)} aria-haspopup="menu" aria-expanded={ratioOpen} title="Frame ratio">
                  {p.aspect === "original" ? "Original" : p.aspect}
                </button>
                {ratioOpen && (
                  <div className="ratio-menu" role="menu">
                    {["original", ...RATIOS].map((a) => (
                      <button key={a} role="menuitemradio" aria-checked={p.aspect === a} className={p.aspect === a ? "on" : ""}
                        onClick={() => (h.commit({ ...p, aspect: a }), setRatioOpen(false))}>
                        <span className="tick">{p.aspect === a ? "✓" : ""}</span>
                        <span className="name">{a === "original" ? "Original" : a}</span>
                        {a === "original" ? <span className="sub">{resolveAspect({ ...p, aspect: "original" }).replace(/^(\d+):1000$/, (_m, n) => (Number(n) / 1000).toFixed(2) + ":1")}</span> : <RatioIcon aspect={a} />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button className="icon" onClick={toggleFullscreen} aria-label="Full screen" title="Full screen">⛶</button>
            </div>
          </div>
        </div>

        <aside className="panel">
          <h4>Inspector</h4>
          {selClip && (
            <div className="form">
              <b>{selClip.name}</b>
              {selClip.kind === "image" ? (
                <label>Length (s)<input type="number" step="0.1" min={0.2} value={Number(clipLen(selClip).toFixed(2))} onChange={(e) => patchClip(selClip.id, { in: 0, out: Math.max(0.2, Number(e.target.value)) })} /></label>
              ) : (
                <>
                  <label>Trim in (s)<input type="number" step="0.1" min={0} max={selClip.out - 0.2} value={Number(selClip.in.toFixed(2))} onChange={(e) => patchClip(selClip.id, { in: Number(e.target.value) })} /></label>
                  <label>Trim out (s)<input type="number" step="0.1" min={selClip.in + 0.2} max={selClip.srcDuration} value={Number(selClip.out.toFixed(2))} onChange={(e) => patchClip(selClip.id, { out: Number(e.target.value) })} /></label>
                  <label className="row"><input type="checkbox" checked={selClip.muted} onChange={(e) => patchClip(selClip.id, { muted: e.target.checked })} /> Mute original sound</label>
                </>
              )}
              <div className="seg" role="radiogroup" aria-label="In the frame">
                <span>In the frame</span>
                {(["fit", "fill"] as const).map((mode) => (
                  <button key={mode} role="radio" aria-checked={(selClip.fit ?? "fit") === mode} className={(selClip.fit ?? "fit") === mode ? "on" : ""} onClick={() => patchClip(selClip.id, { fit: mode })}>
                    {mode === "fit" ? "Fit (whole picture)" : "Fill (crop)"}
                  </button>
                ))}
              </div>
              <label>Size {Math.round((selClip.scale ?? 1) * 100)}%<input type="range" min={0.1} max={4} step={0.01} value={selClip.scale ?? 1} onChange={(e) => patchClip(selClip.id, { scale: Number(e.target.value) })} /></label>
              <label>Rotation {Math.round(selClip.rotation ?? 0)}°<input type="range" min={-180} max={180} step={1} value={selClip.rotation ?? 0} onChange={(e) => patchClip(selClip.id, { rotation: Number(e.target.value) })} /></label>
              <button onClick={() => patchClip(selClip.id, { scale: undefined, x: undefined, y: undefined, rotation: undefined })}>Reset size, position and rotation</button>
              <p className="hint">Drag it on the preview to move, its corners to resize, the round handle to rotate.</p>
            </div>
          )}
          {selOverlay?.kind === "text" && (
            <div className="form">
              <label>Text<LiveText key={selOverlay.id} value={selOverlay.text} {...typeText(selOverlay.id)} /></label>
              <label>Font
                <select value={selOverlay.font ?? DEFAULT_FONT} onChange={(e) => patchOverlay(selOverlay.id, { font: e.target.value })}>
                  {FONTS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                </select>
              </label>
              {fontFor(selOverlay.text, selOverlay.font).id !== (selOverlay.font ?? DEFAULT_FONT) && (
                <p className="hint">This font has no Hindi letters, so {fontFor(selOverlay.text, selOverlay.font).label} is used for this title.</p>
              )}
              <label>Size<input type="range" min={16} max={120} value={selOverlay.fontSize} onChange={(e) => patchOverlay(selOverlay.id, { fontSize: Number(e.target.value) })} /></label>
              <label>Rotation {Math.round(selOverlay.rotation ?? 0)}°<input type="range" min={-180} max={180} step={1} value={selOverlay.rotation ?? 0} onChange={(e) => patchOverlay(selOverlay.id, { rotation: Number(e.target.value) })} /></label>
              <label>Colour<input type="color" value={selOverlay.color} onChange={(e) => patchOverlay(selOverlay.id, { color: e.target.value.toUpperCase() })} /></label>
              <label className="row"><input type="checkbox" checked={!!selOverlay.bg} onChange={(e) => patchOverlay(selOverlay.id, e.target.checked ? { bg: "#000000", bgOpacity: 0.6 } : { bg: undefined })} /> Background box</label>
              {selOverlay.bg && (
                <div className="pair">
                  <label>Box colour<input type="color" value={selOverlay.bg} onChange={(e) => patchOverlay(selOverlay.id, { bg: e.target.value.toUpperCase() })} /></label>
                  <label>Opacity<input type="range" min={0.1} max={1} step={0.05} value={selOverlay.bgOpacity ?? 0.6} onChange={(e) => patchOverlay(selOverlay.id, { bgOpacity: Number(e.target.value) })} /></label>
                </div>
              )}
              <div className="seg" role="group" aria-label="Position">
                <span>Position (or drag it on the preview)</span>
                {([["Top", 0.12], ["Middle", 0.5], ["Bottom", 0.86]] as const).map(([label, y]) => (
                  <button key={label} className={Math.abs(selOverlay.y - y) < 0.01 && Math.abs(selOverlay.x - 0.5) < 0.01 ? "on" : ""} onClick={() => patchOverlay(selOverlay.id, { x: 0.5, y })}>{label}</button>
                ))}
              </div>
              {p.tracks.find((x) => x.id === selOverlay.track)?.role === "captions" && (
                <button onClick={() => applyStyleToCaptions(selOverlay)}>Apply this style to all captions</button>
              )}
            </div>
          )}
          {(selOverlay?.kind === "image" || selOverlay?.kind === "video") && (
            <div className="form">
              {selOverlay.kind === "video" && <b>{selOverlay.name}</b>}
              <label>Size {Math.round(selOverlay.width * 100)}% of the frame width<input type="range" min={0.02} max={2} step={0.01} value={selOverlay.width} onChange={(e) => patchOverlay(selOverlay.id, { width: Number(e.target.value) })} /></label>
              <label>Rotation {Math.round(selOverlay.rotation ?? 0)}°<input type="range" min={-180} max={180} step={1} value={selOverlay.rotation ?? 0} onChange={(e) => patchOverlay(selOverlay.id, { rotation: Number(e.target.value) })} /></label>
              {selOverlay.kind === "video" && (
                <label className="row"><input type="checkbox" checked={selOverlay.muted} onChange={(e) => patchOverlay(selOverlay.id, { muted: e.target.checked })} /> Mute its sound</label>
              )}
              <p className="hint">Drag on the preview to position. Drag its edges on the timeline to trim.</p>
            </div>
          )}
          {joinClip && (
            <div className="form">
              <b>Transition: {p.clips[joinIndex - 1]?.name} → {joinClip.name}</b>
              <label>Transition
                <select value={joinClip.transition?.type ?? ""} onChange={(e) => setTransition(joinClip.id, e.target.value ? { type: e.target.value, duration: joinClip.transition?.duration ?? DEFAULT_TRANSITION_SECONDS } : undefined)}>
                  <option value="">None</option>
                  {TRANSITIONS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                </select>
              </label>
              {joinClip.transition && (
                <>
                  <label>Length {joinLen.toFixed(1)} s
                    <input type="range" min={0.1} max={MAX_TRANSITION_SECONDS} step={0.1} value={joinClip.transition.duration}
                      onChange={(e) => setTransition(joinClip.id, { ...joinClip.transition!, duration: Number(e.target.value) })} />
                  </label>
                  {joinLen < joinClip.transition.duration - 0.05 && <p className="hint">Shortened to {joinLen.toFixed(1)} s: a transition can use at most half of each clip.</p>}
                  <p className="hint">Both clips play at once during it, so the video is {joinLen.toFixed(1)} s shorter.</p>
                  <button onClick={() => setTransition(joinClip.id, undefined)}>Remove transition</button>
                </>
              )}
            </div>
          )}
          {selOverlay?.kind === "effect" && (
            <div className="form">
              <label>Effect
                <select value={selOverlay.effect} onChange={(e) => patchOverlay(selOverlay.id, { effect: e.target.value })}>
                  {EFFECTS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                </select>
              </label>
              <label>Strength {Math.round(selOverlay.amount * 100)}%
                <input type="range" min={0} max={1} step={0.05} value={selOverlay.amount} onChange={(e) => patchOverlay(selOverlay.id, { amount: Number(e.target.value) })} />
              </label>
              <p className="hint">It changes everything on the tracks below it while it runs. Drag its ends on the timeline to change when.</p>
            </div>
          )}
          {selAudio && (
            <div className="form">
              <b>{selAudio.name}</b>
              <label>Volume<input type="range" min={0} max={1} step={0.05} value={selAudio.volume} onChange={(e) => patchAudio(selAudio.id, { volume: Number(e.target.value) })} /></label>
              <p className="hint">Drag its edges on the timeline to trim.</p>
            </div>
          )}
          {!selClip && !selOverlay && !selAudio && !joinClip && <p className="hint">Select something on the timeline.</p>}
          <h4>Captions</h4>
          <div className="form captions">
            <div className="pair">
              <button onClick={addCaption}>+ Caption</button>
              <label className="file">Import .srt
                <input type="file" accept=".srt,.vtt,text/vtt" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; void importSubtitles(f); }} />
              </label>
            </div>
            {captionsOf(p).length === 0 ? (
              <p className="hint">No captions yet. Add one at the playhead, or import an .srt or .vtt file.</p>
            ) : (
              <ol className="cap-list">
                {captionsOf(p).map((c) => (
                  <li key={c.id} className={isSel(c.id) ? "sel" : ""}>
                    <button className="cap-time" title="Go to this caption" onClick={() => (setSel({ type: "overlay", id: c.id }), seek(c.start))}>{short(c.start)}</button>
                    <LiveText aria-label={`Caption at ${short(c.start)}`} value={c.text} onFocus={() => (setSel({ type: "overlay", id: c.id }), seek(c.start))} {...typeText(c.id)} />
                  </li>
                ))}
              </ol>
            )}
          </div>
          <h4>Audio</h4>
          <div className="form">
            <label>Sound of the video clips<input type="range" min={0} max={1} step={0.05} value={p.originalVolume} onChange={(e) => h.commit({ ...p, originalVolume: Number(e.target.value) })} /></label>
          </div>
        </aside>
      </div>

      <Timeline p={p} selected={selected} join={join} hover={hover} librarySrcs={librarySrcs} zoomStore={zoomStore} time={clock} act={act} trackRef={trackRef} />

      <div className="export">
        <h4>Export</h4>
        <label>Resolution{" "}
          <select value={res} onChange={(e) => setRes(Number(e.target.value) as 720 | 1080)}>
            <option value={720}>720p</option><option value={1080}>1080p</option>
          </select>
        </label>
        <button disabled={!!busy} onClick={() => void runExport("server")}>Server: FFmpeg</button>
        <button disabled={!!busy} className="minor" onClick={() => void runExport("wasm")} title="Kept for comparison only: slowest engine, and on one real clip its cuts landed 3 frames late">ffmpeg.wasm (comparison only)</button>
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
                  <td><button onClick={() => (setLastUrl(r.url), setPlayNonce((n) => n + 1))}>Play</button> <a href={r.url} download={`export-${i}.mp4`}>Download</a></td>
                </tr>
              ))}
            </tbody>
          </table>
          {lastUrl && <video key={lastUrl} ref={resultRef} src={lastUrl} controls playsInline className="result-video" />}
        </div>
      )}
    </div>
  );
}
