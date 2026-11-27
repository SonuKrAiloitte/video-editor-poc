// PoC render server: edit JSON in, MP4 out. Native FFmpeg (ffmpeg-static binary).
// In production this is a BullMQ worker in its own container, reading from and writing to S3.
import express from "express";
import cors from "cors";
import ffmpegPath from "ffmpeg-static";
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, mkdirSync, statSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFfmpegArgs } from "../shared/ffmpeg-graph.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root); // lets the filter graph use relative paths (no "C:" to escape)
mkdirSync("out/uploads", { recursive: true });

const app = express();
app.use(cors());
app.use("/out", express.static("out"));

// Browser-imported files are pushed here first so FFmpeg can read them.
// The body is streamed straight to disk, so a large upload never sits in memory.
// (Production: the browser uploads to S3 with a presigned URL and this endpoint disappears.)
app.put("/api/upload/:name", async (req, res) => {
  const safe = req.params.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const file = `out/uploads/${Date.now()}_${safe}`;
  try {
    await pipeline(req, createWriteStream(file));
    res.json({ src: "/" + file });
  } catch (e) {
    res.status(500).json({ error: String(e.message ?? e) });
  }
});

const resolve = (src) => {
  const clean = decodeURIComponent(src.split("?")[0]);
  if (clean.startsWith("/out/uploads/")) return clean.slice(1);
  if (clean.startsWith("/media/")) return "public" + clean;
  throw new Error("unknown media source: " + src);
};

// A small in-process queue: at most MAX_JOBS FFmpeg processes at once, the rest wait their turn.
// (Production: BullMQ + Redis, so the queue survives restarts and spreads over several workers.)
const MAX_JOBS = Number(process.env.MAX_JOBS ?? 2);
let running = 0;
const waiting = [];
export const queueState = () => ({ running, waiting: waiting.length, max: MAX_JOBS });
async function queued(job) {
  if (running >= MAX_JOBS) await new Promise((go) => waiting.push(go));
  running++;
  try {
    return await job();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

function ffmpeg(args) {
  return new Promise((ok, fail) => {
    const p = spawn(ffmpegPath, args);
    let log = "";
    p.stderr.on("data", (d) => (log = (log + d).slice(-6000)));
    p.on("close", (code) => (code === 0 ? ok(log) : fail(new Error(log.split("\n").slice(-12).join("\n")))));
  });
}

export function render(project, height, name = `export_${Date.now()}.mp4`) {
  const output = `out/${name}`;
  const { args, width, height: h, duration } = buildFfmpegArgs(project, {
    height, resolve, font: (file) => "public/fonts/" + file, output,
  });
  const asked = Date.now();
  return queued(async () => {
    const started = Date.now();
    await ffmpeg(args);
    return { url: "/" + output, ms: Date.now() - started, waitedMs: started - asked, bytes: statSync(output).size, width, height: h, duration };
  });
}

/** What FFmpeg says about a file's first video stream. */
export function describe(file) {
  const log = spawnSync(ffmpegPath, ["-hide_banner", "-i", file], { encoding: "utf8" }).stderr;
  const v = /Stream #0:\d+.*?: Video: [^\n]*/.exec(log)?.[0] ?? "";
  return {
    codec: /Video: (\w+)/.exec(v)?.[1] ?? null,
    hdr: /smpte2084|arib-std-b67/.test(v),
    hasAudio: /Stream #0:\d+.*?: Audio:/.test(log),
  };
}

/**
 * Normalise a file the browser cannot work with (AVI, HDR phone footage, unsupported codecs) into
 * a plain H.264 + AAC MP4 that every browser and every export engine reads. HDR is tone-mapped to SDR.
 */
export function convert(src) {
  const input = resolve(src);
  const output = `out/uploads/${Date.now()}_converted.mp4`;
  const info = describe(input);
  if (!info.codec) return Promise.reject(new Error("no video stream found in this file"));
  const fit = "scale='min(1920,iw)':'min(1920,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2";
  const toSdr = "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv";
  const vf = [info.hdr ? toSdr : null, fit, "format=yuv420p"].filter(Boolean).join(",");
  const args = [
    "-y", "-hide_banner", "-i", input, "-map", "0:v:0", "-map", "0:a:0?", "-vf", vf,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
    "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", output,
  ];
  return queued(async () => {
    const started = Date.now();
    await ffmpeg(args);
    return { src: "/" + output, ms: Date.now() - started, bytes: statSync(output).size, from: info.codec, hdr: info.hdr };
  });
}

app.post("/api/render", express.json({ limit: "2mb" }), async (req, res) => {
  try {
    res.json(await render(req.body.project, req.body.height ?? 720));
  } catch (e) {
    res.status(500).json({ error: String(e.message ?? e) });
  }
});

app.post("/api/convert", express.json({ limit: "64kb" }), async (req, res) => {
  try {
    res.json(await convert(req.body.src));
  } catch (e) {
    res.status(500).json({ error: String(e.message ?? e) });
  }
});

app.get("/api/queue", (_req, res) => res.json(queueState()));

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  app.listen(5181, () => console.log(`render server on http://localhost:5181 (up to ${MAX_JOBS} exports at once)`));
}
