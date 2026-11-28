// Prints container, codecs, size, frame rate, rotation and duration of real files (uses the bundled FFmpeg).
// usage: node scripts/probe.mjs <file> [<file> ...]
import ffmpegPath from "ffmpeg-static";
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";

export function probe(file) {
  const log = spawnSync(ffmpegPath, ["-hide_banner", "-i", file], { encoding: "utf8" }).stderr;
  const dur = /Duration: (\d+):(\d+):([\d.]+)/.exec(log);
  const v = /Stream #0:\d+.*?: Video: (\w+)(?: \(([^)]*)\))?[^\n]*?, (\d{2,5})x(\d{2,5})[^\n]*/.exec(log);
  const a = /Stream #0:\d+.*?: Audio: (\w+)[^\n]*?, (\d+) Hz, ([\w.()]+)/.exec(log);
  const fps = v && /([\d.]+) fps/.exec(v[0]);
  const tbr = v && /([\d.]+) tbr/.exec(v[0]);
  const pix = v && /(yuv[\w]+|gbr[\w]+|nv\d+)/.exec(v[0]);
  const rot = /rotation of (-?[\d.]+) degrees/.exec(log) ?? /rotate\s*:\s*(-?\d+)/.exec(log);
  return {
    file: path.basename(file),
    mb: +(statSync(file).size / 1048576).toFixed(1),
    duration: dur ? +(+dur[1] * 3600 + +dur[2] * 60 + +dur[3]).toFixed(2) : null,
    video: v ? `${v[1]}${v[2] ? " " + v[2] : ""}` : null,
    size: v ? `${v[3]}x${v[4]}` : null,
    pix: pix?.[1] ?? null,
    fps: fps ? +fps[1] : null,
    tbr: tbr ? +tbr[1] : null,
    rotation: rot ? +rot[1] : 0,
    audio: a ? `${a[1]} ${a[2]}Hz ${a[3]}` : null,
    channels: a ? (a[3].startsWith("mono") ? 1 : 2) : 0,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.slice(1))) {
  for (const f of process.argv.slice(2)) console.log(JSON.stringify(probe(f)));
}
