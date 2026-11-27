// The player bar under the preview, driven with the mouse: play, the ratio menu (each ratio, and Original),
// Fit vs Fill on a clip, and that the server and browser exports keep the whole picture with black bars.
// Writes out/player-check.png: preview | server export | Mediabunny export, for 9:16, 16:9 and 2.35:1.
// Needs :5180 and :5181.
import puppeteer from "puppeteer-core";
import ffmpegPath from "ffmpeg-static";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: "new", defaultViewport: { width: 1440, height: 1000 } });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 200)));
await page.goto("http://localhost:5180/#own", { waitUntil: "networkidle0" });
await wait(1200);
await page.evaluate(() => [...document.querySelectorAll(".bar button")].find((b) => b.textContent.trim() === "Reset").click());
await wait(500);

let failures = 0;
const check = (ok, label) => { if (!ok) failures++; console.log(`${ok ? "OK  " : "FAIL"} ${label}`); };
const proj = () => page.evaluate(() => window.__poc.getProject());

// play from the player bar
const t0 = await page.$eval(".player-bar .time", (e) => e.textContent);
await page.click(".player-bar .play");
await wait(1500);
await page.click(".player-bar .play");
const t1 = await page.$eval(".player-bar .time", (e) => e.textContent);
check(t0 !== t1 && /^\d\d:\d\d:\d\d:\d\d/.test(t1), `play button under the preview: time ${t0} -> ${t1}`);

/** pick a ratio from the menu with the mouse */
const pickRatio = async (label) => {
  await page.click(".ratio-btn");
  await wait(150);
  const item = await page.evaluateHandle((l) => [...document.querySelectorAll(".ratio-menu button")].find((b) => b.querySelector(".name").textContent === l), label);
  await item.asElement().click();
  await wait(700);
};
const menu = await (async () => { await page.click(".ratio-btn"); await wait(150); const items = await page.$$eval(".ratio-menu .name", (n) => n.map((x) => x.textContent)); await page.click(".ratio-btn"); return items; })();
check(menu.length >= 9 && menu[0] === "Original", `ratio menu lists: ${menu.join(", ")}`);

const shots = [];
for (const ratio of ["9:16", "16:9", "2.35:1"]) {
  await pickRatio(ratio);
  const q = await proj();
  const canvas = await page.$eval(".preview canvas", (c) => [c.width, c.height]);
  check(q.aspect === ratio, `picked ${ratio}: edit says ${q.aspect}, preview canvas ${canvas.join("x")}`);
  await page.evaluate(() => window.__poc.seek(2));
  await wait(1200);
  const prev = `out/player_${ratio.replace(/[:.]/g, "_")}_preview.png`;
  writeFileSync(prev, Buffer.from((await page.$eval(".preview canvas", (c) => c.toDataURL("image/png"))).split(",")[1], "base64"));
  const row = [prev];
  for (const engine of ["server", "mediabunny"]) {
    const r = await page.evaluate(async (engine) => {
      const r = await window.__poc.run(engine);
      if ("error" in r) return r;
      const up = await (await fetch(`/api/upload/player_${engine}.mp4`, { method: "PUT", body: await (await fetch(r.url)).blob() })).json();
      return { file: up.src.slice(1), w: r.width, h: r.height };
    }, engine);
    if (r.error) { check(false, `${engine} export at ${ratio}: ${r.error.slice(0, 200)}`); continue; }
    const png = `out/player_${ratio.replace(/[:.]/g, "_")}_${engine}.png`;
    spawnSync(ffmpegPath, ["-y", "-loglevel", "error", "-ss", "2", "-i", r.file, "-frames:v", "1", png]);
    const log = spawnSync(ffmpegPath, ["-hide_banner", "-i", png, "-i", prev, "-lavfi", "[1:v][0:v]scale2ref[p][v];[v][p]ssim", "-f", "null", "-"], { encoding: "utf8" }).stderr;
    const s = +(/All:([\d.]+)/.exec(log)?.[1] ?? 0);
    check(s > 0.85, `${ratio} ${engine} export ${r.w}x${r.h}, frame at 2 s matches the preview: ${s.toFixed(3)}`);
    row.push(png);
  }
  shots.push(row);
}

// Fit vs Fill: the first clip is 16:9 in a 9:16 frame, so Fit leaves black bars above and below and Fill does not
await pickRatio("9:16");
await page.evaluate(() => window.__poc.seek(1));
const firstClip = await page.evaluateHandle(() => document.querySelector(".tl .track.main .clip"));
await firstClip.asElement().click();
await wait(300);
const barBrightness = () => page.evaluate(() => { const c = document.querySelector(".preview canvas"); const d = c.getContext("2d").getImageData(0, Math.round(c.height * 0.1), c.width, 4).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2]; return Math.round(s / (d.length / 4 * 3)); });
await wait(900);
const fitTop = await barBrightness();
await page.evaluate(() => [...document.querySelectorAll(".seg button")].find((b) => b.textContent.startsWith("Fill")).click());
await wait(900);
const fillTop = await barBrightness();
const fitMode = (await proj()).clips[0].fit;
check(fitTop < 5 && fillTop > 30 && fitMode === "fill", `Fit vs Fill on a 16:9 clip in 9:16: top of the frame brightness ${fitTop} (black bar) -> ${fillTop} after "Fill (crop)"`);

// Original follows the first clip's shape
await pickRatio("Original");
const orig = await page.$eval(".preview canvas", (c) => [c.width, c.height]);
check(Math.abs(orig[0] / orig[1] - 16 / 9) < 0.01, `Original: frame follows the first clip (16:9): ${orig.join("x")}`);

// one row per ratio (preview | server | Mediabunny), rows stacked on a grey ground
const rows = shots.map((row, r) => {
  const out = `out/_player_row_${r}.png`;
  spawnSync(ffmpegPath, ["-y", "-loglevel", "error", ...row.flatMap((x) => ["-i", x]), "-filter_complex",
    row.map((_, k) => `[${k}:v]scale=-2:240${k < row.length - 1 ? ",pad=iw+8:ih:0:0:color=gray" : ""}[s${k}]`).join(";") + ";" + row.map((_, k) => `[s${k}]`).join("") + `hstack=inputs=${row.length}`, out]);
  return out;
});
spawnSync(ffmpegPath, ["-y", "-loglevel", "error", ...rows.flatMap((x) => ["-i", x]), "-filter_complex",
  rows.map((_, k) => `[${k}:v]pad=1900:ih:0:0:color=gray[r${k}]`).join(";") + ";" + rows.map((_, k) => `[r${k}]`).join("") + `vstack=inputs=${rows.length},scale=1400:-2`, "out/player-check.png"]);
await page.screenshot({ path: "out/player-ui.png" });
check(errors.length === 0, errors.length ? "console errors:\n  " + [...new Set(errors)].join("\n  ") : "no console errors");
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
await browser.close();
process.exit(failures ? 1 : 0);
