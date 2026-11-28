// CapCut-style editing in the own-core editor, with the mouse and keyboard in Chrome:
// Library click plays, "+" adds at the playhead, multi-select and box select delete together, track lock / hide / mute
// (in the editor and in the server export), and the playhead handle. Needs :5180 and :5181.
import puppeteer from "puppeteer-core";
import ffmpegPath from "ffmpeg-static";
import { spawnSync } from "node:child_process";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: "new", defaultViewport: { width: 1440, height: 1000 }, args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 200)));
await page.goto("http://localhost:5180/#own", { waitUntil: "networkidle0" });
await wait(1200);
const reset = async () => { await page.evaluate(() => [...document.querySelectorAll(".bar button")].find((b) => b.textContent.trim() === "Reset").click()); await wait(500); };
await reset();

let failures = 0;
const check = (ok, label) => { if (!ok) failures++; console.log(`${ok ? "OK  " : "FAIL"} ${label}`); };
const proj = () => page.evaluate(() => window.__poc.getProject());
const notice = () => page.evaluate(() => document.querySelector(".notice")?.textContent ?? null);
const centreOf = (sel) => page.evaluate((sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, sel);
const libItem = (name) => page.evaluate((name) => {
  const audio = /\.(mp3|wav|ogg)$/i.test(name);
  [...document.querySelectorAll(".lib-tabs button")][audio ? 1 : 0].click();
  return new Promise((ok) => setTimeout(ok, 150));
}, name);
const clipBox = (text) => page.evaluate((text) => { const el = [...document.querySelectorAll(".tl .clip")].find((e) => e.textContent.includes(text)); const r = el.getBoundingClientRect(); return { x: r.left + Math.min(40, r.width / 2), y: r.top + r.height / 2 }; }, text);
const starts = (q) => { let t = 0; return q.clips.map((c) => { const s = t; t += c.out - c.in; return +s.toFixed(2); }); };

// 1. a click on a Library item plays it and leaves the timeline alone
let q0 = await proj();
await libItem("clipB_h264_9x16.mp4");
const libB = await page.evaluate(() => { const el = [...document.querySelectorAll(".lib")].find((x) => x.textContent.includes("clipB_h264_9x16.mp4")); const r = el.querySelector(".lib-name").getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; });
await page.mouse.click(libB.x, libB.y);
await wait(1500);
const playing = await page.evaluate(() => { const v = document.querySelector(".lib-preview video"); return v ? { src: v.src.split("/").pop(), time: +v.currentTime.toFixed(2), paused: v.paused } : null; });
let q = await proj();
check(!!playing && playing.time > 0.3 && q.clips.length === q0.clips.length, `click on clipB in the Library plays it in the player (${JSON.stringify(playing)}); timeline unchanged (${q.clips.length} clips)`);
await page.click(".lib-preview-bar button[aria-label='Close the Library preview']");
await wait(200);

// 2. "+" adds at the playhead: video goes into Main exactly there (the clip under the playhead is split)
await page.evaluate(() => window.__poc.seek(2));
await wait(200);
await libItem("clipD_hevc.mov");
await page.evaluate(() => [...document.querySelectorAll(".lib")].find((x) => x.textContent.includes("clipD_hevc.mov")).querySelector(".lib-add").click());
await wait(1200);
q = await proj();
const idxD = q.clips.findIndex((c) => c.name === "clipD_hevc.mov");
check(idxD >= 0 && Math.abs(starts(q)[idxD] - 2) < 0.06 && q.clips.length === q0.clips.length + 2, `+ on clipD with the playhead at 2 s -> on Main starting at ${starts(q)[idxD]} s; the clip under the playhead was split (${q0.clips.length} -> ${q.clips.length} clips)`);
await libItem("music.mp3");
await page.evaluate(() => window.__poc.seek(2));
await page.evaluate(() => [...document.querySelectorAll(".lib")].find((x) => x.textContent.includes("music.mp3")).querySelector(".lib-add").click());
await wait(1200);
q = await proj();
const newAudio = q.audios[q.audios.length - 1];
check(q.audios.length === q0.audios.length + 1 && Math.abs(newAudio.start - 2) < 0.06, `+ on music.mp3 with the playhead at 2 s -> audio at ${newAudio.start} s on ${q.tracks.find((t) => t.id === newAudio.track)?.kind} track`);

// 3. Ctrl+click several clips, then Delete removes all of them
await reset();
q0 = await proj();
await page.mouse.click(...Object.values(await clipBox("clipA_h264")));
await page.keyboard.down("Control");
await page.mouse.click(...Object.values(await clipBox("clipB_h264")));
await page.mouse.click(...Object.values(await clipBox("Diwali Sale")));
await page.keyboard.up("Control");
await wait(200);
const label = await page.evaluate(() => [...document.querySelectorAll(".bar button")].find((b) => b.textContent.startsWith("Delete")).textContent);
const shown = await page.$$eval(".tl .clip.sel", (els) => els.length);
check(label === "Delete 3" && shown === 3, `Ctrl+click on 3 items -> ${shown} highlighted, button reads "${label}"`);
await page.keyboard.press("Delete");
await wait(400);
q = await proj();
check(q.clips.length === q0.clips.length - 2 && q.overlays.length === q0.overlays.length - 1, `Delete removes all 3: clips ${q0.clips.length} -> ${q.clips.length}, items on tracks ${q0.overlays.length} -> ${q.overlays.length}`);

// 4. box select: drag across empty timeline from the New row up over the tracks
await reset();
const newRow = await page.evaluate(() => { const r = document.querySelector('[data-row="new"]').getBoundingClientRect(); return { x: r.left + 400, y: r.top + r.height / 2 }; });
const topRow = await page.evaluate(() => { const r = document.querySelector(".tl > .track").getBoundingClientRect(); return { x: r.left + 5, y: r.top + 4 }; });
await page.mouse.move(newRow.x, newRow.y);
await page.mouse.down();
for (let i = 1; i <= 10; i++) await page.mouse.move(newRow.x + ((topRow.x - newRow.x) * i) / 10, newRow.y + ((topRow.y - newRow.y) * i) / 10);
const duringBox = await page.$$eval(".marquee", (m) => m.length);
await page.mouse.up();
await wait(200);
const boxed = await page.$$eval(".tl .clip.sel", (els) => els.length);
check(duringBox === 1 && boxed >= 5, `box drawn over the timeline (box shown: ${duringBox === 1}) selects ${boxed} items`);
await page.mouse.click(newRow.x, newRow.y);
await wait(150);
check((await page.$$eval(".tl .clip.sel", (els) => els.length)) === 0, `a click on empty timeline clears the selection`);

// 5. lock the main track: no moving, no deleting, no dropping onto it
await reset();
q0 = await proj();
await page.click(".tl-labels .track.main .tbtn[aria-label='Lock Main']");
await wait(300);
const a0 = await clipBox("clipA_h264");
await page.mouse.move(a0.x, a0.y); await page.mouse.down();
for (let i = 1; i <= 8; i++) await page.mouse.move(a0.x + 30 * i, a0.y);
await page.mouse.up(); await wait(300);
q = await proj();
check(JSON.stringify(q.clips.map((c) => c.id)) === JSON.stringify(q0.clips.map((c) => c.id)) && /locked/.test(await notice()), `locked Main: dragging clipA does nothing ("${await notice()}")`);
await page.mouse.click(a0.x, a0.y);
await page.keyboard.press("Delete"); await wait(300);
q = await proj();
check(q.clips.length === q0.clips.length, `locked Main: Delete keeps the clip (${q.clips.length} clips)`);
await page.evaluate(() => window.__poc.seek(1));
await libItem("clipD_hevc.mov");
await page.evaluate(() => [...document.querySelectorAll(".lib")].find((x) => x.textContent.includes("clipD_hevc.mov")).querySelector(".lib-add").click());
await wait(800);
q = await proj();
check(q.clips.length === q0.clips.length, `locked Main: + does not add to it ("${await notice()}")`);
await page.click(".tl-labels .track.main .tbtn[aria-label='Unlock Main']");
await wait(300);

// 6. hide Main and mute everything: the server export shows black under the title and logo, and is silent
await page.click(".tl-labels .track.main .tbtn[aria-label='Hide Main']");
await page.click(".tl-labels .track.main .tbtn[aria-label='Mute Main']");
for (const b of await page.$$(".tl-labels .track.audio .tbtn[aria-label^='Mute']")) await b.click();
await wait(400);
const previewMid = await page.evaluate(() => { window.__poc.seek(3); return new Promise((ok) => setTimeout(() => { const c = document.querySelector(".preview canvas"); const d = c.getContext("2d").getImageData(c.width / 2 - 40, c.height / 2 - 40, 80, 80).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2]; ok(Math.round(s / (d.length / 4 * 3))); }, 800)); });
check(previewMid < 5, `hidden Main: the preview is black under the overlays (brightness ${previewMid})`);
const r = await page.evaluate(async () => { const r = await window.__poc.run("server"); if ("error" in r) return r; const up = await (await fetch("/api/upload/hidden.mp4", { method: "PUT", body: await (await fetch(r.url)).blob() })).json(); return { file: up.src.slice(1), duration: r.duration }; });
if (r.error) check(false, "server export: " + r.error);
else {
  const log = spawnSync(ffmpegPath, ["-hide_banner", "-ss", "3", "-i", r.file, "-t", "1", "-vf", "crop=iw/4:ih/8:iw*3/8:ih*7/16,signalstats,metadata=print:key=lavfi.signalstats.YAVG", "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" }).stderr;
  const yavg = Math.max(...[...log.matchAll(/YAVG=([\d.]+)/g)].map((m) => +m[1]));
  const vol = /mean_volume: (\S+)/.exec(log)?.[1];
  check(yavg < 20 && +vol < -80, `server export with Main hidden and every track muted: middle of the frame brightness ${yavg.toFixed(1)}/255, sound ${vol} dB, ${r.duration} s long`);
}
const heads = await page.$$eval(".tl-labels .track", (els) => els.map((e) => `${e.querySelector(".tname")?.textContent ?? e.textContent}: ${[...e.querySelectorAll(".tbtn")].map((b) => b.getAttribute("aria-label").split(" ")[0]).join("/")}`));
console.log("     track headers: " + heads.join(" | "));
console.log("     edit tracks: " + JSON.stringify(await page.evaluate(() => { const q = window.__poc.getProject(); return { tracks: q.tracks.map((t) => t.id), overlays: q.overlays.map((o) => o.kind + "@" + o.track), clips: q.clips.length }; })));

// 7. the playhead handle: drag it 2 s to the right
await reset();
await page.evaluate(() => window.__poc.seek(1));
await wait(200);
const knob = await centreOf(".playhead .knob");
await page.mouse.move(knob.x, knob.y); await page.mouse.down();
for (let i = 1; i <= 10; i++) await page.mouse.move(knob.x + 12 * i, knob.y);
await page.mouse.up(); await wait(200);
const time = await page.$eval(".player-bar .time b", (e) => e.textContent);
check(time.startsWith("00:00:03"), `playhead handle dragged 120 px (2 s at this zoom) -> ${time}`);

await page.screenshot({ path: "out/editing-check.png" });
check(errors.length === 0, errors.length ? "console errors:\n  " + [...new Set(errors)].join("\n  ") : "no console errors");
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
await browser.close();
process.exit(failures ? 1 : 0);
