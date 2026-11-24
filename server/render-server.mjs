// PoC render server: edit JSON in, MP4 out. Native FFmpeg (ffmpeg-static binary).
// In production this is a BullMQ worker in its own container, reading from and writing to S3.
import express from "express";
import cors from "cors";
import ffmpegPath from "ffmpeg-static";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFfmpegArgs } from "../shared/ffmpeg-graph.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root); // lets the filter graph use relative paths (no "C:" to escape)
mkdirSync("out/uploads", { recursive: true });

const app = express();
app.use(cors());
app.use("/out", express.static("out"));

// browser-imported files are pushed here first so FFmpeg can read them
app.put("/api/upload/:name", express.raw({ type: "*/*", limit: "500mb" }), (req, res) => {
  const safe = req.params.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const file = `out/uploads/${Date.now()}_${safe}`;
  writeFileSync(file, req.body);
  res.json({ src: "/" + file });
});

const resolve = (src) => {
  const clean = decodeURIComponent(src.split("?")[0]);
  if (clean.startsWith("/out/uploads/")) return clean.slice(1);
  if (clean.startsWith("/media/")) return "public" + clean;
  throw new Error("unknown media source: " + src);
};

export function render(project, height, name = `export_${Date.now()}.mp4`) {
  const output = `out/${name}`;
  const { args, width, height: h, duration } = buildFfmpegArgs(project, {
    height, resolve, font: "public/fonts/PlusJakartaSans.ttf", output,
  });
  const started = Date.now();
  return new Promise((ok, fail) => {
    const p = spawn(ffmpegPath, args);
    let log = "";
    p.stderr.on("data", (d) => (log += d));
    p.on("close", (code) => {
      if (code !== 0) return fail(new Error(log.split("\n").slice(-12).join("\n")));
      ok({ url: "/" + output, ms: Date.now() - started, bytes: statSync(output).size, width, height: h, duration });
    });
  });
}

app.post("/api/render", express.json({ limit: "2mb" }), async (req, res) => {
  try {
    res.json(await render(req.body.project, req.body.height ?? 720));
  } catch (e) {
    res.status(500).json({ error: String(e.message ?? e) });
  }
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  app.listen(5181, () => console.log("render server on http://localhost:5181"));
}
