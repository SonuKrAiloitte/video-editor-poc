/** The bottom toolbar: its buttons follow what is selected (nothing, a clip, a title, a logo, the music). */
import type { ReactNode } from "react";
import { Icon } from "./icons";
import type { SheetName } from "./common";

export type ToolbarName = "main" | "clip" | "text" | "logo" | "music";

const Tool = ({ icon, label, onClick, disabled, danger }: { icon: ReactNode; label: string; onClick: () => void; disabled?: boolean; danger?: boolean }) => (
  <button onClick={onClick} disabled={disabled} className={danger ? "danger" : undefined} aria-label={label}>
    {icon}
    <span>{label}</span>
  </button>
);

export interface ToolbarActions {
  open: (s: SheetName) => void;
  addText: () => void;
  split: () => void;
  canSplit: boolean;
  toggleMute: () => void;
  muted: boolean;
  /** the selected clip is a photo: no sound to mute, a length to choose instead */
  photo: boolean;
  remove: () => void;
  done: () => void;
}

export function Toolbar({ name, title, empty, a }: { name: ToolbarName; title?: string; empty: boolean; a: ToolbarActions }) {
  return (
    <nav className="e-toolbar" aria-label={`${name} tools`}>
      {title && <span className="e-tool-title" title={title}>{title}</span>}
      {name === "main" && (
        <>
          <Tool icon={<Icon.addVideo />} label="Add video" onClick={() => a.open("media-video")} />
          <Tool icon={<Icon.text />} label="Text" onClick={a.addText} disabled={empty} />
          <Tool icon={<Icon.logo />} label="Logo" onClick={() => a.open("media-image")} disabled={empty} />
          <Tool icon={<Icon.music />} label="Music" onClick={() => a.open("media-audio")} disabled={empty} />
          <Tool icon={<Icon.format />} label="Format" onClick={() => a.open("format")} />
        </>
      )}
      {name === "clip" && (
        <>
          <Tool icon={<Icon.split />} label="Split" onClick={a.split} disabled={!a.canSplit} />
          {a.photo ? (
            <Tool icon={<Icon.clock />} label="Length" onClick={() => a.open("length")} />
          ) : (
            <Tool icon={a.muted ? <Icon.sound /> : <Icon.mute />} label={a.muted ? "Unmute" : "Mute"} onClick={a.toggleMute} />
          )}
          <Tool icon={<Icon.trash />} label="Delete" onClick={a.remove} danger />
          <Tool icon={<Icon.done />} label="Done" onClick={a.done} />
        </>
      )}
      {name === "text" && (
        <>
          <Tool icon={<Icon.edit />} label="Edit" onClick={() => a.open("text")} />
          <Tool icon={<Icon.font />} label="Font" onClick={() => a.open("font")} />
          <Tool icon={<Icon.colour />} label="Colour" onClick={() => a.open("colour")} />
          <Tool icon={<Icon.style />} label="Style" onClick={() => a.open("style")} />
          <Tool icon={<Icon.size />} label="Size" onClick={() => a.open("size")} />
          <Tool icon={<Icon.position />} label="Position" onClick={() => a.open("position")} />
          <Tool icon={<Icon.trash />} label="Delete" onClick={a.remove} danger />
          <Tool icon={<Icon.done />} label="Done" onClick={a.done} />
        </>
      )}
      {name === "logo" && (
        <>
          <Tool icon={<Icon.size />} label="Size" onClick={() => a.open("size")} />
          <Tool icon={<Icon.position />} label="Position" onClick={() => a.open("position")} />
          <Tool icon={<Icon.trash />} label="Delete" onClick={a.remove} danger />
          <Tool icon={<Icon.done />} label="Done" onClick={a.done} />
        </>
      )}
      {name === "music" && (
        <>
          <Tool icon={<Icon.split />} label="Split" onClick={a.split} disabled={!a.canSplit} />
          <Tool icon={<Icon.volume />} label="Volume" onClick={() => a.open("volume")} />
          <Tool icon={<Icon.trash />} label="Delete" onClick={a.remove} danger />
          <Tool icon={<Icon.done />} label="Done" onClick={a.done} />
        </>
      )}
    </nav>
  );
}
