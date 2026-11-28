// Server-only check of transitions and effects: every transition between two clips and every effect strip render with
// FFmpeg, and the file is as long as the edit says. No browser needed. usage: node scripts/fx-render-check.mjs
import ffmpegPath from "ffmpeg-static";
import { spawnSync } from "node:child_process";
import { render } from "../server/render-server.mjs";
import { EFFECTS, TRANSITIONS } from "../shared/fx.js";
import { projectDuration } from "../shared/model.js";

const durOf = (file) => Number(/Duration: (\d+):(\d+):([\d.]+)/.exec(spawnSync(ffmpegPath, ["-hide_banner", "-i", file], { encoding: "utf8" }).stderr)?.slice(1).reduce((s, x) => s * 60 + Number(x), 0));
const clip = (id, name, inT, out, extra = {}) => ({ id, kind: "video", name, src: `/media/${name}`, in: inT, out, srcDuration: 8, muted: false, hasAudio: true, channels: 1, ...extra });
let failed = 0;
const only = process.argv[2];

for (const t of TRANSITIONS) {
  if (only && only !== t.id) continue;
  const p = {
    aspect: "9:16", originalVolume: 1, tracks: [], overlays: [], audios: [],
    clips: [clip("a", "clipA_h264_16x9.mp4", 0, 3), clip("b", "clipB_h264_9x16.mp4", 0, 3, { transition: { type: t.id, duration: 1 } }), clip("c", "clipC_vp9.webm", 0, 2, { transition: { type: t.id, duration: 0.5 } })],
  };
  try {
    const r = await render(p, 720, `fx_t_${t.id}.mp4`);
    const d = durOf("out/" + `fx_t_${t.id}.mp4`);
    const want = projectDuration(p);
    const ok = Math.abs(d - want) < 0.07;
    if (!ok) failed++;
    console.log(`${ok ? "OK  " : "FAIL"} transition ${t.id.padEnd(11)} ${(r.ms / 1000).toFixed(1)} s, file ${d.toFixed(2)} s (edit ${want.toFixed(2)} s)`);
  } catch (e) {
    failed++;
    console.log(`FAIL transition ${t.id}: ${String(e.message).split("\n").slice(-4).join(" | ")}`);
  }
}
for (const e of EFFECTS) {
  if (only && only !== e.id) continue;
  const p = {
    aspect: "16:9", originalVolume: 1, audios: [],
    clips: [clip("a", "clipA_h264_16x9.mp4", 0, 6)],
    tracks: [{ id: "fx", kind: "visual" }, { id: "t1", kind: "visual" }],
    overlays: [
      { id: "title", track: "t1", kind: "text", text: "Effect test", fontSize: 40, color: "#FFFFFF", x: 0.5, y: 0.2, start: 0, end: 6 },
      { id: "e", track: "fx", kind: "effect", effect: e.id, amount: 0.6, x: 0.5, y: 0.5, start: 1.5, end: 4.5 },
    ],
  };
  try {
    const r = await render(p, 720, `fx_e_${e.id}.mp4`);
    const d = durOf("out/" + `fx_e_${e.id}.mp4`);
    const ok = Math.abs(d - 6) < 0.07;
    if (!ok) failed++;
    console.log(`${ok ? "OK  " : "FAIL"} effect     ${e.id.padEnd(11)} ${(r.ms / 1000).toFixed(1)} s, file ${d.toFixed(2)} s (edit 6.00 s)`);
  } catch (err) {
    failed++;
    console.log(`FAIL effect ${e.id}: ${String(err.message).split("\n").slice(-4).join(" | ")}`);
  }
}
console.log(failed ? `${failed} FAILED` : "all rendered");
process.exit(failed ? 1 : 0);
