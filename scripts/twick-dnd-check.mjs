// Twick with the CapCut-style track rules (src/twick-track-rules.tsx + scripts/patch-twick.mjs), driven with the mouse:
// moves between tracks (allowed and refused), Library drops onto tracks, and the joined-up main track.
// Needs :5180 and :5181. usage: node scripts/twick-dnd-check.mjs [--headed]
import puppeteer from "puppeteer-core";

const headed = process.argv.includes("--headed");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: headed ? false : "new", defaultViewport: { width: 1440, height: 1000 } });
const page = (await browser.pages())[0] ?? (await browser.newPage());
page.on("dialog", (d) => d.accept());
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 200)));
// start from the hand-written demo timeline, not a timeline Twick saved from an earlier visit
await page.goto("http://localhost:5180/#twick", { waitUntil: "networkidle0" });
await page.evaluate(() => { localStorage.clear(); indexedDB.databases?.().then((dbs) => dbs.forEach((d) => d.name && !/media/i.test(d.name) && indexedDB.deleteDatabase(d.name))); });
await page.reload({ waitUntil: "networkidle0" });
await wait(3000);
await page.evaluate(() => (globalThis.__twickRefusals = []));
/**
 * Twick's Library cards use the browser's own (HTML5) drag, which the test tool cannot perform with the mouse.
 * This sends the same drag events Chrome would (dragstart on the card, dragover and drop on the timeline),
 * so Twick's handlers run as they do for a person; only the OS-level drag gesture is not exercised.
 */
const htmlDrag = (cardPoint, to) => page.evaluate((c, to) => {
  const card = document.elementFromPoint(c.x, c.y)?.closest("[draggable=true]");
  if (!card) return "no draggable card at that point";
  const dt = new DataTransfer();
  const ev = (type, x, y) => new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y });
  card.dispatchEvent(ev("dragstart", c.x, c.y));
  const target = document.elementFromPoint(to.x, to.y);
  target.dispatchEvent(ev("dragenter", to.x, to.y));
  target.dispatchEvent(ev("dragover", to.x, to.y));
  target.dispatchEvent(ev("drop", to.x, to.y));
  card.dispatchEvent(ev("dragend", to.x, to.y));
  return "dropped with data types: " + [...dt.types].join(", ");
}, cardPoint, to);
/** refusals the track rules reported since the last call */
const refusals = () => page.evaluate(() => globalThis.__twickRefusals.splice(0));

let failures = 0;
const check = (ok, label) => { if (!ok) failures++; console.log(`${ok ? "OK  " : "FAIL"} ${label}`); };
const log = () => page.evaluate(() => document.querySelector(".twick-log")?.textContent ?? "");
/** the timeline as Twick holds it: tracks top to bottom with their elements */
const timeline = async () => {
  await page.evaluate(() => localStorage.removeItem("poc-twick-draft"));
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Save Draft")?.click());
  await wait(500);
  const raw = await page.evaluate(() => localStorage.getItem("poc-twick-draft"));
  const p = JSON.parse(raw);
  return (p.input?.tracks ?? p.tracks ?? []).map((t) => ({ id: t.id, name: t.name, type: t.type, els: (t.elements ?? []).map((e) => ({ id: e.id, type: e.type, s: +e.s.toFixed(2), e: +e.e.toFixed(2), src: String(e.props?.src ?? e.props?.text ?? "").split("/").pop() })) }));
};
const show = (tl) => tl.map((t) => `${t.name}[${t.type}]: ${t.els.map((e) => `${e.type}:${e.src}@${e.s}-${e.e}`).join(", ") || "empty"}`).join("\n       ");
/** DOM box of the n-th track row, and of an element block by its label */
const rowBox = (n) => page.evaluate((n) => { const r = document.querySelectorAll(".twick-track")[n]?.getBoundingClientRect(); return r && { x: r.x, y: r.y, w: r.width, h: r.height }; }, n);
const elBox = (n, k = 0) => page.evaluate((n, k) => { const r = document.querySelectorAll(".twick-track")[n]?.querySelectorAll(".twick-track-element")[k]?.getBoundingClientRect(); return r && { x: r.x, y: r.y, w: r.width, h: r.height }; }, n, k);
const mouseDrag = async (from, to) => {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / 12, from.y + ((to.y - from.y) * i) / 12);
  await wait(200);
  await page.mouse.up();
  await wait(900);
};
const centre = (b, dx = 0) => ({ x: b.x + Math.min(b.w / 2, 30) + dx, y: b.y + b.h / 2 });

let tl = await timeline();
console.log("start:\n       " + show(tl));
const mainIdx = tl.findIndex((t) => t.name === "Main");
const textIdx = tl.findIndex((t) => t.els.some((e) => e.type === "text"));
const audioIdx = tl.findIndex((t) => t.els.some((e) => e.type === "audio"));

// 1. text dragged onto the audio track: refused
await mouseDrag(centre(await elBox(textIdx)), centre(await rowBox(audioIdx), 80));
tl = await timeline();
let said = await refusals();
check(said.length === 1 && tl[audioIdx].els.every((e) => e.type === "audio"), `text dragged onto the audio track is refused: ${JSON.stringify(said)}`);

