// Shared by the Node render server AND ffmpeg.wasm in the browser.
// Turns our edit JSON (see src/own/project.ts) into FFmpeg arguments.
// One builder, two runtimes: this is what keeps server and browser exports identical.

import { fontFor } from "./fonts.js";

export const SIZES = {
  "16:9": { 720: [1280, 720], 1080: [1920, 1080] },
  "9:16": { 720: [720, 1280], 1080: [1080, 1920] },
  "1:1": { 720: [720, 720], 1080: [1080, 1080] },
};

export function projectDuration(p) {
  return p.clips.reduce((s, c) => s + (c.out - c.in), 0);
}

const esc = (s) =>
  String(s).replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\u2019").replace(/%/g, "\\%");
const n = (x) => Number(x.toFixed(4));
// FFmpeg lowers a mono source by 3 dB when it widens it to stereo; browsers do not.
// Copy the single channel to both sides instead, so server and browser exports are equally loud.
const widen = (channels) => (channels === 1 ? "pan=stereo|c0=c0|c1=c0," : "");

/**
 * @param project   edit JSON
 * @param opts.height   720 | 1080
 * @param opts.resolve  (src) => path FFmpeg should open
 * @param opts.font     (fileName) => path of that .ttf for FFmpeg; a plain string is used for every title
 * @param opts.output   output file name
 * @param opts.preset   x264 preset
 * @param opts.seek     "input" (default) | "filter"
 */
export function buildFfmpegArgs(project, opts) {
  const [W, H] = SIZES[project.aspect][opts.height];
  const total = projectDuration(project);
  const args = ["-y", "-hide_banner"];
  const f = [];
  let idx = 0;

  // 1. video track: trim -> crop-to-fit -> concat
  const pairs = [];
  for (const c of project.clips) {
    const vi = idx++;
    const len = n(c.out - c.in);
    // Seek on the INPUT, so FFmpeg jumps to the clip instead of decoding the file from its start.
    // (A 5 s clip taken from the end of a 4-minute recording took 17 s with a filter-only trim.)
    // opts.seek = "filter" keeps the old behaviour (decode from the start, cut in the filter graph).
    const inputSeek = opts.seek !== "filter";
    if (inputSeek && c.in > 0) args.push("-ss", String(n(c.in)));
    if (inputSeek) args.push("-t", String(n(len + 0.5)));
    args.push("-i", opts.resolve(c.src));
    const cut = inputSeek ? `end=${len}` : `start=${n(c.in)}:end=${n(c.out)}`;
    f.push(
      `[${vi}:v]trim=${cut},setpts=PTS-STARTPTS,` +
        `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=30,setsar=1,format=yuv420p[v${vi}]`,
    );
    const vol = c.muted ? 0 : project.originalVolume;
    if (c.hasAudio === false) {
      f.push(`anullsrc=r=48000:cl=stereo,atrim=0:${len}[a${vi}]`);
    } else {
      f.push(
        `[${vi}:a]atrim=${cut},asetpts=PTS-STARTPTS,volume=${n(vol)},${widen(c.channels)}` +
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
      const file = fontFor(o.text, o.font).file;
      const fontfile = typeof opts.font === "function" ? opts.font(file) : opts.font;
      f.push(
        `[${last}]drawtext=expansion=none:fontfile=${fontfile}:text='${esc(o.text)}':fontsize=${size}:fontcolor=${o.color.replace("#", "0x")}:` +
          `x=${n(o.x)}*w-text_w/2:y=${n(o.y)}*h-text_h/2:${gate}[${out}]`,
      );
    } else {
      const ii = idx++;
      args.push("-i", opts.resolve(o.src));
      f.push(`[${ii}:v]scale=${Math.round(o.width * W)}:-1[img${ii}]`);
      f.push(`[${last}][img${ii}]overlay=x=${n(o.x)}*W-w/2:y=${n(o.y)}*H-h/2:${gate}[${out}]`);
    }
    last = out;
  }

  // 3. audio track: background music mixed under the clip audio
  let alast = "acat";
  if (project.music) {
    const mi = idx++;
    args.push("-i", opts.resolve(project.music.src));
    f.push(
      `[${mi}:a]atrim=0:${n(total)},asetpts=PTS-STARTPTS,volume=${n(project.music.volume)},${widen(project.music.channels)}` +
        `aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[mus]`,
    );
    f.push(`[acat][mus]amix=inputs=2:duration=first:normalize=0[aout]`);
    alast = "aout";
  }

  args.push(
    "-filter_complex", f.join(";"),
    "-map", `[${last}]`, "-map", `[${alast}]`,
    "-c:v", "libx264", "-preset", opts.preset ?? "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    // Say which colour standard the file uses. Without it a source that carries no colour tag produces an
    // untagged export, and players then guess (a browser and FFmpeg guessed differently in testing).
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
    "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-t", String(n(total)),
    opts.output,
  );
  return { args, width: W, height: H, duration: total };
}
