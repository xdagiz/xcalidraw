import type { FileEntry } from "@shared/ipc";
import { parentIdOf } from "@shared/ipc";

import { isInsideSubtree, remapId } from "./entry-tree";

export { nextCopyName } from "@shared/ipc";

export const EXPANDED_FOLDERS_STORAGE_KEY = "xcalidraw.expandedFolderIds";

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

const rankOf = (entry: FileEntry): number => (entry.kind === "directory" ? 0 : 1);

export const sortSiblings = (children: FileEntry[]): FileEntry[] =>
  children.toSorted((a, b) => {
    const rankDelta = rankOf(a) - rankOf(b);
    if (rankDelta !== 0) return rankDelta;
    return collator.compare(a.name, b.name);
  });

export const buildSortedChildIndex = (entries: FileEntry[]) => {
  const index = new Map<string | null, FileEntry[]>();

  for (const entry of entries) {
    const siblings = index.get(entry.parentId);
    if (siblings) {
      siblings.push(entry);
    } else {
      index.set(entry.parentId, [entry]);
    }
  }

  for (const [parent, children] of index) index.set(parent, sortSiblings(children));
  return index;
};

export const buildEntriesById = (entries: FileEntry[]) => {
  const map = new Map<string, FileEntry>();
  for (const entry of entries) map.set(entry.id, entry);
  return map;
};

export type VisibleTreeEntry = {
  entry: FileEntry;
  level: number;
  posInSet: number;
  setSize: number;
  isExpanded: boolean;
};

export const flattenVisibleEntries = (
  childIndex: Map<string | null, FileEntry[]>,
  expandedIds: Set<string>,
): VisibleTreeEntry[] => {
  const visible: VisibleTreeEntry[] = [];

  const walk = (siblings: FileEntry[], level: number) => {
    siblings.forEach((entry, posInSet) => {
      const isExpanded = expandedIds.has(entry.id);
      visible.push({ entry, level, posInSet, setSize: siblings.length, isExpanded });
      if (isExpanded) walk(childIndex.get(entry.id) ?? [], level + 1);
    });
  };

  walk(childIndex.get(null) ?? [], 0);
  return visible;
};

export const TYPEAHEAD_RESET_MS = 500;

export const findTypeaheadMatch = (names: string[], startIndex: number, query: string) => {
  const count = names.length;
  if (!query || count === 0) return null;

  const needle = query.toLowerCase();
  for (let step = 1; step <= count; step += 1) {
    const index = (startIndex + step) % count;
    if (names[index].toLowerCase().startsWith(needle)) return index;
  }

  return null;
};

export const ancestorIdsOf = (id: string) => {
  const out: string[] = [];
  let current = parentIdOf(id);

  while (current !== null) {
    out.push(current);
    current = parentIdOf(current);
  }

  out.reverse();
  return out;
};

type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "setItem">;

const parseExpandedFolderIds = (raw: string | null): Set<string> => {
  if (!raw) return new Set();

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((value): value is string => typeof value === "string"));
  } catch {
    return new Set();
  }
};

export const readExpandedFolderIds = (storage: StorageReader): Set<string> => {
  try {
    return parseExpandedFolderIds(storage.getItem(EXPANDED_FOLDERS_STORAGE_KEY));
  } catch {
    return new Set();
  }
};

export const MAX_EXPANDED_FOLDERS = 500;

export const pasteParentId = (focused: FileEntry | null) => {
  if (!focused) return null;
  return focused.kind === "directory" ? focused.id : focused.parentId;
};

export const canReparent = (
  sourceId: string,
  destParentId: string | null,
  entries: readonly FileEntry[],
): { ok: true } | { ok: false; reason: "into-self" | "same-parent" } => {
  if (destParentId !== null && isInsideSubtree(sourceId, destParentId)) {
    return { ok: false, reason: "into-self" };
  }

  const source = entries.find((entry) => entry.id === sourceId);
  const currentParent = source ? source.parentId : parentIdOf(sourceId);
  if (currentParent === destParentId) return { ok: false, reason: "same-parent" };
  return { ok: true };
};

export const remapExpandedIds = (
  ids: Iterable<string>,
  oldRoot: string,
  newRoot: string,
): Set<string> => {
  const next = new Set<string>();
  for (const id of ids) next.add(remapId(id, oldRoot, newRoot));
  return next;
};

export type DropRow = {
  id: string;
  kind: "file" | "directory";
  parentId: string | null;
};

export const dropParentAtOffset = (
  rows: readonly DropRow[],
  offsetPx: number,
  rowHeight: number,
) => {
  if (rowHeight <= 0 || rows.length === 0) return null;
  if (offsetPx < 0 || offsetPx >= rows.length * rowHeight) return null;
  const row = rows[Math.floor(offsetPx / rowHeight)];
  if (!row) return null;
  return row.kind === "directory" ? row.id : row.parentId;
};

export const writeExpandedFolderIds = (storage: StorageWriter, ids: Iterable<string>) => {
  try {
    const list = [...ids];
    storage.setItem(
      EXPANDED_FOLDERS_STORAGE_KEY,
      JSON.stringify(
        list.length > MAX_EXPANDED_FOLDERS ? list.slice(0, MAX_EXPANDED_FOLDERS) : list,
      ),
    );
  } catch {
    return;
  }
};
