// Adds a track-rules hook to Twick's timeline (node_modules/@twick/video-editor), for the CapCut-style rules in the
// Twick demo. Runs after `npm install` (package.json "postinstall") and is safe to run again.
//
// Twick's own rules: an element can be dragged only onto a track of type "element", and a video, image or audio
// element can never be dragged out to a new track. That blocks most moves. With the hook, the page decides:
// src/twick-demo.tsx sets globalThis.__twickTrackRules = { canPlace(element, track), refuse(element, track) }.
// Without the hook object, Twick behaves exactly as shipped.
//
// If Twick changes the code around these lines, this script stops with an error instead of patching blindly.
import { readFileSync, writeFileSync, rmSync } from "node:fs";

const MARK = "/* poc-track-rules */";
const files = ["node_modules/@twick/video-editor/dist/index.mjs", "node_modules/@twick/video-editor/dist/index.js"];
const edits = [
  {
    what: "dragging an element onto another track",
    from: "if (!isElementTrackType(targetTrack)) {\n      return;\n    }",
    to: `${MARK} if (globalThis.__twickTrackRules ? !globalThis.__twickTrackRules.canPlace(element, targetTrack) : !isElementTrackType(targetTrack)) {\n      globalThis.__twickTrackRules?.refuse?.(element, targetTrack);\n      return;\n    }`,
  },
  {
    what: "dragging a video, image or audio element out to a new track",
    from: "if (!wouldBeElementTrack(element)) {\n        return;\n      }",
    to: `${MARK} if (!globalThis.__twickTrackRules && !wouldBeElementTrack(element)) {\n        return;\n      }`,
  },
  {
    what: "dropping a Library item on a track",
    from: "const element = createElementFromDrop(type, url, videoResolution);\n      element.setStart(timeSec);",
    to: `const element = createElementFromDrop(type, url, videoResolution);\n      ${MARK} if (track && globalThis.__twickTrackRules && !globalThis.__twickTrackRules.canPlace(element, track)) {\n        globalThis.__twickTrackRules.refuse?.(element, track);\n        return;\n      }\n      element.setStart(timeSec);`,
  },
];

let changed = false;
for (const file of files) {
  let s = readFileSync(file, "utf8");
  if (s.includes(MARK)) {
    console.log(`already patched: ${file}`);
    continue;
  }
  for (const e of edits) {
    const count = s.split(e.from).length - 1;
    if (count !== 1) throw new Error(`${file}: expected the code for "${e.what}" once, found it ${count} times. Twick has changed; update scripts/patch-twick.mjs.`);
    s = s.replace(e.from, e.to);
  }
  writeFileSync(file, s);
  changed = true;
  console.log(`patched: ${file}`);
}
// Vite keeps a pre-bundled copy of Twick; drop it so the dev server picks up the change
if (changed) rmSync("node_modules/.vite", { recursive: true, force: true });
