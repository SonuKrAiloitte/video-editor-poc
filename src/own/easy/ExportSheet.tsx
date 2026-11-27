/**
 * Export, in plain words: pick a quality, press one button, watch the finished video, download or keep it.
 * The engine choice (server FFmpeg by default) only appears under "Technical details", for the demo comparison.
 */
import { useState } from "react";
import { exportFfmpegWasm, exportMediabunny, exportServer, saveToLibrary, type ExportResult } from "../exporters";
import type { Project } from "../project";
import { Sheet } from "./Sheets";

const ENGINES = {
  server: { label: "Server (FFmpeg)", run: exportServer },
  mediabunny: { label: "Browser (Mediabunny)", run: exportMediabunny },
  wasm: { label: "Browser fallback (ffmpeg.wasm)", run: exportFfmpegWasm },
} as const;
type Engine = keyof typeof ENGINES;
export type ExportOutcome = ExportResult | { engine: string; error: string };

const QUALITY = [
  { h: 720 as const, label: "Standard (720p)", hint: "Good for most posts" },
  { h: 1080 as const, label: "High (1080p)", hint: "Sharper, bigger file" },
];

export function ExportSheet({ project, close, onBusy, onResult, onSaved }: {
  project: () => Project;
  close: () => void;
  /** tells the screen an export is running, so nothing closes this sheet meanwhile */
  onBusy: (busy: boolean) => void;
  onResult: (r: ExportOutcome) => void;
  onSaved: () => void;
}) {
  const [height, setHeight] = useState<720 | 1080>(1080);
  const [engine, setEngine] = useState<Engine>("server");
  const [tech, setTech] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const busy = progress !== null;

  const run = async () => {
    setResult(null);
    setError(null);
    setSaved(null);
    setProgress(0);
    onBusy(true);
    try {
      const r = await ENGINES[engine].run(project(), height, setProgress);
      setResult(r);
      onResult(r);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      onResult({ engine, error: msg });
    } finally {
      onBusy(false);
      setProgress(null);
    }
  };

  const save = async () => {
    if (!result) return;
    setSaved("Saving...");
    try {
      const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, "");
      await saveToLibrary(result, `my_video_${result.width}x${result.height}_${stamp}.mp4`);
      setSaved("Saved to My media ✓");
      onSaved();
    } catch {
      setSaved("Could not save. Is the server running?");
    }
  };

  return (
    <Sheet title="Export" onClose={() => !busy && close()}>
      <div className="e-options two">
        {QUALITY.map((q) => (
          <button key={q.h} aria-label={q.label} className={`e-option ${height === q.h ? "on" : ""}`} disabled={busy} onClick={() => setHeight(q.h)}>
            <span>{q.label}</span>
            <small>{q.hint}</small>
          </button>
        ))}
      </div>

      {busy ? (
        <div className="e-progress" role="status">
          <span>Making your video... {Math.round((progress ?? 0) * 100)}%</span>
          <i style={{ width: `${Math.max(4, (progress ?? 0) * 100)}%` }} />
        </div>
      ) : (
        <button className="e-cta wide" onClick={() => void run()}>Export video</button>
      )}

      {error && <p className="e-error">Something went wrong while making the video. Please try again.{tech && <><br /><code>{error.slice(0, 300)}</code></>}</p>}

      {result && !busy && (
        <div className="e-result">
          <video src={result.url} controls playsInline />
          <div className="e-result-actions">
            <a className="e-cta" href={result.url} download="my-video.mp4">Download</a>
            {saved ? <span className="e-saved-msg">{saved}</span> : <button className="e-secondary" onClick={() => void save()}>Save to my media</button>}
          </div>
        </div>
      )}

      <button className="e-link small" onClick={() => setTech((v) => !v)} aria-expanded={tech}>Technical details</button>
      {tech && (
        <div className="e-tech">
          <p className="e-hint">How the video is made. The server is the default; the browser options are for comparison.</p>
          <div className="e-options three">
            {(Object.keys(ENGINES) as Engine[]).map((k) => (
              <button key={k} aria-label={ENGINES[k].label} className={`e-option small ${engine === k ? "on" : ""}`} disabled={busy} onClick={() => setEngine(k)}>
                <span>{ENGINES[k].label}</span>
              </button>
            ))}
          </div>
          {result && (
            <p className="e-hint">
              {result.engine}: {result.width}x{result.height}, {result.duration.toFixed(1)} s of video made in {(result.ms / 1000).toFixed(2)} s
              ({(result.duration / (result.ms / 1000)).toFixed(1)}x realtime), {(result.bytes / 1024 / 1024).toFixed(2)} MB.
            </p>
          )}
        </div>
      )}
    </Sheet>
  );
}
