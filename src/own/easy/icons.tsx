/** Simple stroke icons for the easy editor (24x24, currentColor). */
import type { ReactNode } from "react";

const I = ({ children, size = 22 }: { children: ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const Icon = {
  addVideo: () => <I><rect x="3" y="6" width="13" height="12" rx="2" /><path d="M16 10l5-3v10l-5-3" /><path d="M9.5 9.5v5M7 12h5" /></I>,
  text: () => <I><path d="M5 6V4h14v2" /><path d="M12 4v16" /><path d="M9 20h6" /></I>,
  logo: () => <I><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="M21 16l-5-5-8 9" /></I>,
  music: () => <I><path d="M9 18V5l11-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="17" cy="16" r="3" /></I>,
  format: () => <I><rect x="7" y="3" width="10" height="18" rx="2" /><path d="M3 8v8M21 8v8" /></I>,
  undo: () => <I><path d="M9 14L4 9l5-5" /><path d="M4 9h11a5 5 0 010 10h-3" /></I>,
  redo: () => <I><path d="M15 14l5-5-5-5" /><path d="M20 9H9a5 5 0 000 10h3" /></I>,
  play: () => <I size={26}><path d="M7 4.5v15l12-7.5z" fill="currentColor" /></I>,
  pause: () => <I size={26}><rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" /><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" /></I>,
  split: () => <I><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M20 4L8.1 15.9M14.5 14.5L20 20M8.1 8.1L12 12" /></I>,
  sound: () => <I><path d="M4 9v6h4l5 4V5L8 9z" /><path d="M16 9a4 4 0 010 6M18.5 6.5a8 8 0 010 11" /></I>,
  mute: () => <I><path d="M4 9v6h4l5 4V5L8 9z" /><path d="M17 9l5 6M22 9l-5 6" /></I>,
  trash: () => <I><path d="M4 7h16M10 11v6M14 11v6" /><path d="M6 7l1 13h10l1-13M9 7V4h6v3" /></I>,
  done: () => <I><path d="M5 12l5 5L19 7" /></I>,
  edit: () => <I><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M13 7l4 4" /></I>,
  font: () => <I><path d="M4 19L9 5h1l5 14M6 14h7" /><path d="M16 19v-5a2.5 2.5 0 015 0v5M16 16.5h5" /></I>,
  colour: () => <I><circle cx="12" cy="12" r="9" /><circle cx="8" cy="10" r="1.3" fill="currentColor" /><circle cx="12" cy="7.5" r="1.3" fill="currentColor" /><circle cx="16" cy="10" r="1.3" fill="currentColor" /><path d="M12 21a2.5 2.5 0 010-5h2" /></I>,
  size: () => <I><path d="M4 20L20 4M14 4h6v6M10 20H4v-6" /></I>,
  position: () => <I><path d="M12 3v18M3 12h18" /><path d="M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3" /></I>,
  volume: () => <I><path d="M4 9v6h4l5 4V5L8 9z" /><path d="M16 9a4 4 0 010 6" /></I>,
  replace: () => <I><path d="M4 7h13l-3-3M20 17H7l3 3" /></I>,
  export: () => <I><path d="M12 15V3M7 8l5-5 5 5" /><path d="M5 14v5a2 2 0 002 2h10a2 2 0 002-2v-5" /></I>,
  upload: () => <I size={28}><path d="M12 16V4M7 9l5-5 5 5" /><path d="M4 16v3a2 2 0 002 2h12a2 2 0 002-2v-3" /></I>,
  close: () => <I><path d="M6 6l12 12M18 6L6 18" /></I>,
  plus: () => <I><path d="M12 5v14M5 12h14" /></I>,
  minus: () => <I><path d="M5 12h14" /></I>,
  style: () => <I><rect x="3" y="5" width="18" height="14" rx="4" /><path d="M8 15l4-8 4 8M9.5 12h5" /></I>,
  clock: () => <I><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></I>,
  photo: () => <I><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="9" cy="10" r="1.8" /><path d="M21 16l-5-4-9 7" /></I>,
  newPost: () => <I><path d="M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9z" /><path d="M14 3v6h6M12 12v6M9 15h6" /></I>,
};

/** Shape of each post format, drawn to scale. */
export const FormatShape = ({ w, h }: { w: number; h: number }) => {
  const s = 26 / Math.max(w, h);
  return (
    <svg width={30} height={30} viewBox="0 0 30 30" aria-hidden="true">
      <rect x={15 - (w * s) / 2} y={15 - (h * s) / 2} width={w * s} height={h * s} rx={3} fill="none" stroke="currentColor" strokeWidth={1.8} />
    </svg>
  );
};
