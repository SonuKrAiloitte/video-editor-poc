// Shared by the Node render server AND ffmpeg.wasm in the browser.
// Turns our edit JSON (see src/own/project.ts and shared/model.js) into FFmpeg arguments.
// One builder, two runtimes: this is what keeps server and browser exports identical.

import { fontFor } from "./fonts.js";
import { audioLen, frameSizeFor, layers, mainDuration, normalizeProject, projectDuration, resolveAspect } from "./model.js";

export { projectDuration };

/** kept for older scripts; any ratio works through frameSizeFor */
export const SIZES = Object.fromEntries(["16:9", "9:16", "1:1"].map((a) => [a, { 720: frameSizeFor(a, 720), 1080: frameSizeFor(a, 1080) }]));

const esc = (s) =>
  String(s).replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\u2019").replace(/%/g, "\\%");
const n = (x) => Number(x.toFixed(4));
const even = (x) => Math.max(2, Math.round(x / 2) * 2);
// FFmpeg lowers a mono source by 3 dB when it widens it to stereo; browsers do not.
// Copy the single channel to both sides instead, so server and browser exports are equally loud.
const widen = (channels) => (channels === 1 ? "pan=stereo|c0=c0|c1=c0," : "");
const toStereo = (channels) => `${widen(channels)}aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo`;

/**
 * @param project   edit JSON
 * @param opts.height   720 | 1080
 * @param opts.resolve  (src) => path FFmpeg should open
 * @param opts.font     (fileName) => path of that .ttf for FFmpeg; a plain string is used for every title
 * @param opts.output   output file name
 * @param opts.preset   x264 preset
 * @param opts.seek     "input" (default) | "filter"
 */
export function buildFfmpegArgs(input, opts) {
  const project = normalizeProject(input);
  const [W, H] = frameSizeFor(resolveAspect(project), opts.height);
  const total = projectDuration(project);
  const main = mainDuration(project);
  const args = ["-y", "-hide_banner"];
  const f = [];
  let idx = 0;
  /** add an input; seek on the INPUT so FFmpeg jumps to the part used instead of decoding from the start */
  const addInput = (src, from, len, still = false) => {
    if (still) args.push("-loop", "1", "-framerate", "30", "-t", String(n(len)));
    else {
      if (from > 0) args.push("-ss", String(n(from)));
      args.push("-t", String(n(len + 0.5)));
    }
    args.push("-i", opts.resolve(src));
    return idx++;
  };

  // 1. main track: trim -> crop-to-fit -> concat (images are stills of the clip's length)
  const pairs = [];
  for (const c of project.clips) {
    const len = n(c.out - c.in);
    const still = c.kind === "image";
    // opts.seek = "filter" keeps the old behaviour for videos (decode from the start, cut in the filter graph).
    const inputSeek = opts.seek !== "filter" || still;
    let vi;
    if (inputSeek) vi = addInput(c.src, still ? 0 : c.in, len, still);
    else (args.push("-i", opts.resolve(c.src)), (vi = idx++));
    const cut = inputSeek ? `end=${len}` : `start=${n(c.in)}:end=${n(c.out)}`;
    f.push(
      `[${vi}:v]trim=${cut},setpts=PTS-STARTPTS,` +
        // fit: the whole picture, black bars where the shapes differ (CapCut's default); fill: crop to cover the frame
        (c.fit === "fill"
          ? `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},`
          : `scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,`) +
        `fps=30,setsar=1,format=yuv420p[v${vi}]`,
    );
    if (still || c.hasAudio === false) {
      f.push(`anullsrc=r=48000:cl=stereo,atrim=0:${len}[a${vi}]`);
    } else {
      const vol = c.muted ? 0 : project.originalVolume;
      f.push(`[${vi}:a]atrim=${cut},asetpts=PTS-STARTPTS,volume=${n(vol)},${toStereo(c.channels)}[a${vi}]`);
    }
    pairs.push(`[v${vi}][a${vi}]`);
  }
  let last;
  let abase;
  if (pairs.length) {
    f.push(`${pairs.join("")}concat=n=${pairs.length}:v=1:a=1[vcat][acat]`);
    last = "vcat";
    abase = "acat";
    if (total > main + 1e-3) {
      // something on another track runs past the main track: carry on with black and silence
      f.push(`[vcat]tpad=stop_mode=add:stop_duration=${n(total - main)}:color=black[vpad]`);
      f.push(`[acat]apad=whole_dur=${n(total)}[apad]`);
      last = "vpad";
      abase = "apad";
    }
  } else {
    f.push(`color=c=black:s=${W}x${H}:r=30:d=${n(total)},format=yuv420p,setsar=1[vbase]`);
    f.push(`anullsrc=r=48000:cl=stereo,atrim=0:${n(total)}[abase]`);
    last = "vbase";
    abase = "abase";
  }

  // 2. visual tracks, lowest first: text (drawtext), images and videos (overlay), each gated to its time range
  const mix = [];
  let k = 0;
  for (const o of layers(project)) {
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
    } else if (o.kind === "image") {
      const ii = idx++;
      args.push("-i", opts.resolve(o.src));
      f.push(`[${ii}:v]scale=${Math.round(o.width * W)}:-1[img${ii}]`);
      f.push(`[${last}][img${ii}]overlay=x=${n(o.x)}*W-w/2:y=${n(o.y)}*H-h/2:${gate}[${out}]`);
    } else {
      // video on an upper track: its own clock starts at o.start on the timeline
      const len = n(o.end - o.start);
      const ii = addInput(o.src, o.in, len);
      f.push(`[${ii}:v]trim=end=${len},setpts=PTS-STARTPTS+${n(o.start)}/TB,scale=${even(o.width * W)}:-2,setsar=1[pip${ii}]`);
      f.push(`[${last}][pip${ii}]overlay=x=${n(o.x)}*W-w/2:y=${n(o.y)}*H-h/2:eof_action=pass:${gate}[${out}]`);
      if (o.hasAudio !== false && !o.muted) {
        const ms = Math.round(o.start * 1000);
        f.push(`[${ii}:a]atrim=end=${len},asetpts=PTS-STARTPTS,volume=${n(project.originalVolume)},${toStereo(o.channels)},adelay=delays=${ms}:all=1[pa${ii}]`);
        mix.push(`[pa${ii}]`);
      }
    }
    last = out;
  }

  // 3. audio tracks: each clip trimmed, moved to its start and mixed under the main track's sound
  for (const a of project.audios) {
    const len = n(audioLen(a));
    const ai = addInput(a.src, a.in, len);
    const ms = Math.round(a.start * 1000);
    f.push(`[${ai}:a]atrim=end=${len},asetpts=PTS-STARTPTS,volume=${n(a.volume)},${toStereo(a.channels)}${ms ? `,adelay=delays=${ms}:all=1` : ""}[au${ai}]`);
    mix.push(`[au${ai}]`);
  }
  let alast = abase;
  if (mix.length) {
    f.push(`[${abase}]${mix.join("")}amix=inputs=${mix.length + 1}:duration=first:normalize=0[aout]`);
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
