// Renders the sample edit in all three aspect ratios on the server and reports the real output size.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import ffmpeg from "ffmpeg-static";
import { render } from "../server/render-server.mjs";
const project = JSON.parse(readFileSync(new URL("../shared/sample-project.json", import.meta.url)));
for (const aspect of ["16:9", "9:16", "1:1"]) for (const h of [720, 1080]) {
  const name = `aspect_${aspect.replace(":", "x")}_${h}.mp4`;
  const r = await render({ ...project, aspect }, h, name);
  const probe = spawnSync(ffmpeg, ["-hide_banner", "-i", "out/" + name], { encoding: "utf8" }).stderr;
  console.log(`${aspect} ${h}p -> reported ${r.width}x${r.height}, file says ${/, (\d+x\d+)[ ,]/.exec(probe)?.[1]}, ${r.ms} ms`);
}
