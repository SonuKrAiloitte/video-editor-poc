// Makes the transition and effect CONTENT the editor ships with, into public/fx. In production a designer makes these
// (After Effects or similar) and uploads them to the asset library; the code that plays them does not change.
//   ink.mp4, brush.mp4  mask videos for transitions: black = outgoing clip, white = incoming clip, 1 s, 30 fps
//   leak.mp4            a warm light leak on black, laid over the picture in "screen" mode, 3 s, 30 fps
// usage: node scripts/make-fx-assets.mjs
import ffmpeg from "ffmpeg-static";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";

mkdirSync("public/fx", { recursive: true });
const run = (args) => {
  const r = spawnSync(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
};
const enc = ["-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p", "-movflags", "+faststart"];

// a soft random field, 0..255, the "ink" that spreads
// (noise on a small picture, enlarged smoothly: soft blobs instead of grain)
run(["-f", "lavfi", "-i", "color=c=gray:s=36x36:d=1", "-vf", "format=gray,noise=alls=100:allf=u,scale=720:720:flags=bicubic,gblur=sigma=10,normalize", "-frames:v", "1", "public/fx/_field.png"]);
// ink: the incoming clip seeps in where the field is lowest first
run(["-loop", "1", "-i", "public/fx/_field.png", "-t", "1", "-r", "30", "-vf", "format=gray,geq=lum='clip((T*330-p(X,Y))*4,0,255)'", ...enc, "public/fx/ink.mp4"]);
// brush: a wipe from left to right with a ragged edge
run(["-loop", "1", "-i", "public/fx/_field.png", "-t", "1", "-r", "30", "-vf", "format=gray,geq=lum='clip((T*400-(X/W*230+p(X,Y)*0.45))*3,0,255)'", ...enc, "public/fx/brush.mp4"]);
// light leak: two warm glows drifting across black
const glow = (cx, cy, r) => `exp(-((X-W*(${cx}))*(X-W*(${cx}))+(Y-H*(${cy}))*(Y-H*(${cy})))/(2*(W*${r})*(W*${r})))`;
const a = glow("0.15+0.25*T", "0.25+0.05*sin(T*2)", 0.22);
const b = glow("0.95-0.2*T", "0.8", 0.16);
run([
  "-f", "lavfi", "-i", "color=c=black:s=640x360:r=30:d=3", "-vf",
  `format=gbrp,geq=r='clip(255*(${a}+0.8*${b}),0,255)':g='clip(150*(${a})+90*(${b}),0,255)':b='clip(50*(${a})+30*(${b}),0,255)'`,
  ...enc, "public/fx/leak.mp4",
]);
rmSync("public/fx/_field.png", { force: true });
console.log("wrote public/fx/ink.mp4, brush.mp4, leak.mp4");
