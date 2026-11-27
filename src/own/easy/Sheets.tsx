/** Option sheets: small panels that slide up over the timeline for one choice at a time. */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { FONTS, fontOf, type FontId } from "../../../shared/fonts";
import { fontFamily } from "../compose";
import { getThumbs } from "../core/thumbs";
import type { Kind } from "../core/media";
import type { LibraryItem } from "../exporters";
import {
  contrastOn, fileLabel, type Aspect, type AudioClip, type ImageOverlay, type Project, type TextAlign, type TextBg, type TextEffect, type TextOverlay,
} from "../project";
import { FORMATS } from "./common";
import { FormatShape, Icon } from "./icons";

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="sheet" role="dialog" aria-label={title}>
      <div className="sheet-head">
        <b>{title}</b>
        <button className="e-done" onClick={onClose}>Done</button>
      </div>
      {children}
    </div>
  );
}

/** A slider that records one undo step per drag (begin on press/focus, live updates while moving). */
export function Slider(props: { label: string; value: number; min: number; max: number; step?: number; show: (v: number) => string; begin: () => void; onChange: (v: number) => void }) {
  return (
    <label className="e-slider">
      <span>{props.label}<b>{props.show(props.value)}</b></span>
      <input
        type="range" aria-label={props.label} min={props.min} max={props.max} step={props.step ?? 1} value={props.value}
        onPointerDown={props.begin} onFocus={props.begin} onChange={(e) => props.onChange(Number(e.target.value))}
      />
    </label>
  );
}

export function FormatSheet({ aspect, choose, close }: { aspect: Aspect; choose: (a: Aspect) => void; close: () => void }) {
  return (
    <Sheet title="Post format" onClose={close}>
      <div className="e-options">
        {FORMATS.map((f) => (
          <button key={f.aspect} aria-label={f.label} className={`e-option ${aspect === f.aspect ? "on" : ""}`} onClick={() => choose(f.aspect)}>
            <FormatShape w={f.w} h={f.h} />
            <span>{f.label}</span>
            <small>{f.hint}</small>
          </button>
        ))}
      </div>
      <p className="e-hint">Your video is cropped to fill the frame.</p>
    </Sheet>
  );
}

const MediaThumb = ({ item }: { item: LibraryItem }) => {
  const [src, setSrc] = useState<string | null>(item.kind === "image" ? item.src : null);
  useEffect(() => {
    if (item.kind !== "video") return;
    let live = true;
    void getThumbs(item.src, 0, 1, 1, 160).then((t) => live && setSrc(t[0] ?? null));
    return () => void (live = false);
  }, [item]);
  if (item.kind === "audio") return <div className="e-media-icon"><Icon.music /></div>;
  return src ? <img src={src} alt="" draggable={false} /> : <div className="e-media-icon"><Icon.addVideo /></div>;
};

const KIND_WORDS: Record<Kind, { title: string; upload: string; accept: string }> = {
  // the video track takes photos too (a story can be all pictures)
  video: { title: "Add a video or photo", upload: "Upload a video or photo", accept: "video/mp4,video/quicktime,video/webm,image/*" },
  image: { title: "Add a logo or picture", upload: "Upload a picture", accept: "image/*" },
  audio: { title: "Add music", upload: "Upload music", accept: "audio/*" },
};
const GROUP_WORDS: Record<LibraryItem["group"], string> = { export: "Your saved videos", upload: "Your uploads", sample: "Samples" };

