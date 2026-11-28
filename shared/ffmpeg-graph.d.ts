import type { Project } from "../src/own/project";
export const SIZES: Record<string, Record<number, [number, number]>>;
export function projectDuration(p: Project): number;
export function buildFfmpegArgs(
  project: Project | Record<string, unknown>,
  opts: { height: 720 | 1080; resolve: (src: string) => string; font: string | ((fileName: string) => string); output: string; preset?: string; seek?: "input" | "filter" },
): { args: string[]; width: number; height: number; duration: number };
