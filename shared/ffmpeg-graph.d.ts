import type { Project } from "../src/own/project";
import type { FontId } from "./fonts";
export const SIZES: Record<string, Record<number, [number, number]>>;
export function projectDuration(p: Project): number;
export function buildFfmpegArgs(
  project: Project,
  opts: { height: 720 | 1080; resolve: (src: string) => string; fontPath: (font: FontId) => string; output: string; preset?: string },
): { args: string[]; width: number; height: number; duration: number };
