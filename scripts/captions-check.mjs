// Text and captions in the own-core editor, with the mouse and keyboard in Chrome:
// "+ Caption" at the playhead (and after a caption already showing), editing lines in the captions list (English and
// Hindi), background box, position presets, "Apply this style to all captions", .srt import, and the exports.
// Writes out/captions-check.png: preview | server | Mediabunny at two caption times. Needs :5180 and :5181.
import puppeteer from "puppeteer-core";
import ffmpegPath from "ffmpeg-static";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: "new", defaultViewport: { width: 1440, height: 1000 } });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
page.on("dialog", (d) => d.accept());
await page.goto("http://localhost:5180/#own", { waitUntil: "networkidle0" });
await wait(1000);
await page.evaluate(() => [...document.querySelectorAll(".bar button")].find((b) => b.textContent.trim() === "Reset").click());
await wait(400);

let failures = 0;
const check = (ok, label) => { if (!ok) failures++; console.log(`${ok ? "OK  " : "FAIL"} ${label}`); };
const proj = () => page.evaluate(() => window.__poc.getProject());
const captions = async () => { const q = await proj(); const tr = q.tracks.find((t) => t.role === "captions"); return tr ? q.overlays.filter((o) => o.track === tr.id).sort((a, b) => a.start - b.start) : []; };
const clickButton = (label, scope = "") => page.evaluate((l, s) => [...document.querySelectorAll(`${s} button`)].find((b) => b.textContent.trim() === l).click(), label, scope);

// 1. "+ Caption" at 1 s, then again with the playhead inside that caption: the second one starts after it
await page.evaluate(() => window.__poc.seek(1));
await clickButton("+ Caption", ".bar");
await wait(300);
await page.evaluate(() => window.__poc.seek(2));
await clickButton("+ Caption", ".bar");
await wait(300);
let cs = await captions();
const head = await page.evaluate(() => [...document.querySelectorAll(".tl-labels .tname")].map((e) => e.textContent));
check(cs.length === 2 && cs[0].start === 1 && Math.abs(cs[1].start - cs[0].end) < 1e-6 && head[0] === "Captions",
  `+ Caption twice -> ${cs.map((c) => `${c.start}-${c.end} s`).join(", ")} on a track named "${head[0]}", white on a dark box near the bottom (y ${cs[0].y})`);

// 2. type the lines in the captions list
const typeInto = async (n, text) => { const el = (await page.$$(".cap-list input"))[n]; await el.click({ clickCount: 3 }); await page.keyboard.type(text); await wait(200); };
await typeInto(0, "Diwali offer: 40% off");
await typeInto(1, "दिवाली की हार्दिक शुभकामनाएँ");
cs = await captions();
check(cs[0].text === "Diwali offer: 40% off" && cs[1].text === "दिवाली की हार्दिक शुभकामनाएँ", `typed in the captions list: "${cs[0].text}" | "${cs[1].text}"`);

// 3. style the first caption (colour, size, box, Top), then apply that style to all captions
await (await page.$$(".cap-list .cap-time"))[0].click();
await wait(200);
await page.evaluate(() => {
  const set = (input, v, ev = "input") => { const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; d.call(input, v); input.dispatchEvent(new Event(ev, { bubbles: true })); };
  const label = (t) => [...document.querySelectorAll(".form label")].find((l) => l.textContent.startsWith(t)).querySelector("input");
  set(label("Colour"), "#ffe08a");
  set(label("Size"), "40");
  set(label("Box colour"), "#1f2f57");
});
await clickButton("Top", ".seg");
await wait(200);
await clickButton("Apply this style to all captions");
await wait(300);
cs = await captions();
check(cs.every((c) => c.color === "#FFE08A" && c.fontSize === 40 && c.bg === "#1F2F57" && c.y === 0.12),
  `style on the first caption, then "Apply this style to all captions" -> ${cs.map((c) => `${c.color}/${c.fontSize}px/box ${c.bg}/y ${c.y}`).join(" | ")}`);
await clickButton("Bottom", ".seg");
await clickButton("Apply this style to all captions");
await wait(300);

