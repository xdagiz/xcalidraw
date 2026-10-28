import { codedError, isNotFoundError } from "@shared/errors";
import type {
  AppSettings,
  DrawingInfo,
  DrawingsSnapshot,
  FileEntry,
  FilesChangedEvent,
  SettingsUpdate,
  UnsavedReason,
  WatcherErrorEvent,
} from "@shared/ipc";
import {
  DEFAULT_SETTINGS,
  compareEntryIds,
  type FileDeleteMode,
  sortFileEntries,
} from "@shared/ipc";
import { serializeRecentFileHistory } from "@shared/recent-history";
import { create } from "zustand";

import { toast } from "@/components/ui/toast";
import { saveErrorToastId, toAppError, type AppError } from "@/lib/app-error";
import { createConflictResolver } from "@/lib/conflict-resolution";
import { reduceEntries, removeKey, type ExternalConflict } from "@/lib/conflicts";
import type { SaveOrigin } from "@/lib/drawing-session";
import {
  applySubtreeDelete,
  applySubtreeRemap,
  isInsideSubtree,
  remapId,
  remapNullableId,
} from "@/lib/entry-tree";
import { pushRecentId, pushSwitcherId, remapRecentIds, removeRecentIds } from "@/lib/recent-files";
import { sessionOwner } from "@/lib/session-owner";
import { readStoredTheme, writeStoredTheme } from "@/lib/theme";
import { viewportCache } from "@/lib/viewport-cache";
import { viewportPersistence } from "@/lib/viewport-persistence";

const isOpenableFile = (
  entries: FileEntry[],
  fileId: string | null | undefined,
): fileId is string =>
  typeof fileId === "string" &&
  fileId.length > 0 &&
  entries.some((entry) => entry.id === fileId && entry.kind === "file");

const upsertSorted = (entries: FileEntry[], entry: FileEntry, removeId = entry.id): FileEntry[] => {
  const withoutOld = entries.filter((e) => e.id !== removeId);

  let low = 0;
  let high = withoutOld.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (compareEntryIds(withoutOld[mid].id, entry.id) < 0) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  const next = [...withoutOld];
  next.splice(low, 0, entry);

  return next;
};

const pad2 = (value: number) => `${value}`.padStart(2, "0");

export const drawingTimestamp = (date: Date) => {
  const year = date.getFullYear();
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  const hr = pad2(date.getHours());
  const min = pad2(date.getMinutes());
  return `${year}-${month}-${day}-${hr}${min}`;
};

export const isNameTaken = (entries: FileEntry[], parentId: string | null, candidate: string) => {
  return entries.some((e) => e.parentId === parentId && e.name === candidate);
};

const sameIdList = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((id, i) => b[i] === id);

const persistRecentFileIds = (rootPath: string | null, ids: string[]) => {
  const value = serializeRecentFileHistory(rootPath, ids);
  if (value !== null) void window.api.store.set("recentFiles", value);
};

const flushViewportPreferences = async () => {
  try {
    await viewportPersistence.flush();
  } catch (error) {
    console.error("Failed to persist viewport preferences:", error);
  }
};

export const nextDefaultName = (
  entries: FileEntry[],
  parentId: string | null,
  kind: "file" | "directory",
  now: Date = new Date(),
) => {
  const nameSet = new Set(entries.filter((e) => e.parentId === parentId).map((e) => e.name));
  const base = kind === "directory" ? "New Folder" : `Untitled-${drawingTimestamp(now)}`;
  const suffix = kind === "directory" ? "" : ".excalidraw";

  let n = 1;
  let candidate = `${base}${suffix}`;
  while (nameSet.has(candidate)) {
    n += 1;
    candidate = `${base} ${n}${suffix}`;
  }

  return candidate;
};

export const resolveEntryName = (
  entries: FileEntry[],
  parentId: string | null,
  kind: "file" | "directory",
  requestedName?: string,
) => {
  const trimmed = requestedName?.trim();
  if (trimmed && trimmed.length > 0) return trimmed;
  return nextDefaultName(entries, parentId, kind);
};

