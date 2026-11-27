// Twick's own Upload buttons, fed real files through the file picker, in headless Chrome.
// Needs :5180 and :5181 running.
// usage: node scripts/twick-upload-check.mjs <video file> [<video file> ...]
import puppeteer from "puppeteer-core";
const files = process.argv.slice(2);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: "new", defaultViewport: { width: 1440, height: 1000 } });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 200)));
await page.goto("http://localhost:5180/#twick", { waitUntil: "networkidle0" });
await wait(2500);

const buttons = await page.$$eval("button, label", (b) => b.map((x) => x.textContent.trim()).filter((t) => /upload/i.test(t)));
console.log(`${buttons.length ? "OK  " : "FAIL"} upload button(s) shown: ${buttons.join(", ") || "none"}`);
const cards = () => page.evaluate(() => [...document.querySelectorAll("video")].map((v) => ({ src: decodeURIComponent((v.currentSrc || v.src).split("/").pop()), ready: v.readyState, dur: Number.isFinite(v.duration) ? +v.duration.toFixed(1) : null })));

for (const file of files) {
  const before = (await cards()).length;
  const [chooser] = await Promise.all([page.waitForFileChooser({ timeout: 5000 }), page.evaluate(() => [...document.querySelectorAll("button, label")].find((x) => /upload video/i.test(x.textContent))?.click())]);
  await chooser.accept([file]);
  let after = before, last = null;
  for (let i = 0; i < 60 && after <= before; i++) { await wait(500); const c = await cards(); after = c.length; last = c[c.length - 1]; }
  await wait(1500);
  last = (await cards()).find((c) => c.src.includes(file.split(/[\\/]/).pop().replace(/[^a-zA-Z0-9._-]/g, "_").replace(/\.[^.]+$/, "")) || /converted/.test(c.src)) ?? last;
  const name = file.split(/[\\/]/).pop();
  console.log(`${after > before && last?.ready >= 2 ? "OK  " : "FAIL"} ${name.padEnd(34)} library ${before} -> ${after}; new card: ${last ? `${last.src}, ${last.dur}s, playable: ${last.ready >= 2}` : "none"}`);
}
await page.screenshot({ path: "out/twick-upload-check.png" });
console.log(errors.length ? "errors:\n  " + [...new Set(errors)].join("\n  ") : "no console errors");
await browser.close();
