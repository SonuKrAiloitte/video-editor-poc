// PoC render server: edit JSON in, MP4 out. Native FFmpeg (ffmpeg-static binary).
// Also stands in for the platform's media library: uploads and saved exports live on disk here.
// In production this is a BullMQ worker in its own container, reading from and writing to S3,
// and the library is the platform's own media table.
import express from "express";
import ffmpegPath from "ffmpeg-static";
import { spawn } from "node:child_process";
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { buildFfmpegArgs } from "../shared/ffmpeg-graph.js";
import { FONTS } from "../shared/fonts.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root); // lets the filter graph use relative paths (no "C:" to escape)
mkdirSync("out/uploads", { recursive: true });
mkdirSync("out/library", { recursive: true });
mkdirSync("out/render-assets", { recursive: true });

const MAX_UPLOAD = 500 * 1024 * 1024;
const RENDER_TIMEOUT_MS = 5 * 60 * 1000;

const app = express();
// no CORS: the app reaches this server through the Vite proxy (same origin), so other websites cannot
app.use("/out", express.static("out"));

const safeName = (name) => String(name).replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120) || "file";
const stamp = (name) => `${Date.now()}_${safeName(name)}`;

const KIND = {
  video: [".mp4", ".mov", ".webm", ".m4v", ".mkv"],
  audio: [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".opus"],
  image: [".png", ".jpg", ".jpeg", ".gif", ".webp"],
};
const kindOf = (file) => {
  const ext = path.extname(file).toLowerCase();
  return Object.keys(KIND).find((k) => KIND[k].includes(ext)) ?? null;
};

// Media the edit JSON may point at, mapped to folders on disk. Anything else is refused.
const ROOTS = [
  { url: "/out/uploads/", dir: path.join(root, "out/uploads") },
  { url: "/out/library/", dir: path.join(root, "out/library") },
  // title pictures the browser draws for an export; never listed in the library
  { url: "/out/render-assets/", dir: path.join(root, "out/render-assets") },
  { url: "/media/", dir: path.join(root, "public/media") },
  // finished server renders, so one can be saved to the library
  { url: "/out/", dir: path.join(root, "out") },
];
export const resolve = (src) => {
  const clean = decodeURIComponent(String(src).split("?")[0]);
  for (const r of ROOTS) {
    if (!clean.startsWith(r.url)) continue;
    const file = path.resolve(r.dir, clean.slice(r.url.length));
    // path.resolve collapses "..", so this catches any attempt to climb out of the folder
    if (!file.startsWith(r.dir + path.sep)) break;
    if (!existsSync(file)) throw new Error("media file not found: " + clean);
    return path.relative(root, file).split(path.sep).join("/");
  }
  throw new Error("unknown media source: " + src);
};

// files the user imports are pushed here, so FFmpeg can read them and the draft survives a reload
async function receive(req, res, dir) {
  // only media: anything else (say an .html page) would be served back from the app's own address
  if (!kindOf(req.params.name)) return res.status(415).json({ error: "Only video, audio and picture files can be added." });
  const length = Number(req.headers["content-length"] ?? 0);
  if (length > MAX_UPLOAD) return res.status(413).json({ error: "file is larger than 500 MB" });
  const name = stamp(req.params.name);
  const file = `out/${dir}/${name}`;
  // count bytes as they arrive: a chunked upload has no Content-Length to check up front
  let seen = 0;
  const limit = new Transform({
    transform(chunk, _enc, done) {
      seen += chunk.length;
      done(seen > MAX_UPLOAD ? new Error("file is larger than 500 MB") : null, chunk);
    },
  });
  try {
    await pipeline(req, limit, createWriteStream(file));
    res.json({ src: "/" + file, name: req.params.name, kind: kindOf(name) });
  } catch (e) {
    if (existsSync(file)) unlinkSync(file);
    res.status(500).json({ error: String(e.message ?? e) });
  }
}
app.put("/api/upload/:name", (req, res) => receive(req, res, "uploads"));
app.put("/api/render-asset/:name", (req, res) => {
  if (kindOf(req.params.name) !== "image") return res.status(415).json({ error: "render assets are pictures" });
  return receive(req, res, "render-assets");
});

// ---------------------------------------------------------------- library
// The platform library stand-in: sample media, the user's uploads, and exports they saved.
const listDir = (dir, url, group) =>
  readdirSync(dir)
    .filter((f) => kindOf(f))
    .map((f) => ({ src: url + f, name: f.replace(/^\d{10,}_/, ""), kind: kindOf(f), group, mtime: statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

app.get("/api/library", (_req, res) => {
  res.json([
    ...listDir("out/library", "/out/library/", "export"),
    ...listDir("out/uploads", "/out/uploads/", "upload"),
    ...(existsSync("public/media") ? listDir("public/media", "/media/", "sample").sort((a, b) => a.name.localeCompare(b.name)) : []),
  ]);
});

// save an export into the library: a server render is copied over, a browser render is uploaded
app.post("/api/library", express.json(), (req, res) => {
  try {
    const from = resolve(req.body.src);
    const file = `out/library/${stamp(req.body.name ?? path.basename(from))}`;
    copyFileSync(from, file);
    res.json({ src: "/" + file, name: req.body.name, kind: kindOf(file), group: "export" });
  } catch (e) {
    res.status(400).json({ error: String(e.message ?? e) });
  }
});
app.put("/api/library/:name", (req, res) => receive(req, res, "library"));

// ---------------------------------------------------------------- render
export function render(project, height, name = `export_${Date.now()}.mp4`) {
  const output = `out/${name}`;
  const { args, width, height: h, duration } = buildFfmpegArgs(project, {
    height, resolve, fontPath: (id) => `public/fonts/${FONTS[id].file}`, output,
  });
  const started = Date.now();
  return new Promise((ok, fail) => {
    const p = spawn(ffmpegPath, args);
    const timer = setTimeout(() => p.kill("SIGKILL"), RENDER_TIMEOUT_MS);
    let log = "";
    p.stderr.on("data", (d) => (log = (log + d).slice(-20000)));
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return fail(new Error(code === null ? "render timed out" : log.split("\n").slice(-12).join("\n")));
      ok({ url: "/" + output, ms: Date.now() - started, bytes: statSync(output).size, width, height: h, duration });
    });
  });
}

app.post("/api/render", express.json({ limit: "2mb" }), async (req, res) => {
  try {
    res.json(await render(req.body.project, req.body.height === 1080 ? 1080 : 720));
  } catch (e) {
    res.status(500).json({ error: String(e.message ?? e) });
  }
});

app.get("/api/health", (_req, res) => res.json({ ok: true }));

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  app.listen(5181, () => console.log("render server on http://localhost:5181"));
}
