// Twick: does "Add to timeline" put a library video on the timeline? Tries a seeded clip, a clip added by URL and
// a clip uploaded with "Upload video", then reads the project Twick hands to "Save Draft".
// Needs :5180 and :5181. usage: node scripts/twick-add-check.mjs [<file to upload>] [<name of the uploaded card>]
import puppeteer from "puppeteer-core";
const upload = process.argv[2] ?? "public/media/clipD_hevc.mov"; // any video file; this one comes with npm run media
const uploadMatch = process.argv[3]; // name to look for if the server renames the file (an AVI comes back as *_converted.mp4)
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: "new", defaultViewport: { width: 1440, height: 1000 } });
const page = await browser.newPage();
const errors = [];
page.on("dialog", (d) => d.accept());
page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
page.on("console", (m) => (m.type() === "error" || m.type() === "warning") && errors.push(`[${m.type()}] ${m.text().slice(0, 300)}`));
await page.goto("http://localhost:5180/#twick", { waitUntil: "networkidle0" });
await wait(2500);

const clickText = (t) => page.evaluate((t) => [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === t)?.click(), t);
const timeline = async () => {
  await page.evaluate(() => localStorage.removeItem("poc-twick-draft"));
  await clickText("Save Draft");
  await wait(800);
  const raw = await page.evaluate(() => localStorage.getItem("poc-twick-draft"));
  if (!raw) return null;
  const p = JSON.parse(raw);
  const tracks = p.input?.tracks ?? p.tracks ?? [];
  return tracks.flatMap((t) => (t.elements ?? []).filter((e) => e.type === "video").map((e) => `${decodeURIComponent(String(e.props?.src).split("/").pop())} [${e.s}-${e.e}]`));
};
/** click the "Add to timeline" button on the library card whose video plays `match` */
const addCard = (match) => page.evaluate((match) => {
  const v = [...document.querySelectorAll("video")].find((x) => decodeURIComponent(x.currentSrc || x.src).includes(match));
  if (!v) return "card not found";
  let card = v; for (let i = 0; i < 6 && card && !card.querySelector('button[title="Add to timeline"], button[aria-label="Add to timeline"]'); i++) card = card.parentElement;
  const b = card?.querySelector('button[title="Add to timeline"], button[aria-label="Add to timeline"]');
  if (!b) return "no add button on card";
  b.click();
  return "clicked";
}, match);

await clickText("New Project");
await wait(1500);
console.log("after New Project:", JSON.stringify(await timeline()));

console.log("seeded clipA:", await addCard("clipA_h264_16x9.mp4"));
await wait(1500);
console.log("  timeline:", JSON.stringify(await timeline()));

// a clip added by URL
const input = await page.evaluateHandle(() => [...document.querySelectorAll("input")].find((x) => /Paste video URL/i.test(x.placeholder)));
await input.asElement().click({ clickCount: 3 });
await page.keyboard.type("http://localhost:5180/media/real_sample.mp4");
await page.evaluate(() => [...document.querySelectorAll("button")].find((x) => /Add video by URL/i.test(x.title || x.getAttribute("aria-label") || ""))?.click());
await wait(4000);
console.log("URL clip real_sample.mp4:", await addCard("real_sample.mp4"));
await wait(1500);
console.log("  timeline:", JSON.stringify(await timeline()));

// a clip uploaded through the file picker
const [chooser] = await Promise.all([page.waitForFileChooser({ timeout: 5000 }), page.evaluate(() => [...document.querySelectorAll("button, label")].find((x) => /upload video/i.test(x.textContent))?.click())]);
await chooser.accept([upload]);
await wait(5000);
// the server saves an upload as "<time>_<name>", which also keeps it apart from a library clip of the same name
const upName = uploadMatch ?? "_" + upload.split(/[\\/]/).pop().replace(/[^a-zA-Z0-9._-]/g, "_");
console.log(`uploaded ${upName}:`, await addCard(upName));
await wait(1500);
console.log("  timeline:", JSON.stringify(await timeline()));

await page.screenshot({ path: "out/twick-add-check.png" });
console.log(errors.length ? "console:\n  " + [...new Set(errors)].join("\n  ") : "no console errors or warnings");
await browser.close();
