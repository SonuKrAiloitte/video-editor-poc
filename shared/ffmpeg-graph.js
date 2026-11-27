// Shared by the Node render server AND ffmpeg.wasm in the browser.
// Turns our edit JSON (see src/own/project.ts) into FFmpeg arguments.
// One builder, two runtimes: this is what keeps server and browser exports identical.
import { fontOf } from "./fonts.js";

export const SIZES = {
  "16:9": { 720: [1280, 720], 1080: [1920, 1080] },
  "9:16": { 720: [720, 1280], 1080: [1080, 1920] },
  "1:1": { 720: [720, 720], 1080: [1080, 1080] },
};

/** Music pieces; a draft from before pieces existed has one `music` playing from 0 for the whole video. */
export function audioOf(p) {
  if (Array.isArray(p.audio)) return p.audio;
  if (!p.music) return [];
  const total = projectDuration(p);
  return [{ ...p.music, start: 0, in: 0, out: total, srcDuration: total }];
}

export function projectDuration(p) {
  return p.clips.reduce((s, c) => s + (c.out - c.in), 0);
}

const esc = (s) =>
  String(s).replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\u2019").replace(/%/g, "\\%");
const n = (x) => Number(Number(x).toFixed(4));
// only a plain #RRGGBB colour may reach the filter graph (anything else could inject filters)
const hex = (c) => (/^#[0-9a-f]{6}$/i.test(String(c)) ? "0x" + String(c).slice(1) : "0xFFFFFF");
// FFmpeg lowers a mono source by 3 dB when it widens it to stereo; browsers do not.
// Copy the single channel to both sides instead, so server and browser exports are equally loud.
const widen = (channels) => (channels === 1 ? "pan=stereo|c0=c0|c1=c0," : "");

/**
 * @param project   edit JSON
 * @param opts.height   720 | 1080
 * @param opts.resolve  (src) => path FFmpeg should open
 * @param opts.fontPath (fontId) => path to that font's .ttf, as FFmpeg should open it
 * @param opts.output   output file name
 * @param opts.preset   x264 preset
 */
export function buildFfmpegArgs(project, opts) {
  const size = SIZES[project.aspect]?.[opts.height];
  if (!size) throw new Error(`unsupported aspect/height: ${project.aspect} ${opts.height}`);
  if (!project.clips.length) throw new Error("the timeline has no clips");
  const [W, H] = size;
  const total = projectDuration(project);
  const args = ["-y", "-hide_banner"];
  const f = [];
  let idx = 0;

  // 1. video track: trim -> crop-to-fit -> concat
  const pairs = [];
  for (const c of project.clips) {
    const vi = idx++;
    const fit = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=30,setsar=1,format=yuv420p`;
    if (c.kind === "image") {
      // a photo: loop the single picture for the clip's length
      args.push("-loop", "1", "-framerate", "30", "-t", String(n(c.out - c.in)), "-i", opts.resolve(c.src));
      f.push(`[${vi}:v]${fit},trim=duration=${n(c.out - c.in)},setpts=PTS-STARTPTS[v${vi}]`);
    } else {
      args.push("-i", opts.resolve(c.src));
      f.push(`[${vi}:v]trim=start=${n(c.in)}:end=${n(c.out)},setpts=PTS-STARTPTS,${fit}[v${vi}]`);
    }
    const vol = c.muted ? 0 : project.originalVolume;
    if (c.hasAudio === false || c.kind === "image") {
      f.push(`anullsrc=r=48000:cl=stereo,atrim=0:${n(c.out - c.in)}[a${vi}]`);
    } else {
      f.push(
        `[${vi}:a]atrim=start=${n(c.in)}:end=${n(c.out)},asetpts=PTS-STARTPTS,volume=${n(vol)},${widen(c.channels)}` +
          `aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${vi}]`,
      );
    }
    pairs.push(`[v${vi}][a${vi}]`);
  }
  f.push(`${pairs.join("")}concat=n=${project.clips.length}:v=1:a=1[vcat][acat]`);

  // 2. overlay track: text (drawtext) and images (overlay), each gated to its time range
  let last = "vcat";
  let k = 0;
  for (const o of project.overlays) {
    const gate = `enable='between(t,${n(o.start)},${n(o.end)})'`;
    const out = `ov${k++}`;
    if (o.kind === "text") {
      const size = Math.round(o.fontSize * (Math.min(W, H) / 720));
      f.push(
        `[${last}]drawtext=expansion=none:fontfile=${opts.fontPath(fontOf(o.font))}:text='${esc(o.text)}':fontsize=${size}:fontcolor=${hex(o.color)}:` +
          `x=${n(o.x)}*w-text_w/2:y=${n(o.y)}*h-text_h/2:${gate}[${out}]`,
      );
    } else {
      const ii = idx++;
      args.push("-i", opts.resolve(o.src));
      if (o.pixel && Number.isInteger(o.pixel.left) && Number.isInteger(o.pixel.top)) {
        // a picture already drawn at export size (a title): place it to the pixel, no rescaling
        // blended in RGB, like the browser's canvas, so saturated edges match (the encoder converts to yuv420p after)
        f.push(`[${last}][${ii}:v]overlay=x=${o.pixel.left}:y=${o.pixel.top}:format=rgb:${gate}[${out}]`);
      } else {
        f.push(`[${ii}:v]scale=${Math.round(o.width * W)}:-1[img${ii}]`);
        f.push(`[${last}][img${ii}]overlay=x=${n(o.x)}*W-w/2:y=${n(o.y)}*H-h/2:${gate}[${out}]`);
      }
    }
    last = out;
  }

  // 3. music pieces: each trimmed to its part of the song, delayed to its start, mixed under the clip audio
  let alast = "acat";
  const pieces = audioOf(project).filter((a) => a.start < total && a.out > a.in);
  pieces.forEach((a, k) => {
    const mi = idx++;
    args.push("-i", opts.resolve(a.src));
    const ms = Math.round(a.start * 1000);
    f.push(
      `[${mi}:a]atrim=start=${n(a.in)}:end=${n(a.out)},asetpts=PTS-STARTPTS,volume=${n(a.volume)},${widen(a.channels)}` +
        `aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=${ms}|${ms}[mus${k}]`,
    );
  });
  if (pieces.length) {
    f.push(`[acat]${pieces.map((_, k) => `[mus${k}]`).join("")}amix=inputs=${pieces.length + 1}:duration=first:normalize=0[aout]`);
    alast = "aout";
  }

  args.push(
    "-filter_complex", f.join(";"),
    "-map", `[${last}]`, "-map", `[${alast}]`,
    "-c:v", "libx264", "-preset", opts.preset ?? "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-t", String(n(total)),
    opts.output,
  );
  return { args, width: W, height: H, duration: total };
}
