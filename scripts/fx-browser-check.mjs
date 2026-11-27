// Transitions and effects end to end in Chrome:
//  1. the UI: the + between two clips, the Transitions tab, the Inspector (type, length, remove), Delete, the Effects tab
//  2. every transition: the preview at 30 %, 50 % and 80 % through it against the server (FFmpeg) export at the same
//     moment, and the sound crossfading (test tones: clip A 440 Hz, clip B 660 Hz)
//  3. every effect: the preview against the server export in the middle of the effect
// Writes out/fx-check-transitions.png and out/fx-check-effects.png (preview on top, export below). Needs :5180, :5181.
import puppeteer from "puppeteer-core";
import ffmpegPath from "ffmpeg-static";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { EFFECTS, TRANSITIONS } from "../shared/fx.js";

const only = process.argv[2]; // optional: one transition or effect id
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: "new", defaultViewport: { width: 1440, height: 1000 }, protocolTimeout: 600_000, args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 200)));
await page.goto((process.env.BASE ?? "http://localhost:5180") + "/#own", { waitUntil: "networkidle0" });
await wait(800);
let failures = 0;
const check = (ok, label) => { if (!ok) failures++; console.log(`${ok ? "OK  " : "FAIL"} ${label}`); };
const proj = () => page.evaluate(() => window.__poc.getProject());
const clip = (id, name, inT, out, extra = {}) => ({ id, kind: "video", name, src: `/media/${name}`, in: inT, out, srcDuration: 8, muted: false, hasAudio: true, channels: 1, ...extra });
const three = (transition) => ({
  aspect: "9:16", originalVolume: 1, tracks: [], overlays: [], audios: [],
  clips: [clip("a", "clipA_h264_16x9.mp4", 0, 3), clip("b", "clipB_h264_9x16.mp4", 0, 3, transition ? { transition } : {}), clip("c", "clipC_vp9.webm", 0, 2)],
});
const setRange = (labelStart, value) => page.evaluate((labelStart, value) => {
  const r = [...document.querySelectorAll(".form label")].find((l) => l.textContent.trim().startsWith(labelStart)).querySelector("input");
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(r, String(value));
  r.dispatchEvent(new Event("input", { bubbles: true }));
}, labelStart, value);
const ssim = (a, b) => +(/All:([\d.]+)/.exec(spawnSync(ffmpegPath, ["-hide_banner", "-i", a, "-i", b, "-lavfi", "[1:v][0:v]scale2ref[p][v];[v][p]ssim", "-f", "null", "-"], { encoding: "utf8" }).stderr)?.[1] ?? 0);
/** the same frames compared at a small size: for film grain, whose random pattern differs by design */
const ssimSmall = (a, b) => +(/All:([\d.]+)/.exec(spawnSync(ffmpegPath, ["-hide_banner", "-i", a, "-i", b, "-lavfi", "[0:v]scale=90:-2[x];[1:v]scale=90:-2[y];[x][y]ssim", "-f", "null", "-"], { encoding: "utf8" }).stderr)?.[1] ?? 0);
const previewAt = async (t, file) => {
  await page.evaluate((t) => window.__poc.seek(t), t);
  await wait(1100);
  writeFileSync(file, Buffer.from((await page.$eval(".preview canvas", (c) => c.toDataURL("image/png"))).split(",")[1], "base64"));
};
const exportServer = async (name) => {
  const r = await page.evaluate(async (name) => {
    const r = await window.__poc.run("server");
    if ("error" in r) return r;
    const up = await (await fetch(`/api/upload/${name}.mp4`, { method: "PUT", body: await (await fetch(r.url)).blob() })).json();
    return { file: up.src.slice(1), duration: r.duration };
  }, name);
  return r;
};
const frameAt = (file, t, png) => spawnSync(ffmpegPath, ["-y", "-loglevel", "error", "-ss", String(t), "-i", file, "-frames:v", "1", png]);
const level = (file, from, to, hz) => {
  const log = spawnSync(ffmpegPath, ["-hide_banner", "-ss", String(from), "-to", String(to), "-i", file, "-af", `bandpass=f=${hz}:width_type=h:w=30,volumedetect`, "-vn", "-f", "null", "-"], { encoding: "utf8" }).stderr;
  return Number(/mean_volume: (-?[\d.]+) dB/.exec(log)?.[1] ?? -99);
};

