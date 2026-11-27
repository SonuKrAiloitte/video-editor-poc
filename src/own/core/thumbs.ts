/**
 * Small frame thumbnails for the timeline filmstrip, decoded with Mediabunny (range requests, no full download).
 * Cached per source/time/height; requests run one at a time so a long edit never floods the decoder.
 */
import { ALL_FORMATS, CanvasSink, Input, UrlSource, type InputVideoTrack } from "mediabunny";

const tracks = new Map<string, Promise<InputVideoTrack | null>>();
const cache = new Map<string, Promise<string[]>>();
let queue: Promise<unknown> = Promise.resolve();
let jobs = 0;
/** how many decode jobs have run, for checks */
export const thumbJobs = () => jobs;

const trackOf = (src: string) => {
  let t = tracks.get(src);
  if (!t) {
    const input = new Input({ source: new UrlSource(new URL(src, location.href)), formats: ALL_FORMATS });
    t = input.getPrimaryVideoTrack().then(async (v) => (v && (await v.canDecode()) ? v : null)).catch(() => null);
    tracks.set(src, t);
  }
  return t;
};

/** `count` frames evenly spread over [inSec, outSec], as JPEG data URLs `height` px tall. Empty if the browser cannot decode the file. */
export function getThumbs(src: string, inSec: number, outSec: number, count: number, height: number): Promise<string[]> {
  const n = Math.max(1, Math.round(count));
  const times = Array.from({ length: n }, (_, k) => +(inSec + ((k + 0.5) * (outSec - inSec)) / n).toFixed(2));
  const key = `${src}|${height}|${times.join(",")}`;
  let hit = cache.get(key);
  if (!hit) {
    hit = (queue = queue.then(async () => {
      jobs++;
      const track = await trackOf(src);
      if (!track) return [];
      const sink = new CanvasSink(track, { height, poolSize: 1 });
      const out: string[] = [];
      const tmp = document.createElement("canvas");
      for await (const frame of sink.canvasesAtTimestamps(times)) {
        if (!frame) continue;
        tmp.width = frame.canvas.width;
        tmp.height = frame.canvas.height;
        tmp.getContext("2d")!.drawImage(frame.canvas, 0, 0);
        out.push(tmp.toDataURL("image/jpeg", 0.7));
      }
      return out;
    }).catch(() => [])) as Promise<string[]>;
    cache.set(key, hit);
  }
  return hit;
}
