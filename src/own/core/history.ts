/**
 * The edit draft and its undo history, shared by both editor screens.
 * It lives at module level, so switching screens (or to the comparison tab) keeps the edit and its history.
 *
 * Two ways to change the project:
 *   commit(next)          one discrete edit = one undo step
 *   begin() + apply(next) a gesture (drag, typing, slider): begin() remembers the document, the first
 *                         apply() after it records that one undo step, later applies just update.
 *                         A click that changes nothing records nothing.
 */
import { useCallback, useEffect, useState } from "react";
import sample from "../../../shared/sample-project.json";
import { dropDeadMedia, normalizeProject, type Project } from "../project";

const STORAGE_KEY = "poc-own-editor-draft-v1";
const HISTORY_LIMIT = 100;

/** How many items an old draft lost because they pointed at files from a closed tab. */
let droppedOnLoad = 0;
/** Read once: the first screen to ask reports it, later mounts do not repeat it. */
export const takeDroppedOnLoad = () => {
  const n = droppedOnLoad;
  droppedOnLoad = 0;
  return n;
};

const loadDraft = (): Project => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const { project, removed } = dropDeadMedia(normalizeProject(JSON.parse(raw)));
      droppedOnLoad = removed;
      return project;
    }
  } catch {
    /* storage unavailable or unreadable: fall through to the sample */
  }
  return sampleProject();
};

export const sampleProject = () => normalizeProject(sample as unknown as Project);

const hist = { past: [] as Project[], future: [] as Project[], pending: null as Project | null, current: null as Project | null };

/** The latest project, even between a change and the next render. */
export const cur = () => (hist.current ??= loadDraft());
export const historyDepth = () => hist.past.length;

export function useHistory() {
  const [project, setProject] = useState<Project>(cur);
  // another screen may have changed the draft while this one was unmounted
  useEffect(() => setProject(cur()), []);
  const set = useCallback((next: Project) => {
    hist.current = next;
    setProject(next);
  }, []);

  const begin = useCallback(() => {
    hist.pending = hist.current;
  }, []);
  const apply = useCallback(
    (next: Project) => {
      if (hist.pending) {
        hist.past.push(hist.pending);
        if (hist.past.length > HISTORY_LIMIT) hist.past.shift();
        hist.future = [];
        hist.pending = null;
      }
      set(next);
    },
    [set],
  );
  const commit = useCallback(
    (next: Project) => {
      if (next === hist.current) return;
      hist.pending = hist.current;
      apply(next);
    },
    [apply],
  );
  const undo = useCallback(() => {
    hist.pending = null;
    const prev = hist.past.pop();
    if (!prev) return;
    hist.future.push(cur());
    set(prev);
  }, [set]);
  const redo = useCallback(() => {
    hist.pending = null;
    const next = hist.future.pop();
    if (!next) return;
    hist.past.push(cur());
    set(next);
  }, [set]);

  // autosave: debounce, then write the JSON
  const [savedAt, setSavedAt] = useState<string | null>(null);
  useEffect(() => {
    const id = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
        setSavedAt(new Date().toLocaleTimeString());
      } catch {
        /* ignore */
      }
    }, 400);
    return () => clearTimeout(id);
  }, [project]);

  return { project, begin, apply, commit, undo, redo, canUndo: hist.past.length > 0, canRedo: hist.future.length > 0, savedAt };
}
export type History = ReturnType<typeof useHistory>;
