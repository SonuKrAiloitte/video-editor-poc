/**
 * Easy editor timeline: a filmstrip that scrolls under a fixed centre playhead (scrolling moves the playhead,
 * playing scrolls the strip). Clip cards show frame thumbnails; the selected clip gets wide trim handles;
 * drag a card to reorder. Text and logo bars sit in lanes below; music below that.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { getThumbs } from "../core/thumbs";
import { audioLen, clampTrim, clipLen, clipStarts, fileLabel, isPhoto, moveClip, totalDuration, type AudioClip, type Clip, type Overlay, type Project } from "../project";
import { cur, type History } from "../core/history";
import { clock, type Sel } from "./common";
import { Icon } from "./icons";

const THUMB_W = 46;
const MAX_THUMBS_PER_CLIP = 24;
const CLIP_H = 58;
const LANE_H = 30;

interface Props {
  project: Project;
  t: number;
  playing: boolean;
  seek: (t: number) => void;
  setPlaying: (v: boolean) => void;
  sel: Sel;
  setSel: (s: Sel) => void;
  h: History;
  pps: number;
  onAddVideo: () => void;
  onAddMusic: () => void;
  /** exposes the strip's state for checks */
  report?: (r: { scrollLeft: number; pps: number; thumbs: number }) => void;
}

function Filmstrip({ clip, width }: { clip: Clip; width: number }) {
  const [thumbs, setThumbs] = useState<string[]>([]);
  const count = Math.min(MAX_THUMBS_PER_CLIP, Math.max(1, Math.ceil(width / THUMB_W)));
  // while a trim handle moves, in/out change every few pixels: ask for new frames only once it settles
  const [req, setReq] = useState({ in: clip.in, out: clip.out, count });
  useEffect(() => {
    const id = setTimeout(() => setReq((r) => (r.in === clip.in && r.out === clip.out && r.count === count ? r : { in: clip.in, out: clip.out, count })), 250);
    return () => clearTimeout(id);
  }, [clip.in, clip.out, count]);
  useEffect(() => {
    // a photo is its own thumbnail: repeat it along the strip, nothing to decode
    if (isPhoto(clip)) return setThumbs(Array.from({ length: req.count }, () => clip.src));
    let live = true;
    void getThumbs(clip.src, req.in, req.out, req.count, CLIP_H * 2).then((t) => live && setThumbs(t));
    return () => void (live = false);
  }, [clip.src, req]);
  return (
    <div className="e-film">
      {thumbs.map((u, i) => <img key={i} src={u} alt="" draggable={false} />)}
    </div>
  );
}

