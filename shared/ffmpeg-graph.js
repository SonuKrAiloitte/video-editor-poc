// Shared by the Node render server AND ffmpeg.wasm in the browser.
// Turns our edit JSON (see src/own/project.ts and shared/model.js) into FFmpeg arguments.
// One builder, two runtimes: this is what keeps server and browser exports identical.

import { fontFor } from "./fonts.js";
import { effectDef, fx, transitionDef } from "./fx.js";
import { applyTrackStates, audioLen, frameSizeFor, layers, mainDuration, normalizeProject, projectDuration, resolveAspect, transitionDur } from "./model.js";

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
/** FFmpeg's rotate filter for a turn in degrees, keeping the corners transparent and the whole picture */
const turn = (deg) => {
  if (!deg) return "";
  const a = n((deg * Math.PI) / 180);
  return `,format=rgba,rotate=${a}:c=none:ow=rotw(${a}):oh=roth(${a})`;
};
const plain = (c) => (c.scale ?? 1) === 1 && (c.x ?? 0.5) === 0.5 && (c.y ?? 0.5) === 0.5 && !c.rotation;
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
  const project = applyTrackStates(normalizeProject(input));
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

  // 1. main track. A clip becomes pieces: its middle, and its ends that take part in a transition. A transition is
  // made from the end of one clip and the start of the next (FFmpeg's xfade, or a mask video), and all pieces are
  // joined with concat. Each piece is its own input with its own seek, so no stream has to wait in memory.
  /** a piece of a clip: `len` seconds starting `from` seconds into the clip; returns its [video, audio] labels */
  const clipPiece = (c, from, rawLen) => {
    const len = n(rawLen);
    const still = c.kind === "image";
    // opts.seek = "filter" keeps the old behaviour for videos (decode from the start, cut in the filter graph).
    const inputSeek = opts.seek !== "filter" || still;
    let vi;
    if (inputSeek) vi = addInput(c.src, still ? 0 : c.in + from, len, still);
    else (args.push("-i", opts.resolve(c.src)), (vi = idx++));
    const cut = inputSeek ? `end=${len}` : `start=${n(c.in + from)}:end=${n(c.in + from + len)}`;
    if (c.hidden) f.push(`color=c=black:s=${W}x${H}:r=30:d=${len},format=yuv420p,setsar=1[v${vi}]`); // hidden main track
    else if (!plain(c)) {
      // its own size, position and turn: fit (or fill) a box `scale` times the frame, turn it, place it on black
      const s = c.scale ?? 1;
      f.push(
        `[${vi}:v]trim=${cut},setpts=PTS-STARTPTS,fps=30,` +
          `scale=${even(W * s)}:${even(H * s)}:force_original_aspect_ratio=${c.fit === "fill" ? "increase" : "decrease"}:force_divisible_by=2,setsar=1${turn(c.rotation)}[m${vi}]`,
      );
      f.push(`color=c=black:s=${W}x${H}:r=30:d=${len}[b${vi}]`);
      f.push(`[b${vi}][m${vi}]overlay=x=${n(c.x ?? 0.5)}*W-w/2:y=${n(c.y ?? 0.5)}*H-h/2:shortest=1,format=yuv420p,setsar=1[v${vi}]`);
    } else f.push(
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
    return [`v${vi}`, `a${vi}`];
  };
  let tn = 0;
  /** the transition from the end of `prev` into the start of `c`, `d` seconds long; the sound crossfades */
  const transitionPiece = (prev, c, d) => {
    const [va, aa] = clipPiece(prev, prev.out - prev.in - d, d);
    const [vb, ab] = clipPiece(c, 0, d);
    const def = transitionDef(c.transition.type) ?? transitionDef("fade");
    const k = tn++;
    if (def.kind === "mask") {
      // the mask's brightness becomes the incoming clip's opacity (black: outgoing clip, white: incoming clip)
      args.push("-i", opts.resolve(def.mask));
      const mi = idx++;
      f.push(
        `[${mi}:v]setpts=PTS*${n(d / def.maskLen)},fps=30,tpad=stop_mode=clone:stop_duration=1,trim=end=${n(d)},` +
          `scale=${W}:${H}:in_range=tv:out_range=pc,format=gray[mk${k}]`,
      );
      f.push(`[${vb}]format=yuva420p[tb${k}]`);
      f.push(`[tb${k}][mk${k}]alphamerge[tm${k}]`);
      f.push(`[${va}][tm${k}]overlay=0:0:shortest=1,format=yuv420p,setsar=1[tv${k}]`);
    } else {
      // in RGB, like the preview: in YUV, xfade's "black" (Y = 0) is darker than black and clips the incoming clip away
      f.push(`[${va}]format=gbrp[xa${k}]`);
      f.push(`[${vb}]format=gbrp[xb${k}]`);
      f.push(`[xa${k}][xb${k}]xfade=transition=${def.xfade}:duration=${n(d)}:offset=0,format=yuv420p,setsar=1[tv${k}]`);
    }
    f.push(`[${aa}][${ab}]acrossfade=d=${n(d)}:c1=tri:c2=tri[ta${k}]`);
    return [`tv${k}`, `ta${k}`];
  };
  const pieces = [];
  project.clips.forEach((c, i) => {
    const dIn = transitionDur(project, i);
    const dOut = transitionDur(project, i + 1);
    if (dIn > 0) pieces.push(transitionPiece(project.clips[i - 1], c, dIn));
    const middle = c.out - c.in - dIn - dOut;
    if (middle > 0.5 / 30) pieces.push(clipPiece(c, dIn, middle));
  });
  let last;
  let abase;
  if (pieces.length) {
    f.push(`${pieces.map(([v, a]) => `[${v}][${a}]`).join("")}concat=n=${pieces.length}:v=1:a=1[vcat][acat]`);
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

  /**
   * An effect strip changes everything drawn so far (the main track and the tracks below it) while it runs.
   * Filters that can switch on and off by time use `enable`; the others (crop, zoompan, the light leak) work on a
   * copy that is laid over the picture only during the strip.
   */
  let en = 0;
  const effect = (o, from, out, gate) => {
    const a = o.amount ?? 0.5;
    const s = Math.min(W, H) / 720;
    const S = n(o.start);
    const e = en++;
    const onCopy = (filters) => {
      f.push(`[${from}]split[ea${e}][eb${e}]`);
      f.push(`[eb${e}]${filters},setsar=1[ec${e}]`);
      f.push(`[ea${e}][ec${e}]overlay=0:0:${gate}[${out}]`);
    };
    switch (o.effect) {
      case "blur": f.push(`[${from}]gblur=sigma=${n(fx.blurSigma(a, s))}:${gate}[${out}]`); break;
      case "pixelate": { const b = fx.pixelBlock(a, s); f.push(`[${from}]pixelize=w=${b}:h=${b}:${gate}[${out}]`); break; }
      case "bw": f.push(`[${from}]hue=s=0:${gate}[${out}]`); break;
      case "flash": f.push(`[${from}]eq=brightness='${fx.flashExpr(a, S)}':eval=frame:${gate}[${out}]`); break;
      case "glitch": { const g = fx.glitchShift(a, s); f.push(`[${from}]rgbashift=rh=${g}:bh=${-g}:${gate}[${out}]`); break; }
      case "grain": f.push(`[${from}]noise=c0s=${fx.grain(a)}:c0f=t+u:${gate}[${out}]`); break;
      // in RGB (picture times the factor), like the preview; in YUV it also darkens by the 16..235 offset
      case "vignette": f.push(`[${from}]format=gbrp,vignette=angle=${n(fx.vignetteAngle(a))}:${gate},format=yuv420p[${out}]`); break;
      case "shake": {
        const z = fx.shakeZoom(a);
        onCopy(`crop=${even(W / z)}:${even(H / z)}:x='(iw-ow)/2*(1+${fx.shakeXExpr(S)})':y='(ih-oh)/2*(1+${fx.shakeYExpr(S)})',scale=${W}:${H}`);
        break;
      }
      case "zoompulse":
        onCopy(`zoompan=z='${fx.pulseExpr(a, S).replace(/\bt\b/g, "in_time")}':d=1:x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':s=${W}x${H}:fps=30`);
        break;
      case "leak": {
        // the light-leak video, looped for the strip, black before and after it ("screen" with black changes nothing)
        const def = effectDef("leak");
        const len = n(o.end - o.start);
        args.push("-stream_loop", "-1", "-t", String(len), "-i", opts.resolve(def.asset));
        const li = idx++;
        f.push(`[${li}:v]scale=${W}:${H},fps=30,trim=end=${len},setpts=PTS-STARTPTS,format=gbrp,tpad=start_duration=${S}:stop_mode=add:stop_duration=${n(total - o.end + 1)}:color=black[lk${e}]`);
        f.push(`[${from}]format=gbrp[lb${e}]`);
        f.push(`[lb${e}][lk${e}]blend=all_mode=screen:all_opacity=${n(fx.leakOpacity(a))}:shortest=1,format=yuv420p[${out}]`);
        break;
      }
      default: f.push(`[${from}]null[${out}]`);
    }
    return out;
  };

  // 2. visual tracks, lowest first: text (drawtext), images and videos (overlay), effects, each gated to its time range
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
          (o.bg ? `box=1:boxcolor=${o.bg.replace("#", "0x")}@${n(o.bgOpacity ?? 0.6)}:boxborderw=${Math.round(size * 0.3)}:` : "") +
          `x=${n(o.x)}*w-text_w/2:y=${n(o.y)}*h-text_h/2:${gate}[${out}]`,
      );
    } else if (o.kind === "effect") {
      last = effect(o, last, out, gate);
      continue;
    } else if (o.kind === "image") {
      const ii = idx++;
      args.push("-i", opts.resolve(o.src));
      f.push(`[${ii}:v]scale=${Math.round(o.width * W)}:-1${turn(o.rotation)}[img${ii}]`);
      f.push(`[${last}][img${ii}]overlay=x=${n(o.x)}*W-w/2:y=${n(o.y)}*H-h/2:${gate}[${out}]`);
    } else {
      // video on an upper track: its own clock starts at o.start on the timeline
      const len = n(o.end - o.start);
      const ii = addInput(o.src, o.in, len);
      f.push(`[${ii}:v]trim=end=${len},setpts=PTS-STARTPTS+${n(o.start)}/TB,scale=${even(o.width * W)}:-2,setsar=1${turn(o.rotation)}[pip${ii}]`);
      f.push(`[${last}][pip${ii}]overlay=x=${n(o.x)}*W-w/2:y=${n(o.y)}*H-h/2:eof_action=pass:${gate}[${out}]`);
      if (o.hasAudio !== false && !o.muted) {
        const ms = Math.round(o.start * 1000);
        f.push(`[${ii}:a]atrim=end=${len},asetpts=PTS-STARTPTS,volume=${n(project.originalVolume)},${toStereo(o.channels)},adelay=delays=${ms}:all=1[pa${ii}]`);
        mix.push(`[pa${ii}]`);
      }
    }
    last = out;
  }

  // 2b. sound of videos on hidden tracks still plays
  for (const o of project.overlays) {
    if (o.kind !== "video" || !o.hidden || o.muted || o.hasAudio === false) continue;
    const len = n(o.end - o.start);
    const ii = addInput(o.src, o.in, len);
    const ms = Math.round(o.start * 1000);
    f.push(`[${ii}:a]atrim=end=${len},asetpts=PTS-STARTPTS,volume=${n(project.originalVolume)},${toStereo(o.channels)},adelay=delays=${ms}:all=1[pa${ii}]`);
    mix.push(`[pa${ii}]`);
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
