// Runs REAL video files (not the generated test clips) through the server export.
//   1. every file alone: 3 seconds, vertical 720p, with a title
//   2. one mixed edit of all of them, at 720p and 1080p
//   3. long exports: the longest file in full
// Then checks each output: duration, black frames, and whether sound is present.
// usage: node scripts/real-media-check.mjs <file> [<file> ...]
import ffmpegPath from "ffmpeg-static";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { render } from "../server/render-server.mjs";
import { probe } from "./probe.mjs";

mkdirSync("out/uploads", { recursive: true });
const files = process.argv.slice(2).map((f, i) => {
  const info = probe(f);
  const local = `out/uploads/real_${i}${path.extname(f).toLowerCase()}`;
  copyFileSync(f, local);
  return { ...info, src: "/" + local };
});

/** what is actually in an exported file */
function inspect(url, expectAudio) {
  const file = url.slice(1);
  const out = probe(file);
  const log = spawnSync(ffmpegPath, ["-hide_banner", "-i", file, "-vf", "blackdetect=d=0.3:pix_th=0.08", "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" }).stderr;
  const black = [...log.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map((m) => `${(+m[1]).toFixed(1)}-${(+m[2]).toFixed(1)}s`);
  const mean = /mean_volume: (-?[\d.]+|-inf) dB/.exec(log)?.[1];
  const silent = mean === undefined || mean === "-inf" || +mean < -80;
  return { duration: out.duration, size: out.size, black, meanDb: mean, audioOk: expectAudio ? !silent : true };
}

const clip = (f, i, from, len) => {
  const dur = f.duration ?? from + len; // some screen recordings carry no duration
  const start = Math.min(from, Math.max(0, dur - len));
  const end = Math.min(dur, start + len);
  return { id: "c" + i, name: f.file, src: f.src, in: start, out: end, srcDuration: dur, muted: false, hasAudio: f.channels > 0, channels: f.channels || undefined };
};
const title = (text, end) => ({ id: "t", kind: "text", text, x: 0.5, y: 0.14, start: 0, end, fontSize: 44, color: "#ffffff" });
const base = { aspect: "9:16", originalVolume: 1, music: null, overlays: [] };
const row = (label, r, chk, want) =>
  console.log(
    `${chk.duration !== null && Math.abs(chk.duration - want) < 0.15 && chk.black.length === 0 && chk.audioOk ? "OK  " : "WARN"} ${label.padEnd(44)} ` +
      `${(r.ms / 1000).toFixed(1).padStart(6)} s  out ${chk.size} ${String(chk.duration).padStart(6)}s (want ${want.toFixed(2)})  ` +
      `black:${chk.black.length ? chk.black.join(",") : "none"}  sound:${chk.meanDb ?? "none"} dB`,
  );

console.log("\n1. each real file alone (3 s, vertical 720p, with title)");
for (const [i, f] of files.entries()) {
  const c = clip(f, i, 1, 3);
  const p = { ...base, clips: [c], overlays: [title("Real footage: 100% test", c.out - c.in)] };
  try {
    const r = await render(p, 720, `real_single_${i}.mp4`);
    row(`${f.file.slice(0, 30)} [${f.video} ${f.size} ${f.fps ?? "?"}fps]`, r, inspect(r.url, c.hasAudio), c.out - c.in);
  } catch (e) {
    console.log(`FAIL ${f.file}  ${String(e.message).split("\n").filter(Boolean).pop()}`);
  }
}

console.log("\n2. mixed edit: every file, 3 s each, title + logo + music");
const mixed = {
  ...base,
  clips: files.map((f, i) => clip(f, i, 1, 3)),
  music: { src: "/media/music.mp3", volume: 0.3, channels: 1 },
};
const total = mixed.clips.reduce((s, c) => s + c.out - c.in, 0);
mixed.overlays = [title("Diwali Sale: 40% off", Math.min(6, total)), { id: "l", kind: "image", src: "/media/logo.png", x: 0.82, y: 0.9, width: 0.22, start: 0, end: total }];
for (const [aspect, h] of [["9:16", 720], ["9:16", 1080], ["16:9", 1080], ["1:1", 720]]) {
  try {
    const r = await render({ ...mixed, aspect }, h, `real_mixed_${aspect.replace(":", "x")}_${h}.mp4`);
    row(`mixed ${files.length} clips ${aspect} ${h}p`, r, inspect(r.url, true), total);
  } catch (e) {
    console.log(`FAIL mixed ${aspect} ${h}p  ${String(e.message).split("\n").filter(Boolean).slice(-3).join(" | ")}`);
  }
}

console.log("\n3. long exports");
const long = [...files].filter((f) => f.duration).sort((a, b) => b.duration - a.duration)[0];
if (long) {
  for (const [label, from, len] of [["5 s taken from near the end", long.duration - 8, 5], ["first 60 s", 0, 60], ["whole file", 0, long.duration]]) {
    if (len > long.duration) continue;
    const c = clip(long, 0, from, len);
    try {
      const r = await render({ ...base, aspect: "16:9", clips: [c], overlays: [title("Long video", 5)] }, 1080, `real_long_${Math.round(len)}.mp4`);
      row(`${label} of ${long.duration}s file, 1080p`, r, inspect(r.url, c.hasAudio), c.out - c.in);
    } catch (e) {
      console.log(`FAIL ${label}  ${String(e.message).split("\n").filter(Boolean).pop()}`);
    }
  }
}
