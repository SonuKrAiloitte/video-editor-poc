// How the own-core editor copes with a long video on a slower laptop: Chrome's CPU throttling slows the page's
// JavaScript 1x / 4x / 6x (video decoding by the graphics chip is NOT slowed, so this is only part of a weak laptop).
// Measures import (includes the upload to the render server), playback smoothness, a seek, and a short browser export.
// Needs :5180 and :5181. usage: node scripts/lowend-check.mjs <long video file> [rates, default 1,4,6]
import puppeteer from "puppeteer-core";

const file = process.argv[2];
const rates = (process.argv[3] ?? "1,4,6").split(",").map(Number);
if (!file) throw new Error("usage: node scripts/lowend-check.mjs <long video file> [1,4,6]");
const name = file.split(/[\\/]/).pop();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: "new", defaultViewport: { width: 1440, height: 1000 }, protocolTimeout: 1_800_000, args: ["--autoplay-policy=no-user-gesture-required"] });

for (const rate of rates) {
  const page = await browser.newPage();
  const cdp = await page.createCDPSession();
  await page.goto((process.env.BASE ?? "http://localhost:5180") + "/#own", { waitUntil: "networkidle0" });
  await wait(800);
  await page.evaluate(() => [...document.querySelectorAll(".bar button")].find((b) => b.textContent.trim() === "Reset").click());
  await cdp.send("Emulation.setCPUThrottlingRate", { rate });
  await wait(500);

  // import (checked, then saved on the server)
  const t0 = Date.now();
  const [chooser] = await Promise.all([page.waitForFileChooser({ timeout: 10000 }), page.click(".lib-import")]);
  await chooser.accept([file]);
  await wait(300);
  for (let i = 0; i < 1200 && (await page.evaluate(() => !!document.querySelector(".lib.pending"))); i++) await wait(250);
  const importSec = (Date.now() - t0) / 1000;
  // PROXY=1: wait for the server's light preview copy before playing (it is made in the background after the import)
  let proxySec = null;
  if (process.env.PROXY) {
    for (let i = 0; i < 600; i++) {
      if (await page.evaluate((name) => !!JSON.parse(localStorage.getItem("poc-own-library-v1") ?? "[]").find((m) => m.name === name)?.proxy, name)) break;
      await wait(500);
    }
    proxySec = ((Date.now() - t0) / 1000 - importSec).toFixed(0);
  }

  // an edit made of just this file
  await page.evaluate((name) => {
    const q = window.__poc.getProject();
    const lib = JSON.parse(localStorage.getItem("poc-own-library-v1") ?? "[]").find((m) => m.name === name);
    window.__poc.setProject({ ...q, overlays: [], audios: [], tracks: [], clips: [{ id: "long", kind: "video", name, src: lib.src, in: 0, out: lib.duration, srcDuration: lib.duration, muted: false, hasAudio: lib.hasAudio, channels: lib.channels, ratio: lib.ratio }] });
    window.__poc.seek(0);
  }, name);
  await wait(2500);

  // play 6 s: how far the playhead got, frames drawn per second, video frames the browser dropped
  const play = await page.evaluate(async () => {
    const btn = document.querySelector(".player-bar .play");
    let frames = 0, run = true; const count = () => { frames++; if (run) requestAnimationFrame(count); };
    const v = window.__poc.media().videos[0];
    btn.click(); const s = performance.now(); requestAnimationFrame(count);
    await new Promise((r) => setTimeout(r, 6000));
    run = false; btn.click();
    const t = (performance.now() - s) / 1000;
    const head = window.__poc.media().videos[0]?.t ?? 0;
    return { fps: Math.round(frames / t), playheadAt: +head.toFixed(2), wall: +t.toFixed(2), src: v?.src };
  });

  // jump to 2 minutes: how long until the preview shows that moment
  const seekMs = await page.evaluate(async () => {
    const c = document.querySelector(".preview canvas"); const x = c.getContext("2d", { willReadFrequently: true });
    const sig = () => { const d = x.getImageData(0, 0, c.width, c.height).data; let s = 0; for (let i = 0; i < d.length; i += 4999) s = (s * 31 + d[i]) | 0; return s; };
    const before = sig(); const t = performance.now(); window.__poc.seek(120);
    for (let i = 0; i < 600; i++) { await new Promise((r) => requestAnimationFrame(r)); if (sig() !== before) return Math.round(performance.now() - t); }
    return null;
  });

  // browser export of 15 s of it at 720p (the editor would send a whole long edit to the server)
  const exp = await page.evaluate(async () => {
    const q = window.__poc.getProject();
    window.__poc.setProject({ ...q, clips: q.clips.map((c) => ({ ...c, in: 60, out: 75 })) });
    await new Promise((r) => setTimeout(r, 500));
    const t = performance.now();
    const r = await window.__poc.run("mediabunny", true);
    return "error" in r ? r.error.slice(0, 120) : +((performance.now() - t) / 1000).toFixed(1);
  });
  const heap = await page.evaluate(() => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null));

  console.log(`CPU ${rate}x slower: import ${importSec.toFixed(1)} s${proxySec ? ` (preview copy ready ${proxySec} s later, playing ${play.src})` : ""} | 6 s of play -> playhead reached ${play.playheadAt} s, ${play.fps} preview frames/s | jump to 2:00 shown after ${seekMs} ms | browser export of 15 s at 720p: ${exp}${typeof exp === "number" ? " s" : ""} | page memory ${heap} MB`);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  await page.evaluate(() => [...document.querySelectorAll(".bar button")].find((b) => b.textContent.trim() === "Reset").click());
  await page.evaluate((name) => [...document.querySelectorAll(".lib.own")].filter((x) => x.querySelector(".lib-name").textContent === name).forEach((x) => x.querySelector(".lib-remove").click()), name);
  await page.close();
}
await browser.close();
