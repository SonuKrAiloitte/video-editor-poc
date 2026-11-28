/**
 * Candidate A: Twick Studio (the stack recommended in the one-page requirements).
 * Mounted as shipped, seeded with our test media, with its own browser renderer wired to Export.
 */
import { useEffect, useRef, useState } from "react";
import { LivePlayerProvider, TimelineProvider, TwickStudio } from "@twick/studio";
import "@twick/studio/dist/studio.css";
import { renderTwickVideoInBrowser } from "@twick/browser-render";
import { TwickTrackRules } from "./twick-track-rules";

const M = (name: string) => `${location.origin}/media/${name}`;

// Twick picks a decoder by file type: MP4 uses WebCodecs, anything else falls back to an "ffmpeg" decoder
// that needs its dev server. So a WebM (or MOV) clip breaks the in-browser export. Add ?webm to the URL to reproduce.
const SECOND = location.search.includes("webm")
  ? { src: M("clipC_vp9.webm"), mediaDuration: 5, time: 0.5 }
  : { src: M("clipB_h264_9x16.mp4"), mediaDuration: 6, time: 0 };

const INITIAL = {
  version: 1,
  tracks: [
    {
      id: "t-video", name: "Main", type: "video",
      elements: [
        { id: "e-a", trackId: "t-video", name: "Clip A", type: "video", s: 0, e: 4, mediaDuration: 8, objectFit: "cover", frame: { size: [720, 1280] }, props: { src: M("clipA_h264_16x9.mp4"), time: 1, volume: 1, play: true } },
        { id: "e-c", trackId: "t-video", name: "Clip 2", type: "video", s: 4, e: 7, mediaDuration: SECOND.mediaDuration, objectFit: "cover", frame: { size: [720, 1280] }, props: { src: SECOND.src, time: SECOND.time, volume: 0, play: true } },
      ],
    },
    {
      id: "t-text", name: "Text", type: "element",
      elements: [{ id: "e-t", trackId: "t-text", name: "Title", type: "text", s: 0.5, e: 6, props: { text: "Diwali Sale: 40% off", fill: "#FFFFFF", fontSize: 44 } }],
    },
    {
      id: "t-audio", name: "Music", type: "audio",
      elements: [{ id: "e-m", trackId: "t-audio", name: "Music", type: "audio", s: 0, e: 7, mediaDuration: 20, props: { src: M("music.mp3"), volume: 0.35, play: true } }],
    },
  ],
};

export function TwickDemo() {
  const [log, setLog] = useState<string>("Use Export in the Twick header to run Twick's own browser renderer.");
  const host = useRef<HTMLDivElement>(null);

  // Twick puts every clip added with "+" on a new track at the bottom of the timeline, often below the visible
  // part, so it looked as if nothing happened. When a track appears, scroll the timeline to show it.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let count = el.querySelectorAll(".twick-track").length;
    const watch = new MutationObserver(() => {
      const tracks = el.querySelectorAll(".twick-track");
      if (tracks.length > count) tracks[tracks.length - 1]?.scrollIntoView({ block: "nearest" });
      count = tracks.length;
    });
    watch.observe(el, { childList: true, subtree: true });
    return () => watch.disconnect();
  }, []);

  return (
    <div className="twick-wrap">
      <div className="twick-log">{log}</div>
      <div className="twick-host" ref={host}>
        <LivePlayerProvider>
          <TimelineProvider initialData={INITIAL as never} contextId="poc-twick">
            <TwickTrackRules onMessage={setLog} />
            <TwickStudio
              studioConfig={{
                videoProps: { width: 720, height: 1280 },
                // Turns on Twick's own "Upload" buttons (video, audio, image panels), which open the
                // computer's file picker. Our render server stores the file and answers with its URL.
                uploadConfig: { uploadApiUrl: "/api/twick-upload", provider: "gcs" },
                media: {
                  namespace: "poc",
                  seed: {
                    items: [
                      { name: "clipA_h264_16x9.mp4", url: M("clipA_h264_16x9.mp4"), type: "video" },
                      { name: "clipB_h264_9x16.mp4", url: M("clipB_h264_9x16.mp4"), type: "video" },
                      { name: "clipC_vp9.webm", url: M("clipC_vp9.webm"), type: "video" },
                      { name: "clipD_hevc.mov", url: M("clipD_hevc.mov"), type: "video" },
                      { name: "music.mp3", url: M("music.mp3"), type: "audio" },
                      { name: "logo.png", url: M("logo.png"), type: "image" },
                    ] as never,
                  },
                },
                saveProject: async (project, fileName) => {
                  localStorage.setItem("poc-twick-draft", JSON.stringify(project));
                  setLog(`Saved "${fileName}": ${JSON.stringify(project).length} bytes of Twick project JSON`);
                  return { status: true, message: "saved" };
                },
                exportVideo: async (project, settings) => {
                  const t0 = performance.now();
                  setLog("Twick browser render started...");
                  try {
                    const blob = await renderTwickVideoInBrowser({
                      variables: { input: { ...project, properties: { ...settings.resolution, fps: settings.fps } } },
                      settings: {
                        ...settings.resolution, fps: settings.fps, includeAudio: true,
                        onProgress: (p: number) => setLog(`Twick browser render ${(p * 100).toFixed(0)}%`),
                      },
                    });
                    const ms = performance.now() - t0;
                    const url = URL.createObjectURL(blob);
                    (window as unknown as Record<string, unknown>).__twickExport = { url, ms, bytes: blob.size };
                    setLog(`Twick browser render done: ${(ms / 1000).toFixed(1)} s, ${(blob.size / 1024 / 1024).toFixed(2)} MB (${settings.resolution.width}x${settings.resolution.height}) -> ${url}`);
                    return { status: true, message: "exported", result: url };
                  } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    setLog("Twick browser render FAILED: " + msg);
                    return { status: false, message: msg };
                  }
                },
              }}
            />
          </TimelineProvider>
        </LivePlayerProvider>
      </div>
    </div>
  );
}
