// Drives the own-core editor in a real (headless) Chrome and checks the preview never shows a black frame
// while pausing and scrubbing. Needs the dev server (:5180) running.
import puppeteer from "puppeteer-core";
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: "new",
  args: ["--autoplay-policy=no-user-gesture-required", "--window-size=1440,900"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto("http://localhost:5180/#own", { waitUntil: "networkidle0" });
await page.evaluate(() => localStorage.removeItem("poc-own-editor-draft-v1"));
await page.reload({ waitUntil: "networkidle0" });
await new Promise((r) => setTimeout(r, 1500));
const out = await page.evaluate(async () => {
  const w = (ms) => new Promise((r) => setTimeout(r, ms));
  let frames = 0; const cnt = () => { frames++; requestAnimationFrame(cnt); }; requestAnimationFrame(cnt);
  await w(500);
  const c = document.querySelector(".preview canvas"); const x = c.getContext("2d");
  const bright = () => { const d = x.getImageData(c.width / 2 - 40, c.height / 2 - 40, 80, 80).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2]; return Math.round(s / (d.length / 4 * 3)); };
  const sample = async (n) => { const a = []; for (let i = 0; i < n; i++) { a.push(bright()); await w(25); } return a; };
  const btn = document.querySelector(".player-bar .play");
  const res = { rafIn500ms: frames };
  window.__poc.seek(1); await w(900); res.atRest = bright();
  btn.click(); await w(1500); res.playing = { time: document.querySelector(".player-bar .time").textContent, media: window.__poc.media().videos[0] };
  btn.click(); res.afterPause = await sample(16);
  window.__poc.seek(3.2); res.afterScrubSameClip = await sample(16);
  window.__poc.seek(5); res.scrubIntoClip2 = await sample(16);
  window.__poc.seek(8); res.scrubIntoClip3 = await sample(16);
  const all = [...res.afterPause, ...res.afterScrubSameClip, ...res.scrubIntoClip2, ...res.scrubIntoClip3];
  res.blackSamples = all.filter((v) => v < 8).length; res.totalSamples = all.length;
  return res;
});
console.log(JSON.stringify({ ...out, errors }, null, 1));
await page.screenshot({ path: "out/preview-check.png" });
await browser.close();
