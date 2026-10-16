import type { FileEntry } from "@shared/ipc";
import { RECENT_FILE_LIMIT } from "@shared/recent-history";

export const RECENTS_LIMIT = RECENT_FILE_LIMIT;
export const SWITCHER_LIMIT = 3;

const pushMruId = (ids: string[], id: string, limit: number) => {
  return [id, ...ids.filter((existing) => existing !== id)].slice(0, limit);
};

export const pushRecentId = (ids: string[], id: string) => pushMruId(ids, id, RECENTS_LIMIT);

export const pushSwitcherId = (ids: string[], id: string) => pushMruId(ids, id, SWITCHER_LIMIT);

export const removeRecentIds = (ids: string[], predicate: (id: string) => boolean) => {
  return ids.filter((id) => !predicate(id));
};

export const remapRecentIds = (ids: string[], remap: (id: string) => string) => {
  const seen = new Set<string>();
  const next: string[] = [];

  for (const id of ids) {
    const mapped = remap(id);
    if (!mapped || seen.has(mapped)) continue;
    seen.add(mapped);
    next.push(mapped);
  }

  return next;
};

export const selectRecentFiles = (ids: string[], entries: FileEntry[]): FileEntry[] => {
  const fileById = new Map(
    entries.filter((entry) => entry.kind === "file").map((entry) => [entry.id, entry]),
  );

  const selected: FileEntry[] = [];
  for (const id of ids) {
    if (selected.length >= RECENTS_LIMIT) break;
    const entry = fileById.get(id);
    if (entry) selected.push(entry);
  }

  return selected;
};

export const selectSwitcherCandidates = (ids: string[], entries: FileEntry[]): FileEntry[] => {
  return selectRecentFiles(ids, entries).slice(0, SWITCHER_LIMIT);
};
