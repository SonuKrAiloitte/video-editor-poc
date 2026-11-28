// The version 1 requirement table, row by row, against the own-core editor in Chrome (mouse and keyboard where a
// person would use them). Covers what the other check scripts do not: snapping, zoom, removing a section,
// merge order, mute original sound, background music volume, undo/redo, autosave across a reload, export sizes.
// Needs :5180 and :5181.
import puppeteer from "puppeteer-core";
import ffmpegPath from "ffmpeg-static";
import { spawnSync } from "node:child_process";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: "new", defaultViewport: { width: 1440, height: 1000 } });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
page.on("dialog", (d) => d.accept());
await page.goto("http://localhost:5180/#own", { waitUntil: "networkidle0" });
await wait(1000);
const reset = async () => { await page.evaluate(() => [...document.querySelectorAll(".bar button")].find((b) => b.textContent.trim() === "Reset").click()); await wait(400); };
await reset();

let failures = 0;
const check = (ok, label) => { if (!ok) failures++; console.log(`${ok ? "OK  " : "FAIL"} ${label}`); };
const proj = () => page.evaluate(() => window.__poc.getProject());
const len = (q) => q.clips.reduce((s, c) => s + c.out - c.in, 0);
const button = (label) => page.evaluate((l) => [...document.querySelectorAll(".bar button")].find((b) => b.textContent.trim() === l).click(), label);
const box = (text) => page.evaluate((text) => { const el = [...document.querySelectorAll(".tl .clip")].find((e) => e.textContent.includes(text)); const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }, text);
const drag = async (from, to) => { await page.mouse.move(from.x, from.y); await page.mouse.down(); for (let i = 1; i <= 10; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / 10, from.y + ((to.y - from.y) * i) / 10); await wait(100); await page.mouse.up(); await wait(300); };
const exportFile = async (engine = "server", height = 720) => page.evaluate(async (engine, height) => {
  const sel = document.querySelector(".export select"); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set; set.call(sel, String(height)); sel.dispatchEvent(new Event("change", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 200));
  const r = await window.__poc.run(engine);
  if ("error" in r) return r;
  const up = await (await fetch(`/api/upload/req_${engine}.mp4`, { method: "PUT", body: await (await fetch(r.url)).blob() })).json();
  return { file: up.src.slice(1), w: r.width, h: r.height, d: r.duration };
}, engine, height);
const volume = (f, from = 0, dur = 99) => /mean_volume: (\S+)/.exec(spawnSync(ffmpegPath, ["-hide_banner", "-ss", String(from), "-t", String(dur), "-i", f, "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" }).stderr)?.[1];

// Timeline: zoom
const w1 = (await box("clipA_h264")).w;
await page.evaluate(() => { const z = document.querySelector(".tl-head input"); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(z, "120"); z.dispatchEvent(new Event("input", { bubbles: true })); });
await wait(200);
const w2 = (await box("clipA_h264")).w;
check(Math.abs(w2 / w1 - 2) < 0.05, `zoom: clip width ${w1.toFixed(0)} px -> ${w2.toFixed(0)} px when zoom goes 60 -> 120`);
await page.evaluate(() => { const z = document.querySelector(".tl-head input"); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(z, "60"); z.dispatchEvent(new Event("input", { bubbles: true })); });
await wait(200);

// Timeline: snapping (drag the title's start close to the playhead, it lands exactly on it)
await page.evaluate(() => window.__poc.seek(2.37));
await wait(200);
const t0 = (await proj()).overlays.find((o) => o.kind === "text");
const tb = await box("Diwali Sale");
await drag({ x: tb.x + 20, y: tb.y + tb.h / 2 }, { x: tb.x + 20 + (2.33 - t0.start) * 60, y: tb.y + tb.h / 2 });
const t1 = (await proj()).overlays.find((o) => o.kind === "text");
check(Math.abs(t1.start - 2.37) < 0.001, `snapping: title dragged to about 2.33 s snaps to the playhead at 2.37 s (start ${t1.start})`);

