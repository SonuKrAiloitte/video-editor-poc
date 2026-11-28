// Which titles FFmpeg may draw itself, and which font Hindi text really gets.
import { fontFor, needsRaster } from "../shared/fonts.js";
const cases = [
  ["Diwali Sale: 40% off, Rs 499 ₹", false],
  ["दिवाली की शुभकामनाएँ", true], // Hindi
  ["Привет", false], // Cyrillic
  ["مرحبا", true], // Arabic
  ["Sale 🎉", true], // emoji
];
let bad = 0;
for (const [text, want] of cases) {
  const got = needsRaster(text);
  if (got !== want) bad++;
  console.log(`${got === want ? "OK  " : "FAIL"} needsRaster=${got}  ${text}`);
}
const f1 = fontFor("दिवाली", "jakarta").id, f2 = fontFor("Diwali", "jakarta").id, f3 = fontFor("दि", "poppins").id;
console.log(`${f1 === "noto-deva" && f2 === "jakarta" && f3 === "poppins" ? "OK  " : "FAIL"} fontFor: Hindi in Jakarta -> ${f1}, English in Jakarta -> ${f2}, Hindi in Poppins -> ${f3}`);
process.exit(bad ? 1 : 0);
