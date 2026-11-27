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
import { useCallback, useEffect, useRef, useState } from "react";
import { ALL_FORMATS, BlobSource, Input } from "mediabunny";
import { DEFAULT_FONT, FONTS, fontFor } from "../../shared/fonts.js";
import { RATIOS, audioLen, canPlace, normalizeProject, overlapsOnTrack, refuseReason, resolveAspect, type ItemKind } from "../../shared/model.js";
import sample from "../../shared/sample-project.json";
import { drawMain, drawOverlays, getImage, loadImage, preloadOverlayAssets } from "./compose";
import { blobNames, exportFfmpegWasm, exportMediabunny, exportServer, type ExportResult } from "./exporters";
import {
  clipAt, clipLen, clipStarts, frameSize, insertIndexAt, mainLength, moveClip, splitAt, totalDuration, uid,
  type Aspect, type AudioItem, type Clip, type ImageOverlay, type Overlay, type Project, type TrackKind, type VideoOverlay,
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
}
const BUILT_IN = [
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
const fmt = (t: number) => {
  const f = Math.round(t * 30);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(Math.floor(f / 108000))}:${two(Math.floor(f / 1800) % 60)}:${two(Math.floor(f / 30) % 60)}:${two(f % 30)}`;
};
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
  const h = useHistory();
  const p = h.project;
  const total = totalDuration(p);
  const mainLen = mainLength(p);

  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [sel, setSel] = useState<Ref | null>(null);
  const [zoom, setZoom] = useState(60); // px per second
  const [notice, setNotice] = useState<string | null>(null);
  /** row the pointer is over during a drag, and whether the dragged thing may go there */
  const [hover, setHover] = useState<{ row: RowId; ok: boolean } | null>(null);
  const [library, setLibrary] = useState<Media[]>([]);
  const [libTab, setLibTab] = useState<"media" | "audio">("media");
  /** the Library item being dragged, drawn next to the pointer */
  const [ghost, setGhost] = useState<{ name: string; kind: Media["kind"]; x: number; y: number } | null>(null);

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
  /** one <video> per video item on the timeline (the same file can play at two places at once) */
  const videos = useRef(new Map<string, HTMLVideoElement>());
  const audioEls = useRef(new Map<string, HTMLAudioElement>());
  /** copy of the last main-track frame drawn, shown while the browser is busy seeking */
  const lastFrame = useRef<HTMLCanvasElement | null>(null);
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
    const videoFor = (key: string, src: string) => {
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
      const live = new Set<string>();

      // main track: only the clip under the playhead plays
      let active: HTMLVideoElement | null = null;
      for (const c of proj.clips) {
        if (c.kind === "image") continue;
        const v = videoFor(c.id, c.src);
        live.add(c.id);
        if (hit && hit.clip.id === c.id) {
          active = v;
          sync(v, c.in + (time - hit.start), c.muted ? 0 : proj.originalVolume);
        } else if (!v.paused) v.pause();
      }
      // videos on the visual tracks
      const pip = new Map<string, HTMLVideoElement>();
      for (const o of proj.overlays) {
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
      if (cv && ctx) {
        const keep = (lastFrame.current ??= document.createElement("canvas"));
        const sameSize = keep.width === cv.width && keep.height === cv.height;
        const still = hit?.clip.kind === "image" ? getImage(hit.clip.src) : undefined;
        if (still || (active && active.readyState >= 2)) {
          ctx.fillStyle = "#000";
          ctx.fillRect(0, 0, cv.width, cv.height);
          if (still) drawMain(ctx, hit?.clip.fit, still, still.naturalWidth, still.naturalHeight, cv.width, cv.height);
          else if (active) drawMain(ctx, hit?.clip.fit, active, active.videoWidth, active.videoHeight, cv.width, cv.height);
          if (!sameSize) (keep.width = cv.width), (keep.height = cv.height);
          keep.getContext("2d")?.drawImage(cv, 0, 0);
        } else if (hit && sameSize) {
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

  // drag the selected item around the preview
  const dragOnPreview = (e: React.PointerEvent<HTMLCanvasElement>) => {
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
  const removeSelected = () => {
    if (!sel) return;
    const cur = pRef.current;
    if (sel.type === "clip") h.commit({ ...cur, clips: cur.clips.filter((c) => c.id !== sel.id) });
    if (sel.type === "overlay") h.commit({ ...cur, overlays: cur.overlays.filter((o) => o.id !== sel.id) });
    if (sel.type === "audio") h.commit({ ...cur, audios: cur.audios.filter((a) => a.id !== sel.id) });
    setSel(null);
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
  const convertOnServer = async (src: string, name: string, why: string) => {
    setNotice(`${name}: ${why}. Converting it on the server...`);
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
      setNotice(`${name}: ${why}, so the server converted it to MP4 in ${(done.ms / 1000).toFixed(1)} s.`);
      return media;
    }
    return { name, src, kind, duration: info!.duration, hasAudio: info!.hasAudio, channels: info!.channels, ratio: info!.ratio };
  };

  /** Place a Library item at `time` on `row`. Refuses with a reason if the row does not take that kind. */
  const place = (m: Media, row: RowId, time: number): boolean => {
    let proj = pRef.current;
    const rowKind = kindOfRow(proj, row);
    const reason = rowKind === "new" ? null : refuseReason(m.kind, rowKind);
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

  /** Clicking a Library item (or importing a file) adds it where it usually goes. */
  const addDefault = (m: Media) => {
    const proj = pRef.current;
    if (m.kind === "video") return place(m, "main", mainLength(proj));
    if (m.kind === "audio") {
      const track = proj.tracks.find((x) => x.kind === "audio" && !overlapsOnTrack(itemsOn(proj), x.id, 0, m.duration));
      return place(m, track?.id ?? "new", 0);
    }
    // an image: as a logo over the whole edit, on a new top track
    const end = Math.max(IMAGE_SECONDS, totalDuration(proj));
    const ok = place({ ...m, duration: end }, "new", 0);
    if (ok) h.apply({ ...pRef.current, overlays: pRef.current.overlays.map((o) => (o.kind === "image" && o.src === m.src && o.start === 0 ? { ...o, width: 0.25 } : o)) });
    return ok;
  };

  const builtIn = useRef(new Map<string, Promise<Media>>());
  const mediaFor = (name: string, kind: Media["kind"]) => {
    const own = library.find((m) => m.name === name);
    if (own) return Promise.resolve(own);
    if (!builtIn.current.has(name)) builtIn.current.set(name, prepare(`/media/${name}`, name, kind));
    return builtIn.current.get(name)!;
  };

  const onFiles = async (files: FileList | null) => {
    for (const f of Array.from(files ?? [])) {
      const url = URL.createObjectURL(f);
      blobNames.set(url, f.name);
      const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
      const kind = f.type.startsWith("video") || VIDEO_EXT.includes(ext) ? "video" : f.type.startsWith("audio") || AUDIO_EXT.includes(ext) ? "audio" : "image";
      try {
        const m = await prepare(url, f.name, kind);
        setLibrary((lib) => [...lib.filter((x) => x.name !== m.name), m]);
        setLibTab(m.kind === "audio" ? "audio" : "media"); // show the tab the new file is in
        addDefault(m);
      } catch (e) {
        const reason = e instanceof Error ? e.message.trim().split(/\r?\n/).pop() : "unknown error";
        setNotice(`${f.name}: could not be imported (${reason}).`);
      }
    }
  };
  const addText = () => {
    const proj = pRef.current;
    const start = Math.round(t * 10) / 10;
    const top = proj.tracks.find((x) => x.kind === "visual");
    const [next, track] = landing(proj, top?.id ?? "new", "visual", start, start + 3);
    const o: Overlay = { id: uid(), track, kind: "text", text: "New title", fontSize: 40, color: "#FFFFFF", x: 0.5, y: 0.5, start, end: start + 3 };
    h.commit({ ...next, overlays: [...next.overlays, o] });
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
  /** snap a timeline time to the playhead, item edges, then a 0.1 s grid */
  const snap = (time: number, ignoreId?: string) => {
    const tol = 8 / zoom;
    const cur = pRef.current;
    const points = [tRef.current, 0, mainLength(cur), ...clipStarts(cur)];
    for (const x of itemsOn(cur)) if (x.id !== ignoreId) points.push(x.start, x.end);
    for (const pt of points) if (Math.abs(pt - time) < tol) return pt;
    return Math.round(time * 10) / 10;
  };
  const trackRef = useRef<HTMLDivElement>(null);
  const timeAtPointer = (clientX: number) => Math.max(0, (clientX - (trackRef.current?.getBoundingClientRect().left ?? 0)) / zoom);
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
    return !!kind && (rk === "new" || canPlace(kind, rk));
  };

  const drag = (e: React.PointerEvent, onMove: (dxSeconds: number, ev: PointerEvent) => void, onEnd?: (ev: PointerEvent, before: Project) => void) => {
    e.stopPropagation();
    e.preventDefault();
    const x0 = e.clientX;
    const before = pRef.current;
    h.checkpoint();
    const move = (ev: PointerEvent) => onMove((ev.clientX - x0) / zoom, ev);
    const up = (ev: PointerEvent) => {
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
    const reason = rk === "new" || !kind ? null : refuseReason(kind, rk);
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
        if (o.kind === "text") return;
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
    seek(timeAtPointer(e.clientX));
    const move = (ev: PointerEvent) => seek(timeAtPointer(ev.clientX));
    const up = () => (window.removeEventListener("pointermove", move), window.removeEventListener("pointerup", up));
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /**
   * Drag from the Library: press, move onto a track, release. A press without movement is a click (adds it where
   * it usually goes). Pointer events, not HTML5 drag, so it behaves like the timeline drags and works on touch.
   */
  const grabLibrary = (e: React.PointerEvent, m: { name: string; kind: Media["kind"] }) => {
    e.preventDefault();
    const x0 = e.clientX;
    const y0 = e.clientY;
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
      moved = true;
      setGhost({ ...m, x: ev.clientX, y: ev.clientY });
      const row = rowAtPointer(ev.clientX, ev.clientY);
      setHover(row ? { row, ok: allowed(m.kind, pRef.current, row) } : null);
    };
    const up = async (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setGhost(null);
      setHover(null);
      try {
        const media = await mediaFor(m.name, m.kind);
        if (!moved) return void addDefault(media);
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
  const engines = { mediabunny: exportMediabunny, wasm: exportFfmpegWasm, server: exportServer } as const;
  const runExport = async (key: keyof typeof engines, force = false) => {
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
  const width = Math.max(total + 4, 12) * zoom;

  const visualTracks = p.tracks.filter((x) => x.kind === "visual");
  const audioTracks = p.tracks.filter((x) => x.kind === "audio");
  const rowClass = (row: RowId, extra = "") =>
    `track ${extra} ${hover?.row === row ? (hover.ok ? "drop-ok" : "drop-bad") : ""}`;
  const rowEvents = (row: RowId) => ({ "data-row": row });
  const libItems: { name: string; kind: Media["kind"]; own: boolean }[] = [
    ...BUILT_IN.map((m) => ({ name: m.name, kind: m.kind, own: false })),
    ...library.map((m) => ({ name: m.name, kind: m.kind, own: true })),
  ];

  return (
    <div className="own">
      <div className="bar">
        <button onClick={() => h.commit(splitAt(p, t))} title="S">Split at playhead</button>
        <button onClick={removeSelected} disabled={!sel}>Delete</button>
        <button onClick={h.undo} disabled={!h.canUndo}>Undo</button>
        <button onClick={h.redo} disabled={!h.canRedo}>Redo</button>
        <button onClick={() => (setPlaying(false), setSel(null), h.commit(SAMPLE), seek(0))} title="Back to the sample edit (Undo brings your edit back)">Reset</button>
        <span className="sep" />
        <button onClick={addText}>+ Text</button>
        <label className="file">Import files
          <input type="file" multiple accept="video/*,image/*,audio/*,.avi,.mkv,.mov,.m4v,.3gp" onChange={(e) => void onFiles(e.target.files)} />
        </label>
        <span className="saved">{h.savedAt ? `Draft saved ${h.savedAt}` : "Not saved yet"}</span>
      </div>
      {notice && <div className="notice">{notice}</div>}
      {ghost && (
        <div className={`ghost ${hover && !hover.ok ? "bad" : ""}`} style={{ left: ghost.x + 12, top: ghost.y + 8 }}>
          <span className={`tag ${ghost.kind}`}>{ghost.kind}</span> {ghost.name}
          {hover && !hover.ok && <em> cannot go here</em>}
        </div>
      )}

      <div className="stage">
        <aside className="panel">
          <h4>Library</h4>
          {/* Media (video and images, which share tracks) and Audio, as two tabs like CapCut */}
          <div className="lib-tabs" role="tablist">
            {(["media", "audio"] as const).map((tab) => (
              <button key={tab} role="tab" aria-selected={libTab === tab} className={libTab === tab ? "on" : ""} onClick={() => setLibTab(tab)}>
                {tab === "media" ? "Media" : "Audio"} <span className="count">{libItems.filter((m) => (m.kind === "audio") === (tab === "audio")).length}</span>
              </button>
            ))}
          </div>
          <label className="file lib-import">{libTab === "media" ? "+ Import video or image" : "+ Import audio"}
            <input
              type="file"
              multiple
              accept={libTab === "media" ? "video/*,image/*,.avi,.mkv,.mov,.m4v,.3gp" : "audio/*,.mp3,.wav,.ogg,.m4a,.aac,.flac,.opus"}
              onChange={(e) => void onFiles(e.target.files)}
            />
          </label>
          <div className="lib-list">
            {libItems.filter((m) => (m.kind === "audio") === (libTab === "audio")).map((m) => (
              <button key={m.name} className="lib" title={m.name} onPointerDown={(e) => grabLibrary(e, m)}>
                <span className={`tag ${m.kind}`}>{m.kind}</span> {m.name}
              </button>
            ))}
          </div>
          <p className="hint">{libTab === "media" ? "Drag onto Main or a track above it, or click to add." : "Drag onto an audio track or New, or click to add."}</p>
        </aside>

        <div className="player" ref={playerRef}>
          <div className="preview">
            <canvas ref={canvasRef} width={W} height={H} onPointerDown={dragOnPreview} style={{ aspectRatio: `${W} / ${H}` }} />
          </div>
          <div className="player-bar">
            <span className="time"><b>{fmt(t)}</b> / {fmt(total)}</span>
            <button className="play" onClick={() => setPlaying((v) => !v)} aria-label={playing ? "Pause" : "Play"} title="Space">
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
              <p className="hint">Main track. Drag it up to a track above to lay it over other clips.</p>
            </div>
          )}
          {selOverlay?.kind === "text" && (
            <div className="form">
              <label>Text<input value={selOverlay.text} onChange={(e) => patchOverlay(selOverlay.id, { text: e.target.value })} /></label>
              <label>Font
                <select value={selOverlay.font ?? DEFAULT_FONT} onChange={(e) => patchOverlay(selOverlay.id, { font: e.target.value })}>
                  {FONTS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                </select>
              </label>
              {fontFor(selOverlay.text, selOverlay.font).id !== (selOverlay.font ?? DEFAULT_FONT) && (
                <p className="hint">This font has no Hindi letters, so {fontFor(selOverlay.text, selOverlay.font).label} is used for this title.</p>
              )}
              <label>Size<input type="range" min={16} max={120} value={selOverlay.fontSize} onChange={(e) => patchOverlay(selOverlay.id, { fontSize: Number(e.target.value) })} /></label>
              <label>Colour<input type="color" value={selOverlay.color} onChange={(e) => patchOverlay(selOverlay.id, { color: e.target.value.toUpperCase() })} /></label>
              <p className="hint">Drag on the preview to position.</p>
            </div>
          )}
          {(selOverlay?.kind === "image" || selOverlay?.kind === "video") && (
            <div className="form">
              {selOverlay.kind === "video" && <b>{selOverlay.name}</b>}
              <label>Width<input type="range" min={0.05} max={1} step={0.01} value={selOverlay.width} onChange={(e) => patchOverlay(selOverlay.id, { width: Number(e.target.value) })} /></label>
              {selOverlay.kind === "video" && (
                <label className="row"><input type="checkbox" checked={selOverlay.muted} onChange={(e) => patchOverlay(selOverlay.id, { muted: e.target.checked })} /> Mute its sound</label>
              )}
              <p className="hint">Drag on the preview to position. Drag its edges on the timeline to trim.</p>
            </div>
          )}
          {selAudio && (
            <div className="form">
              <b>{selAudio.name}</b>
              <label>Volume<input type="range" min={0} max={1} step={0.05} value={selAudio.volume} onChange={(e) => patchAudio(selAudio.id, { volume: Number(e.target.value) })} /></label>
              <p className="hint">Drag its edges on the timeline to trim.</p>
            </div>
          )}
          {!selClip && !selOverlay && !selAudio && <p className="hint">Select something on the timeline.</p>}
          <h4>Audio</h4>
          <div className="form">
            <label>Sound of the video clips<input type="range" min={0} max={1} step={0.05} value={p.originalVolume} onChange={(e) => h.commit({ ...p, originalVolume: Number(e.target.value) })} /></label>
          </div>
        </aside>
      </div>

      <div className="tl-head">
        <span>Timeline</span>
        <label>Zoom <input type="range" min={20} max={200} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} /></label>
        <span className="hint">Drag from the Library onto any track. Drag clips sideways or onto another track. The main track keeps clips joined; audio goes only on audio tracks.</span>
      </div>
      <div className="tl-wrap">
      <div className="tl-labels">
        <div className="ruler" />
        {visualTracks.map((tr, n) => <div key={tr.id} className="track">{`Track ${visualTracks.length - n + 1}`}</div>)}
        <div className="track main">Main</div>
        {audioTracks.map((tr, n) => <div key={tr.id} className="track audio">{`Audio ${n + 1}`}</div>)}
        <div className="track new">New</div>
      </div>
      <div className="tl-scroll">
        <div className="tl" style={{ width }} ref={trackRef}>
          <div className="ruler" onPointerDown={scrub}>
            {Array.from({ length: Math.ceil(width / zoom) }, (_, s) => (
              <span key={s} style={{ left: s * zoom }}>{s}s</span>
            ))}
          </div>
          {visualTracks.map((tr, n) => (
            <div key={tr.id} className={rowClass(tr.id, "visual")} data-label={`Track ${visualTracks.length - n + 1}`} {...rowEvents(tr.id)}>
              {p.overlays.filter((o) => o.track === tr.id).map((o) => (
                <div key={o.id} className={`clip ${o.kind} ${sel?.id === o.id ? "sel" : ""}`} style={{ left: o.start * zoom, width: (o.end - o.start) * zoom }} onPointerDown={(e) => grabOverlay(e, o)}>
                  <i className="h l" onPointerDown={(e) => trimOverlay(e, o, "start")} />
                  <span>{o.kind === "text" ? o.text : o.kind === "video" ? o.name : (o as ImageOverlay).src.split("/").pop()}</span>
                  <i className="h r" onPointerDown={(e) => trimOverlay(e, o, "end")} />
                </div>
              ))}
            </div>
          ))}
          <div className={rowClass("main", "main")} data-label="Main" {...rowEvents("main")}>
            {p.clips.map((c, i) => (
              <div key={c.id} className={`clip ${c.kind === "image" ? "image" : "video"} ${sel?.id === c.id ? "sel" : ""}`} style={{ left: (starts[i] ?? 0) * zoom, width: clipLen(c) * zoom }} onPointerDown={(e) => grabClip(e, i)}>
                <i className="h l" onPointerDown={(e) => trimClip(e, c, i, "in")} />
                <span>{c.muted ? "(muted) " : ""}{c.name}</span>
                <i className="h r" onPointerDown={(e) => trimClip(e, c, i, "out")} />
              </div>
            ))}
            {mainLen === 0 && <span className="empty">Drop video or images here</span>}
          </div>
          {audioTracks.map((tr, n) => (
            <div key={tr.id} className={rowClass(tr.id, "audio")} data-label={`Audio ${n + 1}`} {...rowEvents(tr.id)}>
              {p.audios.filter((a) => a.track === tr.id).map((a) => (
                <div key={a.id} className={`clip audio ${sel?.id === a.id ? "sel" : ""}`} style={{ left: a.start * zoom, width: audioLen(a) * zoom }} onPointerDown={(e) => grabAudio(e, a)}>
                  <i className="h l" onPointerDown={(e) => trimAudio(e, a, "start")} />
                  <span>{a.name} ({Math.round(a.volume * 100)}%)</span>
                  <i className="h r" onPointerDown={(e) => trimAudio(e, a, "end")} />
                </div>
              ))}
            </div>
          ))}
          <div className={rowClass("new", "new")} data-label="New" {...rowEvents("new")}>
            <span className="empty">Drop here for a new track</span>
          </div>
          <div className="playhead" style={{ left: t * zoom }} />
        </div>
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
