// Generates small synthetic test clips so every demo runs on identical inputs.
import ffmpeg from "ffmpeg-static";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
const out = new URL("../public/media/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
mkdirSync(out, { recursive: true });
const run = (args) => execFileSync(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", ...args], { stdio: "inherit" });
// Arial on Windows (what the benchmark clips were made with); the bundled font on Linux and macOS
const font = (win) => existsSync(`C:/Windows/Fonts/${win}`) ? `C\:/Windows/Fonts/${win}` : new URL("../public/fonts/PlusJakartaSans.ttf", import.meta.url).pathname;
const txt = (t) => `drawtext=text='${t}':fontcolor=white:fontsize=64:x=(w-tw)/2:y=(h-th)/2:box=1:boxcolor=black@0.5:fontfile='${font("arial.ttf")}'`;
// A: 16:9 H.264/AAC MP4, 8s
run(["-f","lavfi","-i","testsrc2=size=1280x720:rate=30:duration=8","-f","lavfi","-i","sine=frequency=440:duration=8",
  "-vf",txt("CLIP A h264"),"-c:v","libx264","-pix_fmt","yuv420p","-c:a","aac","-shortest",out+"clipA_h264_16x9.mp4"]);
// B: 9:16 H.264/AAC MP4, 6s
run(["-f","lavfi","-i","smptebars=size=720x1280:rate=30:duration=6","-f","lavfi","-i","sine=frequency=660:duration=6",
  "-vf",txt("CLIP B 9x16"),"-c:v","libx264","-pix_fmt","yuv420p","-c:a","aac","-shortest",out+"clipB_h264_9x16.mp4"]);
// C: VP9/Opus WebM, 5s
run(["-f","lavfi","-i","mandelbrot=size=1280x720:rate=30","-f","lavfi","-i","sine=frequency=330:duration=5",
  "-t","5","-vf",txt("CLIP C vp9"),"-c:v","libvpx-vp9","-b:v","1M","-deadline","realtime","-cpu-used","8","-c:a","libopus",out+"clipC_vp9.webm"]);
// D: HEVC/AAC MOV (iPhone-style), 5s
run(["-f","lavfi","-i","testsrc=size=1920x1080:rate=30:duration=5","-f","lavfi","-i","sine=frequency=550:duration=5",
  "-vf",txt("CLIP D hevc mov"),"-c:v","libx265","-tag:v","hvc1","-pix_fmt","yuv420p","-c:a","aac","-shortest",out+"clipD_hevc.mov"]);
// music: 20s mp3
run(["-f","lavfi","-i","sine=frequency=220:duration=20","-af","tremolo=f=4:d=0.7","-c:a","libmp3lame",out+"music.mp3"]);
// logo png with alpha
run(["-f","lavfi","-i","color=c=0x283E73@0.9:s=320x120,format=rgba","-frames:v","1",
  "-vf",`drawtext=text='LOGO':fontcolor=white:fontsize=72:x=(w-tw)/2:y=(h-th)/2:fontfile='${font("arialbd.ttf")}'`,out+"logo.png"]);
console.log("media written to", out);
