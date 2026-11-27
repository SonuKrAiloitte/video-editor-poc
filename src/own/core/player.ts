/**
 * The live preview, shared by both editor screens: a requestAnimationFrame loop that owns the playhead,
 * keeps one <video> per source file (only the clip under the playhead plays) plus a music element,
 * and draws each frame with the same compositor the Mediabunny export uses.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { cachedImage, fontFamily, loadFonts, loadImage, drawCover, drawOverlays, preloadOverlayAssets } from "../compose";
import { audioLen, clipAt, isPhoto, totalDuration, type Project } from "../project";
import { cur } from "./history";

type Ctx = CanvasRenderingContext2D;
export interface PreviewOptions {
  /** drawn on top of the frame in the preview only (never in an export), e.g. a selection box */
  drawExtra?: (ctx: Ctx, W: number, H: number, t: number, p: Project) => void;
  /** lines shown on an empty timeline */
  emptyText?: [string, string];
  /** colour behind the frame and of the empty text */
  emptyColour?: string;
}

export function usePreview(canvasRef: RefObject<HTMLCanvasElement | null>, project: Project, opts: PreviewOptions = {}) {
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const tRef = useRef(0);
  const playRef = useRef(false);
  playRef.current = playing;
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const videos = useRef(new Map<string, HTMLVideoElement>());
  const musicEls = useRef(new Map<string, HTMLAudioElement>());

  /** Starting playback at the very end restarts from the beginning (otherwise it would stop on the next frame). */
  const setPlayingFromStart = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setPlaying((prev) => {
      const next = typeof v === "function" ? v(prev) : v;
      if (next && !prev && tRef.current >= totalDuration(cur()) - 0.05) tRef.current = 0;
      return next;
    });
  }, []);

  const seek = useCallback((next: number) => {
    tRef.current = Math.max(0, Math.min(totalDuration(cur()), next));
    setT(tRef.current);
  }, []);

  useEffect(() => void preloadOverlayAssets(project).catch(() => undefined), [project]);

  useEffect(() => {
    void loadFonts();
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      // cap the step: if the browser stalls frames (background tab), playback waits instead of jumping ahead
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const proj = cur();
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

      // one <video> per video source file; only the clip under the playhead plays (photos are drawn directly)
      const used = new Set(proj.clips.filter((c) => !isPhoto(c)).map((c) => c.src));
      for (const src of used) {
        if (videos.current.has(src)) continue;
        const v = document.createElement("video");
        v.src = src;
        v.preload = "auto";
        v.playsInline = true;
        videos.current.set(src, v);
      }
      let active: HTMLVideoElement | null = null;
      for (const [src, v] of videos.current) {
        if (!used.has(src)) {
          // its clips were deleted: release the decoder and the buffered media
          v.pause();
          v.removeAttribute("src");
          v.load();
          videos.current.delete(src);
          continue;
        }
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
      // one <audio> per music piece; a piece plays only while the playhead is inside it
      const pieces = new Set(proj.audio.map((m) => m.id));
      for (const [id, a] of musicEls.current) {
        if (pieces.has(id)) continue;
        a.pause();
        a.removeAttribute("src");
        a.load();
        musicEls.current.delete(id);
      }
      for (const m of proj.audio) {
        let a = musicEls.current.get(m.id);
        if (!a) {
          a = new Audio();
          a.preload = "auto";
          musicEls.current.set(m.id, a);
        }
        if (!a.src.endsWith(m.src)) a.src = m.src;
        a.volume = Math.min(1, m.volume);
        const inside = time >= m.start && time < m.start + audioLen(m) && time < dur;
        const target = m.in + (time - m.start);
        if (playRef.current && inside) {
          if (a.paused) {
            a.currentTime = target;
            void a.play().catch(() => undefined);
          } else if (Math.abs(a.currentTime - target) > 0.3) a.currentTime = target;
        } else if (!a.paused) a.pause();
      }

      const cv = canvasRef.current;
      const ctx = cv?.getContext("2d");
      if (cv && ctx) {
        const o = optsRef.current;
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, cv.width, cv.height);
        if (!proj.clips.length) {
          const [l1, l2] = o.emptyText ?? ["Import a video,", "or pick one from the Library"];
          const fs = Math.round(Math.min(cv.width, cv.height) / 14);
          ctx.fillStyle = o.emptyColour ?? "#9aa3b8";
          ctx.font = `${fs}px "${fontFamily("jakarta")}"`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(l1, cv.width / 2, cv.height / 2 - fs * 0.7);
          ctx.fillText(l2, cv.width / 2, cv.height / 2 + fs * 0.7);
        } else {
          const photo = hit && isPhoto(hit.clip) ? cachedImage(hit.clip.src) : null;
          if (hit && isPhoto(hit.clip)) {
            if (photo) drawCover(ctx, photo, photo.naturalWidth, photo.naturalHeight, cv.width, cv.height);
            else void loadImage(hit.clip.src).catch(() => undefined);
          } else if (active && active.readyState >= 2) drawCover(ctx, active, active.videoWidth, active.videoHeight, cv.width, cv.height);
          drawOverlays(ctx, proj, time, cv.width, cv.height);
          o.drawExtra?.(ctx, cv.width, cv.height, time, proj);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const vids = videos.current;
    return () => {
      cancelAnimationFrame(raf);
      for (const v of vids.values()) v.pause();
      for (const a of musicEls.current.values()) a.pause();
    };
  }, [canvasRef]);

  /** state of the real media elements behind the preview, for checks */
  const media = useCallback(
    () => ({
      videos: [...videos.current].map(([src, v]) => ({ src: src.split("/").pop(), paused: v.paused, t: +v.currentTime.toFixed(2), volume: v.volume })),
      music: [...musicEls.current].map(([id, a]) => ({ id, paused: a.paused, t: +a.currentTime.toFixed(2), volume: a.volume })),
    }),
    [],
  );

  return { t, playing, setPlaying: setPlayingFromStart, seek, tRef, media };
}