// Trim, split, delete: remove a section from the middle of a clip (split twice, delete the middle part)
await reset();
let q0 = await proj();
await page.evaluate(() => window.__poc.seek(1));
await button("Split at playhead");
await page.evaluate(() => window.__poc.seek(2.5));
await button("Split at playhead");
await wait(200);
let q = await proj();
const middle = q.clips[1];
const mid = await page.evaluate(() => { const els = [...document.querySelectorAll(".tl .track.main .clip")]; const r = els[1].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
await page.mouse.click(mid.x, mid.y);
await page.keyboard.press("Delete");
await wait(300);
q = await proj();
check(q.clips.length === q0.clips.length + 1 && Math.abs(len(q) - (len(q0) - 1.5)) < 0.01, `remove a section: split at 1 s and 2.5 s, delete the middle -> ${q.clips.length} clips, length ${len(q0)} s -> ${len(q).toFixed(2)} s, no gap`);

// Undo / redo
await page.keyboard.down("Control"); await page.keyboard.press("z"); await page.keyboard.up("Control"); await wait(200);
const afterUndo = await proj();
await button("Redo"); await wait(200);
const afterRedo = await proj();
check(afterUndo.clips.length === q.clips.length + 1 && afterRedo.clips.length === q.clips.length, `undo (Ctrl+Z) brings the section back (${afterUndo.clips.length} clips), Redo removes it again (${afterRedo.clips.length})`);

// Merge and reorder: drag the last main clip to the front
await reset();
q0 = await proj();
const last = await page.evaluate(() => { const els = [...document.querySelectorAll(".tl .track.main .clip")]; const r = els.at(-1).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
const first = await page.evaluate(() => { const r = document.querySelector(".tl .track.main .clip").getBoundingClientRect(); return { x: r.left + 4, y: r.top + r.height / 2 }; });
await drag(last, first);
q = await proj();
check(q.clips[0].id === q0.clips.at(-1).id && Math.abs(len(q) - len(q0)) < 1e-6, `reorder: last clip dragged to the front -> order ${q.clips.map((c) => c.name.split("_")[0]).join(", ")}, still joined (${len(q)} s)`);

// Audio: mute original sound on every clip, background music at a set volume
await reset();
await page.evaluate(() => { const q = window.__poc.getProject(); window.__poc.setProject({ ...q, clips: q.clips.map((c) => ({ ...c, muted: true })) }); });
await page.mouse.click(...Object.values(await page.evaluate(() => { const r = [...document.querySelectorAll(".tl .clip.audio")][0].getBoundingClientRect(); return { x: r.left + 40, y: r.top + r.height / 2 }; })));
await wait(200);
const setVol = (v) => page.evaluate((v) => { const r = [...document.querySelectorAll(".form label")].find((l) => l.textContent.startsWith("Volume")).querySelector("input"); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(r, String(v)); r.dispatchEvent(new Event("input", { bubbles: true })); }, v);
await setVol(0.8); await wait(300);
let e = await exportFile();
const loud = volume(e.file);
await setVol(0.2); await wait(300);
e = await exportFile();
const quiet = volume(e.file);
check(+loud - +quiet > 10 && +loud - +quiet < 14, `audio: original sound muted, music volume 80% -> 20%: export level ${loud} dB -> ${quiet} dB (expected about 12 dB lower)`);
await page.evaluate(() => { const q = window.__poc.getProject(); window.__poc.setProject({ ...q, audios: [] }); });
await wait(300);
e = await exportFile();
check(+volume(e.file) < -80, `audio: original sound muted and no music -> silent export (${volume(e.file)} dB)`);

// Aspect ratio: 16:9, 9:16, 1:1 at both sizes
await reset();
const sizes = [];
for (const a of ["16:9", "9:16", "1:1"]) {
  await page.evaluate((a) => { const q = window.__poc.getProject(); window.__poc.setProject({ ...q, aspect: a }); }, a);
  for (const h of [720, 1080]) { const r = await exportFile("server", h); sizes.push(`${a}@${h}=${r.w}x${r.h}`); }
}
check(sizes.join(" ") === "16:9@720=1280x720 16:9@1080=1920x1080 9:16@720=720x1280 9:16@1080=1080x1920 1:1@720=720x720 1:1@1080=1080x1080", `aspect ratio and export size: ${sizes.join(", ")}`);

// Autosave: an edit survives closing and reopening the page
await reset();
await page.evaluate(() => window.__poc.seek(3));
await page.evaluate(() => [...document.querySelectorAll(".bar button")].find((b) => b.textContent.trim() === "+ Text").click());
await wait(800);
const saved = (await proj()).overlays.length;
await page.reload({ waitUntil: "networkidle0" });
await wait(1000);
check((await proj()).overlays.length === saved, `autosave: added a title, reloaded the page -> the edit still has ${(await proj()).overlays.length} items on tracks`);
await reset();

check(errors.length === 0, errors.length ? "page errors:\n  " + errors.join("\n  ") : "no page errors");
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
await browser.close();
process.exit(failures ? 1 : 0);
