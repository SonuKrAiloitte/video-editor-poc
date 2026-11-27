// Real files through the EDITOR in Chrome: import with the file picker (video AND audio files), preview each
// clip, then export the edit with each engine and inspect the files. Needs :5180 and :5181 running.
// usage: node scripts/real-browser-check.mjs [--headed] [--hold] [--engines=server,mediabunny,wasm] [--secs=3] <file> ...
//   --headed  open a visible Chrome window and go slowly, so a person can watch
//   --force   keep a long edit in the browser engine instead of letting the editor send it to the server
//   --hold    leave the window open at the end; the script finishes when the window is closed
import puppeteer from "puppeteer-core";
import ffmpegPath from "ffmpeg-static";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { probe } from "./probe.mjs";

const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => { const [k, v] = a.slice(2).split("="); return [k, v ?? "1"]; }));
const paths = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const engines = (flags.engines ?? "server,mediabunny,wasm").split(",");
const secs = Number(flags.secs ?? 3);
const headed = !!flags.headed;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const beat = () => wait(headed ? 1500 : 0); // a pause a person can follow

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: headed ? false : "new",
  defaultViewport: headed ? null : { width: 1440, height: 900 },
  protocolTimeout: 1_800_000,
  args: ["--autoplay-policy=no-user-gesture-required", headed ? "--start-maximized" : "--window-size=1440,900"],
});
const page = (await browser.pages())[0] ?? (await browser.newPage());
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 200)));
await page.goto("http://localhost:5180/#own", { waitUntil: "networkidle0" });
await wait(1200);
if (flags.wasmseek) await page.evaluate((m) => (globalThis.__wasmSeek = m), flags.wasmseek);
const input = await page.$('input[type="file"]');
const state = () => page.evaluate(() => { const q = window.__poc.getProject(); return { n: q.clips.length, last: q.clips[q.clips.length - 1], music: q.music, notice: document.querySelector(".notice")?.textContent ?? null }; });

console.log("1. import through the file picker");
const videos = [], audios = [];
for (const file of paths) {
  const want = probe(file);
  const before = await state();
  const nErr = errors.length;
  await input.uploadFile(file);
  let now = before, kind = null;
  for (let i = 0; i < 240 && !kind; i++) {
    await wait(250);
    now = await state();
    if (now.n > before.n) kind = "video";
    else if (now.music?.src !== before.music?.src) kind = "audio";
    else if (now.notice && now.notice !== before.notice && !/Converting it on the server/.test(now.notice)) kind = "notice"; // "Converting..." means: keep waiting
    else if (errors.length > nErr) kind = "error";
  }
  const tag = `${want.file.padEnd(34)} [${want.video ? `${want.video} ${want.size} ${want.fps}fps, ` : ""}${want.audio ?? "no audio"}, ${want.duration}s]`;
  if (kind === "video") {
    const c = now.last;
    console.log(`${Math.abs(c.srcDuration - want.duration) < 0.25 && c.hasAudio === want.channels > 0 ? "OK  " : "WARN"} ${tag}\n       -> added as a CLIP: ${c.srcDuration.toFixed(2)}s, sound track: ${c.hasAudio ? "yes" : "no"}`);
    if (/converted it/.test(now.notice ?? "")) console.log("       -> " + now.notice);
    videos.push(c.id);
  } else if (kind === "audio") {
    console.log(`OK   ${tag}\n       -> set as MUSIC (channels: ${now.music.channels ?? "?"})`);
    audios.push({ name: want.file, music: now.music });
  } else {
    console.log(`FAIL ${tag}\n       -> ${kind === "notice" ? "editor message: " + now.notice : kind === "error" ? "error: " + errors[errors.length - 1] : "nothing happened (no clip, no message)"}`);
  }
  await beat();
}

// one edit made only of the real clips, `secs` seconds from each
await page.evaluate((ids, secs) => {
  const q = window.__poc.getProject();
  const clips = q.clips.filter((c) => ids.includes(c.id)).map((c) => {
    const start = Math.min(1, Math.max(0, c.srcDuration - secs));
    return { ...c, in: start, out: Math.min(c.srcDuration, start + secs) };
  });
  const total = clips.reduce((s, c) => s + c.out - c.in, 0);
  window.__poc.setProject({ ...q, clips, overlays: q.overlays.map((o) => ({ ...o, start: 0, end: Math.min(o.end, total) })) });
}, videos, secs);
await wait(800);

console.log(`\n2. preview: seek into every real clip, then play (edit = ${videos.length} clips x ${secs} s)`);
const preview = await page.evaluate(async (playMs) => {
  const w = (ms) => new Promise((r) => setTimeout(r, ms));
  const c = document.querySelector(".preview canvas");
  const q = window.__poc.getProject(); const rows = []; let at = 0;
  for (const clip of q.clips) {
    const mid = at + (clip.out - clip.in) / 2; window.__poc.seek(mid);
    await w(1500); // let the seek land; the preview holds the previous frame until then
    rows.push({ name: clip.name, at: mid, png: c.toDataURL("image/png") });
    at += clip.out - clip.in;
  }
  window.__poc.seek(0); await w(600);
  const time = () => document.querySelector(".bar .time").textContent;
  const t1 = time(); document.querySelector(".bar button").click(); await w(playMs);
  const m = window.__poc.media(); const t2 = time(); document.querySelector(".bar button").click();
  return { rows, play: `${t1} -> ${t2} after ${playMs / 1000} s of play`, music: m.music };
}, headed ? 9000 : 4000);
preview.rows.forEach((r, i) => writeFileSync(`out/real_prev_${i}.png`, Buffer.from(r.png.split(",")[1], "base64")));
console.log(`     playhead ${preview.play}; music element ${preview.music ? `was playing (at ${preview.music.t}s)` : "none"}`);
await page.screenshot({ path: "out/real-browser-check.png" });
await beat();

