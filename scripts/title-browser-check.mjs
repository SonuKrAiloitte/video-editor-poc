// In Chrome: a Hindi title and an English title in a chosen font, exported by every engine, and the same
// moment grabbed from the preview. Writes out/title-check.png (preview | server | mediabunny | wasm) to look at,
// and prints how closely each export matches the preview. Also checks that a long edit goes to the server.
// Needs :5180 and :5181 running.
import puppeteer from "puppeteer-core";
import ffmpegPath from "ffmpeg-static";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const engines = (process.argv.find((a) => a.startsWith("--engines="))?.split("=")[1] ?? "server,mediabunny,wasm").split(",");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: "new", defaultViewport: { width: 1440, height: 900 }, protocolTimeout: 900_000 });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 200)));
await page.goto("http://localhost:5180/#own", { waitUntil: "networkidle0" });
await wait(1200);

// 1. titles
await page.evaluate(() => {
  const q = window.__poc.getProject();
  window.__poc.setProject({
    ...q, aspect: "16:9", audios: [], tracks: [], clips: [{ ...q.clips[0], in: 1, out: 3 }],
    overlays: [
      { id: "hi", kind: "text", text: "दिवाली की हार्दिक शुभकामनाएँ", font: "jakarta", fontSize: 56, color: "#FFE08A", x: 0.5, y: 0.3, start: 0, end: 2 },
      { id: "pp", kind: "text", text: "त्योहार की बिक्री: 40% छूट", font: "poppins", fontSize: 48, color: "#FFFFFF", x: 0.5, y: 0.52, start: 0, end: 2 },
      { id: "en", kind: "text", text: "Playfair Display: Sale 40% off", font: "playfair", fontSize: 44, color: "#FFFFFF", x: 0.5, y: 0.76, start: 0, end: 2 },
    ],
  });
});
await wait(1500);
await page.evaluate(() => window.__poc.seek(1));
await wait(1500);
writeFileSync("out/title_preview.png", Buffer.from((await page.evaluate(() => document.querySelector(".preview canvas").toDataURL("image/png"))).split(",")[1], "base64"));
const shots = ["out/title_preview.png"];
for (const engine of engines) {
  const r = await page.evaluate(async (engine) => {
    const r = await window.__poc.run(engine);
    if ("error" in r) return r;
    const up = await (await fetch(`/api/upload/title_${engine}.mp4`, { method: "PUT", body: await (await fetch(r.url)).blob() })).json();
    return { ms: r.ms, file: up.src.slice(1) };
  }, engine);
  if (r.error) { console.log(`FAIL ${engine}: ${r.error.slice(0, 300)}`); continue; }
  const png = `out/title_${engine}.png`;
  spawnSync(ffmpegPath, ["-y", "-loglevel", "error", "-ss", "1", "-i", r.file, "-frames:v", "1", png]);
  const log = spawnSync(ffmpegPath, ["-hide_banner", "-i", png, "-i", "out/title_preview.png", "-lavfi", "[1:v][0:v]scale2ref[p][v];[v][p]ssim", "-f", "null", "-"], { encoding: "utf8" }).stderr;
  console.log(`${engine.padEnd(11)} ${(r.ms / 1000).toFixed(1).padStart(5)} s   match with the preview frame: ${/All:([\d.]+)/.exec(log)?.[1]}`);
  shots.push(png);
}
spawnSync(ffmpegPath, ["-y", "-loglevel", "error", ...shots.flatMap((s) => ["-i", s]), "-filter_complex", `${shots.map((_, i) => `[${i}:v]scale=960:540[s${i}]`).join(";")};${shots.map((_, i) => `[s${i}]`).join("")}vstack=inputs=${shots.length}`, "out/title-check.png"]);
console.log(`wrote out/title-check.png, top to bottom: preview, ${engines.join(", ")}`);

// 2. a long edit must be exported on the server even when a browser engine is asked for
const routed = await page.evaluate(async () => {
  const q = window.__poc.getProject();
  const c = q.clips[0];
  window.__poc.setProject({ ...q, overlays: [], clips: Array.from({ length: 11 }, (_, i) => ({ ...c, id: "L" + i, in: 0, out: 6 })) });
  await new Promise((r) => setTimeout(r, 400));
  const r = await window.__poc.run("mediabunny");
  return { engine: r.engine ?? r.error, duration: r.duration, notice: document.querySelector(".notice")?.textContent ?? null };
});
console.log(`${/Server/.test(routed.engine) ? "OK  " : "FAIL"} 66 s edit, "Browser: Mediabunny" pressed -> exported by: ${routed.engine}`);
console.log(`     message shown: ${routed.notice}`);
console.log(errors.length ? "errors:\n  " + [...new Set(errors)].join("\n  ") : "no console errors");
await browser.close();
