export interface TransitionDef { id: string; label: string; kind: "xfade" | "mask"; xfade?: string; mask?: string; maskLen?: number }
export interface EffectDef { id: string; label: string; asset?: string; assetLen?: number }
export const TRANSITIONS: TransitionDef[];
export function transitionDef(id: string): TransitionDef | undefined;
export const DEFAULT_TRANSITION_SECONDS: number;
export const MAX_TRANSITION_SECONDS: number;
export const EFFECTS: EffectDef[];
export function effectDef(id: string): EffectDef | undefined;
export const fx: {
  blurSigma(a: number, s: number): number;
  pixelBlock(a: number, s: number): number;
  flash(a: number, tau: number): number;
  flashExpr(a: number, start: number): string;
  shakeZoom(a: number): number;
  shakeX(tau: number): number;
  shakeY(tau: number): number;
  shakeXExpr(start: number): string;
  shakeYExpr(start: number): string;
  pulse(a: number, tau: number): number;
  pulseExpr(a: number, start: number): string;
  glitchShift(a: number, s: number): number;
  grain(a: number): number;
  vignetteAngle(a: number): number;
  leakOpacity(a: number): number;
};