console.log("\n3. export with each engine, once per sound source");
const want = await page.evaluate(() => window.__poc.getProject().clips.reduce((s, c) => s + c.out - c.in, 0));
const variants = [{ label: "clips' own sound, no music", music: null, muted: false }, ...audios.map((a) => ({ label: "music = " + a.name, music: { ...a.music, volume: 0.5 }, muted: true }))];
let firstServer = null;
for (const [vi, v] of variants.entries()) {
  console.log(`   ${v.label}`);
  await page.evaluate((v) => { const q = window.__poc.getProject(); window.__poc.setProject({ ...q, music: v.music, clips: q.clips.map((c) => ({ ...c, muted: v.muted })) }); }, v);
  await wait(500);
  const outs = {}, db = {};
  for (const engine of engines) {
    const r = await page.evaluate(async (engine, vi, force) => {
      const r = await window.__poc.run(engine, force); // force = stay in the browser even for a long edit
      if ("error" in r) return r;
      // put the result on disk through the render server's upload endpoint, so FFmpeg can inspect it
      const blob = await (await fetch(r.url)).blob();
      const up = await (await fetch(`/api/upload/real_${engine}_${vi}.mp4`, { method: "PUT", body: blob })).json();
      return { ms: r.ms, bytes: r.bytes, file: up.src.slice(1) };
    }, engine, vi, !!flags.force);
    if (r.error) { console.log(`FAIL ${engine.padEnd(11)} ${r.error.slice(0, 300)}`); continue; }
    const p = probe(r.file);
    const log = spawnSync(ffmpegPath, ["-hide_banner", "-i", r.file, "-vf", "blackdetect=d=0.3:pix_th=0.08", "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" }).stderr;
    const black = [...log.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map((m) => `${(+m[1]).toFixed(1)}-${(+m[2]).toFixed(1)}s`);
    db[engine] = +(/mean_volume: (\S+)/.exec(log)?.[1] ?? NaN);
    const soundOk = v.music ? db[engine] > -60 && (db.server === undefined || Math.abs(db[engine] - db.server) < 1) : true;
    const ok = p.duration !== null && Math.abs(p.duration - want) < 0.2 && black.length === 0 && soundOk;
    console.log(`${ok ? "OK  " : "WARN"} ${engine.padEnd(11)} ${(r.ms / 1000).toFixed(1).padStart(6)} s  ${p.size} ${p.duration}s (want ${want.toFixed(2)})  black:${black.length ? black.join(",") : "none"}  sound:${db[engine]} dB  ${(r.bytes / 1048576).toFixed(1)} MB`);
    outs[engine] = r.file;
  }
  for (const e of engines.filter((e) => e !== "server" && outs[e] && outs.server)) {
    const log = spawnSync(ffmpegPath, ["-hide_banner", "-i", outs[e], "-i", outs.server, "-lavfi", "[0:v]fps=30[a];[1:v]fps=30[b];[a][b]ssim", "-f", "null", "-"], { encoding: "utf8" }).stderr;
    console.log(`     picture match ${e} vs server: ${/All:([\d.]+)/.exec(log)?.[1] ?? "?"}`);
  }
  firstServer ??= outs.server ?? null;
  await beat();
}

if (firstServer) {
  console.log("\n4. does the preview show what the export contains? (preview frame vs the same moment in the server export)");
  for (const [i, r] of preview.rows.entries()) {
    // take ONE frame out of the export first; comparing against the stream averages over many frames
    spawnSync(ffmpegPath, ["-y", "-loglevel", "error", "-ss", String(r.at), "-i", firstServer, "-frames:v", "1", "out/_frame.png"]);
    const log = spawnSync(ffmpegPath, ["-hide_banner", "-i", "out/_frame.png", "-i", `out/real_prev_${i}.png`, "-lavfi", "[1:v][0:v]scale2ref[p][v];[v][p]ssim", "-f", "null", "-"], { encoding: "utf8" }).stderr;
    const s = +(/All:([\d.]+)/.exec(log)?.[1] ?? 0);
    console.log(`${s > 0.8 ? "OK  " : "WARN"} ${r.name.padEnd(34)} at ${r.at.toFixed(1)}s  match ${s.toFixed(3)}`);
  }
}
console.log("\ntab was: " + (await page.evaluate(() => document.visibilityState)) + (errors.length ? "\nerrors:\n  " + [...new Set(errors)].join("\n  ") : "\nno console errors"));
if (flags.hold) {
  // leave the last export playing so the result can be watched
  await page.evaluate(() => { const v = document.querySelector(".result-video"); if (v) { v.scrollIntoView({ block: "center" }); v.loop = true; void v.play(); } });
  console.log("\nDone. The Chrome window stays open; close it to finish.");
  await new Promise((r) => browser.on("disconnected", r));
} else {
  await browser.close();
}
