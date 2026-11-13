import type { FileEntry } from "@shared/ipc";

import type { SidebarDropHit } from "@/lib/drop-surface";
import { stripExcalidraw } from "@/lib/utils";

export type DropZone =
  | { kind: "sidebar"; parentId: string | null }
  | { kind: "canvas"; parentId: null };

export const canvasDropZone: DropZone = { kind: "canvas", parentId: null };

export const resolveDropZone = (hit: SidebarDropHit | null): DropZone =>
  hit ? { kind: "sidebar", parentId: hit.parentId } : canvasDropZone;

export const dropDestinationLabel = (
  parentId: string | null,
  entriesById: ReadonlyMap<string, FileEntry>,
) => {
  if (parentId === null) return "your library";
  const entry = entriesById.get(parentId);
  if (!entry || entry.kind !== "directory") return "your library";
  return stripExcalidraw(entry.name);
};
