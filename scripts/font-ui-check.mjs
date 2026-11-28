// The font picker, driven with real clicks and typing in headless Chrome: select the title on the timeline,
// pick a font from the list, type Hindi into the text box, and export on the server. Needs :5180 and :5181.
import puppeteer from "puppeteer-core";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: "new", defaultViewport: { width: 1440, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 200)));
await page.goto("http://localhost:5180/#own", { waitUntil: "networkidle0" });
await wait(1200);
const title = () => page.evaluate(() => window.__poc.getProject().overlays.find((o) => o.kind === "text"));

const box = await (await page.$(".tl .clip.text span")).boundingBox();
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); // select the title on the timeline
await wait(300);
const options = await page.$$eval(".form select option", (o) => o.map((x) => x.textContent));
console.log(`${options.length === 4 ? "OK  " : "FAIL"} font list shows: ${options.join(", ")}`);

await page.select(".form select", "playfair");
await wait(300);
console.log(`${(await title()).font === "playfair" ? "OK  " : "FAIL"} picked Playfair Display -> title font is "${(await title()).font}"`);

const input = await page.$(".form input:not([type])");
await input.click({ clickCount: 3 });
await page.keyboard.type("दिवाली सेल");
await wait(400);
const hint = await page.$$eval(".form .hint", (h) => h.map((x) => x.textContent).find((t) => /Hindi/.test(t)) ?? null);
console.log(`${(await title()).text === "दिवाली सेल" ? "OK  " : "FAIL"} typed Hindi -> title text is "${(await title()).text}"`);
console.log(`${hint ? "OK  " : "FAIL"} hint shown: ${hint}`);

await page.keyboard.down("Control"); await page.keyboard.press("z"); await page.keyboard.up("Control");
const r = await page.evaluate(async () => { const r = await window.__poc.run("server"); return "error" in r ? r.error : `${r.engine}, ${r.duration}s`; });
console.log(`${/Server/.test(r) ? "OK  " : "FAIL"} server export with the Hindi title: ${r}`);
console.log(errors.length ? "errors:\n  " + [...new Set(errors)].join("\n  ") : "no console errors");
await browser.close();
