// Checks what the speed work changed, in Chrome: a burst of typing is one Undo step; playing does not re-render the
// editor; zoom places blocks right; the preview switches to the server's light proxy copy, and the export still reads
// the original file. Needs :5180 (or BASE) and :5181. usage: node scripts/speed-fixes-check.mjs <big or 60 fps video>
import puppeteer from "puppeteer-core";

const file = process.argv[2];
if (!file) throw new Error("usage: node scripts/speed-fixes-check.mjs <video over 720p or over 30 fps>");
const name = file.split(/[\\/]/).pop();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, text) => (console.log(`${ok ? "OK  " : "FAIL"} ${text}`), ok || failed++);
const browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: "new", defaultViewport: { width: 1440, height: 1000 }, args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
page.on("dialog", (d) => d.accept());
await page.goto((process.env.BASE ?? "http://localhost:5180") + "/#own", { waitUntil: "networkidle0" });
await wait(800);
await page.evaluate(() => [...document.querySelectorAll(".bar button")].find((b) => b.textContent.trim() === "Reset").click());
await wait(300);

// 1. typing: one Undo step per burst; the edit gets the text after the keys stop
await page.evaluate(() => [...document.querySelectorAll(".bar button")].find((b) => b.textContent.trim() === "+ Caption").click());
await wait(300);
const before = await page.evaluate(() => window.__poc.getProject().overlays.find((o) => o.text === "Caption")?.id);
const input = await page.$(".cap-list input");
await input.click({ clickCount: 3 });
const r0 = await page.evaluate(() => window.__poc.renders());
await page.keyboard.type("Diwali offer", { delay: 40 });
const r1 = await page.evaluate(() => window.__poc.renders());
await wait(400);
const typed = await page.evaluate((id) => window.__poc.getProject().overlays.find((o) => o.id === id)?.text, before);
check(typed === "Diwali offer", `typed 12 letters -> the edit has "${typed}"; the editor re-rendered ${r1 - r0} times while typing (was 12+)`);
await page.mouse.click(5, 990); // leave the box
await wait(300);
await page.evaluate(() => window.__poc.undo());
await wait(200);
const undone = await page.evaluate((id) => window.__poc.getProject().overlays.find((o) => o.id === id)?.text, before);
check(undone === "Caption", `one Undo after typing -> "${undone}" (the whole burst, not one letter)`);
await page.evaluate(() => window.__poc.redo());
await wait(200);

// 2. zoom: blocks sit at start x zoom, width length x zoom
const z = await page.evaluate(async () => {
  const el = document.querySelector(".tl-head input");
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  set.call(el, "120");
  el.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 300));
  const p = window.__poc.getProject();
  const o = p.overlays[0];
  const b = document.querySelector(`[data-ref="overlay:${o.id}"]`).getBoundingClientRect();
  const tl = document.querySelector(".tl").getBoundingClientRect();
  const labels = [...document.querySelectorAll(".tl > .ruler span")].map((s) => s.textContent);
  return { left: Math.round(b.left - tl.left), want: Math.round(o.start * 120), width: Math.round(b.width), wantW: Math.round((o.end - o.start) * 120), labels: labels.slice(0, 4) };
});
check(Math.abs(z.left - z.want) <= 1 && Math.abs(z.width - z.wantW) <= 1, `zoom 120: block at ${z.left} px wide ${z.width} (want ${z.want}, ${z.wantW}); ruler ${z.labels.join(" ")}`);
await page.evaluate(() => { const el = document.querySelector(".tl-head input"); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, "20"); el.dispatchEvent(new Event("input", { bubbles: true })); });
await wait(300);
const far = await page.evaluate(() => [...document.querySelectorAll(".tl > .ruler span")].map((s) => s.textContent).slice(0, 4).join(" "));
check(far.includes("5s"), `zoom 20: ruler labels spaced out: ${far}`);

// 3. playing re-renders only the time, the playhead and the selection box, not the editor
const play = await page.evaluate(async () => {
  window.__poc.seek(0);
  const r0 = window.__poc.renders();
  const btn = document.querySelector(".player-bar .play");
  btn.click();
  await new Promise((r) => setTimeout(r, 2000));
  btn.click();
  return { renders: window.__poc.renders() - r0, time: document.querySelector(".player-bar .time b").textContent, head: document.querySelector(".playhead").style.left };
});
check(play.renders <= 4 && play.time !== "00:00:00:00", `2 s of play: editor re-rendered ${play.renders} times (was ~120); time shows ${play.time}, playhead at ${play.head}`);

// 4. proxy: import a big file, the preview switches to the light copy; the edit and the export keep the original
const [chooser] = await Promise.all([page.waitForFileChooser(), page.click(".lib-import")]);
await chooser.accept([file]);
for (let i = 0; i < 1200 && (await page.evaluate(() => !!document.querySelector(".lib.pending"))); i++) await wait(250);
const t0 = Date.now();
let lib = null;
for (let i = 0; i < 400; i++) {
  lib = await page.evaluate((name) => JSON.parse(localStorage.getItem("poc-own-library-v1")).find((m) => m.name === name), name);
  if (lib?.proxy) break;
  await wait(500);
}
check(!!lib?.proxy, `proxy ready ${((Date.now() - t0) / 1000).toFixed(0)} s after the import: ${lib?.proxy ?? "none"}`);
await page.evaluate((lib) => {
  const q = window.__poc.getProject();
  window.__poc.setProject({ ...q, overlays: [], audios: [], tracks: [], clips: [{ id: "big", kind: "video", name: lib.name, src: lib.src, in: 10, out: 14, srcDuration: lib.duration, muted: false, hasAudio: lib.hasAudio, channels: lib.channels, ratio: lib.ratio }] });
  window.__poc.seek(1);
}, lib);
await wait(2500);
const media = await page.evaluate(() => ({ videos: window.__poc.media().videos.map((v) => v.src), clip: window.__poc.getProject().clips[0].src }));
check(media.videos.some((s) => s.endsWith(".proxy.mp4")) && !media.clip.includes(".proxy."), `preview plays ${media.videos.join(", ")}; the edit keeps ${media.clip.split("/").pop()}`);
const exp = await page.evaluate(async () => window.__poc.run("server"));
const size = await page.evaluate(async (url) => { const v = document.createElement("video"); v.src = url; await new Promise((r) => (v.onloadedmetadata = r)); return `${v.videoWidth}x${v.videoHeight}`; }, exp.url);
check(!exp.error && exp.height >= 720, `server export of that edit (which points at the original): ${size}, ${exp.duration?.toFixed(1)} s`);

await page.evaluate(() => [...document.querySelectorAll(".bar button")].find((b) => b.textContent.trim() === "Reset").click());
await page.evaluate((name) => [...document.querySelectorAll(".lib.own")].filter((x) => x.querySelector(".lib-name").textContent === name).forEach((x) => x.querySelector(".lib-remove").click()), name);
check(errors.length === 0, errors.length ? `page errors: ${errors.join(" | ")}` : "no page errors");
await browser.close();
console.log(failed ? `${failed} check(s) FAILED` : "all checks passed");
process.exit(failed ? 1 : 0);