// ---------------------------------------------------------------- 1. the UI
if (!only) {
  await page.evaluate((p) => window.__poc.setProject(p), three(null));
  await wait(600);
  await page.click('[data-join="b"]');
  await wait(300);
  const tab = await page.evaluate(() => ({ on: document.querySelector(".lib-tabs .on")?.textContent, items: document.querySelectorAll(".lib.fx").length, inspector: [...document.querySelectorAll(".form b")].map((b) => b.textContent).join(" | ") }));
  check(tab.on.startsWith("Transitions") && tab.items === TRANSITIONS.length && tab.inspector.includes("Transition"), `the + between clip 1 and 2 opens the Transitions tab (${tab.items} transitions) and the Inspector shows "${tab.inspector}"`);
  await page.evaluate(() => [...document.querySelectorAll(".lib.fx")].find((x) => x.textContent.includes("Ink")).click());
  await wait(400);
  let q = await proj();
  const len1 = await page.evaluate(() => window.__poc.getProject() && document.querySelector(".player-bar .time").textContent);
  check(q.clips[1].transition?.type === "ink" && q.clips[1].transition.duration === 0.5 && (await page.$('[data-join="b"].on')), `clicking "Ink" puts it on that join (0.5 s); the join shows ⇄; length now ${len1.split("/")[1].trim()} (was 00:00:08:00)`);
  await setRange("Length", 1.8);
  await wait(300);
  q = await proj();
  const hint = await page.evaluate(() => [...document.querySelectorAll(".form .hint")].map((h) => h.textContent).join(" | "));
  check(q.clips[1].transition.duration === 1.8 && hint.includes("1.5 s"), `Length 1.8 s between two 3 s clips is used as 1.5 s (half a clip): "${hint.slice(0, 90)}"`);
  await page.select(".form select", "slideleft");
  await wait(300);
  q = await proj();
  check(q.clips[1].transition.type === "slideleft", `the Inspector's list changes it to ${q.clips[1].transition.type}`);
  await page.keyboard.press("Delete");
  await wait(300);
  q = await proj();
  check(!q.clips[1].transition, `Delete removes the picked transition`);
  await page.evaluate(() => window.__poc.undo());
  await wait(300);
  check((await proj()).clips[1].transition?.type === "slideleft", `Undo brings it back`);

  await page.evaluate(() => window.__poc.seek(1));
  await page.evaluate(() => [...document.querySelectorAll(".lib-tabs button")].find((b) => b.textContent.startsWith("Effects")).click());
  await wait(200);
  await page.evaluate(() => [...document.querySelectorAll(".lib.fx")].find((x) => x.textContent.includes("Blur")).click());
  await wait(400);
  q = await proj();
  const eff = q.overlays.find((o) => o.kind === "effect");
  const heads = await page.$$eval(".tl-labels .tname", (e) => e.map((x) => x.textContent));
  check(eff?.effect === "blur" && eff.start === 1 && eff.end === 4 && heads[0] === "Effects" && (await page.$(`[data-ref="overlay:${eff.id}"]`)), `Effects tab, "Blur": a 3 s strip at the playhead on a new Effects track at the top (tracks: ${heads.join(", ")})`);
  await setRange("Strength", 0.9);
  await wait(200);
  check((await proj()).overlays.find((o) => o.kind === "effect").amount === 0.9, `the Inspector's Strength slider sets it to 90 %`);
  const mb = await page.evaluate(() => window.__poc.run("mediabunny"));
  check(!!mb.error && mb.error.includes("Server: FFmpeg"), `the browser export refuses an edit with transitions or effects: "${mb.error?.slice(0, 80)}"`);
  check(!(await page.evaluate(() => [...document.querySelectorAll(".export button")].some((b) => b.textContent.includes("Mediabunny")))), `the export panel has no Mediabunny button any more`);
  await page.screenshot({ path: "out/fx-ui.png" });
}

