import {
  isValidViewport,
  MAX_VIEWPORT_ENTRIES,
  MAX_VIEWPORT_STORE_BYTES,
  viewportKey,
  viewportsEqual,
  viewportStoreFrom,
} from "@shared/viewport";
import type { PersistedViewport, Viewport } from "@shared/viewport";

import { isInsideSubtree, remapId } from "./entry-tree";

export const VIEWPORT_PERSISTENCE_DEBOUNCE_MS = 250;

export type ViewportPersistenceStorage = {
  get: () => Promise<string | null>;
  set: (value: string) => Promise<void>;
};

export type ViewportPersistence = {
  get: (rootPath: string | null, fileId: string) => Promise<Viewport | undefined>;
  set: (rootPath: string | null, fileId: string, viewport: Viewport) => Promise<void>;
  deleteSubtree: (rootPath: string | null, fileId: string) => Promise<void>;
  remapSubtree: (rootPath: string | null, fromFileId: string, toFileId: string) => Promise<void>;
  pruneRoot: (rootPath: string | null, fileIds: ReadonlySet<string>) => Promise<void>;
  flush: () => Promise<void>;
};

export const createViewportPersistence = (
  storage: ViewportPersistenceStorage,
  debounceMs = VIEWPORT_PERSISTENCE_DEBOUNCE_MS,
): ViewportPersistence => {
  const entries = new Map<string, PersistedViewport>();
  let loaded: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dirty = false;
  let revision = 0;
  let flushing: Promise<void> | null = null;
  let mutations: Promise<void> = Promise.resolve();

  const ensureLoaded = () => {
    if (loaded) return loaded;
    loaded = storage
      .get()
      .then((raw) => {
        const state = viewportStoreFrom(raw);
        for (const entry of state?.entries ?? []) {
          entries.set(viewportKey(entry.rootPath, entry.fileId), entry);
        }
      })
      .catch((error: unknown) => {
        console.error("Failed to load viewport preferences:", error);
      });
    return loaded;
  };

  const enqueueMutation = (mutation: () => void) => {
    const operation = mutations.then(async () => {
      await ensureLoaded();
      mutation();
    });
    mutations = operation.catch(() => undefined);
    return operation;
  };

  const waitForMutations = async () => {
    for (;;) {
      const observed = mutations;
      await observed;
      if (observed === mutations) return;
    }
  };

  const schedule = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void flush().catch((error: unknown) => {
        console.error("Failed to persist viewport preferences:", error);
      });
    }, debounceMs);
  };

  const markDirty = () => {
    dirty = true;
    revision += 1;
    schedule();
  };

  const serializedEntries = () => {
    let value = JSON.stringify({ version: 1, entries: [...entries.values()] });
    while (
      entries.size > 0 &&
      new TextEncoder().encode(value).byteLength > MAX_VIEWPORT_STORE_BYTES
    ) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
      value = JSON.stringify({ version: 1, entries: [...entries.values()] });
    }
    return value;
  };

  const flush = async () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    await ensureLoaded();
    await waitForMutations();
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }

    if (flushing) {
      await flushing;
      if (dirty) await flush();
      return;
    }

    const run = async () => {
      for (;;) {
        await waitForMutations();
        if (!dirty) break;
        const snapshotRevision = revision;
        const value = serializedEntries();
        dirty = false;
        try {
          await storage.set(value);
        } catch (error) {
          dirty = true;
          throw error;
        }
        if (revision !== snapshotRevision) dirty = true;
      }
    };

    flushing = run();
    try {
      await flushing;
    } finally {
      flushing = null;
    }
  };

  const deleteSubtree = (rootPath: string | null, fileId: string) => {
    if (!rootPath || !fileId) return Promise.resolve();
    return enqueueMutation(() => {
      let changed = false;
      for (const [key, entry] of entries) {
        if (entry.rootPath === rootPath && isInsideSubtree(fileId, entry.fileId)) {
          entries.delete(key);
          changed = true;
        }
      }
      if (changed) markDirty();
    });
  };

  return {
    get: async (rootPath, fileId) => {
      if (!rootPath || !fileId) return undefined;
      await ensureLoaded();
      await waitForMutations();
      const entry = entries.get(viewportKey(rootPath, fileId));
      return entry ? { ...entry.viewport } : undefined;
    },
    set: (rootPath, fileId, viewport) => {
      if (!rootPath || !fileId || !isValidViewport(viewport)) return Promise.resolve();
      const key = viewportKey(rootPath, fileId);
      return enqueueMutation(() => {
        const previous = entries.get(key)?.viewport;
        if (previous && viewportsEqual(previous, viewport)) return;
        entries.delete(key);
        entries.set(key, {
          rootPath,
          fileId,
          viewport: { ...viewport },
          updatedAt: Date.now(),
        });
        while (entries.size > MAX_VIEWPORT_ENTRIES) {
          const oldest = entries.keys().next().value;
          if (oldest === undefined) break;
          entries.delete(oldest);
        }
        markDirty();
      });
    },
    deleteSubtree,
    remapSubtree: (rootPath, fromFileId, toFileId) => {
      if (!rootPath || !fromFileId || !toFileId || fromFileId === toFileId) {
        return Promise.resolve();
      }
      return enqueueMutation(() => {
        const matching = [...entries.values()].filter(
          (entry) => entry.rootPath === rootPath && isInsideSubtree(fromFileId, entry.fileId),
        );
        if (matching.length === 0) return;
        for (const entry of matching) {
          entries.delete(viewportKey(rootPath, entry.fileId));
        }
        for (const entry of matching) {
          const fileId = remapId(entry.fileId, fromFileId, toFileId);
          const key = viewportKey(rootPath, fileId);
          entries.delete(key);
          entries.set(key, { ...entry, fileId });
        }
        markDirty();
      });
    },
    pruneRoot: (rootPath, fileIds) => {
      if (!rootPath) return Promise.resolve();
      return enqueueMutation(() => {
        let changed = false;
        for (const [key, entry] of entries) {
          if (entry.rootPath === rootPath && !fileIds.has(entry.fileId)) {
            entries.delete(key);
            changed = true;
          }
        }
        if (changed) markDirty();
      });
    },
    flush,
  };
};

export const viewportPersistence = createViewportPersistence({
  get: () => window.api.store.get("viewports"),
  set: (value) => window.api.store.set("viewports", value),
});