// 2. audio dragged onto the main track: refused
{
  const a = await elBox(audioIdx), m = await rowBox(mainIdx);
  await mouseDrag({ x: a.x + a.w / 2, y: a.y + a.h / 2 }, { x: a.x + a.w / 2, y: m.y + m.h / 2 });
}
tl = await timeline();
said = await refusals();
check(said.length === 1 && tl[mainIdx].els.every((e) => e.type !== "audio"), `audio dragged onto Main is refused: ${JSON.stringify(said)}`);

// 2b. Library drops (Twick's own HTML5 drag from the media panel): music onto Main is refused, video onto Music is refused
const openTab = async (label) => { await page.evaluate((l) => [...document.querySelectorAll(".toolbar-btn")].find((b) => b.textContent.trim() === l)?.click(), label); await wait(800); await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "My assets")?.click()); await wait(800); };
const cardBox = (sel) => page.evaluate((sel) => { const el = [...document.querySelectorAll(sel)].find((x) => x.closest("[draggable=true]")); const c = el?.closest("[draggable=true]"); const r = c?.getBoundingClientRect(); return r && { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, sel);
await openTab("Audio");
const musicCard = await cardBox(".panel-container button, .panel-container div");
if (musicCard) {
  const target = await rowBox(mainIdx);
  console.log("     " + (await htmlDrag(musicCard, { x: target.x + 300, y: target.y + target.h / 2 })));
  await wait(900);
  said = await refusals();
  tl = await timeline();
  check(said.length === 1 && tl[mainIdx].els.every((e) => e.type !== "audio"), `music card dragged from the Library onto Main is refused: ${JSON.stringify(said)}`);
} else check(false, "no draggable audio card found in the Library");
await openTab("Video");
const videoCard = await cardBox("video");
if (videoCard) {
  const target = await rowBox(audioIdx);
  const before = (await timeline())[audioIdx].els.length;
  console.log("     " + (await htmlDrag(videoCard, { x: target.x + 300, y: target.y + target.h / 2 })));
  await wait(900);
  said = await refusals();
  tl = await timeline();
  check(said.length === 1 && tl[audioIdx].els.length === before, `video card dragged from the Library onto the Music track is refused: ${JSON.stringify(said)}`);
  const textRow = await rowBox(tl.findIndex((t) => t.els.some((e) => e.type === "text")));
  const countBefore = tl.reduce((n, t) => n + t.els.length, 0);
  console.log("     " + (await htmlDrag(videoCard, { x: textRow.x + 150, y: textRow.y + textRow.h / 2 })));
  await wait(1200);
  tl = await timeline();
  check(tl.reduce((n, t) => n + t.els.length, 0) === countBefore + 1, `video card dragged from the Library onto the Text track is added (on a new track, as it would cover the title) (elements ${countBefore} -> ${tl.reduce((n, t) => n + t.els.length, 0)})`);
} else check(false, "no draggable video card found in the Library");

// 3. text dragged onto the main (video) track: allowed (video, image and text share tracks)
await mouseDrag(centre(await elBox(textIdx)), { x: (await rowBox(mainIdx)).x + 40, y: (await rowBox(mainIdx)).y + (await rowBox(mainIdx)).h / 2 });
tl = await timeline();
const textNow = tl.findIndex((t) => t.els.some((e) => e.type === "text"));
check(textNow >= 0, `text dragged onto Main -> now on "${tl[textNow]?.name}" (Twick puts it on a new track next to Main if it would cover a clip)`);

// 4 + 5. first main clip dragged out below the last track: allowed (Twick refused this before the hook),
// and the main track closes the gap it leaves, the way CapCut's main track does
tl = await timeline();
{
  const m0 = tl.findIndex((t) => t.name === "Main");
  const before = tl[m0].els.length;
  const repacksBefore = await page.evaluate(() => globalThis.__twickRepacks ?? 0);
  const clipBox = await elBox(m0, 0);
  const rows = await page.evaluate(() => [...document.querySelectorAll(".twick-track")].map((r) => r.getBoundingClientRect().bottom));
  await mouseDrag({ x: clipBox.x + clipBox.w / 2, y: clipBox.y + clipBox.h / 2 }, { x: clipBox.x + clipBox.w / 2, y: Math.max(...rows) + 6 });
  await wait(600);
  tl = await timeline();
  const main = tl.find((t) => t.name === "Main");
  check(main.els.length === before - 1, `first main clip dragged below the last track -> moved out to its own track: Main has ${main.els.length} clip(s) (was ${before})`);
  const first = [...main.els].sort((x, y) => x.s - y.s)[0];
  const repacks = (await page.evaluate(() => globalThis.__twickRepacks ?? 0)) - repacksBefore;
  check(first && Math.abs(first.s) < 0.05 && repacks >= 1, `the clip that was second on Main slid to ${first?.s} s to close the gap (${repacks} repack)`);
}
console.log("end:\n       " + show(tl));
await page.screenshot({ path: "out/twick-dnd.png" });
check(errors.length === 0, errors.length ? "console errors:\n  " + [...new Set(errors)].join("\n  ") : "no console errors");
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
await browser.close();
process.exit(failures ? 1 : 0);
