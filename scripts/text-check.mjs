// Titles in every font, in English and in Hindi, through the server export.
// Writes out/text-check.png (one frame per font) so the shaping of Hindi text can be looked at.
import ffmpegPath from "ffmpeg-static";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { render } from "../server/render-server.mjs";
import { FONTS, fontFor } from "../shared/fonts.js";

const sample = JSON.parse(readFileSync(new URL("../shared/sample-project.json", import.meta.url)));
const clip = { ...sample.clips[0], in: 1, out: 2 };
const shots = [];
for (const f of FONTS) {
  const project = {
    ...sample, aspect: "16:9", clips: [clip], audios: [], tracks: [],
    overlays: [
      { id: "a", kind: "text", text: `${f.label}: Diwali Sale 40% off`, font: f.id, fontSize: 40, color: "#FFFFFF", x: 0.5, y: 0.3, start: 0, end: 1 },
      { id: "b", kind: "text", text: "दिवाली की हार्दिक शुभकामनाएँ", font: f.id, fontSize: 52, color: "#FFE08A", x: 0.5, y: 0.6, start: 0, end: 1 },
    ],
  };
  const r = await render(project, 720, `text_${f.id}.mp4`);
  const png = `out/text_${f.id}.png`;
  spawnSync(ffmpegPath, ["-y", "-loglevel", "error", "-ss", "0.5", "-i", r.url.slice(1), "-frames:v", "1", png]);
  console.log(`${f.label.padEnd(24)} Hindi drawn with: ${fontFor("दिवाली", f.id).label.padEnd(22)} ${r.ms} ms`);
  shots.push(png);
}
spawnSync(ffmpegPath, ["-y", "-loglevel", "error", ...shots.flatMap((s) => ["-i", s]), "-filter_complex", `${shots.map((_, i) => `[${i}:v]scale=640:-1[s${i}]`).join(";")};${shots.map((_, i) => `[s${i}]`).join("")}vstack=inputs=${shots.length}`, "out/text-check.png"]);
console.log("wrote out/text-check.png");
