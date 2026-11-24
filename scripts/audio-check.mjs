// Proves what is actually in an export's audio: measures loudness of each test tone, per timeline segment.
// Test tones: clip A = 440 Hz, clip C = 330 Hz, clip B = 660 Hz, clip D = 550 Hz, music = 220 Hz.
import ffmpeg from "ffmpeg-static";
import { spawnSync } from "node:child_process";
const [file, ...segs] = process.argv.slice(2); // segs like 0-4 4-7 7-10
const level = (from, to, hz) => {
  const r = spawnSync(ffmpeg, ["-hide_banner", "-ss", from, "-to", to, "-i", file, "-af", `bandpass=f=${hz}:width_type=h:w=30,volumedetect`, "-vn", "-f", "null", "-"], { encoding: "utf8" });
  const m = /mean_volume: (-?[\d.]+|-inf) dB/.exec(r.stderr);
  return m ? m[1] : "no-audio";
};
for (const s of segs) {
  const [a, b] = s.split("-");
  console.log(`${s.padEnd(6)} s  ` + [220, 330, 440, 550, 660].map((hz) => `${hz}Hz ${String(level(a, b, hz)).padStart(6)} dB`).join("   "));
}
