// Headless check of the server path: same edit JSON at 720p and 1080p, plus a codec matrix.
import { readFileSync } from "node:fs";
import { render } from "../server/render-server.mjs";
const project = JSON.parse(readFileSync(new URL("../shared/sample-project.json", import.meta.url)));
for (const h of [720, 1080]) {
  const r = await render(project, h, `bench_${h}.mp4`);
  console.log(`${h}p  ${r.width}x${r.height}  ${r.duration}s video  rendered in ${r.ms} ms  (${(r.bytes / 1024).toFixed(0)} KB)  speed ${(r.duration / (r.ms / 1000)).toFixed(1)}x realtime`);
}
// codec matrix: can the server read each container/codec as a clip?
for (const [name, dur] of [["clipA_h264_16x9.mp4", 8], ["clipC_vp9.webm", 5], ["clipD_hevc.mov", 5]]) {
  const p = { ...project, overlays: [], music: null, clips: [{ id: "x", name, src: "/media/" + name, in: 0, out: 2, srcDuration: dur, muted: false, hasAudio: true }] };
  try { const r = await render(p, 720, `codec_${name}.mp4`); console.log(`codec OK   ${name}  ${r.ms} ms`); }
  catch (e) { console.log(`codec FAIL ${name}  ${String(e.message).split("\n").pop()}`); }
}
