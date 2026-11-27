// The track model of the edit JSON, shared by the editor, the browser exporters and the render server.
//
// Like CapCut:
//   - the MAIN track holds video and image clips joined end to end (magnetic: no gaps),
//   - VISUAL tracks above it hold video, image and text, placed anywhere in time (gaps allowed),
//   - AUDIO tracks below it hold audio only.
// `tracks` lists the extra tracks top to bottom as the timeline shows them: visual tracks first (the top one is
// drawn over everything), then audio tracks. The main track is implicit and is not in the list.

/** What a track of each kind accepts. "main" is the magnetic main track. */
export const ACCEPTS = {
  main: ["video", "image"],
  visual: ["video", "image", "text"],
  audio: ["audio"],
};

export const canPlace = (itemKind, trackKind) => ACCEPTS[trackKind]?.includes(itemKind) ?? false;

/** Plain-language reason a drop is refused, or null when it is allowed. */
export function refuseReason(itemKind, trackKind) {
  if (canPlace(itemKind, trackKind)) return null;
  if (trackKind === "audio") return "An audio track takes audio only.";
  if (itemKind === "audio") return "Audio goes on an audio track.";
  if (trackKind === "main" && itemKind === "text") return "Text goes on a track above the main track.";
  return "This track does not take that kind of item.";
}

/** Ratios offered in the player, like CapCut. "original" follows the first clip on the main track. */
export const RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "4:5", "2.35:1", "2:1", "1.85:1"];

const ratioOf = (aspect) => {
  const [w, h] = String(aspect).split(":").map(Number);
  return w > 0 && h > 0 ? w / h : 16 / 9;
};
/** The ratio the frame really has: "original" becomes the first main clip's shape (16:9 if it is unknown). */
export function resolveAspect(p) {
  if (p.aspect !== "original") return p.aspect;
  const r = p.clips?.[0]?.ratio;
  return r ? `${Math.round(r * 1000)}:1000` : "16:9";
}
/** Frame size in pixels. `short` is the short side (720 or 1080); both sides are even, as H.264 needs. */
export function frameSizeFor(aspect, short) {
  const r = ratioOf(aspect);
  const even = (x) => Math.max(2, Math.round(x / 2) * 2);
  return r >= 1 ? [even(short * r), short] : [short, even(short / r)];
}

export const mainDuration = (p) => p.clips.reduce((s, c) => s + (c.out - c.in), 0);
export const audioLen = (a) => a.out - a.in;

/** Length of the whole edit: the main track, or further if something on another track ends later. */
export function projectDuration(p) {
  let end = mainDuration(p);
  for (const o of p.overlays ?? []) end = Math.max(end, o.end);
  for (const a of p.audios ?? []) end = Math.max(end, a.start + audioLen(a));
  return end;
}

/**
 * Visual items in drawing order, bottom first: the lowest visual track first, the top track last.
 * Within a track, items are in time order (they do not overlap on one track).
 */
export function layers(p) {
  const order = (p.tracks ?? []).filter((t) => t.kind === "visual").map((t) => t.id).reverse();
  return [...(p.overlays ?? [])].sort((a, b) => order.indexOf(a.track) - order.indexOf(b.track) || a.start - b.start);
}

/**
 * Bring an edit saved in the older shape up to date: one music field, overlays without a track.
 * Overlays that overlap in time go on separate tracks so none hides another, as the old lanes did.
 */
export function normalizeProject(p) {
  const loose = (p.overlays ?? []).some((o) => !o.track);
  if (Array.isArray(p.tracks) && Array.isArray(p.audios) && !loose && !p.music) return p;
  const tracks = [...(p.tracks ?? [])];
  const used = new Set(tracks.map((t) => t.id));
  const fresh = (prefix) => {
    let i = 1;
    while (used.has(`${prefix}${i}`)) i++;
    used.add(`${prefix}${i}`);
    return `${prefix}${i}`;
  };
  // overlays without a track: overlapping ones go on separate new visual tracks, placed above the existing ones
  const laneEnds = [];
  const laneIds = [];
  const overlays = (p.overlays ?? []).map((o) => {
    if (o.track) return o;
    let lane = laneEnds.findIndex((end) => end <= o.start);
    if (lane === -1) (lane = laneEnds.length), laneIds.push(fresh("v"));
    laneEnds[lane] = o.end;
    return { ...o, track: laneIds[lane] };
  });
  tracks.unshift(...laneIds.map((id) => ({ id, kind: "visual" })).reverse());
  const audios = [...(p.audios ?? [])];
  if (p.music) {
    const len = mainDuration(p);
    const id = fresh("a");
    tracks.push({ id, kind: "audio" });
    audios.push({ id: "music", track: id, src: p.music.src, name: p.music.name, start: 0, in: 0, out: len, srcDuration: len, volume: p.music.volume, channels: p.music.channels });
  }
  const { music: _drop, ...rest } = p;
  return { ...rest, clips: (p.clips ?? []).map((c) => ({ kind: "video", ...c })), tracks, overlays, audios };
}

/** Does [start, end) collide with another item on that track? */
export function overlapsOnTrack(items, track, start, end, ignoreId) {
  return items.some((o) => o.track === track && o.id !== ignoreId && o.start < end - 1e-6 && start < o.end - 1e-6);
}
