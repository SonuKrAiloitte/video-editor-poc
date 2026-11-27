// CapCut-style timeline in the own-core editor, driven with the mouse in Chrome:
// drags from the Library onto tracks (allowed and refused), drags between tracks, then exports.
// Needs :5180 and :5181. usage: node scripts/timeline-dnd-check.mjs [--headed]
import puppeteer from "puppeteer-core";
import ffmpegPath from "ffmpeg-static";
import { spawnSync } from "node:child_process";

const headed = process.argv.includes("--headed");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: headed ? false : "new", defaultViewport: { width: 1440, height: 1000 } });
const page = (await browser.pages())[0] ?? (await browser.newPage());
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 200)));
await page.goto("http://localhost:5180/#own", { waitUntil: "networkidle0" });
await wait(1200);
await page.evaluate(() => [...document.querySelectorAll(".bar button")].find((b) => b.textContent.trim() === "Reset").click());
await wait(600);

let failures = 0;
const check = (ok, label) => { if (!ok) failures++; console.log(`${ok ? "OK  " : "FAIL"} ${label}`); };
const proj = () => page.evaluate(() => window.__poc.getProject());
const notice = () => page.evaluate(() => document.querySelector(".notice")?.textContent ?? null);
const rows = () => page.evaluate(() => [...document.querySelectorAll("[data-row]")].map((r) => ({ row: r.dataset.row, label: r.dataset.label })));
/** centre of a row, at timeline second `sec` */
const rowPoint = (row, sec) => page.evaluate((row, sec) => {
  const r = document.querySelector(`[data-row="${row}"]`).getBoundingClientRect();
  const tl = document.querySelector(".tl").getBoundingClientRect();
  return { x: tl.left + sec * 60, y: r.top + r.height / 2 };
}, row, sec);
const libPoint = (name) => page.evaluate((name) => {
  // open the Library tab the item is in (Media or Audio)
  const audio = /\.(mp3|wav|ogg|m4a|aac|flac|opus)$/i.test(name);
  [...document.querySelectorAll(".lib-tabs button")][audio ? 1 : 0].click();
  return new Promise((ok) => setTimeout(ok, 150));
}, name).then(() => page.evaluate((name) => {
  const b = [...document.querySelectorAll(".lib")].find((x) => x.textContent.includes(name));
  const r = b.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}, name));
const libDrop = async (name, row, sec) => { await mouseDrag(await libPoint(name), await rowPoint(row, sec)); await wait(800); };
/** press on an item on the timeline and move it with the mouse */
const itemPoint = (id) => page.evaluate((id) => {
  const sel = [...document.querySelectorAll(".tl .clip")];
  const q = window.__poc.getProject();
  const name = q.clips.find((c) => c.id === id)?.name ?? q.overlays.find((o) => o.id === id)?.text ?? q.overlays.find((o) => o.id === id)?.name ?? q.audios.find((a) => a.id === id)?.name;
  const el = sel.find((e) => e.textContent.includes(name));
  const r = el.getBoundingClientRect();
  return { x: r.left + Math.min(40, r.width / 2), y: r.top + r.height / 2 };
}, id);
const mouseDrag = async (from, to) => {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / 10, from.y + ((to.y - from.y) * i) / 10);
  await wait(150);
  await page.mouse.up();
  await wait(400);
};

const start = await proj();
console.log("rows at start:", (await rows()).map((r) => r.label).join(" | "));

// 1. refused drops
await libDrop("music.mp3", "main", 2);
let q = await proj();
check(q.audios.length === start.audios.length && q.clips.length === start.clips.length, `audio dropped on Main is refused (notice: ${await notice()})`);
const audioRow = start.tracks.find((t) => t.kind === "audio").id;
await libDrop("clipB_h264_9x16.mp4", audioRow, 2);
q = await proj();
check(q.overlays.length === start.overlays.length && q.clips.length === start.clips.length, `video dropped on an audio track is refused (notice: ${await notice()})`);

// 2. allowed drops
const topVisual = start.tracks.find((t) => t.kind === "visual").id;
await libDrop("clipB_h264_9x16.mp4", topVisual, 6);
q = await proj();
const pip = q.overlays.find((o) => o.kind === "video");
check(!!pip, `video dropped on a visual track at 6 s -> video on track ${pip?.track}, ${pip?.start.toFixed(1)}-${pip?.end.toFixed(1)} s${pip && pip.track !== topVisual ? " (spot was taken, so a new track was made)" : ""}`);

await libDrop("logo.png", "main", 0.2);
q = await proj();
check(q.clips[0]?.kind === "image" && q.clips.length === start.clips.length + 1, `image dropped at the start of Main -> first main clip is "${q.clips[0]?.name}" (${q.clips[0]?.kind}); the others moved along, ${q.clips.length} clips`);

