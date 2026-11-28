// Imported files must survive a page reload: import a file, put it on the timeline, reload, export with both engines.
// Also: an edit that still points at a file lost before this fix gets a clear message and a red clip, not "Failed to fetch".
// Needs :5180 and :5181. usage: node scripts/reload-check.mjs [<video file>]
import puppeteer from "puppeteer-core";

const file = process.argv[2] ?? "public/media/clipC_vp9.webm";
const name = file.split(/[\\/]/).pop();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: "new", defaultViewport: { width: 1440, height: 1000 } });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
await page.goto("http://localhost:5180/#own", { waitUntil: "networkidle0" });
await wait(1000);
await page.evaluate(() => [...document.querySelectorAll(".bar button")].find((x) => x.textContent.trim() === "Reset").click());
await wait(400);

let failures = 0;
const check = (ok, label) => { if (!ok) failures++; console.log(`${ok ? "OK  " : "FAIL"} ${label}`); };
const run = (engine) => page.evaluate(async (engine) => { const r = await window.__poc.run(engine, true); return "error" in r ? "ERROR: " + r.error : `ok, ${r.duration.toFixed(2)} s`; }, engine);
const libNames = () => page.$$eval(".lib .lib-name", (n) => n.map((x) => x.textContent));

// import through the Library button, then "+" with the playhead at the end
const [chooser] = await Promise.all([page.waitForFileChooser({ timeout: 5000 }), page.click(".lib-import")]);
await chooser.accept([file]);
// wait for this import to finish (a file with the same name may already be listed)
for (let i = 0; i < 80 && !(await page.evaluate((n) => !!([...document.querySelectorAll(".lib.own")].find((x) => x.querySelector(".lib-name")?.textContent === n)) && !document.querySelector(".lib.pending"), name)); i++) await wait(250);
await page.evaluate((name) => { window.__poc.seek(1e9); [...document.querySelectorAll(".lib.own")].find((x) => x.querySelector(".lib-name").textContent === name).querySelector(".lib-add").click(); }, name);
await wait(800);
const src = await page.evaluate(() => window.__poc.getProject().clips.at(-1).src);
check(src.startsWith("/out/uploads/"), `imported ${name} is stored on the server: ${src}`);

await page.reload({ waitUntil: "networkidle0" });
await wait(1500);
check((await libNames()).includes(name), `after a reload the Library still lists ${name}`);
const server = await run("server");
check(server.startsWith("ok"), `after a reload, server export: ${server}`);
const mb = await run("mediabunny");
check(mb.startsWith("ok"), `after a reload, Mediabunny export: ${mb}`);

// an edit saved before the fix: a clip whose src is a blob: link from an earlier page
await page.evaluate(() => {
  const q = window.__poc.getProject();
  const c = q.clips[0];
  localStorage.setItem("poc-own-editor-draft-v1", JSON.stringify({ ...q, clips: [...q.clips, { ...c, id: "old", name: "old-import.mp4", src: "blob:http://localhost:5180/00000000-dead" }] }));
});
await page.reload({ waitUntil: "networkidle0" });
await wait(1500);
const msg = await page.evaluate(() => document.querySelector(".notice")?.textContent ?? "");
const red = await page.$$eval(".tl .clip.lost", (e) => e.length);
check(/old-import\.mp4/.test(msg) && red === 1, `a clip lost before the fix: message shown ("${msg.slice(0, 120)}..."), ${red} clip marked red`);
const blocked = await run("server");
check(/Cannot export/.test(blocked), `export of that edit stops with a reason: "${blocked.slice(0, 110)}..."`);
await page.evaluate(() => [...document.querySelectorAll(".bar button")].find((x) => x.textContent.trim() === "Reset").click());
await wait(300);
check(errors.length === 0, errors.length ? "page errors:\n  " + errors.join("\n  ") : "no page errors");
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
await browser.close();
process.exit(failures ? 1 : 0);
