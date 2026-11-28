// Makes clips that behave like phone-camera files, for the cases generated colour bars do not cover:
//   rotated.mp4      H.264 stored sideways with a 90 degree rotation flag (how phones record portrait)
//   iphone_like.mov  HEVC in MOV with a rotation flag
//   hdr10.mp4        HEVC 10-bit HDR (BT.2020, PQ), like an HDR phone recording
//   vfr.mp4          variable frame rate (frames dropped at random), like a phone in low light
// These are SYNTHETIC. They exercise the same file features, but they are not real camera footage.
import ffmpegPath from "ffmpeg-static";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";

mkdirSync("out/phone", { recursive: true });
const run = (label, args) => {
  const r = spawnSync(ffmpegPath, ["-y", "-hide_banner", "-loglevel", "error", ...args], { encoding: "utf8" });
  console.log(`${r.status === 0 ? "made" : "FAILED"} ${label}${r.status === 0 ? "" : "\n" + r.stderr.split("\n").slice(-4).join("\n")}`);
};
const font = "public/fonts/PlusJakartaSans.ttf";
// A scene with an obvious "up": the word TOP near the top edge and a moving box, 1080x1920 upright.
const upright = (extra = "") =>
  `testsrc2=s=1080x1920:r=30:d=6,drawtext=fontfile=${font}:text='TOP':fontsize=160:fontcolor=white:box=1:boxcolor=black@0.6:x=(w-text_w)/2:y=80${extra}`;
const tone = "sine=frequency=440:sample_rate=48000:duration=6";

// 1. stored sideways (1920x1080) + rotation flag, the way a phone held upright records
run("rotated.mp4 (sideways pixels, upright via flag)", ["-f", "lavfi", "-i", upright(",transpose=1"), "-f", "lavfi", "-i", tone, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "out/phone/_sideways.mp4"]);
run("rotated.mp4", ["-display_rotation", "90", "-i", "out/phone/_sideways.mp4", "-c", "copy", "out/phone/rotated.mp4"]);

// 2. HEVC in MOV with the same flag
run("iphone_like.mov (encode)", ["-f", "lavfi", "-i", upright(",transpose=1"), "-f", "lavfi", "-i", tone, "-c:v", "libx265", "-tag:v", "hvc1", "-pix_fmt", "yuv420p", "-x265-params", "log-level=error", "-c:a", "aac", "-shortest", "out/phone/_sideways_hevc.mov"]);
run("iphone_like.mov", ["-display_rotation", "90", "-i", "out/phone/_sideways_hevc.mov", "-c", "copy", "-tag:v", "hvc1", "out/phone/iphone_like.mov"]);

// 3. HDR10: 10-bit HEVC flagged BT.2020 + PQ
run("hdr10.mp4", [
  "-f", "lavfi", "-i", upright(), "-f", "lavfi", "-i", tone,
  "-vf", "zscale=tin=bt709:t=smpte2084:pin=bt709:p=bt2020:min=bt709:m=bt2020nc:r=tv,format=yuv420p10le",
  "-c:v", "libx265", "-tag:v", "hvc1", "-x265-params", "log-level=error:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc",
  "-color_primaries", "bt2020", "-color_trc", "smpte2084", "-colorspace", "bt2020nc", "-c:a", "aac", "-shortest", "out/phone/hdr10.mp4",
]);

// 4. variable frame rate: drop about a third of the frames at random and keep the real timestamps
run("vfr.mp4", ["-f", "lavfi", "-i", upright(), "-f", "lavfi", "-i", tone, "-vf", "select='gt(random(0),0.33)'", "-fps_mode", "vfr", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "out/phone/vfr.mp4"]);