const audioTracksBefore = q.tracks.filter((t) => t.kind === "audio").length;
await libDrop("music.mp3", "new", 3);
q = await proj();
const newAudio = q.audios[q.audios.length - 1];
check(q.tracks.filter((t) => t.kind === "audio").length === audioTracksBefore + 1 && newAudio.start > 2.5, `audio dropped on "New" -> new audio track, starts at ${newAudio.start.toFixed(1)} s`);

// 3. moving items between tracks
const title = q.overlays.find((o) => o.kind === "text");
await mouseDrag(await itemPoint(title.id), await rowPoint("main", 3));
q = await proj();
check(q.overlays.some((o) => o.id === title.id && o.track === title.track) && !q.clips.some((c) => c.id === title.id), `text dragged onto Main is refused and stays on its track (notice: ${await notice()})`);

const second = q.clips[2];
await mouseDrag(await itemPoint(second.id), await rowPoint("new", 1));
q = await proj();
const moved = q.overlays.find((o) => o.id === second.id);
check(!!moved && moved.kind === "video" && !q.clips.some((c) => c.id === second.id), `main clip "${second.name}" dragged to "New" -> now a video on its own track at ${moved?.start.toFixed(1)} s; main has ${q.clips.length} clips, still joined`);

const before = (await proj()).overlays.find((o) => o.kind === "video" && o.id !== moved?.id) ?? moved;
const p0 = await itemPoint(before.id);
await mouseDrag(p0, { x: p0.x + 60, y: p0.y });
q = await proj();
const after = q.overlays.find((o) => o.id === before.id);
check(Math.abs(after.start - before.start - 1) < 0.25, `video on a visual track dragged 1 s right -> start ${before.start.toFixed(1)} -> ${after.start.toFixed(1)} s (gap allowed)`);

const aud = q.audios[q.audios.length - 1];
await mouseDrag(await itemPoint(aud.id), await rowPoint(q.tracks.find((t) => t.kind === "visual").id, 1));
q = await proj();
check(q.audios.some((a) => a.id === aud.id) && !q.overlays.some((o) => o.id === aud.id), `audio dragged onto a visual track is refused (notice: ${await notice()})`);

console.log("rows now:", (await rows()).map((r) => r.label).join(" | "));
await page.screenshot({ path: "out/timeline-dnd.png" });

// 4. the edit exports, and the server and browser agree
const total = await page.evaluate(() => { const q = window.__poc.getProject(); return Math.max(q.clips.reduce((s, c) => s + c.out - c.in, 0), ...q.overlays.map((o) => o.end), ...q.audios.map((a) => a.start + a.out - a.in)); });
const outs = {};
for (const engine of ["server", "mediabunny"]) {
  const r = await page.evaluate(async (engine) => {
    const r = await window.__poc.run(engine, true);
    if ("error" in r) return r;
    const up = await (await fetch(`/api/upload/dnd_${engine}.mp4`, { method: "PUT", body: await (await fetch(r.url)).blob() })).json();
    return { ms: r.ms, file: up.src.slice(1), duration: r.duration };
  }, engine);
  if (r.error) { check(false, `${engine} export: ${r.error.slice(0, 300)}`); continue; }
  const log = spawnSync(ffmpegPath, ["-hide_banner", "-i", r.file, "-f", "null", "-"], { encoding: "utf8" }).stderr;
  const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(log);
  const secs = d ? +d[1] * 3600 + +d[2] * 60 + +d[3] : 0;
  check(Math.abs(secs - total) < 0.2, `${engine} export: ${(r.ms / 1000).toFixed(1)} s, file is ${secs.toFixed(2)} s long (edit is ${total.toFixed(2)} s)`);
  outs[engine] = r.file;
}
if (outs.server && outs.mediabunny) {
  const log = spawnSync(ffmpegPath, ["-hide_banner", "-i", outs.mediabunny, "-i", outs.server, "-lavfi", "[0:v][1:v]ssim", "-f", "null", "-"], { encoding: "utf8" }).stderr;
  const s = +(/All:([\d.]+)/.exec(log)?.[1] ?? 0);
  check(s > 0.9, `picture match Mediabunny vs server: ${s.toFixed(3)}`);
  const shots = [2, 7].map((sec) => { const f = `out/dnd_${sec}.png`; spawnSync(ffmpegPath, ["-y", "-loglevel", "error", "-ss", String(sec), "-i", outs.server, "-frames:v", "1", "-vf", "scale=270:-2", f]); return f; });
  spawnSync(ffmpegPath, ["-y", "-loglevel", "error", "-i", shots[0], "-i", shots[1], "-filter_complex", "hstack", "out/timeline-dnd-export.png"]);
}
check(errors.length === 0, errors.length ? "console errors:\n  " + [...new Set(errors)].join("\n  ") : "no console errors");
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
await browser.close();
process.exit(failures ? 1 : 0);
