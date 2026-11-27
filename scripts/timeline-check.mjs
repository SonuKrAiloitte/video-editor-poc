// Server-render checks for photo clips and placed music pieces. Fast (no browser); needs `npm run media` only.
//   node scripts/timeline-check.mjs
// Test tones: clip A = 440 Hz, clip B = 660 Hz, music = 220 Hz.
import { spawnSync } from "node:child_process";
import ffmpeg from "ffmpeg-static";
import { render } from "../server/render-server.mjs";

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
};
const level = (file, from, to, hz) => {
  const r = spawnSync(ffmpeg, ["-hide_banner", "-ss", String(from), "-to", String(to), "-i", file, "-af", `bandpass=f=${hz}:width_type=h:w=30,volumedetect`, "-vn", "-f", "null", "-"], { encoding: "utf8" });
  const m = /mean_volume: (-?[\d.]+|-inf) dB/.exec(r.stderr);
  return m ? (m[1] === "-inf" ? -120 : Number(m[1])) : -120;
};
const duration = (file) => {
  const r = spawnSync(ffmpeg, ["-hide_banner", "-i", file], { encoding: "utf8" });
  const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(r.stderr);
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0;
};
/** decoded video frames in the file (30 fps output, so 1 s = 30 frames) */
const frames = (file) => {
  const r = spawnSync(ffmpeg, ["-hide_banner", "-i", file, "-map", "0:v:0", "-f", "null", "-"], { encoding: "utf8" });
  const all = [...r.stderr.matchAll(/frame=\s*(\d+)/g)];
  return all.length ? Number(all.at(-1)[1]) : 0;
};
const LOUD = -45; // a tone at least this loud in its band is "present"

const videoClip = (id, name, inS, outS, src = 8) => ({ id, name, src: `/media/${name}`, in: inS, out: outS, srcDuration: src, muted: false, hasAudio: true, channels: 1 });
const photo = (id, len) => ({ id, kind: "image", name: "logo.png", src: "/media/logo.png", in: 0, out: len, srcDuration: 60, muted: false, hasAudio: false });
const song = (id, start, inS, outS, volume = 0.5) => ({ id, name: "music.mp3", src: "/media/music.mp3", start, in: inS, out: outS, srcDuration: 20, volume, channels: 1 });
const base = { aspect: "9:16", originalVolume: 1, overlays: [] };

// 1. a story made only of photos
try {
  const r = await render({ ...base, clips: [photo("p1", 5), photo("p2", 3)], audio: [] }, 720, "tl_photos.mp4");
  const d = duration("out/tl_photos.mp4");
  const f = frames("out/tl_photos.mp4");
  check("photo-only story renders 8 s of picture", Math.abs(d - 8) < 0.15 && Math.abs(f - 240) <= 2, `${d.toFixed(2)} s, ${f} frames, ${r.width}x${r.height}`);
} catch (e) { check("photo-only story renders", false, String(e.message).split("\n").pop()); }

// 2. photo then video: the video's sound starts when the video does
try {
  await render({ ...base, clips: [photo("p1", 3), videoClip("a", "clipA_h264_16x9.mp4", 0, 3)], audio: [] }, 720, "tl_mixed.mp4");
  const f = frames("out/tl_mixed.mp4");
  check("photo then video gives 6 s of picture", Math.abs(f - 180) <= 2, `${f} frames`);
  const before = level("out/tl_mixed.mp4", 0.3, 2.7, 440);
  const after = level("out/tl_mixed.mp4", 3.3, 5.7, 440);
  check("photo clip is silent, the video after it is not", before < LOUD && after > LOUD, `440 Hz ${before} dB then ${after} dB`);
} catch (e) { check("photo clip is silent, the video after it is not", false, String(e.message).split("\n").pop()); }

// 3. one music piece placed at 4 s plays only from 4 s
try {
  await render({ ...base, clips: [videoClip("a", "clipA_h264_16x9.mp4", 0, 8)], originalVolume: 0, audio: [song("m1", 4, 2, 8)] }, 720, "tl_placed.mp4");
  const early = level("out/tl_placed.mp4", 0.3, 3.7, 220);
  const late = level("out/tl_placed.mp4", 4.3, 7.7, 220);
  check("music placed at 4 s is silent before and audible after", early < LOUD && late > LOUD, `220 Hz ${early} dB then ${late} dB`);
} catch (e) { check("music placed at 4 s is silent before and audible after", false, String(e.message).split("\n").pop()); }

// 4. two pieces, with a gap between them
try {
  await render({ ...base, clips: [videoClip("a", "clipA_h264_16x9.mp4", 0, 8)], originalVolume: 0, audio: [song("m1", 0, 0, 2), song("m2", 5, 10, 13)] }, 720, "tl_two.mp4");
  const a = level("out/tl_two.mp4", 0.3, 1.7, 220);
  const gap = level("out/tl_two.mp4", 2.4, 4.6, 220);
  const b = level("out/tl_two.mp4", 5.3, 7.7, 220);
  check("two music pieces play in their own ranges, silence between", a > LOUD && gap < LOUD && b > LOUD, `${a} / ${gap} / ${b} dB`);
} catch (e) { check("two music pieces play in their own ranges, silence between", false, String(e.message).split("\n").pop()); }

// 5. a draft saved before music pieces existed ({ music }) still renders with its music
try {
  await render({ ...base, clips: [videoClip("a", "clipA_h264_16x9.mp4", 0, 4)], originalVolume: 0, music: { src: "/media/music.mp3", name: "music.mp3", volume: 0.5, channels: 1 } }, 720, "tl_legacy.mp4");
  const m = level("out/tl_legacy.mp4", 0.3, 3.7, 220);
  check("old single-music drafts still render their music", m > LOUD, `${m} dB`);
} catch (e) { check("old single-music drafts still render their music", false, String(e.message).split("\n").pop()); }

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
