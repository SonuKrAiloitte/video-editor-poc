// Clicks through the toolbar in headless Chrome: split, add text, Reset, Undo. Needs the dev server running.
import puppeteer from "puppeteer-core";
const b = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: "new" });
const p = await b.newPage(); await p.setViewport({ width: 1440, height: 900 });
const errors = []; p.on("pageerror", (e) => errors.push(String(e))); p.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await p.goto("http://localhost:5180/#own", { waitUntil: "networkidle0" });
await new Promise((r) => setTimeout(r, 1200));
const click = async (label) => { const h = await p.evaluateHandle((l) => [...document.querySelectorAll(".bar button")].find((x) => x.textContent.trim() === l), label); await h.click(); await new Promise((r) => setTimeout(r, 250)); };
const state = () => p.evaluate(() => { const q = window.__poc.getProject(); return { clips: q.clips.length, overlays: q.overlays.length, time: document.querySelector(".bar .time").textContent }; });
const out = {};
await p.evaluate(() => window.__poc.seek(2)); await click("Split at playhead"); await click("+ Text"); out.edited = await state();
await click("Reset"); out.afterReset = await state();
await click("Undo"); out.afterUndo = await state();
await click("Reset"); out.resetAgain = await state();
console.log(JSON.stringify({ ...out, errors }));
await b.close();
