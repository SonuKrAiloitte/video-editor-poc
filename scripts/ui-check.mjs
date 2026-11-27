// Headless UI checks: drives a throwaway Chrome profile over CDP through each editor's window.__poc hook.
// Needs `npm run server` and `npm run dev` running.
//   node scripts/ui-check.mjs advanced | easy | all
// Screenshots go to out/ui-check/. Files the checks upload or save are deleted afterwards (only those).
import { spawn, spawnSync } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const which = process.argv[2] ?? "all";
const APP = process.env.APP_URL ?? "http://localhost:5180";
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const outDir = path.join(repo, "out/ui-check");
mkdirSync(outDir, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const media = (name) => path.join(repo, "public/media", name);

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
};

// ---------------------------------------------------------------- browser harness
async function openBrowser() {
  const profile = mkdtempSync(path.join(outDir, "chrome-"));
  const port = 9300 + Math.floor(Math.random() * 500);
  const chrome = spawn(CHROME, [
    "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run",
    "--window-size=1440,1000", "--autoplay-policy=no-user-gesture-required", "about:blank",
  ], { stdio: "ignore" });
  let targets;
  for (let i = 0; i < 60 && !targets; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { await wait(250); }
  }
  if (!targets) throw new Error("Chrome did not start (set CHROME to its path)");
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    if (msg.method === "Runtime.exceptionThrown") errors.push("exception: " + (msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text));
    if (msg.method === "Fetch.requestPaused") {
      // simulate the render server refusing uploads
      ws.send(JSON.stringify({ id: ++id, method: "Fetch.fulfillRequest", params: {
        requestId: msg.params.requestId, responseCode: 503,
        responseHeaders: [{ name: "content-type", value: "application/json" }],
        body: Buffer.from('{"error":"server unavailable"}').toString("base64"),
      } }));
    }
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") errors.push("console.error: " + msg.params.args.map((a) => a.value ?? a.description).join(" "));
  };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(expr.slice(0, 100) + " -> " + (r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text));
    return r.result?.result?.value;
  };
  const until = async (expr, ms = 20000) => {
    for (let t = 0; t < ms; t += 200) { if (await ev(expr).catch(() => false)) return true; await wait(200); }
    throw new Error("timed out waiting for: " + expr);
  };
  const shot = async (name) => {
    const r = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(path.join(outDir, name), Buffer.from(r.result.data, "base64"));
  };
  const setFiles = async (selector, files) => {
    const { root } = (await send("DOM.getDocument")).result;
    const { nodeId } = (await send("DOM.querySelector", { nodeId: root.nodeId, selector })).result;
    if (!nodeId) throw new Error("no element for " + selector);
    await send("DOM.setFileInputFiles", { nodeId, files });
  };
  const go = async (hash, { fresh = false } = {}) => {
    await send("Page.navigate", { url: `${APP}/${hash}` });
    await until("!!window.__poc");
    if (fresh) {
      await ev("localStorage.clear()");
      await send("Page.reload");
      await wait(400);
      await until("!!window.__poc");
    }
    await wait(1200);
  };
  // click a button the way a user would: by its visible label (or aria-label), optionally inside a container
  const click = async (label, within = "body") => {
    const ok = await ev(`(() => {
      const root = document.querySelector(${JSON.stringify(within)});
      const b = root && [...root.querySelectorAll("button, [role=button], a")].find((x) =>
        (x.getAttribute("aria-label") ?? x.textContent ?? "").trim() === ${JSON.stringify(label)} && !x.disabled);
      if (b) b.click();
      return !!b;
    })()`);
    if (!ok) throw new Error(`no enabled button "${label}" in ${within}`);
    await wait(250);
  };
  const isDisabled = (label) => ev(`(() => { const b = [...document.querySelectorAll("button")].find((x) => (x.getAttribute("aria-label") ?? x.textContent ?? "").trim() === ${JSON.stringify(label)}); return b ? b.disabled : null; })()`);
  const text = () => ev("document.body.innerText");
  const failUploads = async (on) => (on ? send("Fetch.enable", { patterns: [{ urlPattern: "*/api/upload/*" }] }) : send("Fetch.disable"));
  // move a slider the way a pointer would (React listens to the input event)
  const setRange = async (selector, value) => {
    await ev(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error("no slider ${selector.replace(/"/g, "")}");
      el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, String(${value}));
      el.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await wait(150);
  };
  const reload = async () => { await send("Page.reload"); await wait(400); await until("!!window.__poc"); await wait(1200); };
  await send("Runtime.enable");
  await send("Page.enable");
  await send("DOM.enable");
  return {
    ev, until, shot, setFiles, go, reload, send, errors, click, isDisabled, text, failUploads, setRange,
    close: () => { ws.close(); chrome.kill(); setTimeout(() => rmSync(profile, { recursive: true, force: true }), 500); },
  };
}

