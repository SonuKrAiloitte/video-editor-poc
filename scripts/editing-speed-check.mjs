// Editing without exporting, on a slower laptop: Chrome's CPU throttling (1x / 4x / 6x) while dragging a clip,
// trimming, typing a caption, scrubbing and zooming, on an edit like a real one (a 4-minute video cut into four
// clips on Main, a video and a title on tracks above, a caption, music). Reports the worst and the typical gap
// between frames during each action: under 50 ms feels smooth, over 100 ms feels stuck.
// Also measures how busy the page is while nothing happens. Needs :5180 and :5181.
// usage: node scripts/editing-speed-check.mjs [<long video file>] [rates]
import puppeteer from "puppeteer-core";

const file = process.argv[2] ?? "public/media/clipA_h264_16x9.mp4";
const rates = (process.argv[3] ?? "1,4,6").split(",").map(Number);
const name = file.split(/[\\/]/).pop();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: "new", defaultViewport: { width: 1440, height: 1000 }, protocolTimeout: 1_800_000 });
const page = await browser.newPage();
page.on("dialog", (d) => d.accept());
const cdp = await page.createCDPSession();
await page.goto((process.env.BASE ?? "http://localhost:5180") + "/#own", { waitUntil: "networkidle0" });
await wait(800);

// import the file once and build the edit
const [chooser] = await Promise.all([page.waitForFileChooser({ timeout: 10000 }), page.click(".lib-import")]);
await chooser.accept([file]);
await wait(300);
for (let i = 0; i < 1200 && (await page.evaluate(() => !!document.querySelector(".lib.pending"))); i++) await wait(250);
// the server makes the light preview copy in the background (on this same machine in the PoC, using every core);
// measure only once it is done, as on a real setup where it runs on the server and not on the user's laptop
{
  const src = await page.evaluate((name) => JSON.parse(localStorage.getItem("poc-own-library-v1")).find((m) => m.name === name)?.src, name);
  for (let i = 0; i < 600; i++) {
    const r = await page.evaluate((src) => fetch("/api/proxy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ src }) }).then((x) => x.json()), src);
    if (r.status !== "working") break;
    await wait(1000);
  }
  await wait(3000); // the editor picks the copy up within 1.5 s
}
await page.evaluate((name) => {
  const lib = JSON.parse(localStorage.getItem("poc-own-library-v1")).find((m) => m.name === name);
  const d = lib.duration, q4 = d / 4;
  const clip = (i) => ({ id: "m" + i, kind: "video", name: `${i + 1}_${name}`, src: lib.src, in: i * q4, out: (i + 1) * q4 - 0.1, srcDuration: d, muted: false, hasAudio: lib.hasAudio, channels: lib.channels, ratio: lib.ratio });
  window.__poc.setProject({
    aspect: "4:5", originalVolume: 1,
    clips: [0, 1, 2, 3].map(clip),
    tracks: [{ id: "cap", kind: "visual", role: "captions" }, { id: "t3", kind: "visual" }, { id: "t2", kind: "visual" }, { id: "a1", kind: "audio" }],
    overlays: [
      { id: "cap1", track: "cap", kind: "text", text: "Caption", fontSize: 34, color: "#FFFFFF", bg: "#000000", bgOpacity: 0.6, x: 0.5, y: 0.86, start: 1.4, end: 3.9 },
      { id: "pip", track: "t3", kind: "video", name: "pip_" + name, src: lib.src, in: 30, srcDuration: d, width: 0.35, x: 0.25, y: 0.12, start: 0, end: 6, muted: true, hasAudio: false },
      { id: "title", track: "t2", kind: "text", text: "Test", fontSize: 40, color: "#FFFFFF", x: 0.5, y: 0.14, start: 0, end: 3 },
    ],
    audios: [{ id: "mus", track: "a1", name: "music.mp3", src: "/media/music.mp3", start: 0, in: 0, out: 20, srcDuration: 20, volume: 0.4, channels: 1 }],
  });
  window.__poc.seek(1);
}, name);
await wait(2500);

/** run an action while counting frame gaps; returns the worst and the median gap in ms */
const measure = (fn) => page.evaluate(async (fnText) => {
  const gaps = []; let last = performance.now(), run = true;
  const tick = (t) => { gaps.push(t - last); last = t; if (run) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  await (0, eval)(fnText)();
  run = false;
  await new Promise((r) => setTimeout(r, 50));
  gaps.sort((a, b) => a - b);
  return { worst: Math.round(gaps.at(-1) ?? 0), median: Math.round(gaps[Math.floor(gaps.length / 2)] ?? 0) };
}, fn.toString());

const mouseDrag = async (from, to, steps = 30) => {
  await page.mouse.move(from.x, from.y); await page.mouse.down();
  const t = await page.evaluate(() => { window.__gaps = []; let last = performance.now(); window.__run = true; const tick = (x) => { window.__gaps.push(x - last); last = x; if (window.__run) requestAnimationFrame(tick); }; requestAnimationFrame(tick); return 0; });
  for (let i = 1; i <= steps; i++) { await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps); await wait(16); }
  await page.mouse.up();
  return page.evaluate(() => { window.__run = false; const g = window.__gaps.sort((a, b) => a - b); return { worst: Math.round(g.at(-1) ?? 0), median: Math.round(g[Math.floor(g.length / 2)] ?? 0) }; });
};
const box = (sel) => page.evaluate((sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { x: r.left + Math.min(40, r.width / 2), y: r.top + r.height / 2, r: r.right }; }, sel);
const fmt = (m) => `worst ${String(m.worst).padStart(4)} ms, typical ${String(m.median).padStart(3)} ms`;

for (const rate of rates) {
  await cdp.send("Emulation.setCPUThrottlingRate", { rate });
  await wait(600);
  // idle: how much of each second the page is busy while nothing happens
  const idle = await page.evaluate(async () => {
    let busy = 0; const obs = new PerformanceObserver((l) => l.getEntries().forEach((e) => (busy += e.duration))); obs.observe({ type: "longtask", buffered: false });
    let frames = 0, run = true; const t0 = performance.now(); const tick = () => { frames++; if (run) requestAnimationFrame(tick); }; requestAnimationFrame(tick);
    await new Promise((r) => setTimeout(r, 2000)); run = false; obs.disconnect();
    return { fps: Math.round(frames / ((performance.now() - t0) / 1000)), longTaskMs: Math.round(busy) };
  });
  const drag = await (async () => { const b = await box('[data-ref="overlay:title"]'); return mouseDrag(b, { x: b.x + 200, y: b.y }); })();
  const trim = await (async () => { const b = await page.evaluate(() => { const r = document.querySelector('[data-ref="clip:m1"] .h.r').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }); return mouseDrag(b, { x: b.x - 120, y: b.y }); })();
  const scrub = await (async () => { const b = await box(".tl > .ruler"); return mouseDrag({ x: b.x + 20, y: b.y }, { x: b.x + 700, y: b.y }); })();
  const typing = await (async () => {
    const input = await page.$(".cap-list input"); await input.click({ clickCount: 3 });
    await page.evaluate(() => { window.__gaps = []; let last = performance.now(); window.__run = true; const tick = (x) => { window.__gaps.push(x - last); last = x; if (window.__run) requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
    await page.keyboard.type("Diwali offer on now", { delay: 60 });
    return page.evaluate(() => { window.__run = false; const g = window.__gaps.sort((a, b) => a - b); return { worst: Math.round(g.at(-1)), median: Math.round(g[Math.floor(g.length / 2)]) }; });
  })();
  await page.mouse.click(5, 990);
  const zoom = await (async () => { const b = await page.evaluate(() => { const r = document.querySelector(".tl-head input").getBoundingClientRect(); return { x: r.left + 5, y: r.top + r.height / 2, w: r.width }; }); return mouseDrag(b, { x: b.x + b.w - 10, y: b.y }); })();
  console.log(`\nCPU ${rate}x slower`);
  console.log(`  doing nothing      : ${idle.fps} frames/s, page busy ${idle.longTaskMs} ms of 2000 ms`);
  console.log(`  drag a title       : ${fmt(drag)}`);
  console.log(`  trim a clip        : ${fmt(trim)}`);
  console.log(`  scrub the ruler    : ${fmt(scrub)}`);
  console.log(`  type a caption     : ${fmt(typing)}`);
  console.log(`  zoom the timeline  : ${fmt(zoom)}`);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  await page.evaluate(() => { const z = document.querySelector(".tl-head input"); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(z, "60"); z.dispatchEvent(new Event("input", { bubbles: true })); });
  await wait(500);
}
await page.evaluate(() => [...document.querySelectorAll(".bar button")].find((b) => b.textContent.trim() === "Reset").click());
await page.evaluate((name) => [...document.querySelectorAll(".lib.own")].filter((x) => x.querySelector(".lib-name").textContent === name).forEach((x) => x.querySelector(".lib-remove").click()), name);
await browser.close();
