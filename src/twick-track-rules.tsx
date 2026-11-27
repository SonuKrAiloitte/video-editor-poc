/**
 * CapCut-style track rules for the Twick demo, added from outside Twick:
 *   - a track that holds audio takes only audio; a track that holds video, image or text takes only those
 *   - an empty track takes anything
 *   - the main track (named "Main", or else the first video track) keeps its clips joined end to end
 *   - a track left empty is removed
 *
 * Twick calls globalThis.__twickTrackRules from three places that scripts/patch-twick.mjs hooks
 * (drag to another track, drag out to a new track, drop from the Library). The main track is re-packed
 * after each change, once the mouse button is up.
 */
import { useEffect, useRef } from "react";
import { useTimelineContext } from "@twick/timeline";

interface El {
  getId(): string;
  getType(): string;
  getStart(): number;
  getEnd(): number;
  setStart(s: number): void;
  setEnd(e: number): void;
}
interface Tr {
  getId(): string;
  getName(): string;
  getType(): string;
  getElements(): readonly El[];
}
interface Ed {
  getTimelineData(): { tracks: Tr[] } | null | undefined;
  updateElement(el: El): unknown;
  removeTrackById(id: string): void;
  refresh(): void;
}
declare global {
  // eslint-disable-next-line no-var
  var __twickTrackRules: { canPlace(el: El, track: Tr): boolean; refuse(el: El, track: Tr): void } | undefined;
}

const isAudio = (el: El) => el.getType().toLowerCase() === "audio";
/** what a track holds now: "audio", "visual" (video, image, text and the rest), or "any" when it is empty */
function trackKind(track: Tr, ignore?: El): "audio" | "visual" | "any" {
  const els = track.getElements().filter((e) => e.getId() !== ignore?.getId());
  if (track.getType() === "audio" || els.some(isAudio)) return "audio";
  if (track.getType() === "video" || els.length > 0) return "visual";
  return "any";
}
function mainTrack(tracks: Tr[]): Tr | undefined {
  return (
    tracks.find((t) => t.getName() === "Main") ??
    tracks.find((t) => t.getType() === "video") ??
    tracks.find((t) => t.getElements().length > 0 && t.getElements().every((e) => ["video", "image"].includes(e.getType().toLowerCase())))
  );
}

export function TwickTrackRules({ onMessage }: { onMessage: (text: string) => void }) {
  const { editor, changeLog } = useTimelineContext() as unknown as { editor: Ed; changeLog: number };
  const pointerDown = useRef(false);
  const pending = useRef(false);

  useEffect(() => {
    globalThis.__twickTrackRules = {
      canPlace(el, track) {
        if (track.getElements().some((e) => e.getId() === el.getId())) return true;
        const kind = trackKind(track, el);
        return kind === "any" || kind === (isAudio(el) ? "audio" : "visual");
      },
      refuse(el) {
        const text = isAudio(el) ? "Refused: audio goes on an audio track." : "Refused: an audio track takes audio only. Video, image and text go on the other tracks.";
        (globalThis as unknown as { __twickRefusals?: string[] }).__twickRefusals?.push(text); // read by scripts/twick-dnd-check.mjs
        onMessage(text);
      },
    };
    (globalThis as unknown as { __twickEditor?: Ed }).__twickEditor = editor; // read by scripts/twick-dnd-check.mjs
    return () => void (globalThis.__twickTrackRules = undefined);
  }, [onMessage, editor]);

  // main track: close every gap, keeping the clips in the order of their start times
  useEffect(() => {
    const repack = () => {
      const tracks = editor.getTimelineData()?.tracks ?? [];
      const main = mainTrack(tracks);
      let changed = false;
      // tracks left empty by a move disappear, as in CapCut (the main track stays)
      for (const t of tracks) if (t !== main && t.getElements().length === 0) (editor.removeTrackById(t.getId()), (changed = true));
      if (!main) return void (changed && editor.refresh());
      let cursor = 0;
      for (const el of [...main.getElements()].sort((a, b) => a.getStart() - b.getStart())) {
        const len = el.getEnd() - el.getStart();
        if (Math.abs(el.getStart() - cursor) > 1e-3) {
          el.setStart(cursor);
          el.setEnd(cursor + len);
          editor.updateElement(el);
          changed = true;
        }
        cursor += len;
      }
      if (changed) {
        editor.refresh();
        const g = globalThis as unknown as { __twickRepacks?: number };
        g.__twickRepacks = (g.__twickRepacks ?? 0) + 1; // read by scripts/twick-dnd-check.mjs
      }
    };
    const later = () => {
      if (pointerDown.current) pending.current = true;
      else repack();
    };
    const id = setTimeout(later, 150);
    const down = () => void (pointerDown.current = true);
    const up = () => {
      pointerDown.current = false;
      if (pending.current) (pending.current = false), setTimeout(repack, 150);
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    return () => {
      clearTimeout(id);
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
    };
  }, [editor, changeLog]);

  return null;
}
