// Does ffmpeg.wasm (the browser FFmpeg, kept for comparison) also render a transition and an effect strip?
// The same filter graph goes to it, plus the mask video it fetches. Needs :5180 and :5181.
import puppeteer from "puppeteer-core";

const browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: "new", defaultViewport: { width: 1440, height: 1000 }, protocolTimeout: 600_000 });
const page = await browser.newPage();
await page.goto((process.env.BASE ?? "http://localhost:5180") + "/#own", { waitUntil: "networkidle0" });
await new Promise((r) => setTimeout(r, 800));
const clip = (id, name, extra = {}) => ({ id, kind: "video", name, src: `/media/${name}`, in: 0, out: 3, srcDuration: 8, muted: false, hasAudio: true, channels: 1, ...extra });
for (const type of ["slideleft", "ink"]) {
  const r = await page.evaluate(async (p) => {
    window.__poc.setProject(p);
    await new Promise((r) => setTimeout(r, 500));
    const r = await window.__poc.run("wasm");
    return "error" in r ? { error: r.error.slice(-300) } : { duration: r.duration, ms: Math.round(r.ms) };
  }, {
    aspect: "9:16", originalVolume: 1, audios: [],
    clips: [clip("a", "clipA_h264_16x9.mp4"), clip("b", "clipB_h264_9x16.mp4", { transition: { type, duration: 1 } })],
    tracks: [{ id: "fx", kind: "visual", role: "effects" }],
    overlays: [{ id: "e", track: "fx", kind: "effect", effect: "vignette", amount: 0.6, x: 0.5, y: 0.5, start: 0.5, end: 1.5 }],
  });
  console.log(`${r.error ? "FAIL" : "OK  "} ffmpeg.wasm, ${type} transition + vignette strip: ${r.error ?? `${r.duration.toFixed(2)} s edit in ${(r.ms / 1000).toFixed(1)} s`}`);
}
await page.evaluate(() => [...document.querySelectorAll(".bar button")].find((b) => b.textContent.trim() === "Reset").click());
await browser.close();
