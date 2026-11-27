// PoC render server: edit JSON in, MP4 out. Native FFmpeg (ffmpeg-static binary).
// In production this is a BullMQ worker in its own container, reading from and writing to S3.
import express from "express";
import cors from "cors";
import ffmpegPath from "ffmpeg-static";
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
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
  const size = /, (\d{2,5})x(\d{2,5})/.exec(v);
  return {
    codec: /Video: (\w+)/.exec(v)?.[1] ?? null,
    width: size ? Number(size[1]) : null,
    height: size ? Number(size[2]) : null,
    fps: Number(/([\d.]+) fps/.exec(v)?.[1] ?? 0) || null,
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

/**
 * A light copy of an uploaded video for the editor's preview: the short side at most 720, at most 30 frames a second,
 * and a keyframe every second, so playing and jumping around stay smooth on a slow laptop. Exports always read the
 * original. Made in the background after the upload, one at a time and apart from the export queue, so it never
 * delays an export. (Production: a job on the same worker, written next to the original in S3.)
 */
const proxies = new Map(); // original src -> { status: "working" | "ready" | "not-needed" | "failed", proxy?, ms?, error? }
let proxyChain = Promise.resolve();
export function makeProxy(src) {
  const known = proxies.get(src);
  if (known) return known;
  const input = resolve(src);
  const info = describe(input);
  const short = Math.min(info.width ?? 0, info.height ?? 0);
  const fast = (info.fps ?? 0) > 31;
  if (!info.codec || (short <= 720 && !fast)) return proxies.set(src, { status: "not-needed" }).get(src);
  const output = input.replace(/\.[^./]+$/, "") + ".proxy.mp4";
  // made before a server restart
  if (existsSync(output) && statSync(output).size > 0) return proxies.set(src, { status: "ready", proxy: "/" + output, ms: 0 }).get(src);
  const state = { status: "working" };
  proxies.set(src, state);
  // the short side becomes 720 (a phone video stays upright), never enlarged
  const scale = (info.width ?? 0) >= (info.height ?? 0) ? "scale=-2:'min(720,ih)'" : "scale='min(720,iw)':-2";
  const vf = [scale, fast ? "fps=30" : null, "format=yuv420p"].filter(Boolean).join(",");
  const args = [
    "-y", "-hide_banner", "-i", input, "-map", "0:v:0", "-map", "0:a:0?", "-vf", vf,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-g", "30", "-keyint_min", "30",
    "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", output,
  ];
  proxyChain = proxyChain.then(async () => {
    const started = Date.now();
    try {
      await ffmpeg(args);
      Object.assign(state, { status: "ready", proxy: "/" + output, ms: Date.now() - started });
    } catch (e) {
      Object.assign(state, { status: "failed", error: String(e.message ?? e).slice(-300) });
    }
  });
  return state;
}
app.post("/api/proxy", express.json({ limit: "64kb" }), (req, res) => {
  try {
    res.json(makeProxy(req.body.src));
  } catch (e) {
    res.status(500).json({ status: "failed", error: String(e.message ?? e) });
  }
});

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

// Upload endpoint for Twick Studio's own "Upload" buttons (its "gcs" mode: multipart form with a
// "file" field, answer { url }). Without an endpoint like this Twick only offers "paste a URL".
// Files the browser cannot play (AVI and similar, or HDR) are converted first, like in our own editor.
const BROWSER_UNFRIENDLY = /\.(avi|wmv|flv|mpg|mpeg|ts|mkv|3gp)$/i;
app.post("/api/twick-upload", async (req, res) => {
  try {
    const form = await new Request("http://local/", {
      method: "POST", headers: { "content-type": req.headers["content-type"] }, body: Readable.toWeb(req), duplex: "half",
    }).formData();
    const file = form.get("file");
    if (!file || typeof file === "string") return res.status(400).json({ error: "no file in the upload" });
    const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const saved = `out/uploads/${Date.now()}_${safe}`;
    writeFileSync(saved, Buffer.from(await file.arrayBuffer()));
    // Twick needs a full URL: with a path like "/out/uploads/x.mp4" the clip shows in the library and plays,
    // but "Add to timeline" silently does nothing. The browser's Origin header is the app's own address.
    const base = req.headers.origin ?? `http://${req.headers.host}`;
    const isVideo = (file.type || "").startsWith("video") || BROWSER_UNFRIENDLY.test(safe);
    if (isVideo && (BROWSER_UNFRIENDLY.test(safe) || describe(saved).hdr)) {
      const done = await convert("/" + saved);
      return res.json({ url: base + done.src, convertedFrom: done.from });
    }
    res.json({ url: base + "/" + saved });
  } catch (e) {
    res.status(500).json({ error: String(e.message ?? e) });
  }
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  app.listen(5181, () => console.log(`render server on http://localhost:5181 (up to ${MAX_JOBS} exports at once)`));
}
