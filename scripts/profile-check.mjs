// Step 0 of the speed work: where does the time go? With the CPU slowed (default 4x), records a CPU profile while
// typing a caption, zooming, dragging a title and playing, and prints for each: how many times the whole editor
// rendered, and the functions that used the most CPU. Needs :5180 and :5181.
// usage: node scripts/profile-check.mjs [<video file>] [rate]
import puppeteer from "puppeteer-core";

const file = process.argv[2] ?? "public/media/clipA_h264_16x9.mp4";
const rate = Number(process.argv[3] ?? 4);
const name = file.split(/[\\/]/).pop();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: "new", defaultViewport: { width: 1440, height: 1000 }, protocolTimeout: 1_800_000, args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage();
page.on("dialog", (d) => d.accept());
const cdp = await page.createCDPSession();
await page.goto((process.env.BASE ?? "http://localhost:5180") + "/#own", { waitUntil: "networkidle0" });
await wait(800);
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
  const clip = (i) => ({ id: "m" + i, kind: "video", name: `${i + 1}_${name}`, src: lib.src, proxy: lib.proxy, in: i * q4, out: (i + 1) * q4 - 0.1, srcDuration: d, muted: false, hasAudio: lib.hasAudio, channels: lib.channels, ratio: lib.ratio });
  window.__poc.setProject({
    aspect: "4:5", originalVolume: 1, clips: [0, 1, 2, 3].map(clip),
    tracks: [{ id: "cap", kind: "visual", role: "captions" }, { id: "t3", kind: "visual" }, { id: "t2", kind: "visual" }, { id: "a1", kind: "audio" }],
    overlays: [
      { id: "cap1", track: "cap", kind: "text", text: "Caption", fontSize: 34, color: "#FFFFFF", bg: "#000000", bgOpacity: 0.6, x: 0.5, y: 0.86, start: 1.4, end: 3.9 },
      { id: "pip", track: "t3", kind: "video", name: "pip_" + name, src: lib.src, proxy: lib.proxy, in: 30, srcDuration: d, width: 0.35, x: 0.25, y: 0.12, start: 0, end: 6, muted: true, hasAudio: false },
      { id: "title", track: "t2", kind: "text", text: "Test", fontSize: 40, color: "#FFFFFF", x: 0.5, y: 0.14, start: 0, end: 3 },
    ],
    audios: [{ id: "mus", track: "a1", name: "music.mp3", src: "/media/music.mp3", start: 0, in: 0, out: 20, srcDuration: 20, volume: 0.4, channels: 1 }],
  });
  window.__poc.seek(1);
}, name);
await wait(2500);
await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
await cdp.send("Emulation.setCPUThrottlingRate", { rate });

const profile = async (label, action) => {
  const r0 = await page.evaluate(() => window.__poc.renders());
  await cdp.send("Profiler.start");
  const t0 = Date.now();
  await action();
  const { profile } = await cdp.send("Profiler.stop");
  const ms = Date.now() - t0;
  const r1 = await page.evaluate(() => window.__poc.renders());
  // self time per function, from the sampled profile
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  const dt = profile.timeDeltas;
  profile.samples.forEach((id, i) => {
    const n = byId.get(id);
    const f = n.callFrame;
    const where = f.url ? f.url.split("/").pop().split("?")[0] : "";
    const key = `${f.functionName || "(anonymous)"} ${where}`.trim();
    self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0) / 1000);
  });
  const total = [...self.values()].reduce((a, b) => a + b, 0);
  const top = [...self.entries()].filter(([k]) => !/^\(idle\)|^\(program\)|^\(garbage collector\)/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const gc = self.get("(garbage collector)") ?? 0;
  console.log(`\n${label}: ${ms} ms, whole editor rendered ${r1 - r0} times, CPU busy ${Math.round(total - (self.get("(idle)") ?? 0))} ms (garbage collection ${Math.round(gc)} ms)`);
  for (const [k, v] of top) console.log(`   ${String(Math.round(v)).padStart(5)} ms  ${k}`);
};

await profile("type 15 letters in a caption", async () => {
  const input = await page.$(".cap-list input"); await input.click({ clickCount: 3 });
  await page.keyboard.type("Diwali offer on", { delay: 60 });
});
await page.mouse.click(5, 990);
await profile("drag the zoom slider", async () => {
  const b = await page.evaluate(() => { const r = document.querySelector(".tl-head input").getBoundingClientRect(); return { x: r.left + 5, y: r.top + r.height / 2, w: r.width }; });
  await page.mouse.move(b.x, b.y); await page.mouse.down();
  for (let i = 1; i <= 20; i++) { await page.mouse.move(b.x + ((b.w - 10) * i) / 20, b.y); await wait(16); }
  await page.mouse.up();
});
await page.evaluate(() => { const z = document.querySelector(".tl-head input"); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(z, "60"); z.dispatchEvent(new Event("input", { bubbles: true })); });
await wait(500);
await profile("drag a title along its track", async () => {
  const b = await page.evaluate(() => { const r = document.querySelector('[data-ref="overlay:title"]').getBoundingClientRect(); return { x: r.left + 30, y: r.top + r.height / 2 }; });
  await page.mouse.move(b.x, b.y); await page.mouse.down();
  for (let i = 1; i <= 30; i++) { await page.mouse.move(b.x + 7 * i, b.y); await wait(16); }
  await page.mouse.up();
});
await profile("play for 4 seconds", async () => {
  await page.evaluate(() => document.querySelector(".player-bar .play").click());
  await wait(4000);
  await page.evaluate(() => document.querySelector(".player-bar .play").click());
});
await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
await page.evaluate(() => [...document.querySelectorAll(".bar button")].find((b) => b.textContent.trim() === "Reset").click());
await page.evaluate((name) => [...document.querySelectorAll(".lib.own")].filter((x) => x.querySelector(".lib-name").textContent === name).forEach((x) => x.querySelector(".lib-remove").click()), name);
await browser.close();