export function MediaSheet(props: {
  kind: Kind;
  library: LibraryItem[];
  busy: string | null;
  pick: (item: LibraryItem) => void;
  upload: (files: File[]) => void;
  close: () => void;
}) {
  const words = KIND_WORDS[props.kind];
  const items = props.library.filter((i) => i.kind === props.kind || (props.kind === "video" && i.kind === "image"));
  return (
    <Sheet title={words.title} onClose={props.close}>
      <label className={`e-upload ${props.busy ? "busy" : ""}`}>
        <Icon.upload />
        <span>{props.busy ?? `${words.upload} from your computer`}</span>
        <input
          type="file" accept={words.accept} multiple={props.kind !== "audio"} disabled={!!props.busy}
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            if (files.length) props.upload(files);
          }}
        />
      </label>
      {(["export", "upload", "sample"] as const).map((g) => {
        const list = items.filter((i) => i.group === g);
        if (!list.length) return null;
        return (
          <div key={g}>
            <p className="e-group">{GROUP_WORDS[g]}</p>
            <div className="e-media-grid">
              {list.map((i) => (
                <button key={i.src} className="e-media" title={i.name} aria-label={fileLabel(i.name)} disabled={!!props.busy} onClick={() => props.pick(i)}>
                  <MediaThumb item={i} />
                  <span>{fileLabel(i.name)}</span>
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </Sheet>
  );
}

export function TextSheet({ o, begin, set, close }: { o: TextOverlay; begin: () => void; set: (text: string) => void; close: () => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.select(), []);
  return (
    <Sheet title="Your text" onClose={close}>
      <textarea
        ref={ref} className="e-text-input" value={o.text} placeholder="Type your text" aria-label="Text" rows={Math.min(5, o.text.split("\n").length + 1)}
        onFocus={begin} onChange={(e) => set(e.target.value)}
        style={{ fontFamily: `"${fontFamily(fontOf(o.font))}"`, textAlign: o.align ?? "center" }}
      />
      <p className="e-hint">Press Enter for a new line.</p>
    </Sheet>
  );
}

const BG: [TextBg, string, string][] = [["none", "None", "No background"], ["solid", "Solid", "Solid"], ["soft", "See-through", "See-through"]];
const ALIGN: [TextAlign, string][] = [["left", "Left"], ["center", "Centre"], ["right", "Right"]];
const EFFECT: [TextEffect, string, string][] = [["none", "None", "No effect"], ["outline", "Outline", "Outline"], ["shadow", "Shadow", "Shadow"], ["neon", "Neon", "Neon"]];

/** Instagram-style look: background box (the "A" button), alignment, effect. Each choice is one undo step. */
export function StyleSheet({ o, set, close }: { o: TextOverlay; set: (patch: Partial<TextOverlay>) => void; close: () => void }) {
  const bg = o.bg ?? "none";
  const sample = (b: TextBg) => ({ background: b === "none" ? "transparent" : o.bgColor ?? "#000000", opacity: 1, color: b === "none" ? "#fff" : o.color, filter: b === "soft" ? "opacity(0.6)" : undefined });
  return (
    <Sheet title="Style" onClose={close}>
      <p className="e-group">Background</p>
      <div className="e-segs">
        {BG.map(([v, label, aria]) => (
          <button key={v} aria-label={aria} className={`e-seg ${bg === v ? "on" : ""}`} onClick={() => set({ bg: v, bgColor: o.bgColor ?? "#000000" })}>
            <span className="e-bg-sample" style={sample(v)}>Aa</span> {label}
          </button>
        ))}
      </div>
      <div className="e-swatches small">
        {SWATCHES.map(([name, hex]) => (
          <button
            key={hex} aria-label={`Box ${name}`} title={`${name} box`}
            className={`e-swatch ${bg !== "none" && (o.bgColor ?? "").toUpperCase() === hex ? "on" : ""}`} style={{ background: hex }}
            // a box colour turns the box on, and the text to whichever of black or white reads on it
            onClick={() => set({ bg: bg === "none" ? "solid" : bg, bgColor: hex, color: contrastOn(hex) })}
          />
        ))}
      </div>
      <p className="e-group">Align</p>
      <div className="e-segs">
        {ALIGN.map(([v, label]) => (
          <button key={v} aria-label={label} className={`e-seg ${(o.align ?? "center") === v ? "on" : ""}`} onClick={() => set({ align: v })}>
            <AlignIcon a={v} /> {label}
          </button>
        ))}
      </div>
      <p className="e-group">Effect</p>
      <div className="e-segs">
        {EFFECT.map(([v, label, aria]) => (
          <button key={v} aria-label={aria} className={`e-seg fx-${v} ${(o.effect ?? "none") === v ? "on" : ""}`} onClick={() => set({ effect: v })}>
            <span className="e-fx-sample">Aa</span> {label}
          </button>
        ))}
      </div>
    </Sheet>
  );
}

const AlignIcon = ({ a }: { a: TextAlign }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M4 6h16" />
    <path d={a === "left" ? "M4 12h10" : a === "right" ? "M10 12h10" : "M7 12h10"} />
    <path d={a === "left" ? "M4 18h14" : a === "right" ? "M6 18h14" : "M5 18h14"} />
  </svg>
);

export function FontSheet({ o, choose, close }: { o: TextOverlay; choose: (f: FontId) => void; close: () => void }) {
  return (
    <Sheet title="Font" onClose={close}>
      <div className="e-fonts">
        {(Object.keys(FONTS) as FontId[]).map((id) => (
          <button key={id} aria-label={FONTS[id].label} className={`e-font ${fontOf(o.font) === id ? "on" : ""}`} onClick={() => choose(id)}>
            <span style={{ fontFamily: `"${fontFamily(id)}"` }}>Aa</span>
            <small>{FONTS[id].label}</small>
          </button>
        ))}
      </div>
    </Sheet>
  );
}

export const SWATCHES: [string, string][] = [
  ["White", "#FFFFFF"], ["Black", "#111111"], ["Yellow", "#FFD60A"], ["Pink", "#FF4D8D"],
  ["Red", "#FF3B30"], ["Blue", "#2F80FF"], ["Green", "#34C759"], ["Orange", "#FF9500"],
];

export function ColourSheet({ o, begin, choose, close }: { o: TextOverlay; begin: () => void; choose: (c: string, live?: boolean) => void; close: () => void }) {
  return (
    <Sheet title="Colour" onClose={close}>
      <div className="e-swatches">
        {SWATCHES.map(([name, hex]) => (
          <button key={hex} aria-label={name} title={name} className={`e-swatch ${o.color.toUpperCase() === hex ? "on" : ""}`} style={{ background: hex }} onClick={() => choose(hex)} />
        ))}
        <label className="e-swatch custom" title="More colours">
          <input type="color" aria-label="More colours" value={o.color} onFocus={begin} onPointerDown={begin} onChange={(e) => choose(e.target.value.toUpperCase(), true)} />
        </label>
      </div>
    </Sheet>
  );
}

export type Spot = { label: string; x: "l" | "c" | "r"; y: "t" | "m" | "b" };
export const TEXT_SPOTS: Spot[] = [
  { label: "Top", x: "c", y: "t" }, { label: "Middle", x: "c", y: "m" }, { label: "Bottom", x: "c", y: "b" },
];
export const LOGO_SPOTS: Spot[] = [
  { label: "Top left", x: "l", y: "t" }, { label: "Top right", x: "r", y: "t" }, { label: "Centre", x: "c", y: "m" },
  { label: "Bottom left", x: "l", y: "b" }, { label: "Bottom right", x: "r", y: "b" },
];

export function PositionSheet({ spots, current, choose, close }: { spots: Spot[]; current: { x: number; y: number }; choose: (s: Spot) => void; close: () => void }) {
  return (
    <Sheet title="Position" onClose={close}>
      <div className="e-spots">
        {spots.map((s) => (
          <button key={s.label} aria-label={s.label} className="e-spot" onClick={() => choose(s)}>
            <span className="e-spot-frame"><i className={`x-${s.x} y-${s.y}`} /></span>
            <small>{s.label}</small>
          </button>
        ))}
      </div>
      <p className="e-hint">You can also drag it on the video. Now at {Math.round(current.x * 100)}% across, {Math.round(current.y * 100)}% down.</p>
    </Sheet>
  );
}

export function SizeSheet({ o, begin, set, close }: { o: TextOverlay | ImageOverlay; begin: () => void; set: (v: number) => void; close: () => void }) {
  return (
    <Sheet title="Size" onClose={close}>
      {o.kind === "text" ? (
        <Slider label="Size" value={o.fontSize} min={16} max={140} show={(v) => `${v}`} begin={begin} onChange={set} />
      ) : (
        <Slider label="Size" value={o.width} min={0.05} max={0.8} step={0.01} show={(v) => `${Math.round(v * 100)}%`} begin={begin} onChange={set} />
      )}
    </Sheet>
  );
}

export function VolumeSheet({ p, piece, begin, setVideo, setPiece, close }: {
  p: Project;
  piece?: AudioClip;
  begin: () => void;
  setVideo: (v: number) => void;
  setPiece: (v: number) => void;
  close: () => void;
}) {
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  return (
    <Sheet title="Volume" onClose={close}>
      {piece && <Slider label="This song" value={piece.volume} min={0} max={1} step={0.05} show={pct} begin={begin} onChange={setPiece} />}
      <Slider label="Video sound" value={p.originalVolume} min={0} max={1} step={0.05} show={pct} begin={begin} onChange={setVideo} />
    </Sheet>
  );
}

/** How long a photo stays on screen. */
export function LengthSheet({ seconds, choose, close }: { seconds: number; choose: (s: number) => void; close: () => void }) {
  return (
    <Sheet title="Show this photo for" onClose={close}>
      <div className="e-options lengths">
        {[2, 3, 5, 8, 10].map((n) => (
          <button key={n} aria-label={`${n} seconds`} className={`e-option ${Math.abs(seconds - n) < 0.01 ? "on" : ""}`} onClick={() => choose(n)}>
            <span>{n} s</span>
          </button>
        ))}
      </div>
      <p className="e-hint">Or drag the white handles on the timeline for any length.</p>
    </Sheet>
  );
}
