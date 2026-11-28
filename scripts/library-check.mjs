// Library and timeline stay in step, and an export can be played, with the mouse in Chrome:
// "Added" on items used on the timeline, removing an imported file turns its clips red and stops export,
// importing it again relinks them, and "Play" on an export result plays it. Needs :5180 and :5181.
// usage: node scripts/library-check.mjs [<video file>]
import puppeteer from "puppeteer-core";

const file = process.argv[2] ?? "public/media/clipD_hevc.mov";
const name = file.split(/[\\/]/).pop();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: "new", defaultViewport: { width: 1440, height: 1000 } });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
const dialogs = [];
page.on("dialog", (d) => (dialogs.push(d.message()), d.accept()));
await page.goto("http://localhost:5180/#own", { waitUntil: "networkidle0" });
await wait(1000);
await page.evaluate(() => [...document.querySelectorAll(".bar button")].find((x) => x.textContent.trim() === "Reset").click());
await wait(400);

let failures = 0;
const check = (ok, label) => { if (!ok) failures++; console.log(`${ok ? "OK  " : "FAIL"} ${label}`); };
const notice = () => page.evaluate(() => document.querySelector(".notice span")?.textContent ?? "");
const own = (sel) => page.evaluate((name, sel) => { const el = [...document.querySelectorAll(".lib.own")].find((x) => x.querySelector(".lib-name").textContent === name); return el ? (sel ? !!el.querySelector(sel) : true) : null; }, name, sel);
const red = () => page.$$eval(".tl .clip.lost", (e) => e.length);
const importIt = async () => {
  const [chooser] = await Promise.all([page.waitForFileChooser({ timeout: 5000 }), page.click(".lib-import")]);
  await chooser.accept([file]);
  await wait(300);
  for (let i = 0; i < 80 && !(await page.evaluate((n) => !!([...document.querySelectorAll(".lib.own")].find((x) => x.querySelector(".lib-name")?.textContent === n)) && !document.querySelector(".lib.pending"), name)); i++) await wait(250);
};

// 1. import: in the Library, not yet "Added"
await importIt();
check((await own()) === true && (await own(".added")) === false, `imported ${name}: listed in the Library, no "Added" mark yet`);
// 2. "+" puts it on the timeline: the item now says "Added"
await page.evaluate((name) => { window.__poc.seek(1e9); [...document.querySelectorAll(".lib.own")].find((x) => x.querySelector(".lib-name").textContent === name).querySelector(".lib-add").click(); }, name);
await wait(800);
check((await own(".added")) === true, `after "+", the Library item shows "Added"`);
const builtInAdded = await page.$$eval(".lib:not(.own) .added", (e) => e.length);
check(builtInAdded === 4, `built-in files used by the sample edit also show "Added": ${builtInAdded} (clipA, clipB, clipC and the logo)`);

// 3. remove it from the Library: asked first, then its clip turns red and export stops
await page.evaluate((name) => [...document.querySelectorAll(".lib.own")].find((x) => x.querySelector(".lib-name").textContent === name).querySelector(".lib-remove").click(), name);
await wait(500);
check(dialogs.length === 1 && (await own()) === null && (await red()) === 1, `remove: asked first ("${(dialogs[0] ?? "").slice(0, 60)}..."), gone from the Library, ${await red()} clip red`);
const blocked = await page.evaluate(async () => { const r = await window.__poc.run("server"); return "error" in r ? r.error : "exported"; });
check(/Cannot export/.test(blocked), `export stops with: "${blocked.slice(0, 100)}..."`);

// 4. import the same file again: the red clip is relinked
await importIt();
check((await red()) === 0 && /back in the Library/.test(await notice()) && (await own(".added")) === true, `imported again: "${await notice()}"; red clips now ${await red()}`);

// 5. export, then "Play" on the result plays it
const r = await page.evaluate(async () => { const r = await window.__poc.run("server"); return "error" in r ? r.error : r.duration; });
check(typeof r === "number", `server export after relinking: ${typeof r === "number" ? r.toFixed(2) + " s" : r}`);
await page.evaluate(() => [...document.querySelectorAll(".results button")].filter((b) => b.textContent === "Play").pop().click());
await wait(1500);
const v = await page.evaluate(() => { const v = document.querySelector(".result-video"); return { paused: v.paused, t: +v.currentTime.toFixed(2) }; });
check(!v.paused && v.t > 0.5, `"Play" on the result starts the video (playing: ${!v.paused}, at ${v.t} s)`);

// leave the Library as it was
await page.evaluate((name) => [...document.querySelectorAll(".lib.own")].filter((x) => x.querySelector(".lib-name").textContent === name).forEach((x) => x.querySelector(".lib-remove").click()), name);
await page.evaluate(() => [...document.querySelectorAll(".bar button")].find((x) => x.textContent.trim() === "Reset").click());
check(errors.length === 0, errors.length ? "page errors:\n  " + errors.join("\n  ") : "no page errors");
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
await browser.close();
process.exit(failures ? 1 : 0);