export type State = {
  drawings: DrawingInfo | null;
  entries: FileEntry[];
  openFileId: string | null;
  recentFileIds: string[];
  switcherFileIds: string[];
  homeReturnFileId: string | null;
  dirtyById: Record<string, true>;
  rawDirtyById: Record<string, true>;
  error: AppError | null;
  externalConflict: ExternalConflict;
  watcherDown: string | null;
  isLoadingDrawings: boolean;
  pendingCanvasAction: boolean;
  scratchUnsaved: boolean;
  editorGeneration: number;
  settings: AppSettings;
  settingsDialogOpen: boolean;
  editorMounted: boolean;
  paletteOpen: boolean;
  editorPaletteOpen: boolean;
  searchOpen: boolean;
  loadSnapshot: (snapshot: DrawingsSnapshot) => void;
  applyEntries: (event: FilesChangedEvent) => void;
  reportWatcherError: (event: WatcherErrorEvent) => void;
  setOpenFileId: (fileId: string | null) => Promise<boolean>;
  openReservedFile: (fileId: string) => Promise<boolean>;
  openHome: () => Promise<void>;
  renameEntry: (id: string, newName: string) => Promise<FileEntry | null>;
  moveEntry: (id: string, parentId: string | null) => Promise<FileEntry | null>;
  copyEntry: (id: string, parentId: string | null) => Promise<string | null>;
  deleteEntry: (id: string, mode: FileDeleteMode) => Promise<boolean>;
  createEntry: (
    parentId: string | null,
    kind: "file" | "directory",
    requestedName?: string,
  ) => Promise<string | null>;
  createFileWithContent: (
    parentId: string | null,
    fileName: string,
    content: string,
  ) => Promise<string | null>;
  createAndOpenEntry: (
    parentId: string | null,
    kind: "file" | "directory",
    requestedName?: string,
  ) => Promise<string | null>;
  saveFile: (id: string, content: string, origin?: SaveOrigin) => Promise<boolean>;
  overwriteOpenFileFromSession: () => Promise<boolean>;
  setFileDirty: (id: string, dirty: boolean) => void;
  setRawDirty: (id: string, dirty: boolean) => void;
  clearFileMarkers: (id: string) => void;
  setPendingCanvasAction: (pending: boolean) => void;
  setScratchUnsaved: (pending: boolean) => void;
  setSettingsDialogOpen: (open: boolean) => void;
  setEditorMounted: (mounted: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
  setEditorPaletteOpen: (open: boolean) => void;
  setSearchOpen: (open: boolean) => void;
  reportError: (error: unknown, operation: "load" | "save" | "recover" | "settings") => void;
  reloadOpenFileFromDisk: () => void;
  discardMissingOpenFile: () => void;
  resolveChangedConflict: (opts?: {
    force?: boolean;
  }) => Promise<"reload" | "overwrite" | "cancel">;
  recoverMissingOpenFile: () => Promise<boolean>;
  resolveMissingConflict: (
    content?: string,
    opts?: { force?: boolean },
  ) => Promise<"recover" | "discard" | "cancel">;
  ensureCleanOrConfirm: (reason?: UnsavedReason) => Promise<boolean>;
  initSettings: () => Promise<void>;
  updateSettings: (updated: SettingsUpdate) => Promise<boolean>;
  pickAndSwitchFolder: () => Promise<boolean>;
};

type UnsavedSource = Pick<State, "rawDirtyById"> & {
  getSession: (fileId?: string) => { isDirty: () => boolean } | null;
};

export const isUnsaved = (fileId: string, state: UnsavedSource) =>
  state.getSession(fileId)?.isDirty() ?? state.rawDirtyById[fileId] !== undefined;

export const useStore = create<State>((set, get) => {
  const {
    gateConflictedSave,
    recoverMissingOpenFile,
    resolveChangedConflict,
    resolveMissingConflict,
    resetConflicts,
    clearDismissalIfOwned,
    syncDismissal,
  } = createConflictResolver({
    get: () => {
      const s = get();
      return {
        rootPath: s.drawings?.path ?? null,
        editorGeneration: s.editorGeneration,
        entries: s.entries,
        openFileId: s.openFileId,
        dirtyById: s.dirtyById,
        rawDirtyById: s.rawDirtyById,
        error: s.error,
        externalConflict: s.externalConflict,
      };
    },
    set: (patch) => set(patch),
    reloadOpenFileFromDisk: () => get().reloadOpenFileFromDisk(),
    discardMissingOpenFile: () => get().discardMissingOpenFile(),
    commitEntries: sortFileEntries,
  });

  let filesRevision = -1;

  const persistDrawingToDisk = async (id: string, content: string, origin: SaveOrigin) => {
    try {
      const savedEntry = await window.api.files.write(id, content);
      const latest = get();
      const ownsConflict = clearDismissalIfOwned(id);
      set({
        error: null,
        ...(ownsConflict ? { externalConflict: null } : {}),
        entries: sortFileEntries(upsertSorted(latest.entries, savedEntry)),
      });
      toast.close(saveErrorToastId(id));
      return true;
    } catch (error) {
      if (!isNotFoundError(error)) {
        set({ error: toAppError(error, "save", { resourceId: id }) });
        return false;
      }

      const latest = get();
      if (latest.externalConflict?.type !== "missing" || latest.externalConflict.fileId !== id) {
        set({ externalConflict: { type: "missing", fileId: id } });
      }

      if (origin !== "explicit") return false;

      const choice = await get().resolveMissingConflict(content, { force: true });
      return choice !== "cancel";
    }
  };

  const recordOpenedFile = (fileId: string) => {
    const { recentFileIds, switcherFileIds, drawings } = get();
    const nextRecentFileIds = pushRecentId(recentFileIds, fileId);
    const nextSwitcherFileIds = pushSwitcherId(switcherFileIds, fileId);
    set({ recentFileIds: nextRecentFileIds, switcherFileIds: nextSwitcherFileIds });
    persistRecentFileIds(drawings?.path ?? null, nextRecentFileIds);
  };

  const confirmSubtreeChange = async (id: string) => {
    const openId = get().openFileId;
    if (
      isInsideSubtree(id, openId) &&
      isUnsaved(openId, {
        rawDirtyById: get().rawDirtyById,
        getSession: sessionOwner.getSession,
      })
    ) {
      return get().ensureCleanOrConfirm("switch");
    }
    return true;
  };

  const commitSubtreeRemap = async (
    oldId: string,
    entry: FileEntry,
    expectedRootPath: string | null,
  ) => {
    const rootPath = expectedRootPath;
    viewportCache.remapSubtree(rootPath, oldId, entry.id);
    await viewportPersistence.remapSubtree(rootPath, oldId, entry.id).catch((error: unknown) => {
      console.error("Failed to remap viewport preferences:", error);
    });
    if ((get().drawings?.path ?? null) !== expectedRootPath) return null;

    const activeSessionFileId = sessionOwner.getActiveFileId();
    if (activeSessionFileId) {
      const remappedActive = remapId(activeSessionFileId, oldId, entry.id);
      if (remappedActive !== activeSessionFileId) {
        sessionOwner.retargetActive(activeSessionFileId, remappedActive);
      }
    }

    const { entries, openFileId, dirtyById, rawDirtyById, recentFileIds, switcherFileIds } = get();
    const next = applySubtreeRemap(
      { entries, openFileId, dirtyById, rawDirtyById },
      oldId,
      entry.id,
      {
        rootEntry: entry,
        sort: true,
      },
    );

    const pairs = new Map<string, string>();
    for (const existing of entries) {
      const mapped = remapId(existing.id, oldId, entry.id);
      if (mapped !== existing.id) pairs.set(existing.id, mapped);
    }

    const nextRecentFileIds = remapRecentIds(recentFileIds, (rid) => pairs.get(rid) ?? rid);
    const recentChanged = !sameIdList(nextRecentFileIds, recentFileIds);
    const nextSwitcherFileIds = remapRecentIds(switcherFileIds, (rid) => pairs.get(rid) ?? rid);
    const switcherChanged = !sameIdList(nextSwitcherFileIds, switcherFileIds);

    set({
      entries: next.entries,
      openFileId: next.openFileId,
      dirtyById: next.dirtyById,
      rawDirtyById: next.rawDirtyById,
      homeReturnFileId: remapNullableId(get().homeReturnFileId, oldId, entry.id),
      ...(recentChanged ? { recentFileIds: nextRecentFileIds } : {}),
      ...(switcherChanged ? { switcherFileIds: nextSwitcherFileIds } : {}),
      error: null,
    });
    if (recentChanged) persistRecentFileIds(get().drawings?.path ?? null, nextRecentFileIds);

    if (next.openFileId !== openFileId) {
      void window.api.store.set("lastOpenedFileId", next.openFileId);
    }

    return entry;
  };

  return {
    drawings: null,
    entries: [],
    openFileId: null,
    recentFileIds: [],
    switcherFileIds: [],
    homeReturnFileId: null,
    dirtyById: {},
    rawDirtyById: {},
    error: null,
    externalConflict: null,
    watcherDown: null,
    isLoadingDrawings: true,
    pendingCanvasAction: false,
    scratchUnsaved: false,
    editorGeneration: 0,
    settingsDialogOpen: false,
    editorMounted: false,
    paletteOpen: false,
    editorPaletteOpen: false,
    searchOpen: false,
    settings:
      typeof window !== "undefined"
        ? { ...DEFAULT_SETTINGS, theme: readStoredTheme(window.localStorage) }
        : DEFAULT_SETTINGS,

    loadSnapshot: (snapshot) => {
      resetConflicts();
      filesRevision = -1;
      const recentFileIds = removeRecentIds(
        snapshot.prefs.recentFileIds,
        (id) => !isOpenableFile(snapshot.entries, id),
      );
      set((state) => {
        const openFileId =
          state.settings.reopenLastDrawing &&
          isOpenableFile(snapshot.entries, snapshot.prefs.lastOpenedFileId)
            ? snapshot.prefs.lastOpenedFileId
            : null;

        return {
          drawings: snapshot.info,
          entries: sortFileEntries(snapshot.entries),
          openFileId,
          recentFileIds,
          switcherFileIds: openFileId ? [openFileId] : [],
          dirtyById: {},
          rawDirtyById: {},
          error: null,
          watcherDown: null,
          isLoadingDrawings: false,
          pendingCanvasAction: false,
          scratchUnsaved: false,
          editorGeneration: state.editorGeneration + 1,
        };
      });
      if (!sameIdList(recentFileIds, snapshot.prefs.recentFileIds)) {
        persistRecentFileIds(snapshot.info.path, recentFileIds);
      }
      const fileIds = new Set(
        snapshot.entries.filter((entry) => entry.kind === "file").map((entry) => entry.id),
      );
      if (snapshot.info.path !== null && snapshot.info.configured && !snapshot.info.missing) {
        viewportCache.pruneRoot(snapshot.info.path, fileIds);
        void viewportPersistence.pruneRoot(snapshot.info.path, fileIds).catch((error: unknown) => {
          console.error("Failed to prune viewport preferences:", error);
        });
      }
    },

    applyEntries: (event) => {
      if (event.revision > 0 && event.revision <= filesRevision) return;
      const openFileId = get().openFileId;
      const session = openFileId !== null ? sessionOwner.getSession(openFileId) : null;
      session?.evaluateNow();

      const state = get();
      const openFileDirty =
        openFileId !== null
          ? isUnsaved(openFileId, {
              rawDirtyById: state.rawDirtyById,
              getSession: sessionOwner.getSession,
            })
          : false;
      const reduced = reduceEntries(state, event, openFileDirty);

      syncDismissal(reduced.externalConflict);

      const eventIds = event.root === null ? null : new Set(event.entries.map((entry) => entry.id));
      const prunedRecentFileIds =
        eventIds === null
          ? state.recentFileIds
          : removeRecentIds(state.recentFileIds, (rid) => !eventIds.has(rid));
      const recentsChanged = !sameIdList(prunedRecentFileIds, state.recentFileIds);
      const prunedSwitcherFileIds =
        eventIds === null
          ? state.switcherFileIds
          : removeRecentIds(state.switcherFileIds, (rid) => !eventIds.has(rid));
      const switcherChanged = !sameIdList(prunedSwitcherFileIds, state.switcherFileIds);

      set({
        ...reduced,
        entries: sortFileEntries(reduced.entries),
        drawings: event.info ?? state.drawings,
        watcherDown: null,
        ...(recentsChanged ? { recentFileIds: prunedRecentFileIds } : {}),
        ...(switcherChanged ? { switcherFileIds: prunedSwitcherFileIds } : {}),
      });
      if (recentsChanged) {
        persistRecentFileIds(event.info?.path ?? state.drawings?.path ?? null, prunedRecentFileIds);
      }
      if (eventIds !== null) {
        const rootPath = event.root ?? event.info?.path ?? state.drawings?.path ?? null;
        if (rootPath !== null) {
          viewportCache.pruneRoot(rootPath, eventIds);
          void viewportPersistence.pruneRoot(rootPath, eventIds).catch((error: unknown) => {
            console.error("Failed to prune viewport preferences:", error);
          });
        }
      }

      filesRevision = event.revision;
    },

    setOpenFileId: async (fileId) => {
      const current = get().openFileId;
      if (fileId === current) return true;

      const ok = await get().ensureCleanOrConfirm("switch");
      if (!ok) return false;
      await flushViewportPreferences();

      if (fileId === null) {
        set({ openFileId: null, error: null, externalConflict: null });
        void window.api.store.set("lastOpenedFileId", null);
        return true;
      } else if (isOpenableFile(get().entries, fileId)) {
        set({
          openFileId: fileId,
          error: null,
          externalConflict: null,
          editorGeneration: get().editorGeneration + 1,
        });
        recordOpenedFile(fileId);
        void window.api.store.set("lastOpenedFileId", fileId);
        return true;
      } else {
        const { recentFileIds, switcherFileIds, drawings } = get();
        const staleRecentFileIds = removeRecentIds(recentFileIds, (rid) => rid === fileId);
        const staleSwitcherFileIds = removeRecentIds(switcherFileIds, (rid) => rid === fileId);
        set({
          error: null,
          ...(sameIdList(staleRecentFileIds, recentFileIds)
            ? {}
            : { recentFileIds: staleRecentFileIds }),
          ...(sameIdList(staleSwitcherFileIds, switcherFileIds)
            ? {}
            : { switcherFileIds: staleSwitcherFileIds }),
        });
        if (!sameIdList(staleRecentFileIds, recentFileIds)) {
          persistRecentFileIds(drawings?.path ?? null, staleRecentFileIds);
        }
        toast.add({
          title: "Couldn’t open drawing",
          description: "The file no longer exists.",
          type: "error",
        });
        return false;
      }
    },

    openReservedFile: async (fileId) => {
      const current = get().openFileId;
      if (fileId === current) return true;

      if (sessionOwner.getActiveFileId() === fileId) {
        if (!isOpenableFile(get().entries, fileId)) {
          set({ pendingCanvasAction: false, scratchUnsaved: false });
          return false;
        }
        await flushViewportPreferences();

        set({
          openFileId: fileId,
          error: null,
          externalConflict: null,
          pendingCanvasAction: false,
          scratchUnsaved: false,
        });
        recordOpenedFile(fileId);

        void window.api.store.set("lastOpenedFileId", fileId);
        return true;
      }

      await get().setOpenFileId(fileId);
      return true;
    },

    openHome: async () => {
      const current = get().openFileId;
      if (current === null) return;
      await get().setOpenFileId(null);
      if (get().openFileId === null) set({ homeReturnFileId: current });
    },

    renameEntry: async (id, newName) => {
      const rootPath = get().drawings?.path ?? null;
      if (!(await confirmSubtreeChange(id))) return null;
      const entry = await window.api.files.rename(id, newName);
      if ((get().drawings?.path ?? null) !== rootPath) return null;
      return commitSubtreeRemap(id, entry, rootPath);
    },

    moveEntry: async (id, parentId) => {
      const rootPath = get().drawings?.path ?? null;
      const entry = await window.api.files.move(id, parentId);
      if ((get().drawings?.path ?? null) !== rootPath) return null;
      return commitSubtreeRemap(id, entry, rootPath);
    },

    copyEntry: async (id, parentId) => {
      const rootPath = get().drawings?.path ?? null;
      const created = await window.api.files.copy(id, parentId);
      if ((get().drawings?.path ?? null) !== rootPath) return null;
      const root = created[0];
      if (!root) return null;
      set((state) => {
        let entries = state.entries;
        for (const entry of created) entries = upsertSorted(entries, entry);
        return { entries, error: null };
      });
      return root.id;
    },

    deleteEntry: async (id, mode) => {
      const { openFileId, dirtyById, rawDirtyById } = get();

      if (
        isInsideSubtree(id, openFileId) &&
        isUnsaved(openFileId, {
          rawDirtyById: get().rawDirtyById,
          getSession: sessionOwner.getSession,
        })
      ) {
        toast.add({
          title: "Couldn’t delete",
          description: "The folder contains the open drawing with unsaved changes. Close it first.",
          type: "error",
        });
        return false;
      }

      await window.api.files.delete(id, mode);
      const rootPath = get().drawings?.path ?? null;
      viewportCache.deleteSubtree(rootPath, id);
      await viewportPersistence.deleteSubtree(rootPath, id).catch((error: unknown) => {
        console.error("Failed to remove viewport preferences:", error);
      });

      const { entries, recentFileIds, switcherFileIds } = get();
      const next = applySubtreeDelete({ entries, openFileId, dirtyById, rawDirtyById }, id);
      const nextRecentFileIds = removeRecentIds(recentFileIds, (rid) => isInsideSubtree(id, rid));
      const recentChanged = !sameIdList(nextRecentFileIds, recentFileIds);
      const nextSwitcherFileIds = removeRecentIds(switcherFileIds, (rid) =>
        isInsideSubtree(id, rid),
      );
      const switcherChanged = !sameIdList(nextSwitcherFileIds, switcherFileIds);
      const homeReturnFileId = get().homeReturnFileId;

      set({
        entries: next.entries,
        openFileId: next.openFileId,
        dirtyById: next.dirtyById,
        rawDirtyById: next.rawDirtyById,
        homeReturnFileId:
          homeReturnFileId && isInsideSubtree(id, homeReturnFileId) ? null : homeReturnFileId,
        ...(recentChanged ? { recentFileIds: nextRecentFileIds } : {}),
        ...(switcherChanged ? { switcherFileIds: nextSwitcherFileIds } : {}),
        ...(next.openFileId !== openFileId ? { editorGeneration: get().editorGeneration + 1 } : {}),
        error: null,
      });
      if (recentChanged) persistRecentFileIds(get().drawings?.path ?? null, nextRecentFileIds);

      if (next.openedRemoved) void window.api.store.set("lastOpenedFileId", null);

      return true;
    },

    createEntry: async (parentId, kind, requestedName) => {
      const name = resolveEntryName(get().entries, parentId, kind, requestedName);
      const entry = await window.api.files.create(parentId, name, kind);
      set((state) => ({
        entries: sortFileEntries(upsertSorted(state.entries, entry)),
        error: null,
      }));
      return entry.id;
    },

    createFileWithContent: async (parentId, fileName, content) => {
      const entry = await window.api.files.create(parentId, fileName, "file");
      set((state) => ({
        entries: sortFileEntries(upsertSorted(state.entries, entry)),
        error: null,
      }));

      const saved = await get().saveFile(entry.id, content, "explicit");
      if (!saved) {
        await window.api.files.delete(entry.id, "permanent").catch(() => undefined);
        set((state) => ({
          entries: state.entries.filter((e) => e.id !== entry.id),
        }));
        return null;
      }

      return entry.id;
    },

    createAndOpenEntry: async (parentId, kind, requestedName) => {
      if (kind === "file") {
        const okToSwitch = await get().ensureCleanOrConfirm("switch");
        if (!okToSwitch) return null;
      }

      const name = resolveEntryName(get().entries, parentId, kind, requestedName);

      if (kind === "file") await flushViewportPreferences();
      const entry = await window.api.files.create(parentId, name, kind);
      if (kind !== "file") {
        set((state) => ({
          entries: sortFileEntries(upsertSorted(state.entries, entry)),
          error: null,
        }));
        return entry.id;
      }

      set((state) => ({
        entries: sortFileEntries(upsertSorted(state.entries, entry)),
        openFileId: entry.id,
        error: null,
        externalConflict: null,
        editorGeneration: state.editorGeneration + 1,
      }));
      recordOpenedFile(entry.id);

      void window.api.store.set("lastOpenedFileId", entry.id);
      return entry.id;
    },

    saveFile: async (id, content, origin = "auto") => {
      if (!id) return false;
      const gate = await gateConflictedSave(id, content, origin);
      if (gate.action === "stop") return gate.result;
      return persistDrawingToDisk(id, content, origin);
    },

    overwriteOpenFileFromSession: async () => {
      const { openFileId, externalConflict } = get();
      if (!openFileId || externalConflict) return false;

      const session = sessionOwner.getSession();
      if (!session) return false;

      const result = await session.saveNow({ force: true });
      if (result === "failed") {
        set({
          error: toAppError(
            codedError("Your changes couldn't be written to disk", {
              code: "UNKNOWN",
              reason: "io",
            }),
            "save",
            {
              resourceId: openFileId,
            },
          ),
        });
      }

      return result === "saved" || result === "saved-with-changes";
    },

    setFileDirty: (id, dirty) => {
      if (!id) return;
      set((state) => {
        if (dirty) {
          if (state.dirtyById[id]) return state;
          return { dirtyById: { ...state.dirtyById, [id]: true } };
        }

        if (!state.dirtyById[id]) return state;
        const next = { ...state.dirtyById };
        delete next[id];

        return { dirtyById: next };
      });
    },

    setRawDirty: (id, dirty) => {
      if (!id) return;
      set((state) => {
        if (dirty) {
          if (state.rawDirtyById[id]) return state;
          return { rawDirtyById: { ...state.rawDirtyById, [id]: true } };
        }

        if (!state.rawDirtyById[id]) return state;
        const next = { ...state.rawDirtyById };
        delete next[id];

        return { rawDirtyById: next };
      });
    },

    clearFileMarkers: (id) => {
      if (!id) return;
      set((state) => {
        if (!state.dirtyById[id] && !state.rawDirtyById[id]) return state;
        const dirtyById = { ...state.dirtyById };
        const rawDirtyById = { ...state.rawDirtyById };
        delete dirtyById[id];
        delete rawDirtyById[id];
        return { dirtyById, rawDirtyById };
      });
    },

    setPendingCanvasAction: (pending) => set({ pendingCanvasAction: pending }),
    setScratchUnsaved: (pending) => set({ scratchUnsaved: pending }),

    reportError: (error, operation) =>
      set({
        error: toAppError(error, operation),
        ...(operation === "load" ? { isLoadingDrawings: false } : {}),
      }),
    reportWatcherError: (event) => set({ watcherDown: event.message }),
    setSettingsDialogOpen: (open) => set({ settingsDialogOpen: open }),
    setEditorMounted: (mounted) =>
      set((state) => {
        if (state.editorMounted === mounted) return state;
        return mounted ? { editorMounted: true, paletteOpen: false } : { editorMounted: false };
      }),
    setPaletteOpen: (open) => set({ paletteOpen: open }),
    setEditorPaletteOpen: (open) =>
      set((state) => (state.editorPaletteOpen === open ? state : { editorPaletteOpen: open })),
    setSearchOpen: (open) => set({ searchOpen: open }),
    resolveChangedConflict,
    resolveMissingConflict,
    recoverMissingOpenFile,

    reloadOpenFileFromDisk: () => {
      const { openFileId, dirtyById, rawDirtyById, editorGeneration } = get();
      if (!openFileId) {
        set({ externalConflict: null });
        return;
      }

      sessionOwner.getSession(openFileId)?.invalidate();
      set({
        externalConflict: null,
        dirtyById: removeKey(dirtyById, openFileId),
        rawDirtyById: removeKey(rawDirtyById, openFileId),
        editorGeneration: editorGeneration + 1,
        error: null,
      });
    },

    discardMissingOpenFile: () => {
      const { openFileId, dirtyById, rawDirtyById, recentFileIds, switcherFileIds, drawings } =
        get();
      const nextRecentFileIds = openFileId
        ? removeRecentIds(recentFileIds, (rid) => rid === openFileId)
        : recentFileIds;
      const recentChanged = !sameIdList(nextRecentFileIds, recentFileIds);
      const nextSwitcherFileIds = openFileId
        ? removeRecentIds(switcherFileIds, (rid) => rid === openFileId)
        : switcherFileIds;
      const switcherChanged = !sameIdList(nextSwitcherFileIds, switcherFileIds);

      set({
        openFileId: null,
        externalConflict: null,
        dirtyById: openFileId ? removeKey(dirtyById, openFileId) : dirtyById,
        rawDirtyById: openFileId ? removeKey(rawDirtyById, openFileId) : rawDirtyById,
        ...(recentChanged ? { recentFileIds: nextRecentFileIds } : {}),
        ...(switcherChanged ? { switcherFileIds: nextSwitcherFileIds } : {}),
        ...(openFileId ? { editorGeneration: get().editorGeneration + 1 } : {}),
        error: null,
      });
      if (recentChanged) persistRecentFileIds(drawings?.path ?? null, nextRecentFileIds);

      void window.api.store.set("lastOpenedFileId", null);
    },

    ensureCleanOrConfirm: async (reason = "switch") => {
      const session = sessionOwner.getSession();
      if (!session) {
        const id = get().openFileId;
        return !id || get().rawDirtyById[id] === undefined;
      }

      return session.ensureCleanOrConfirm(reason);
    },

    initSettings: async () => {
      try {
        const settings = await window.api.settings.get();
        writeStoredTheme(window.localStorage, settings.theme);
        set({ settings });
      } catch (error) {
        console.error("failed to load settings:", error);
        toast.add({
          title: "Couldn’t load settings",
          description: "Your saved preferences couldn’t be loaded.",
          type: "warning",
        });
      }
    },

    updateSettings: async (updated) => {
      const settings = await window.api.settings.update(updated);
      writeStoredTheme(window.localStorage, settings.theme);
      set({ settings });
      return true;
    },

    pickAndSwitchFolder: async () => {
      const ok = await get().ensureCleanOrConfirm("switch");
      if (!ok) return false;

      const previousPath = get().drawings?.path ?? null;

      let info: DrawingInfo | null = null;
      try {
        info = await window.api.drawings.pick();
      } catch (error) {
        toast.add({
          title: "Couldn’t choose the drawings folder",
          description: toAppError(error, "unexpected").detail,
          type: "error",
        });
        return false;
      }

      if (info === null) return false;
      if (info.path !== null && info.path === previousPath && info.configured) return true;

      await flushViewportPreferences();
      const pausedSession = sessionOwner.getSession();
      pausedSession?.setAutosavePaused(true);
      try {
        resetConflicts();
        filesRevision = -1;

        set({
          drawings: info,
          entries: [],
          openFileId: null,
          recentFileIds: [],
          switcherFileIds: [],
          homeReturnFileId: null,
          dirtyById: {},
          rawDirtyById: {},
          error: null,
          watcherDown: null,
          isLoadingDrawings: true,
        });
        void window.api.store.set("lastOpenedFileId", null);

        try {
          const snapshot = await window.api.drawings.load();
          get().loadSnapshot(snapshot);
        } catch (error) {
          get().reportError(error, "load");
        }
      } finally {
        pausedSession?.setAutosavePaused(false);
      }

      return true;
    },
  };
});