export function Timeline({ project: p, t, playing, seek, setPlaying, sel, setSel, h, pps, onAddVideo, onAddMusic, report }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const [half, setHalf] = useState(400);
  /** the scrollLeft this component last set itself; any other value means the user scrolled */
  const lastSet = useRef<number | null>(null);
  const [dragX, setDragX] = useState<{ id: string; dx: number } | null>(null);
  const total = totalDuration(p);
  const starts = clipStarts(p);

  // half the visible width pads each side, so time 0 and the end can both reach the centre playhead
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHalf(Math.round(el.clientWidth / 2)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // the playhead moved (playing, seek, undo): scroll the strip to match
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const want = Math.round(t * pps);
    if (Math.abs(el.scrollLeft - want) > 1) el.scrollLeft = want;
    lastSet.current = el.scrollLeft;
  }, [t, pps, half]);

  /** the user moved the strip: they take over from playback */
  const userSeek = (time: number) => {
    if (playing) setPlaying(false);
    seek(time);
  };
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el || (lastSet.current !== null && Math.abs(el.scrollLeft - lastSet.current) <= 1)) return;
    userSeek(el.scrollLeft / pps);
  };

  // a plain mouse wheel (vertical) scrubs the strip too, not only trackpad sideways swipes
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return; // sideways scroll: the browser scrolls, onScroll seeks
      e.preventDefault();
      userSeek((el.scrollLeft + e.deltaY) / pps);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  useEffect(() => {
    report?.({ scrollLeft: scrollRef.current?.scrollLeft ?? 0, pps, thumbs: areaRef.current?.querySelectorAll(".e-film img").length ?? 0 });
  });

  /** timeline time under a pointer x */
  const timeAt = (clientX: number) => (clientX - (areaRef.current?.getBoundingClientRect().left ?? 0) - half) / pps;
  const snap = (time: number) => {
    const tol = 10 / pps;
    for (const pt of [t, 0, total, ...clipStarts(cur())]) if (Math.abs(pt - time) < tol) return pt;
    return Math.round(time * 10) / 10;
  };

  /** pointer gesture: `move` gets the horizontal distance in seconds; returns whether the pointer moved */
  const gesture = (e: React.PointerEvent, move: (dxSec: number, dxPx: number) => void, end?: (moved: boolean, ev: PointerEvent) => void) => {
    e.stopPropagation();
    e.preventDefault();
    const x0 = e.clientX;
    let moved = false;
    h.begin();
    const mv = (ev: PointerEvent) => {
      const dx = ev.clientX - x0;
      if (!moved && Math.abs(dx) < 5) return;
      moved = true;
      move(dx / pps, dx);
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
      end?.(moved, ev);
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
  };

  const patchClip = (id: string, patch: Partial<Clip>) => h.apply({ ...cur(), clips: cur().clips.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
  const patchOverlay = (id: string, patch: Partial<Overlay>) =>
    h.apply({ ...cur(), overlays: cur().overlays.map((o) => (o.id === id ? ({ ...o, ...patch } as Overlay) : o)) });

  const onClipDown = (e: React.PointerEvent, c: Clip, i: number) =>
    gesture(
      e,
      (_s, dx) => setDragX({ id: c.id, dx }),
      (moved, ev) => {
        setDragX(null);
        if (!moved) return setSel({ type: "clip", id: c.id });
        const at = timeAt(ev.clientX);
        const now = cur();
        const st = clipStarts(now);
        let to = now.clips.findIndex((k, j) => at < (st[j] ?? 0) + clipLen(k) / 2);
        if (to === -1) to = now.clips.length;
        if (to > i) to -= 1;
        if (to !== i) h.apply(moveClip(now, i, to));
        setSel({ type: "clip", id: c.id });
      },
    );
  const onTrim = (e: React.PointerEvent, c: Clip, i: number, edge: "in" | "out") => {
    const start = starts[i] ?? 0;
    gesture(e, (dx) => {
      if (edge === "out") patchClip(c.id, clampTrim(c, { out: c.in + (snap(start + clipLen(c) + dx) - start) }));
      else patchClip(c.id, clampTrim(c, { in: Math.round((c.in + dx) * 10) / 10 }));
    });
  };
  const onOverlayDown = (e: React.PointerEvent, o: Overlay, mode: "move" | "start" | "end") =>
    gesture(
      e,
      (dx) => {
        const len = o.end - o.start;
        if (mode === "move") {
          const s = Math.max(0, snap(o.start + dx));
          patchOverlay(o.id, { start: s, end: s + len });
        } else if (mode === "start") patchOverlay(o.id, { start: Math.min(o.end - 0.3, Math.max(0, snap(o.start + dx))) });
        else patchOverlay(o.id, { end: Math.max(o.start + 0.3, snap(o.end + dx)) });
      },
      () => setSel({ type: "overlay", id: o.id }),
    );

  const patchAudio = (id: string, patch: Partial<AudioClip>) => h.apply({ ...cur(), audio: cur().audio.map((a) => (a.id === id ? { ...a, ...patch } : a)) });
  /** music piece: drag to move it; drag its start or end handle to keep less (or more) of the song */
  const onAudioDown = (e: React.PointerEvent, a: AudioClip, mode: "move" | "start" | "end") =>
    gesture(
      e,
      (dx) => {
        if (mode === "move") patchAudio(a.id, { start: Math.max(0, snap(a.start + dx)) });
        else if (mode === "end") {
          const end = snap(a.start + audioLen(a) + dx);
          patchAudio(a.id, { out: Math.min(a.srcDuration, Math.max(a.in + 0.3, a.in + (end - a.start))) });
        } else {
          // the start handle moves the start and the song together, so the rest stays where it was
          const d = Math.min(audioLen(a) - 0.3, Math.max(-a.in, -a.start, snap(a.start + dx) - a.start));
          patchAudio(a.id, { start: +(a.start + d).toFixed(3), in: +(a.in + d).toFixed(3) });
        }
      },
      () => setSel({ type: "audio", id: a.id }),
    );

  /** click or drag on the ruler or empty strip: deselect and move the playhead there */
  const onStripDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (el && e.target === el && e.clientY > el.getBoundingClientRect().bottom - 16) return; // the scrollbar
    setSel(null);
    const total = totalDuration(cur());
    const to = (x: number) => userSeek(Math.max(0, Math.min(total, timeAt(x))));
    to(e.clientX);
    const mv = (ev: PointerEvent) => to(ev.clientX);
    const up = () => {
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  // overlays that overlap in time get their own lane so none hides another
  const lanes: number[] = [];
  const laneEnds: number[] = [];
  for (const o of p.overlays) {
    let lane = laneEnds.findIndex((end) => end <= o.start);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = o.end;
    lanes.push(lane);
  }
  const laneCount = laneEnds.length;
  // music pieces may overlap (they mix): overlapping ones get their own lane
  const audioLanes = { lane: [] as number[], count: 0 };
  const audioEnds: number[] = [];
  for (const a of p.audio) {
    let lane = audioEnds.findIndex((end) => end <= a.start + 0.001);
    if (lane === -1) lane = audioEnds.length;
    audioEnds[lane] = a.start + audioLen(a);
    audioLanes.lane.push(lane);
  }
  audioLanes.count = audioEnds.length;
  const audioEnd = Math.max(0, ...p.audio.map((a) => a.start + audioLen(a)));
  const step = [1, 2, 5, 10, 15, 30, 60, 120].find((s) => s * pps >= 70) ?? 300;
  const width = total * pps;

  return (
    <div className="e-tl">
      <div className="e-scroll" ref={scrollRef} onScroll={onScroll} onPointerDown={onStripDown}>
        <div className="e-area" ref={areaRef} style={{ width: width + half * 2, paddingLeft: half, paddingRight: half }}>
          <div className="e-ruler" style={{ width }}>
            {Array.from({ length: Math.floor(total / step) + 1 }, (_, k) => (
              <span key={k} style={{ left: k * step * pps }}>{clock(k * step)}</span>
            ))}
          </div>

          <div className="e-row" style={{ height: CLIP_H, width }}>
            {p.clips.map((c, i) => {
              const w = clipLen(c) * pps;
              const isSel = sel?.type === "clip" && sel.id === c.id;
              const drag = dragX?.id === c.id ? dragX.dx : 0;
              return (
                <div
                  key={c.id}
                  className={`e-clip ${isSel ? "sel" : ""} ${drag ? "dragging" : ""}`}
                  style={{ left: (starts[i] ?? 0) * pps, width: w, transform: drag ? `translateX(${drag}px)` : undefined }}
                  onPointerDown={(e) => onClipDown(e, c, i)}
                  title={`${fileLabel(c.name)}: drag to reorder`}
                >
                  <Filmstrip clip={c} width={w} />
                  <span className="e-badge">{isPhoto(c) ? <Icon.photo /> : c.muted && <Icon.mute />}{clipLen(c).toFixed(1)}s</span>
                  {isSel && (
                    <>
                      <i className="e-handle l" aria-label="Trim start" onPointerDown={(e) => onTrim(e, c, i, "in")} />
                      <i className="e-handle r" aria-label="Trim end" onPointerDown={(e) => onTrim(e, c, i, "out")} />
                    </>
                  )}
                </div>
              );
            })}
            <button className="e-add-clip" style={{ left: width + 8 }} aria-label="Add video" title="Add video" onPointerDown={(e) => e.stopPropagation()} onClick={onAddVideo}>
              <Icon.plus />
            </button>
          </div>

          {laneCount > 0 && (
            <div className="e-row" style={{ height: laneCount * LANE_H, width }}>
              {p.overlays.map((o, i) => {
                const isSel = sel?.type === "overlay" && sel.id === o.id;
                return (
                  <div
                    key={o.id}
                    className={`e-bar ${o.kind} ${isSel ? "sel" : ""}`}
                    style={{ left: o.start * pps, width: Math.max(8, (o.end - o.start) * pps), top: (lanes[i] ?? 0) * LANE_H }}
                    onPointerDown={(e) => onOverlayDown(e, o, "move")}
                  >
                    {isSel && <i className="e-handle l small" onPointerDown={(e) => onOverlayDown(e, o, "start")} />}
                    <span className="e-bar-label">
                      {o.kind === "image" ? <img src={o.src} alt="" draggable={false} /> : <Icon.text />}
                      <span>{o.kind === "text" ? o.text : o.name ?? fileLabel(o.src)}</span>
                    </span>
                    {isSel && <i className="e-handle r small" onPointerDown={(e) => onOverlayDown(e, o, "end")} />}
                  </div>
                );
              })}
            </div>
          )}

          <div className="e-row" style={{ height: Math.max(1, audioLanes.count) * LANE_H, width }}>
            {p.audio.map((a, i) => {
              const isSel = sel?.type === "audio" && sel.id === a.id;
              return (
                <div
                  key={a.id}
                  className={`e-bar music ${isSel ? "sel" : ""}`}
                  style={{ left: a.start * pps, width: Math.max(8, audioLen(a) * pps), top: (audioLanes.lane[i] ?? 0) * LANE_H }}
                  onPointerDown={(e) => onAudioDown(e, a, "move")}
                  title={`${a.name}: drag to move`}
                >
                  {isSel && <i className="e-handle l small" aria-label="Trim start" onPointerDown={(e) => onAudioDown(e, a, "start")} />}
                  <span className="e-bar-label"><Icon.music /><span>{a.name}</span></span>
                  {isSel && <i className="e-handle r small" aria-label="Trim end" onPointerDown={(e) => onAudioDown(e, a, "end")} />}
                </div>
              );
            })}
            {p.clips.length > 0 && (
              <button
                className="e-add-music" style={{ left: p.audio.length ? audioEnd * pps + 8 : 0 }}
                onPointerDown={(e) => e.stopPropagation()} onClick={onAddMusic} aria-label="Add music"
              >
                <Icon.music /> {p.audio.length ? "+" : "Add music"}
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="e-playhead" aria-hidden="true" />
    </div>
  );
}
