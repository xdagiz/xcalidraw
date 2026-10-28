import { isValidViewport, MAX_VIEWPORT_ENTRIES, viewportKey } from "@shared/viewport";
import type { Viewport } from "@shared/viewport";

import { isInsideSubtree, remapId } from "./entry-tree";

export type { Viewport } from "@shared/viewport";

export type ViewportCache = {
  get: (rootPath: string | null, fileId: string) => Viewport | undefined;
  set: (rootPath: string | null, fileId: string, viewport: Viewport) => boolean;
  delete: (rootPath: string | null, fileId: string) => void;
  deleteSubtree: (rootPath: string | null, fileId: string) => void;
  remapSubtree: (rootPath: string | null, fromFileId: string, toFileId: string) => void;
  pruneRoot: (rootPath: string, fileIds: ReadonlySet<string>) => void;
};

export const MAX_VIEWPORT_CACHE_SIZE = MAX_VIEWPORT_ENTRIES;

export const createViewportCache = (): ViewportCache => {
  const entries = new Map<
    string,
    { rootPath: string | null; fileId: string; viewport: Viewport }
  >();

  const setEntry = (rootPath: string | null, fileId: string, viewport: Viewport) => {
    const key = viewportKey(rootPath, fileId);
    entries.delete(key);
    entries.set(key, { rootPath, fileId, viewport: { ...viewport } });
    if (entries.size > MAX_VIEWPORT_CACHE_SIZE) {
      const oldest = entries.keys().next().value;
      if (oldest !== undefined) entries.delete(oldest);
    }
  };

  return {
    get: (rootPath, fileId) => {
      const key = viewportKey(rootPath, fileId);
      const entry = entries.get(key);
      if (!entry || !isValidViewport(entry.viewport)) return undefined;
      setEntry(rootPath, fileId, entry.viewport);
      return { ...entry.viewport };
    },
    set: (rootPath, fileId, viewport) => {
      if (typeof fileId !== "string" || fileId.length === 0 || !isValidViewport(viewport)) {
        return false;
      }
      const previous = entries.get(viewportKey(rootPath, fileId))?.viewport;
      if (
        previous &&
        previous.scrollX === viewport.scrollX &&
        previous.scrollY === viewport.scrollY &&
        previous.zoom === viewport.zoom
      ) {
        return false;
      }
      setEntry(rootPath, fileId, viewport);
      return true;
    },
    delete: (rootPath, fileId) => {
      entries.delete(viewportKey(rootPath, fileId));
    },
    deleteSubtree: (rootPath, fileId) => {
      for (const [key, entry] of entries) {
        if (entry.rootPath === rootPath && isInsideSubtree(fileId, entry.fileId)) {
          entries.delete(key);
        }
      }
    },
    remapSubtree: (rootPath, fromFileId, toFileId) => {
      const matching = [...entries.values()].filter(
        (entry) => entry.rootPath === rootPath && isInsideSubtree(fromFileId, entry.fileId),
      );
      for (const entry of matching) {
        entries.delete(viewportKey(rootPath, entry.fileId));
      }
      for (const entry of matching) {
        setEntry(rootPath, remapId(entry.fileId, fromFileId, toFileId), entry.viewport);
      }
    },
    pruneRoot: (rootPath, fileIds) => {
      for (const [key, entry] of entries) {
        if (entry.rootPath === rootPath && !fileIds.has(entry.fileId)) entries.delete(key);
      }
    },
  };
};

export const viewportCache = createViewportCache();

export const viewportOf = (appState: {
  scrollX: number;
  scrollY: number;
  zoom?: { value: number };
}): Viewport => ({
  scrollX: appState.scrollX,
  scrollY: appState.scrollY,
  zoom: appState.zoom?.value ?? 1,
});

export const applyViewport = <T extends { scrollX: number; scrollY: number; zoom: unknown }>(
  appState: T,
  viewport: Viewport | undefined,
): T => {
  if (!viewport) return appState;
  const zoom =
    typeof appState.zoom === "object" && appState.zoom !== null
      ? { ...appState.zoom, value: viewport.zoom }
      : { value: viewport.zoom };
  return { ...appState, scrollX: viewport.scrollX, scrollY: viewport.scrollY, zoom };
};
