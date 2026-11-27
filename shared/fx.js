// Transitions and effects the editor offers: ONE list, read by the preview (src/own/compose.ts) and by the FFmpeg
// builder (shared/ffmpeg-graph.js), so both draw the same thing. In production this list comes from the asset library
// (category, thumbnail, who may use it); adding an item of an existing kind needs content only, no code.
//
// Transition kinds:
//   xfade  one of FFmpeg's built-in xfade transitions; the preview re-implements FFmpeg's maths for it
//   mask   a black-to-white mask video decides where the incoming clip shows (designers make these)
// Effect kinds are the `effect` ids below; each has an FFmpeg filter and a canvas version.

/** @type {{ id: string, label: string, kind: "xfade" | "mask", xfade?: string, mask?: string, maskLen?: number }[]} */
export const TRANSITIONS = [
  { id: "fade", label: "Fade", kind: "xfade", xfade: "fade" },
  { id: "fadeblack", label: "Fade through black", kind: "xfade", xfade: "fadeblack" },
  { id: "fadewhite", label: "Fade through white", kind: "xfade", xfade: "fadewhite" },
  { id: "slideleft", label: "Slide left", kind: "xfade", xfade: "slideleft" },
  { id: "slideright", label: "Slide right", kind: "xfade", xfade: "slideright" },
  { id: "slideup", label: "Slide up", kind: "xfade", xfade: "slideup" },
  { id: "slidedown", label: "Slide down", kind: "xfade", xfade: "slidedown" },
  { id: "wipeleft", label: "Wipe left", kind: "xfade", xfade: "wipeleft" },
  { id: "wiperight", label: "Wipe right", kind: "xfade", xfade: "wiperight" },
  { id: "circleopen", label: "Circle open", kind: "xfade", xfade: "circleopen" },
  { id: "zoomin", label: "Zoom in", kind: "xfade", xfade: "zoomin" },
  { id: "pixelize", label: "Pixelize", kind: "xfade", xfade: "pixelize" },
  { id: "ink", label: "Ink", kind: "mask", mask: "/fx/ink.mp4", maskLen: 1 },
  { id: "brush", label: "Brush", kind: "mask", mask: "/fx/brush.mp4", maskLen: 1 },
];
export const transitionDef = (id) => TRANSITIONS.find((t) => t.id === id);
export const DEFAULT_TRANSITION_SECONDS = 0.5;
export const MAX_TRANSITION_SECONDS = 2;

/** @type {{ id: string, label: string, asset?: string, assetLen?: number }[]} */
export const EFFECTS = [
  { id: "blur", label: "Blur" },
  { id: "pixelate", label: "Pixelate" },
  { id: "bw", label: "Black & white" },
  { id: "flash", label: "Flash" },
  { id: "shake", label: "Shake" },
  { id: "zoompulse", label: "Zoom pulse" },
  { id: "glitch", label: "RGB split" },
  { id: "grain", label: "Film grain" },
  { id: "vignette", label: "Vignette" },
  { id: "leak", label: "Light leak", asset: "/fx/leak.mp4", assetLen: 3 },
];
export const effectDef = (id) => EFFECTS.find((e) => e.id === id);

// ---- the numbers both renderers use, so they cannot drift apart. `a` is the strength 0..1, `s` = short side / 720.
export const fx = {
  blurSigma: (a, s) => (2 + 18 * a) * s,
  pixelBlock: (a, s) => Math.max(2, Math.round((6 + 30 * a) * s)),
  /** brightness added at local time tau (seconds since the effect started), 0..~0.6 */
  flash: (a, tau) => 0.6 * a * Math.max(0, Math.sin(2 * Math.PI * 3 * tau)) ** 2,
  flashExpr: (a, start) => `${0.6 * a}*pow(max(0,sin(2*PI*3*(t-${start}))),2)`,
  /** shake: the picture is enlarged by `zoom` and its window moves by up to the spare margin */
  shakeZoom: (a) => 1 + 0.12 * a,
  shakeX: (tau) => Math.sin(2 * Math.PI * 7 * tau),
  shakeY: (tau) => Math.cos(2 * Math.PI * 5.3 * tau),
  shakeXExpr: (start) => `sin(2*PI*7*(t-${start}))`,
  shakeYExpr: (start) => `cos(2*PI*5.3*(t-${start}))`,
  /** zoom pulse: 1 .. 1 + 0.2a, twice a second */
  pulse: (a, tau) => 1 + 0.2 * a * (0.5 - 0.5 * Math.cos(2 * Math.PI * 2 * tau)),
  pulseExpr: (a, start) => `1+${0.2 * a}*(0.5-0.5*cos(2*PI*2*(t-${start})))`,
  glitchShift: (a, s) => Math.max(1, Math.round((4 + 16 * a) * s)),
  grain: (a) => Math.round(10 + 40 * a),
  /** vignette lens angle (FFmpeg default is PI/5); the picture is multiplied by cos(angle * r)^4 */
  vignetteAngle: (a) => Math.min(Math.PI / 2, (0.15 + 0.45 * a) * (Math.PI / 2)),
  leakOpacity: (a) => 0.35 + 0.65 * a,
};