// ---------------------------------------------------------------- comparing exported frames
/** save an export (a server /out URL or a page blob: URL) to out/ui-check/<name> */
async function saveExport(b, url, name) {
  const file = path.join(outDir, name);
  if (url.startsWith("/")) writeFileSync(file, Buffer.from(await (await fetch(APP + url)).arrayBuffer()));
  else writeFileSync(file, Buffer.from(await b.ev(`fetch(${JSON.stringify(url)}).then((r) => r.arrayBuffer()).then((a) => { let s = ""; const u = new Uint8Array(a); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); })`), "base64"));
  return file;
}
/** compare a crop of two frames: { ssim, psnr } (psnr Infinity when identical) */
function compareCrop(fileA, tA, fileB, tB, crop) {
  const run = (filter) => spawnSync(ffmpegPath, ["-hide_banner", "-ss", String(tA), "-i", fileA, "-ss", String(tB), "-i", fileB,
    "-filter_complex", `[0:v]crop=${crop}[a];[1:v]crop=${crop}[b];[a][b]${filter}`, "-frames:v", "1", "-f", "null", "-"], { encoding: "utf8" }).stderr;
  const ssim = Number(/All:([\d.]+)/.exec(run("ssim"))?.[1] ?? 0);
  const ps = /average:(inf|[\d.]+)/.exec(run("psnr"))?.[1];
  return { ssim, psnr: ps === "inf" ? Infinity : Number(ps ?? 0) };
}