// ---------------------------------------------------------------- 2. transitions: preview vs server export
const tRows = [];
for (const t of TRANSITIONS) {
  if (only && only !== t.id) continue;
  await page.evaluate((p) => window.__poc.setProject(p), three({ type: t.id, duration: 1 }));
  await wait(800);
  const r = await exportServer(`fxt_${t.id}`);
  if (r.error) { check(false, `${t.id}: export failed ${r.error.slice(0, 200)}`); continue; }
  const scores = [];
  for (const at of [2.3, 2.5, 2.8]) {
    const pv = `out/fxt_${t.id}_${at}_p.png`;
    const ex = `out/fxt_${t.id}_${at}_e.png`;
    await previewAt(at, pv);
    frameAt(r.file, at, ex);
    scores.push(ssim(ex, pv));
    if (at === 2.5) tRows.push([pv, ex, t.id]);
  }
  // sound: A alone before, both in the middle, B alone after
  const a1 = level(r.file, 1.0, 1.8, 440), mid440 = level(r.file, 2.4, 2.6, 440), mid660 = level(r.file, 2.4, 2.6, 660), b1 = level(r.file, 3.6, 4.4, 660), a2 = level(r.file, 3.6, 4.4, 440);
  // mid-way each tone is about 6 dB down (half loudness each); after it the 440 Hz tone is gone (what is left is the
  // 660 Hz tone leaking through the band filter, about 20 dB down)
  const soundOk = mid440 > a1 - 12 && mid660 > b1 - 12 && a2 < a1 - 15;
  const worst = Math.min(...scores);
  check(worst > 0.85 && Math.abs(r.duration - 7) < 0.05 && soundOk,
    `${t.label.padEnd(18)} preview vs export at 30/50/80 %: ${scores.map((x) => x.toFixed(3)).join(" / ")}; length ${r.duration.toFixed(2)} s; sound 440 Hz ${a1.toFixed(0)} -> ${mid440.toFixed(0)} -> ${a2.toFixed(0)} dB, 660 Hz ${mid660.toFixed(0)} -> ${b1.toFixed(0)} dB`);
}

// ---------------------------------------------------------------- 3. effects: one edit, one strip per effect
const eRows = [];
const effects = EFFECTS.filter((e) => !only || only === e.id);
if (effects.length) {
  const tau = { flash: 0.4, zoompulse: 0.3, shake: 0.3 };
  const strips = effects.map((e, i) => ({ id: `e_${e.id}`, track: "fx", kind: "effect", effect: e.id, amount: 0.6, x: 0.5, y: 0.5, start: +(i * 1.5 + 0.2).toFixed(2), end: +(i * 1.5 + 1.2).toFixed(2) }));
  await page.evaluate((p) => window.__poc.setProject(p), {
    aspect: "16:9", originalVolume: 1, audios: [],
    clips: [clip("a", "clipA_h264_16x9.mp4", 0, 8), clip("b", "clipA_h264_16x9.mp4", 0, 8)],
    tracks: [{ id: "fx", kind: "visual", role: "effects" }, { id: "t1", kind: "visual" }],
    overlays: [{ id: "title", track: "t1", kind: "text", text: "Effects check", fontSize: 44, color: "#FFFFFF", bg: "#000000", bgOpacity: 0.5, x: 0.5, y: 0.2, start: 0, end: 16 }, ...strips],
  });
  await wait(1000);
  const r = await exportServer("fxe_all");
  if (r.error) check(false, `effects export failed: ${r.error.slice(0, 300)}`);
  else {
    for (const s of strips) {
      const at = +(s.start + (tau[s.effect] ?? 0.5)).toFixed(2);
      const pv = `out/fxe_${s.effect}_p.png`;
      const ex = `out/fxe_${s.effect}_e.png`;
      await previewAt(at, pv);
      frameAt(r.file, at, ex);
      const full = ssim(ex, pv);
      const score = s.effect === "grain" ? ssimSmall(ex, pv) : full;
      eRows.push([pv, ex, s.effect]);
      check(score > 0.85, `${(EFFECTS.find((e) => e.id === s.effect).label).padEnd(14)} preview vs export at ${at} s: ${score.toFixed(3)}${s.effect === "grain" ? ` (compared small, the grain pattern is random; full size ${full.toFixed(3)})` : ""}`);
    }
  }
}

// contact sheets: preview on top, export below
const sheet = (rows, out, w) => {
  if (!rows.length) return;
  const ins = rows.flatMap(([p, e]) => ["-i", p, "-i", e]);
  const f = rows.map(([, , label], k) => `[${2 * k}:v]scale=${w}:-2,drawtext=text='${label}':fontcolor=yellow:fontsize=16:x=4:y=4:fontfile=public/fonts/Poppins-Regular.ttf[p${k}];[${2 * k + 1}:v]scale=${w}:-2[e${k}];[p${k}][e${k}]vstack[c${k}]`).join(";");
  spawnSync(ffmpegPath, ["-y", "-loglevel", "error", ...ins, "-filter_complex", `${f};${rows.map((_, k) => `[c${k}]`).join("")}hstack=inputs=${rows.length}`, out]);
};
sheet(tRows, "out/fx-check-transitions.png", 120);
sheet(eRows, "out/fx-check-effects.png", 200);
await page.evaluate(() => [...document.querySelectorAll(".bar button")].find((b) => b.textContent.trim() === "Reset").click());
check(errors.length === 0, errors.length ? "page errors:\n  " + errors.join("\n  ") : "no page errors");
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
await browser.close();
process.exit(failures ? 1 : 0);