// 4. exports match the preview at both caption times (English goes through FFmpeg drawtext, Hindi through the browser's drawing)
const shots = [];
for (const [i, at] of [[0, 2], [1, 4.5]]) {
  await page.evaluate((at) => window.__poc.seek(at), at);
  await wait(1200);
  const prev = `out/cap_${i}_preview.png`;
  writeFileSync(prev, Buffer.from((await page.$eval(".preview canvas", (c) => c.toDataURL("image/png"))).split(",")[1], "base64"));
  shots.push([prev, at]);
}
const rows = shots.map(([prev]) => [prev]);
for (const engine of ["server", "mediabunny"]) {
  const r = await page.evaluate(async (engine) => {
    const r = await window.__poc.run(engine);
    if ("error" in r) return r;
    const up = await (await fetch(`/api/upload/cap_${engine}.mp4`, { method: "PUT", body: await (await fetch(r.url)).blob() })).json();
    return { file: up.src.slice(1) };
  }, engine);
  if (r.error) { check(false, `${engine} export: ${r.error.slice(0, 200)}`); continue; }
  for (const [i, [prev, at]] of shots.entries()) {
    const png = `out/cap_${i}_${engine}.png`;
    spawnSync(ffmpegPath, ["-y", "-loglevel", "error", "-ss", String(at), "-i", r.file, "-frames:v", "1", png]);
    // compare the bottom quarter, where the caption is
    const log = spawnSync(ffmpegPath, ["-hide_banner", "-i", png, "-i", prev, "-lavfi", "[1:v][0:v]scale2ref[p][v];[v]crop=iw:ih/4:0:ih*3/4[a];[p]crop=iw:ih/4:0:ih*3/4[b];[a][b]ssim", "-f", "null", "-"], { encoding: "utf8" }).stderr;
    const s = +(/All:([\d.]+)/.exec(log)?.[1] ?? 0);
    check(s > 0.85, `${engine} export at ${at} s (${i === 0 ? "English, drawtext" : "Hindi, drawn by the browser"}): caption area matches the preview ${s.toFixed(3)}`);
    rows[i].push(png);
  }
}
const strips = rows.map((row, r) => { const out = `out/_cap_row_${r}.png`; spawnSync(ffmpegPath, ["-y", "-loglevel", "error", ...row.flatMap((x) => ["-i", x]), "-filter_complex", row.map((_, k) => `[${k}:v]crop=iw:ih/3:0:ih*2/3,scale=-2:200${k < row.length - 1 ? ",pad=iw+8:ih:0:0:color=gray" : ""}[s${k}]`).join(";") + ";" + row.map((_, k) => `[s${k}]`).join("") + `hstack=inputs=${row.length}`, out]); return out; });
spawnSync(ffmpegPath, ["-y", "-loglevel", "error", ...strips.flatMap((x) => ["-i", x]), "-filter_complex", `[0:v][1:v]vstack=inputs=2`, "out/captions-check.png"]);

// 5. import an .srt: it replaces the captions (after asking) with its lines and times
writeFileSync("out/_test.srt", "1\n00:00:00,500 --> 00:00:02,000\nFirst line\n\n2\n00:00:02,500 --> 00:00:04,000\nSecond <i>line</i>\nwraps here\n\n3\n00:00:05,000 --> 00:00:07,250\nदूसरी पंक्ति\n");
const [chooser] = await Promise.all([page.waitForFileChooser({ timeout: 5000 }), page.click(".captions .file")]);
await chooser.accept(["out/_test.srt"]);
await wait(800);
cs = await captions();
check(cs.length === 3 && cs[1].text === "Second line wraps here" && cs[2].start === 5 && cs[2].end === 7.25 && cs.every((c) => c.y === 0.86),
  `.srt import -> ${cs.map((c) => `${c.start}-${c.end} s "${c.text}"`).join(", ")}; style kept`);

await page.screenshot({ path: "out/captions-ui.png" });
await page.evaluate(() => [...document.querySelectorAll(".bar button")].find((b) => b.textContent.trim() === "Reset").click());
check(errors.length === 0, errors.length ? "page errors:\n  " + errors.join("\n  ") : "no page errors");
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
await browser.close();
process.exit(failures ? 1 : 0);