// files the checks create on the server, removed at the end
const created = new Set();
const track = (src) => { if (typeof src === "string" && /^\/out\/(uploads|library)\//.test(src)) created.add(src); };
const cleanup = () => {
  for (const src of created) {
    const file = path.join(repo, src);
    if (existsSync(file)) unlinkSync(file);
  }
};

// ---------------------------------------------------------------- suites
const suites = {
  async advanced(b) {
    console.log("\n== Advanced editor (#own)");
    await b.go("#own", { fresh: true });
    // a draft saved before music pieces existed ({ music: {...} }) opens with its music as one piece
    await b.ev(`localStorage.setItem("poc-own-editor-draft-v1", JSON.stringify({ aspect: "9:16", originalVolume: 1, clips: [{ id: "c", name: "clipA_h264_16x9.mp4", src: "/media/clipA_h264_16x9.mp4", in: 0, out: 4, srcDuration: 8, muted: false, hasAudio: true, channels: 1 }], overlays: [], music: { src: "/media/music.mp3", name: "music.mp3", volume: 0.3, channels: 1 } }))`);
    await b.reload();
    const legacy = await b.ev("__poc.getProject()");
    check("an old draft's music becomes one music piece", !("music" in legacy) && legacy.audio?.length === 1 && legacy.audio[0].volume === 0.3 && legacy.audio[0].start === 0, JSON.stringify(legacy.audio ?? legacy.music).slice(0, 120));
    await b.go("#own", { fresh: true });
    const p0 = await b.ev("__poc.getProject()");
    check("the sample's music shows as a bar on the timeline", (await b.ev("document.querySelectorAll('.track[data-label=Audio] .clip.audio').length")) === 1);
    await b.ev("document.querySelector('.track[data-label=Overlay] .clip.text').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 5 })); window.dispatchEvent(new PointerEvent('pointerup', { clientX: 5 }))");
    await wait(200);
    await b.ev(`(() => { const el = document.querySelector("select[aria-label='Background']"); if (!el) throw new Error("no Background dropdown"); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(el, "solid"); el.dispatchEvent(new Event("change", { bubbles: true })); })()`).catch((e) => check("Advanced: Background dropdown exists", false, String(e.message).slice(0, 80)));
    await wait(200);
    check("Advanced: Background dropdown sets a box", (await b.ev("__poc.getProject().overlays[0].bg")) === "solid");
    await b.ev("__poc.undo()");
    check("sample edit loads", p0.clips.length === 3, `${p0.clips.length} clips`);
    const z = await b.ev("__poc.zoom()");
    check("timeline zoom fitted on open", z !== 60, `zoom ${z.toFixed(1)} px/s`);
    await b.shot("advanced-1-sample.png");

    const u0 = await b.ev("__poc.canUndo()");
    await b.ev("__poc.newProject()");
    await wait(300);
    check("new project empties timeline", (await b.ev("__poc.getProject().clips.length")) === 0);
    check("new project = exactly one undo step", (await b.ev("__poc.canUndo()")) === u0 + 1);
    await b.ev("__poc.undo()");
    await wait(200);
    check("undo restores the sample", (await b.ev("__poc.getProject().clips.length")) === 3);

    await b.setFiles("input[type=file]", [media("clipA_h264_16x9.mp4"), media("logo.png")]);
    await b.until("__poc.getProject().clips.length === 4 && __poc.getProject().overlays.length === 3", 30000);
    const p1 = await b.ev("__poc.getProject()");
    const up = p1.clips[3];
    const img = p1.overlays[2];
    track(up.src);
    track(img.src);
    check("uploaded video gets a server URL", up.src.startsWith("/out/uploads/"), up.src);
    check("uploaded image overlay is named", img.name === "logo.png", img.name);
    check("new image overlay lasts 3 s, not the whole video", Math.abs(img.end - img.start - 3) < 0.01, `${img.start.toFixed(1)}-${img.end.toFixed(1)} s`);
    check("library lists the upload", await b.ev("__poc.library().some(i => i.group === 'upload')"));
    await b.shot("advanced-2-uploaded.png");

    await b.ev(`(() => { const p = __poc.getProject(); __poc.setProject({ ...p, overlays: p.overlays.map((o, i) => i === 0 ? { ...o, font: 'pacifico' } : o) }); })()`);
    await wait(900);
    await b.reload();
    const p2 = await b.ev("__poc.getProject()");
    check("draft with an upload survives a reload", p2.clips.length === 4 && p2.clips[3].src === up.src);
    check("font choice survives a reload", p2.overlays[0].font === "pacifico");
    const notice = await b.ev("document.querySelector('.notice')?.textContent ?? ''");
    check("no 'removed items' notice for uploaded media", !notice.includes("removed"), notice.slice(0, 60));

    for (const engine of ["server", "mediabunny", "wasm"]) {
      const r = await b.ev(`__poc.run('${engine}')`);
      check(`export: ${engine}`, !r.error, r.error ? r.error.slice(0, 200) : `${r.width}x${r.height} ${r.duration.toFixed(1)} s in ${(r.ms / 1000).toFixed(2)} s`);
    }
    const before = new Set(await b.ev("__poc.library().map(i => i.src)"));
    await b.ev("__poc.save(0)");
    await b.ev("__poc.save(1)");
    await wait(800);
    const saved = (await b.ev("__poc.library().filter(i => i.group === 'export').map(i => i.src)")).filter((s) => !before.has(s));
    saved.forEach(track);
    check("two exports saved to the library", saved.length === 2, saved.join(", "));

    await b.ev("document.querySelector('.lib-list button.lib').click()");
    await b.until("__poc.getProject().clips.length === 5", 15000);
    check("saved export added back from the library", (await b.ev("__poc.getProject().clips[4].src")).startsWith("/out/library/"));
    await b.shot("advanced-3-final.png");
  },

  async layout(b) {
    console.log("\n== Layout: long titles and narrow windows");
    await b.go("#easy", { fresh: true });
    const long = "I don't know what this is but it is a very long title that would never fit on one line";
    await b.ev(`__poc.setProject({ ...__poc.getProject(), overlays: [{ id: "t", kind: "text", text: ${JSON.stringify(long)}, fontSize: 56, color: "#FFD60A", bg: "solid", bgColor: "#111111", x: 0.5, y: 0.5, start: 0, end: 10 }] })`);
    await wait(300);
    const L = await b.ev("__poc.titleLayout('t')");
    check("a long title wraps onto several lines", L.lines >= 3, `${L.lines} lines`);
    check("a wrapped title stays inside the frame", L.left >= 0 && L.right <= L.W, `${L.left.toFixed(0)}..${L.right.toFixed(0)} of ${L.W}`);
    await b.ev(`__poc.setProject({ ...__poc.getProject(), overlays: [{ id: "t", kind: "text", text: "Supercalifragilisticexpialidocious-and-even-longer-without-spaces", fontSize: 80, color: "#FFFFFF", x: 0.5, y: 0.5, start: 0, end: 10 }] })`);
    await wait(300);
    const L2 = await b.ev("__poc.titleLayout('t')");
    check("one very long word is broken to fit", L2.left >= 0 && L2.right <= L2.W && L2.lines >= 2, `${L2.lines} lines, ${L2.left.toFixed(0)}..${L2.right.toFixed(0)} of ${L2.W}`);
    await b.shot("layout-1-long-title.png");
    // narrow windows: the option sheets must fit, never scroll sideways
    for (const width of [1024, 720, 560]) {
      await b.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await wait(300);
      await b.ev("__poc.select('overlay', 't')");
      await wait(200);
      await b.click("Style", ".e-toolbar");
      const fit = await b.ev("(() => { const s = document.querySelector('.sheet'); const r = s.getBoundingClientRect(); return { sw: s.scrollWidth, cw: s.clientWidth, left: r.left, right: r.right, vw: innerWidth }; })()");
      check(`at ${width}px the Style sheet fits the window`, fit.sw <= fit.cw + 1 && fit.left >= 0 && fit.right <= fit.vw + 1, JSON.stringify(fit));
      await b.shot(`layout-2-style-${width}.png`);
      await b.click("Done", ".sheet");
      const tb = await b.ev("(() => { const t = document.querySelector('.e-toolbar'); return { sw: t.scrollWidth, cw: t.clientWidth }; })()");
      check(`at ${width}px the toolbar fits the window`, tb.sw <= tb.cw + 1, JSON.stringify(tb));
    }
    await b.send("Emulation.clearDeviceMetricsOverride");
  },

  async easy(b) {
    console.log("\n== Easy editor (#easy)");
    // --- Task 3: shell
    await b.go("", { fresh: true });
    check("easy editor is the default screen", (await b.ev("__poc.screen")) === "easy");
    check("sample edit loads on the easy screen", (await b.ev("__poc.getProject().clips.length")) === 3);
    await b.shot("easy-1-sample.png");

    await b.click("New post");
    check("empty post shows 'Add your first video'", (await b.text()).includes("Add your first video"));
    check("Export is disabled with no video", (await b.isDisabled("Export")) === true);
    await b.shot("easy-2-empty.png");
    await b.click("Undo");
    check("undo brings the sample back", (await b.ev("__poc.getProject().clips.length")) === 3);

    await b.click("Format");
    check("format sheet opens", (await b.ev("__poc.sheet()")) === "format");
    await b.click("YouTube", ".sheet");
    check("choosing YouTube makes the post 16:9", (await b.ev("__poc.getProject().aspect")) === "16:9");
    await b.click("Undo");
    check("undo returns to 9:16", (await b.ev("__poc.getProject().aspect")) === "9:16");

    await b.click("Square", ".sheet");
    const before = await b.ev("JSON.stringify(__poc.getProject())");
    const depth = await b.ev("__poc.canUndo()");
    check("an edit leaves undo history to carry over", depth >= 1, `depth ${depth}`);
    await b.go("#own");
    await b.go("#easy");
    check("switching to Advanced and back keeps the edit", (await b.ev("JSON.stringify(__poc.getProject())")) === before);
    check("switching to Advanced and back keeps undo history", (await b.ev("__poc.canUndo()")) === depth, `depth ${depth}`);
    await b.click("Undo");
    check("undo still works after switching screens", (await b.ev("__poc.getProject().aspect")) === "9:16");

    // --- Task 4: filmstrip timeline under a fixed centre playhead
    await b.click("Done", ".sheet").catch(() => undefined);
    await b.ev("__poc.seek(5)");
    await wait(400);
    const tl = await b.ev("__poc.timeline()");
    check("timeline scrolls so the playhead sits at 5 s", Math.abs(tl.scrollLeft - 5 * tl.pps) <= 2, `scrollLeft ${tl.scrollLeft}, ${tl.pps} px/s`);
    await b.until("__poc.timeline().thumbs > 0", 20000);
    await wait(1500);
    const thumbs = (await b.ev("__poc.timeline()")).thumbs;
    check("clips show frame thumbnails (6 to 40 for the sample)", thumbs >= 6 && thumbs <= 40, `${thumbs} thumbnails`);
    await b.ev("document.querySelector('.e-clip').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 10 })); window.dispatchEvent(new PointerEvent('pointerup', { clientX: 10 }))");
    await wait(300);
    check("selecting a clip shows the clip tools", (await b.ev("__poc.toolbar()")) === "clip");
    await b.ev("document.querySelector('.e-scroll').scrollLeft = 2 * __poc.timeline().pps");
    await wait(400);
    check("scrolling the timeline moves the playhead", Math.abs((await b.ev("__poc.time()")) - 2) < 0.05, `t = ${(await b.ev("__poc.time()")).toFixed(2)} s`);
    await b.shot("easy-3-timeline.png");

    // --- Task 5: context toolbars and sheets
    const P = "__poc.getProject()";
    await b.ev("__poc.select(null)");
    await wait(200);
    await b.click("Add video", ".e-toolbar");
    check("Add video opens the media sheet", (await b.ev("__poc.sheet()")) === "media-video");
    await b.setFiles(".sheet input[type=file]", [media("clipA_h264_16x9.mp4")]);
    await b.until(`${P}.clips.length === 4`, 30000);
    const added = await b.ev(`${P}.clips[3]`);
    track(added.src);
    check("uploaded video lands on the timeline with a lasting URL", added.src.startsWith("/out/uploads/"), added.src);
    check("the new clip is selected, with clip tools", (await b.ev("__poc.toolbar()")) === "clip");
    check("the media sheet closes after adding", (await b.ev("__poc.sheet()")) === null);

    const startOf = await b.ev(`${P}.clips.slice(0, 3).reduce((s, c) => s + c.out - c.in, 0)`);
    await b.ev(`__poc.seek(${startOf + 1})`);
    await wait(200);
    await b.click("Split", ".e-toolbar");
    check("Split cuts the clip at the playhead", (await b.ev(`${P}.clips.length`)) === 5);
    await b.click("Mute", ".e-toolbar");
    check("Mute silences the selected clip", (await b.ev(`${P}.clips.find((c) => c.id === __poc.selected()).muted`)) === true);
    await b.click("Delete", ".e-toolbar");
    check("Delete removes the selected clip", (await b.ev(`${P}.clips.length`)) === 4);
    check("after Delete the main tools come back", (await b.ev("__poc.toolbar()")) === "main");

    await b.click("Text", ".e-toolbar");
    const txt = await b.ev(`${P}.overlays.at(-1)`);
    const total = await b.ev(`${P}.clips.reduce((s, c) => s + c.out - c.in, 0)`);
    check("Text adds a title for the whole video", txt.kind === "text" && txt.start === 0 && Math.abs(txt.end - total) < 0.01, `${txt.start}-${txt.end} of ${total.toFixed(1)} s`);
    check("Text opens the typing sheet", (await b.ev("__poc.sheet()")) === "text");
    await b.ev(`(() => { const el = document.querySelector(".sheet textarea"); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, "Big Sale"); el.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    await wait(150);
    check("typing changes the title", (await b.ev(`${P}.overlays.at(-1).text`)) === "Big Sale");
    await b.click("Done", ".sheet");
    await b.click("Font", ".e-toolbar");
    await b.click("Bebas Neue", ".sheet");
    check("choosing a font", (await b.ev(`${P}.overlays.at(-1).font`)) === "bebas");
    await b.click("Done", ".sheet");
    await b.click("Colour", ".e-toolbar");
    await b.click("Yellow", ".sheet");
    check("choosing a colour", (await b.ev(`${P}.overlays.at(-1).color`)) === "#FFD60A");
    await b.click("Done", ".sheet");
    await b.click("Size", ".e-toolbar");
    await b.setRange(".sheet input[type=range]", 72);
    check("size slider", (await b.ev(`${P}.overlays.at(-1).fontSize`)) === 72);
    await b.click("Done", ".sheet");
    await b.click("Position", ".e-toolbar");
    await b.click("Bottom", ".sheet");
    check("position: Bottom", (await b.ev(`${P}.overlays.at(-1).y`)) === 0.85);
    await b.click("Done", ".sheet");
    await b.shot("easy-4-text.png");
    const depthBefore = await b.ev("__poc.canUndo()");
    await b.click("Undo");
    check("undo steps back one change at a time", (await b.ev(`${P}.overlays.at(-1).y`)) !== 0.85 && (await b.ev("__poc.canUndo()")) === depthBefore - 1);
    await b.click("Redo");
    await b.click("Done", ".e-toolbar");

    await b.click("Logo", ".e-toolbar");
    await b.setFiles(".sheet input[type=file]", [media("logo.png")]);
    await b.until(`${P}.overlays.length === 4`, 20000);
    const logo = await b.ev(`${P}.overlays.at(-1)`);
    track(logo.src);
    check("logo is named and lasts the whole video", logo.name === "logo.png" && logo.start === 0 && Math.abs(logo.end - total) < 0.01);
    check("logo tools are shown", (await b.ev("__poc.toolbar()")) === "logo");
    await b.click("Position", ".e-toolbar");
    await b.click("Top right", ".sheet");
    const lp = await b.ev(`${P}.overlays.at(-1)`);
    check("logo position: Top right stays inside the frame", lp.x + lp.width / 2 <= 1 && lp.x > 0.5 && lp.y < 0.5, `x ${lp.x.toFixed(3)} y ${lp.y.toFixed(3)}`);
    await b.click("Done", ".sheet");
    await b.click("Delete", ".e-toolbar");
    check("deleting the logo returns to the main tools", (await b.ev("__poc.toolbar()")) === "main" && (await b.ev(`${P}.overlays.length`)) === 3);

    await b.ev("document.querySelector('.e-bar.music').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 5 })); window.dispatchEvent(new PointerEvent('pointerup', { clientX: 5 }))");
    await wait(200);
    check("selecting the music shows music tools", (await b.ev("__poc.toolbar()")) === "music");
    await b.click("Volume", ".e-toolbar");
    await b.setRange(".sheet input[aria-label='This song']", 0.8);
    await b.setRange(".sheet input[aria-label='Video sound']", 0.5);
    const vol = await b.ev(`[${P}.audio[0].volume, ${P}.originalVolume]`);
    check("music and video sound sliders", vol[0] === 0.8 && vol[1] === 0.5, vol.join(", "));
    await b.click("Done", ".sheet");
    await b.click("Done", ".e-toolbar");

    await b.failUploads(true);
    await b.click("Add video", ".e-toolbar");
    await b.setFiles(".sheet input[type=file]", [media("clipB_h264_9x16.mp4")]);
    await b.until(`${P}.clips.length === 5`, 30000);
    await b.failUploads(false);
    check("if the upload fails, the user is told in plain words", (await b.text()).includes("will disappear if you reload the page"));
    await b.click("Undo");
    check("no technical words on the easy screen", !/codec|ffmpeg|mediabunny|wasm|h264|render server|upload(ed)? \(|server unavailable/i.test((await b.ev("document.querySelector('.easy').innerText")).replace(/clip[A-D]_\S+/g, "")));

    // --- Task 6: export sheet
    await b.click("Export", ".e-top");
    check("Export opens the export sheet", (await b.ev("__poc.sheet()")) === "export");
    check("export sheet has no technical words until asked", !/ffmpeg|mediabunny|wasm|codec/i.test(await b.ev("document.querySelector('.sheet').innerText")));
    await b.click("High (1080p)", ".sheet");
    await b.click("Export video", ".sheet");
    await b.until("__poc.results().length === 1", 120000);
    const r1 = await b.ev("__poc.results()[0]");
    check("High quality export is 1080 wide for a Reel", !r1.error && r1.width === 1080 && r1.height === 1920, r1.error ?? `${r1.width}x${r1.height}, ${(r1.ms / 1000).toFixed(2)} s`);
    check("the finished video is shown with a player", await b.ev("!!document.querySelector('.sheet video')"));
    const libBefore = new Set(await b.ev("__poc.library().map((i) => i.src)"));
    await b.click("Save to my media", ".sheet");
    await b.until("document.querySelector('.sheet').innerText.includes('Saved to My media')", 20000);
    await wait(500);
    const newExports = (await b.ev("__poc.library().filter((i) => i.group === 'export').map((i) => i.src)")).filter((x) => !libBefore.has(x));
    newExports.forEach(track);
    check("Save to my media adds it to the library", newExports.length === 1, newExports.join(", "));
    await b.shot("easy-5-exported.png");

    await b.click("Technical details", ".sheet");
    await b.click("Browser (Mediabunny)", ".sheet");
    await b.click("Standard (720p)", ".sheet");
    await b.click("Export video", ".sheet");
    await b.until("__poc.results().length === 2", 120000);
    const r2 = await b.ev("__poc.results()[1]");
    check("Technical details: in-browser export works", !r2.error && r2.width === 720, r2.error ?? `${r2.width}x${r2.height}, ${(r2.ms / 1000).toFixed(2)} s`);
    await b.click("Done", ".sheet");
    check("closing the export sheet", (await b.ev("__poc.sheet()")) === null);

    // --- final review fixes
    const playLabel = () => b.ev("document.querySelector('.e-play').getAttribute('aria-label')");
    // I1: Play at the end starts again from the beginning
    const end = await b.ev(`${P}.clips.reduce((s, c) => s + c.out - c.in, 0)`);
    await b.ev(`__poc.seek(${end})`);
    await wait(200);
    await b.click("Play", ".e-transport");
    await wait(700);
    const tAfter = await b.ev("__poc.time()");
    check("I1: Play at the end restarts from the beginning", tAfter > 0.1 && tAfter < 3 && (await playLabel()) === "Pause", `t = ${tAfter.toFixed(2)} s`);
    // M1: the user scrolling while playing takes over (pauses)
    await b.ev("document.querySelector('.e-scroll').dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }))");
    await wait(300);
    check("M1: scrolling during playback pauses it", (await playLabel()) === "Play");
    // I3: a plain mouse wheel scrubs; clicking the ruler jumps there
    await b.ev("__poc.seek(1)");
    await wait(300);
    const pps = (await b.ev("__poc.timeline()")).pps;
    await b.ev("document.querySelector('.e-scroll').dispatchEvent(new WheelEvent('wheel', { deltaY: 160, bubbles: true, cancelable: true }))");
    await wait(300);
    const tw = await b.ev("__poc.time()");
    check("I3: mouse wheel moves the playhead", Math.abs(tw - (1 + 160 / pps)) < 0.1, `t = ${tw.toFixed(2)} s`);
    await b.ev(`(() => {
      const sc = document.querySelector('.e-scroll'), area = document.querySelector('.e-area'), ruler = document.querySelector('.e-ruler');
      const x = area.getBoundingClientRect().left + sc.clientWidth / 2 + 3 * ${pps};
      ruler.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x }));
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: x }));
    })()`);
    await wait(300);
    const tr = await b.ev("__poc.time()");
    check("I3: clicking the ruler jumps the playhead there", Math.abs(tr - 3) < 0.1, `t = ${tr.toFixed(2)} s`);
    // I2: dragging a trim handle does not queue a thumbnail job per pixel
    await b.ev("document.querySelector('.e-clip').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 10 })); window.dispatchEvent(new PointerEvent('pointerup', { clientX: 10 }))");
    await wait(300);
    const jobs0 = await b.ev("__poc.thumbJobs()");
    await b.ev(`(() => {
      const hdl = document.querySelector('.e-clip.sel .e-handle.r');
      const x0 = hdl.getBoundingClientRect().left;
      hdl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x0 }));
      return new Promise((done) => {
        let k = 0;
        const id = setInterval(() => {
          k++;
          window.dispatchEvent(new PointerEvent('pointermove', { clientX: x0 - 8 * k }));
          if (k === 20) { clearInterval(id); window.dispatchEvent(new PointerEvent('pointerup', { clientX: x0 - 160 })); done(true); }
        }, 30);
      });
    })()`);
    await wait(1500);
    const jobs = (await b.ev("__poc.thumbJobs()")) - jobs0;
    check("I2: a trim drag queues at most a couple of thumbnail jobs", jobs <= 2, `${jobs} jobs`);
    await b.click("Undo");
    // M3: an export survives Escape and a second click on Export
    await b.click("Export", ".e-top");
    await b.click("Standard (720p)", ".sheet");
    const n0 = await b.ev("__poc.results().length");
    await b.click("Export video", ".sheet");
    await b.ev("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await b.ev("document.querySelector('.e-top .e-export').click()");
    await wait(200);
    check("M3: the export sheet stays open while exporting", (await b.ev("__poc.sheet()")) === "export");
    await b.until(`__poc.results().length === ${n0 + 1}`, 120000);
    check("M3: the finished export is still shown", await b.ev("!!document.querySelector('.sheet video')"));
    await b.click("Done", ".sheet");
    // M9: the server refuses files that are not video, audio or pictures
    const st = await b.ev("fetch('/api/upload/evil.html', { method: 'PUT', body: '<script>alert(1)</script>' }).then((r) => r.status)");
    check("M9: uploading a web page is refused", st === 415, `status ${st}`);

    // --- photos as clips, and music pieces
    const A = "__poc.getProject().audio";
    const runExport = async (engineLabel) => {
      await b.click("Export", ".e-top");
      if (engineLabel) {
        await b.click("Technical details", ".sheet");
        await b.click(engineLabel, ".sheet");
      }
      await b.click("Standard (720p)", ".sheet");
      const n = await b.ev("__poc.results().length");
      await b.click("Export video", ".sheet");
      await b.until(`__poc.results().length === ${n + 1}`, 120000);
      const r = await b.ev(`__poc.results()[${n}]`);
      await b.click("Done", ".sheet");
      return r;
    };
    await b.click("New post");
    await b.click("Add video", ".e-toolbar");
    check("the Add video sheet also offers photos", (await b.ev("document.querySelector('.sheet').innerText")).includes("photo"));
    await b.setFiles(".sheet input[type=file]", [media("logo.png")]);
    await b.until(`${P}.clips.length === 1`, 20000);
    const ph = await b.ev(`${P}.clips[0]`);
    track(ph.src);
    check("an uploaded photo becomes a 5-second clip", ph.kind === "image" && ph.out - ph.in === 5 && ph.src.startsWith("/out/uploads/"), `${ph.kind}, ${ph.out - ph.in} s`);
    check("photo clips have no Mute button", (await b.isDisabled("Mute")) === null);
    await b.click("Length", ".e-toolbar");
    await b.click("3 seconds", ".sheet");
    check("Length: 3 seconds", (await b.ev(`${P}.clips[0].out - ${P}.clips[0].in`)) === 3);
    await b.click("Done", ".sheet");
    await b.click("Done", ".e-toolbar");
    await b.click("Add video", ".e-toolbar");
    await b.click("logo.png", ".sheet");
    await b.until(`${P}.clips.length === 2`, 20000);
    check("a photo from My media becomes a clip too", (await b.ev(`${P}.clips[1].kind`)) === "image");
    await b.click("Done", ".e-toolbar");
    await wait(600);
    await b.shot("easy-6-photos.png");
    const rp = await runExport();
    check("a photo-only story exports (server)", !rp.error && Math.abs(rp.duration - 8) < 0.05, rp.error ?? `${rp.duration} s`);
    const rpm = await runExport("Browser (Mediabunny)");
    check("a photo-only story exports (in the browser)", !rpm.error && Math.abs(rpm.duration - 8) < 0.05, rpm.error ?? `${rpm.duration} s`);
    await b.click("Technical details", ".e-top").catch(() => undefined);

    await b.ev("__poc.seek(0)");
    await b.click("Music", ".e-toolbar");
    await b.click("music.mp3", ".sheet");
    await b.until(`${A}.length === 1`, 20000);
    const m1 = await b.ev(`${A}[0]`);
    check("music starts at the playhead and fits the video", m1.start === 0 && m1.in === 0 && m1.out === 8, `start ${m1.start}, ${m1.in}-${m1.out}`);
    check("new music is selected with music tools", (await b.ev("__poc.toolbar()")) === "music");
    await b.click("Done", ".e-toolbar");
    await b.ev("__poc.seek(4)");
    await wait(200);
    await b.click("Music", ".e-toolbar");
    await b.click("music.mp3", ".sheet");
    await b.until(`${A}.length === 2`, 20000);
    const m2 = await b.ev(`${A}[1]`);
    check("a second piece goes at the playhead, trimmed to the video's end", Math.abs(m2.start - 4) < 0.05 && Math.abs(m2.out - m2.in - 4) < 0.05, `start ${m2.start}, ${m2.in}-${m2.out}`);
    check("both pieces show on the timeline", (await b.ev("document.querySelectorAll('.e-bar.music').length")) === 2);

    const pps2 = (await b.ev("__poc.timeline()")).pps;
    const dragBy = (selector, dx) => b.ev(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      const r = el.getBoundingClientRect(), x0 = r.left + r.width / 2, y = r.top + r.height / 2;
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x0, clientY: y }));
      for (let k = 1; k <= 10; k++) window.dispatchEvent(new PointerEvent('pointermove', { clientX: x0 + (${dx} * k) / 10, clientY: y }));
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: x0 + ${dx}, clientY: y }));
    })()`);
    await dragBy(".e-bar.music.sel .e-handle.r", -pps2);
    await wait(200);
    const m2t = await b.ev(`${A}[1]`);
    check("dragging the end handle keeps less of the song", Math.abs(m2t.out - m2t.in - 3) < 0.15, `${(m2t.out - m2t.in).toFixed(2)} s`);
    await b.ev("__poc.seek(5)");
    await wait(200);
    await b.click("Split", ".e-toolbar");
    check("Split cuts the selected music at the playhead", (await b.ev(`${A}.length`)) === 3);
    await b.click("Volume", ".e-toolbar");
    await b.setRange(".sheet input[aria-label='This song']", 0.9);
    const vols = await b.ev(`${A}.map((a) => a.volume)`);
    check("Volume changes only the selected piece", vols.filter((v) => v === 0.9).length === 1, vols.join(", "));
    await b.click("Done", ".sheet");
    await b.click("Delete", ".e-toolbar");
    check("Delete removes the selected piece", (await b.ev(`${A}.length`)) === 2 && (await b.ev("__poc.toolbar()")) === "main");
    const s0 = await b.ev(`${A}[0].start`);
    await dragBy(".e-bar.music", pps2);
    await wait(200);
    const s1 = await b.ev(`${A}[0].start`);
    check("dragging a piece moves where it starts", Math.abs(s1 - s0 - 1) < 0.15, `${s0} -> ${s1.toFixed(2)}`);
    await b.shot("easy-7-music.png");
    const rm = await runExport();
    check("an edit with several music pieces exports", !rm.error, rm.error ?? `${rm.duration} s`);

    // --- Instagram-style text: background, align, effect, several lines
    await b.click("New post");
    await b.click("or try the sample post");
    await wait(500);
    await b.click("Text", ".e-toolbar");
    await b.ev(`(() => { const el = document.querySelector(".sheet textarea"); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, "BIG SALE\\nToday only"); el.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    await wait(150);
    check("the text box takes several lines", (await b.ev(`${P}.overlays.at(-1).text`)) === "BIG SALE\nToday only");
    await b.click("Done", ".sheet");
    await b.click("Style", ".e-toolbar");
    check("Style opens the style sheet", (await b.ev("__poc.sheet()")) === "style");
    await b.click("Solid", ".sheet");
    check("Background: Solid", (await b.ev(`${P}.overlays.at(-1).bg`)) === "solid");
    await b.click("Box Yellow", ".sheet");
    const styled = await b.ev(`${P}.overlays.at(-1)`);
    check("a light box colour turns the text dark", styled.bgColor === "#FFD60A" && styled.color === "#111111", `${styled.bgColor} / ${styled.color}`);
    await b.click("See-through", ".sheet");
    check("Background: See-through", (await b.ev(`${P}.overlays.at(-1).bg`)) === "soft");
    await b.click("Right", ".sheet");
    check("Align: Right", (await b.ev(`${P}.overlays.at(-1).align`)) === "right");
    await b.click("Neon", ".sheet");
    check("Effect: Neon", (await b.ev(`${P}.overlays.at(-1).effect`)) === "neon");
    await b.click("Undo");
    check("undo takes back one style change", (await b.ev(`${P}.overlays.at(-1).effect ?? "none"`)) === "none" && (await b.ev(`${P}.overlays.at(-1).align`)) === "right");
    await b.click("Done", ".sheet");
    await wait(400);
    await b.shot("easy-8-text-style.png");

    // the preview, the browser export and the server export draw titles the same way
    // titles over a moving video (for the see-through check) or over a still photo (so a parity check compares
    // only the titles: the two encoders pick slightly different frames of a fast-moving background)
    const MOVING = { id: "c", name: "clipC_vp9.webm", src: "/media/clipC_vp9.webm", in: 0, out: 4, srcDuration: 5, muted: false, hasAudio: true, channels: 1 };
    const STILL = { id: "c", kind: "image", name: "logo.png", src: "/media/logo.png", in: 0, out: 4, srcDuration: 60, muted: false, hasAudio: false };
    const textProject = (title, clip = MOVING) => `__poc.setProject({ aspect: "9:16", originalVolume: 1, audio: [],
      clips: [${JSON.stringify(clip)}], overlays: ${JSON.stringify(title)} })`;
    await b.ev(textProject([
      { id: "t1", kind: "text", text: "BIG SALE\nToday only", fontSize: 54, color: "#FFFFFF", font: "bebas", bg: "solid", bgColor: "#FF4D8D", align: "left", effect: "outline", x: 0.5, y: 0.3, start: 0, end: 4 },
      { id: "t2", kind: "text", text: "Neon nights", fontSize: 60, color: "#2F80FF", font: "pacifico", effect: "neon", x: 0.5, y: 0.7, start: 0, end: 4 },
    ], STILL));
    await wait(400);
    const rs = await runExport();
    const rb = await runExport("Browser (Mediabunny)");
    if (rs.error || rb.error) check("styled titles export", false, rs.error ?? rb.error);
    else {
      const fs = await saveExport(b, rs.url, "text-server.mp4");
      const fb = await saveExport(b, rb.url, "text-browser.mp4");
      const top = compareCrop(fs, 1, fb, 1, "720:200:0:284");
      const bottom = compareCrop(fs, 1, fb, 1, "720:200:0:796");
      check("server and browser draw the boxed title the same", top.ssim >= 0.95, `SSIM ${top.ssim.toFixed(3)}`);
      check("server and browser draw the neon title the same", bottom.ssim >= 0.95, `SSIM ${bottom.ssim.toFixed(3)}`);
      // a solid box hides the moving video behind it; a see-through one lets it show
      const spaces = (bg) => [{ id: "t", kind: "text", text: "            ", fontSize: 90, color: "#FFFFFF", bg, bgColor: "#000000", x: 0.5, y: 0.3, start: 0, end: 4 }];
      await b.ev(textProject(spaces("solid")));
      const solid = await saveExport(b, (await runExport()).url, "text-solid.mp4");
      await b.ev(textProject(spaces("soft")));
      const soft = await saveExport(b, (await runExport()).url, "text-soft.mp4");
      const crop = "24:12:348:378";
      const sSolid = compareCrop(solid, 0.5, solid, 3, crop);
      const sSoft = compareCrop(soft, 0.5, soft, 3, crop);
      check("a solid box hides the video behind it", sSolid.psnr >= 45, `PSNR ${sSolid.psnr}`);
      check("a see-through box lets the video show", sSoft.psnr < 40, `PSNR ${sSoft.psnr}`);
      check("title pictures never show up in My media", !(await b.ev("__poc.library().some((i) => /title|render-assets/.test(i.src))")));
    }
  },
};

// ---------------------------------------------------------------- run
const names = which === "all" ? Object.keys(suites) : [which];
const b = await openBrowser();
try {
  for (const n of names) {
    if (!suites[n]) throw new Error(`unknown suite "${n}" (advanced | easy | all)`);
    b.errors.length = 0;
    try {
      await suites[n](b);
    } catch (e) {
      check(`${n}: suite ran to the end`, false, String(e.message ?? e).slice(0, 300));
    }
    check(`${n}: no page errors`, b.errors.length === 0, b.errors.join(" | ").slice(0, 400));
  }
} finally {
  b.close();
  cleanup();
}
console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
