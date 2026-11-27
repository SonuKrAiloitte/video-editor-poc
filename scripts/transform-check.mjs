// Resize, move and rotate on the preview, like CapCut, with the mouse in Chrome: click selects what is under the pointer,
// a corner resizes, dragging inside moves, the round handle rotates. For an image on a track, the main-track clip and
// a title. Then the exports are compared with the preview. Writes out/transform-check.png. Needs :5180 and :5181.
import puppeteer from "puppeteer-core";
import ffmpegPath from "ffmpeg-static";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: "new", defaultViewport: { width: 1440, height: 1000 } });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
await page.goto("http://localhost:5180/#own", { waitUntil: "networkidle0" });
await wait(1000);
await page.evaluate(() => [...document.querySelectorAll(".bar button")].find((b) => b.textContent.trim() === "Reset").click());
await wait(400);
await page.evaluate(() => window.__poc.seek(2));
await wait(1200);

let failures = 0;
const check = (ok, label) => { if (!ok) failures++; console.log(`${ok ? "OK  " : "FAIL"} ${label}`); };
const proj = () => page.evaluate(() => window.__poc.getProject());
/** a point of the preview canvas (in canvas pixels, 720 wide for 9:16) as a screen point */
const onScreen = (x, y) => page.evaluate((x, y) => { const c = document.querySelector(".preview canvas"); const r = c.getBoundingClientRect(); return { x: r.left + (x * r.width) / c.width, y: r.top + (y * r.height) / c.height }; }, x, y);
const handle = (sel) => page.evaluate((sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, sel);
const drag = async (from, to) => { await page.mouse.move(from.x, from.y); await page.mouse.down(); for (let i = 1; i <= 12; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / 12, from.y + ((to.y - from.y) * i) / 12); await page.mouse.up(); await wait(250); };
const selected = () => page.$$eval(".tl .clip.sel", (e) => e.map((x) => x.textContent.trim().slice(0, 20)));

// 1. the logo (an image on a track): click it on the preview, then resize, move and rotate it
let q = await proj();
const logo0 = q.overlays.find((o) => o.kind === "image");
await page.mouse.click(...Object.values(await onScreen(logo0.x * 720, logo0.y * 1280)));
await wait(200);
check((await selected()).some((x) => x.includes("logo")) && !!(await handle(".tbox")), `click on the logo in the preview selects it and shows the box with handles`);
const se = await handle(".tbox .corner.se");
await drag(se, { x: se.x + 30, y: se.y + 12 });
q = await proj();
const logo1 = q.overlays.find((o) => o.kind === "image");
check(logo1.width > logo0.width * 1.3, `dragging a corner out makes it bigger: width ${logo0.width.toFixed(3)} -> ${logo1.width.toFixed(3)} of the frame`);
const nw = await handle(".tbox .corner.nw");
const centre = await onScreen(logo1.x * 720, logo1.y * 1280);
await drag(nw, { x: nw.x + (centre.x - nw.x) * 0.5, y: nw.y + (centre.y - nw.y) * 0.5 });
q = await proj();
const logo2 = q.overlays.find((o) => o.kind === "image");
check(logo2.width < logo1.width * 0.7, `dragging a corner in makes it smaller: width ${logo1.width.toFixed(3)} -> ${logo2.width.toFixed(3)}`);
const mid = await onScreen(logo2.x * 720, logo2.y * 1280);
await drag(mid, { x: mid.x - 120, y: mid.y - 300 });
q = await proj();
const logo3 = q.overlays.find((o) => o.kind === "image");
check(logo3.x < logo2.x - 0.2 && logo3.y < logo2.y - 0.2, `dragging inside moves it: centre (${logo2.x.toFixed(2)}, ${logo2.y.toFixed(2)}) -> (${logo3.x.toFixed(2)}, ${logo3.y.toFixed(2)})`);
const turn = await handle(".tbox .turn");
const c3 = await onScreen(logo3.x * 720, logo3.y * 1280);
// move the handle a quarter turn clockwise around the centre (from straight below to straight left)
const rad = Math.hypot(turn.x - c3.x, turn.y - c3.y);
await page.mouse.move(turn.x, turn.y); await page.mouse.down();
for (let i = 1; i <= 12; i++) { const a = Math.PI / 2 + (Math.PI / 2) * (i / 12); await page.mouse.move(c3.x + rad * Math.cos(a), c3.y + rad * Math.sin(a)); }
await page.mouse.up(); await wait(250);
q = await proj();
const logo4 = q.overlays.find((o) => o.kind === "image");
check(Math.abs(logo4.rotation - 90) < 0.01, `round handle a quarter turn -> rotation ${logo4.rotation}° (snaps to 90)`);

// 2. the main-track clip: click the middle of the frame, shrink it from a corner, rotate it in the Inspector
await page.mouse.click(...Object.values(await onScreen(360, 640)));
await wait(200);
check((await selected()).some((x) => x.includes("clipA")), `click on the video in the middle of the frame selects the main-track clip (${(await selected()).join(", ")})`);
const cse = await handle(".tbox .corner.se");
const cc = await onScreen(360, 640);
await drag(cse, { x: cse.x - (cse.x - cc.x) * 0.4, y: cse.y - (cse.y - cc.y) * 0.4 });
await page.evaluate(() => { const r = [...document.querySelectorAll(".form label")].find((l) => l.textContent.startsWith("Rotation")).querySelector("input"); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(r, "-12"); r.dispatchEvent(new Event("input", { bubbles: true })); });
await wait(300);
q = await proj();
check(q.clips[0].scale > 0.5 && q.clips[0].scale < 0.7 && q.clips[0].rotation === -12, `main clip: corner dragged in -> size ${Math.round(q.clips[0].scale * 100)}%, Rotation slider -> ${q.clips[0].rotation}°`);

// 3. the title: bigger from a corner and turned with the Rotation slider
const title = q.overlays.find((o) => o.kind === "text");
await page.mouse.click(...Object.values(await onScreen(title.x * 720, title.y * 1280)));
await wait(200);
const tse = await handle(".tbox .corner.se");
await drag(tse, { x: tse.x + 40, y: tse.y + 10 });
await page.evaluate(() => { const r = [...document.querySelectorAll(".form label")].find((l) => l.textContent.startsWith("Rotation")).querySelector("input"); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(r, "8"); r.dispatchEvent(new Event("input", { bubbles: true })); });
await wait(300);
q = await proj();
const t2 = q.overlays.find((o) => o.kind === "text");
check(t2.fontSize > title.fontSize && t2.rotation === 8, `title: corner -> size ${title.fontSize} -> ${t2.fontSize}, Rotation -> ${t2.rotation}°`);

// 4. a click on empty frame clears the selection
await page.mouse.click(...Object.values(await onScreen(30, 1250)));
await wait(200);
check((await selected()).length === 0 && !(await handle(".tbox")), `click on empty frame clears the selection`);

// 5. exports match the preview with all three changed
await page.evaluate(() => window.__poc.seek(2));
await wait(1200);
writeFileSync("out/tf_preview.png", Buffer.from((await page.$eval(".preview canvas", (c) => c.toDataURL("image/png"))).split(",")[1], "base64"));
const row = ["out/tf_preview.png"];
for (const engine of ["server", "mediabunny"]) {
  const r = await page.evaluate(async (engine) => { const r = await window.__poc.run(engine); if ("error" in r) return r; const up = await (await fetch(`/api/upload/tf_${engine}.mp4`, { method: "PUT", body: await (await fetch(r.url)).blob() })).json(); return { file: up.src.slice(1) }; }, engine);
  if (r.error) { check(false, `${engine} export: ${r.error.slice(0, 200)}`); continue; }
  const png = `out/tf_${engine}.png`;
  spawnSync(ffmpegPath, ["-y", "-loglevel", "error", "-ss", "2", "-i", r.file, "-frames:v", "1", png]);
  const log = spawnSync(ffmpegPath, ["-hide_banner", "-i", png, "-i", "out/tf_preview.png", "-lavfi", "[1:v][0:v]scale2ref[p][v];[v][p]ssim", "-f", "null", "-"], { encoding: "utf8" }).stderr;
  const s = +(/All:([\d.]+)/.exec(log)?.[1] ?? 0);
  check(s > 0.85, `${engine} export at 2 s matches the preview (resized and turned logo, smaller turned video, bigger turned title): ${s.toFixed(3)}`);
  row.push(png);
}
spawnSync(ffmpegPath, ["-y", "-loglevel", "error", ...row.flatMap((x) => ["-i", x]), "-filter_complex", row.map((_, k) => `[${k}:v]scale=-2:480${k < row.length - 1 ? ",pad=iw+8:ih:0:0:color=gray" : ""}[s${k}]`).join(";") + ";" + row.map((_, k) => `[s${k}]`).join("") + `hstack=inputs=${row.length}`, "out/transform-check.png"]);
await page.screenshot({ path: "out/transform-ui.png" });
await page.evaluate(() => [...document.querySelectorAll(".bar button")].find((b) => b.textContent.trim() === "Reset").click());
check(errors.length === 0, errors.length ? "page errors:\n  " + errors.join("\n  ") : "no page errors");
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
await browser.close();
process.exit(failures ? 1 : 0);
