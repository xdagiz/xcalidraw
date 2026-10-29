import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { AutosaveSetting, FileEntry, UnsavedChoice, UnsavedReason } from "@shared/ipc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@excalidraw/excalidraw", () => ({
  serializeAsJSON: (elements: unknown, appState: unknown, files: unknown) =>
    JSON.stringify({ elements, appState, files }),
}));

vi.mock("@/components/ui/toast", () => ({
  toast: { add: vi.fn(), close: vi.fn() },
}));

import { buildCommands } from "./commands";
import { createDrawingSession, type FrameScheduler } from "./drawing-session";
import { sessionOwner } from "./session-owner";
import { useStore } from "./store";
import { viewportCache } from "./viewport-cache";
import { viewportPersistence } from "./viewport-persistence";

const fileId = "a.excalidraw";
const entry = (modifiedAt: number): FileEntry => ({
  id: fileId,
  name: fileId,
  kind: "file",
  parentId: null,
  modifiedAt,
  size: 100,
  ino: "1",
  dev: "1",
});
const appState = { isLoading: false, viewBackgroundColor: "#ffffff" } as AppState;
const elements = [{ id: "local-stroke", type: "rectangle" }] as OrderedExcalidrawElement[];
const files = {
  image: {
    id: "image",
    mimeType: "image/png",
    dataURL: "data:image/png;base64,bG9jYWw=",
    created: 1,
  },
} as unknown as BinaryFiles;
const write = vi.fn<(id: string, content: string) => Promise<FileEntry>>();
const unsavedChanges = vi.fn<(reason: UnsavedReason) => Promise<UnsavedChoice>>();
const reloadCommand = buildCommands({
  openSettings: vi.fn(),
  openRenameDialog: vi.fn(),
  openDeleteDialog: vi.fn(),
  toggleSidebar: vi.fn(),
}).find((command) => command.id === "reload-from-disk")!;
let revision = 0;
const externalEvent = (kind: "changed" | "missing") => ({
  entries: kind === "changed" ? [entry(200)] : [],
  revision: ++revision,
  root: "/drawings",
});

const openSession = (id = fileId, initialAutosave?: AutosaveSetting) => {
  let frame: (() => void) | null = null;
  const scheduleFrame: FrameScheduler = (callback) => {
    frame = callback;
    return () => {
      frame = null;
    };
  };
  const session = sessionOwner.acquire(
    id,
    createDrawingSession({
      fileId: id,
      save: (sid, content, origin) => useStore.getState().saveFile(sid, content, origin),
      onDirtyChange: (sid, dirty) => useStore.getState().setFileDirty(sid, dirty),
      onRawDirtyChange: (sid, dirty) => useStore.getState().setRawDirty(sid, dirty),
      initialAutosave,
      scheduleFrame,
    }),
  );
  session.onChange([], appState, {});
  return {
    session,
    hasPendingFrame: () => frame !== null,
    fireFrame: () => {
      const callback = frame;
      frame = null;
      callback?.();
    },
  };
};

beforeEach(() => {
  revision += 2;
  vi.useFakeTimers();
  write.mockReset().mockResolvedValue(entry(150));
  unsavedChanges.mockReset().mockResolvedValue("cancel");
  vi.stubGlobal("window", {
    api: {
      files: { write },
      dialog: { unsavedChanges },
      store: { get: vi.fn().mockResolvedValue(null), set: vi.fn() },
    },
  });
  useStore.setState(useStore.getInitialState(), true);
  useStore.setState({ entries: [entry(100)], openFileId: fileId, editorGeneration: 7 });
});

afterEach(() => {
  sessionOwner.releaseActive();
  useStore.setState(useStore.getInitialState(), true);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("loadSnapshot viewport pruning", () => {
  it("preserves viewports for a missing drawings folder and prunes stale entries when available", () => {
    const root = "/drawings";
    const keptViewport = { scrollX: 12, scrollY: -8, zoom: 2.5 };
    const staleViewport = { scrollX: 24, scrollY: -16, zoom: 1.5 };
    viewportCache.set(root, fileId, keptViewport);
    viewportCache.set(root, "b.excalidraw", staleViewport);
    const pruneCache = vi.spyOn(viewportCache, "pruneRoot");
    const prunePersistence = vi
      .spyOn(viewportPersistence, "pruneRoot")
      .mockResolvedValue(undefined);

    useStore.getState().loadSnapshot({
      info: {
        path: root,
        displayPath: root,
        displayName: "drawings",
        configured: false,
        missing: true,
      },
      entries: [],
      prefs: { lastOpenedFileId: null, recentFileIds: [] },
    });

    expect(pruneCache).not.toHaveBeenCalled();
    expect(prunePersistence).not.toHaveBeenCalled();
    expect(viewportCache.get(root, fileId)).toEqual(keptViewport);
    expect(viewportCache.get(root, "b.excalidraw")).toEqual(staleViewport);

    useStore.getState().loadSnapshot({
      info: {
        path: root,
        displayPath: root,
        displayName: "drawings",
        configured: true,
        missing: false,
      },
      entries: [entry(100)],
      prefs: { lastOpenedFileId: null, recentFileIds: [] },
    });

    expect(pruneCache).toHaveBeenCalledOnce();
    expect(prunePersistence).toHaveBeenCalledOnce();
    expect(viewportCache.get(root, fileId)).toEqual(keptViewport);
    expect(viewportCache.get(root, "b.excalidraw")).toBeUndefined();
  });
});

describe("renameEntry", () => {
  it("returns null without renaming when the unsaved-changes confirmation is cancelled", async () => {
    const rename = vi.fn();
    Object.assign(window.api.files, { rename });
    const { session, fireFrame } = openSession(fileId, { mode: "off" });
    session.onChange(elements, appState, files);
    fireFrame();
    const state = useStore.getState();

    expect(await useStore.getState().renameEntry(fileId, "Renamed")).toBeNull();
    expect(unsavedChanges).toHaveBeenCalledExactlyOnceWith("switch");
    expect(rename).not.toHaveBeenCalled();
    expect(useStore.getState()).toBe(state);
    expect(session.isDirty()).toBe(true);
  });

  it("prompts in always mode when raw is dirty but the visible marker is suppressed", async () => {
    const rename = vi.fn();
    Object.assign(window.api.files, { rename });
    Object.assign(window.api, { store: { set: vi.fn() } });
    const { session, fireFrame } = openSession(fileId, { mode: "always" });
    session.onChange(elements, appState, files);
    fireFrame();

    expect(session.isDirty()).toBe(true);
    expect(useStore.getState().dirtyById).toEqual({});
    expect(useStore.getState().rawDirtyById).toEqual({ [fileId]: true });

    expect(await useStore.getState().renameEntry(fileId, "Renamed")).toBeNull();
    expect(unsavedChanges).toHaveBeenCalledExactlyOnceWith("switch");
    expect(rename).not.toHaveBeenCalled();
  });

  it("returns the renamed entry after updating state so a fresh drawing can be opened", async () => {
    const created: FileEntry = {
      id: "Untitled.excalidraw",
      name: "Untitled.excalidraw",
      kind: "file",
      parentId: null,
      modifiedAt: 100,
      size: 0,
      ino: "1",
      dev: "1",
    };
    const renamed: FileEntry = {
      ...created,
      id: "My drawing.excalidraw",
      name: "My drawing.excalidraw",
      modifiedAt: 200,
    };
    Object.assign(window.api.files, {
      create: vi.fn().mockResolvedValue(created),
      rename: vi.fn().mockResolvedValue(renamed),
    });
    Object.assign(window.api, { store: { set: vi.fn() } });

    const createdId = await useStore.getState().createEntry(null, "file");
    if (createdId === null) throw new Error("createEntry returned no id");

    const result = await useStore.getState().renameEntry(createdId, "My drawing");

    expect(result).not.toBeNull();
    expect(result).toBe(renamed);
    expect(useStore.getState().entries).toContainEqual(renamed);
    expect(useStore.getState().entries.some((item) => item.id === createdId)).toBe(false);
    expect(useStore.getState().openFileId).toBe(fileId);
    expect(await useStore.getState().setOpenFileId(createdId)).toBe(false);
    expect(useStore.getState().openFileId).toBe(fileId);
    expect(await useStore.getState().setOpenFileId(result!.id)).toBe(true);
    expect(useStore.getState().openFileId).toBe("My drawing.excalidraw");
  });
});

describe("deleteEntry", () => {
  it("blocks in always mode when raw is dirty but the visible marker is suppressed", async () => {
    const del = vi.fn();
    Object.assign(window.api.files, { delete: del });
    const { session, fireFrame } = openSession(fileId, { mode: "always" });
    session.onChange(elements, appState, files);
    fireFrame();

    expect(session.isDirty()).toBe(true);
    expect(useStore.getState().dirtyById).toEqual({});
    expect(useStore.getState().rawDirtyById).toEqual({ [fileId]: true });

    expect(await useStore.getState().deleteEntry(fileId, "permanent")).toBe(false);
    expect(del).not.toHaveBeenCalled();
  });
});

const folderEntry = (
  id: string,
  parentId: string | null,
  kind: "file" | "directory" = "file",
): FileEntry => ({
  id,
  name: id.split("/").pop() ?? id,
  kind,
  parentId,
  modifiedAt: 100,
  size: kind === "file" ? 10 : 0,
  ino: "1",
  dev: "1",
});

describe("moveEntry", () => {
  it("preserves unsaved edits when moving a folder fails", async () => {
    const move = vi.fn().mockRejectedValue(new Error("destination already exists"));
    Object.assign(window.api.files, { move });
    const { session, fireFrame } = openSession("notes/a.excalidraw", { mode: "off" });
    useStore.setState({
      entries: [
        folderEntry("notes", null, "directory"),
        folderEntry("notes/a.excalidraw", "notes"),
      ],
      openFileId: "notes/a.excalidraw",
    });
    session.onChange(elements, appState, files);
    fireFrame();

    await expect(useStore.getState().moveEntry("notes", "archive")).rejects.toThrow(
      "destination already exists",
    );
    expect(move).toHaveBeenCalledWith("notes", "archive");
    expect(unsavedChanges).not.toHaveBeenCalled();
    expect(session.isDirty()).toBe(true);
    expect(useStore.getState().dirtyById).toEqual({ "notes/a.excalidraw": true });
  });

  it("does not apply a late move to a different drawings folder", async () => {
    const pending = Promise.withResolvers<FileEntry>();
    const move = vi.fn(() => pending.promise);
    Object.assign(window.api.files, { move });
    useStore.setState({
      drawings: {
        path: "/first",
        displayPath: "/first",
        displayName: "first",
        configured: true,
        missing: false,
      },
      entries: [
        folderEntry("notes", null, "directory"),
        folderEntry("notes/a.excalidraw", "notes"),
      ],
    });

    const moving = useStore.getState().moveEntry("notes", "archive");
    useStore.setState({
      drawings: {
        path: "/second",
        displayPath: "/second",
        displayName: "second",
        configured: true,
        missing: false,
      },
      entries: [
        folderEntry("notes", null, "directory"),
        folderEntry("notes/a.excalidraw", "notes"),
      ],
    });
    pending.resolve(folderEntry("archive/notes", "archive", "directory"));

    expect(await moving).toBeNull();
    expect(useStore.getState().entries.map((item) => item.id)).toEqual([
      "notes",
      "notes/a.excalidraw",
    ]);
  });

  it("remaps the open drawing, a dirty sibling, and recents", async () => {
    const moved = folderEntry("archive/notes", "archive", "directory");
    const move = vi.fn().mockResolvedValue(moved);
    const set = vi.fn();
    Object.assign(window.api.files, { move });
    Object.assign(window.api, { store: { set } });
    useStore.setState({
      entries: [
        folderEntry("notes", null, "directory"),
        folderEntry("notes/a.excalidraw", "notes"),
        folderEntry("notes/b.excalidraw", "notes"),
      ],
      openFileId: "notes/a.excalidraw",
      dirtyById: { "notes/b.excalidraw": true },
      recentFileIds: ["notes/a.excalidraw"],
      externalConflict: {
        type: "changed",
        fileId: "notes/a.excalidraw",
        diskModifiedAt: 200,
      },
      homeReturnFileId: "notes/a.excalidraw",
    });

    const result = await useStore.getState().moveEntry("notes", "archive");

    expect(result).toBe(moved);
    expect(move).toHaveBeenCalledWith("notes", "archive");
    expect(useStore.getState().openFileId).toBe("archive/notes/a.excalidraw");
    expect(useStore.getState().dirtyById).toEqual({ "archive/notes/b.excalidraw": true });
    expect(useStore.getState().recentFileIds).toEqual(["archive/notes/a.excalidraw"]);
    expect(useStore.getState().externalConflict).toEqual({
      type: "changed",
      fileId: "archive/notes/a.excalidraw",
      diskModifiedAt: 200,
    });
    expect(useStore.getState().homeReturnFileId).toBe("archive/notes/a.excalidraw");
    expect(set).toHaveBeenCalledWith("lastOpenedFileId", "archive/notes/a.excalidraw");
    expect(useStore.getState().entries.map((item) => item.id)).toEqual([
      "archive/notes",
      "archive/notes/a.excalidraw",
      "archive/notes/b.excalidraw",
    ]);
  });
});

describe("copyEntry", () => {
  it("copies the disk version of an unsaved open drawing without asking to discard it", async () => {
    const created = [folderEntry("a copy.excalidraw", null)];
    const copy = vi.fn().mockResolvedValue(created);
    Object.assign(window.api.files, { copy });
    const { session, fireFrame } = openSession(fileId, { mode: "off" });
    session.onChange(elements, appState, files);
    fireFrame();

    expect(await useStore.getState().copyEntry(fileId, null)).toBe("a copy.excalidraw");
    expect(unsavedChanges).not.toHaveBeenCalled();
    expect(copy).toHaveBeenCalledWith(fileId, null);
  });

  it("does not insert a late copy into a different drawings folder", async () => {
    const pending = Promise.withResolvers<FileEntry[]>();
    const copy = vi.fn(() => pending.promise);
    Object.assign(window.api.files, { copy });
    useStore.setState({
      drawings: {
        path: "/first",
        displayPath: "/first",
        displayName: "first",
        configured: true,
        missing: false,
      },
    });

    const copying = useStore.getState().copyEntry(fileId, null);
    useStore.setState({
      drawings: {
        path: "/second",
        displayPath: "/second",
        displayName: "second",
        configured: true,
        missing: false,
      },
      entries: [folderEntry(fileId, null)],
    });
    pending.resolve([folderEntry("a copy.excalidraw", null)]);

    expect(await copying).toBeNull();
    expect(useStore.getState().entries.map((item) => item.id)).toEqual([fileId]);
  });

  it("inserts the copied entries without changing the open drawing", async () => {
    const created = [folderEntry("a copy.excalidraw", null)];
    const copy = vi.fn().mockResolvedValue(created);
    Object.assign(window.api.files, { copy });
    useStore.setState({
      entries: [folderEntry(fileId, null)],
      openFileId: fileId,
    });

    expect(await useStore.getState().copyEntry(fileId, "notes")).toBe("a copy.excalidraw");
    expect(copy).toHaveBeenCalledWith(fileId, "notes");
    expect(useStore.getState().openFileId).toBe(fileId);
    expect(
      useStore
        .getState()
        .entries.map((item) => item.id)
        .toSorted(),
    ).toEqual(["a copy.excalidraw", fileId]);
  });
});

describe("missing-file recovery", () => {
  const prepareRecovery = (mode: AutosaveSetting = { mode: "interval", ms: 5000 }) => {
    const pending = Promise.withResolvers<FileEntry>();
    const writeRecover = vi.fn<(id: string, content: string) => Promise<FileEntry>>(
      () => pending.promise,
    );
    const list = vi.fn().mockRejectedValue(new Error("listing unavailable"));
    Object.assign(window.api.files, { writeRecover, list });
    Object.assign(window.api.dialog, { fileRecover: vi.fn().mockResolvedValue("recover") });
    const opened = openSession(fileId, mode);
    opened.session.onChange(elements, appState, files);
    useStore.getState().applyEntries(externalEvent("missing"));
    return { ...opened, pending, writeRecover, list };
  };

  it("failed recovery preserves the conflict and newer scene", async () => {
    const { session, pending, writeRecover } = prepareRecovery({ mode: "off" });
    const conflict = useStore.getState().externalConflict;
    const recovering = useStore.getState().recoverMissingOpenFile();
    await vi.advanceTimersByTimeAsync(0);
    expect(writeRecover).toHaveBeenCalledTimes(1);
    expect(JSON.parse(writeRecover.mock.calls[0][1])).toEqual({ elements, appState, files });
    session.onChange([{ id: "B", type: "ellipse" } as OrderedExcalidrawElement], appState, files);
    session.evaluateNow();
    pending.reject(new Error("recovery write failed"));
    expect(await recovering).toBe(false);
    expect(useStore.getState().externalConflict).toBe(conflict);
    expect(useStore.getState().error?.operation).toBe("recover");
    expect(session.isDirty()).toBe(true);
    expect(useStore.getState().dirtyById).toEqual({ [fileId]: true });
    expect(JSON.parse(session.getSerializedContent()!).elements).toEqual([
      { id: "B", type: "ellipse" },
    ]);
  });

  it.each(["dispose", "root"] as const)(
    "stale recovery does not apply a late success after %s",
    async (change) => {
      sessionOwner.releaseActive();
      useStore.setState({
        entries: [entry(100)],
        openFileId: fileId,
        dirtyById: {},
        error: null,
        externalConflict: null,
      });
      const { session, pending, writeRecover } = prepareRecovery({ mode: "off" });
      const recovering = useStore.getState().recoverMissingOpenFile();
      await vi.advanceTimersByTimeAsync(0);
      expect(writeRecover).toHaveBeenCalledTimes(1);
      if (change === "dispose") session.dispose();
      if (change === "root") {
        useStore.getState().loadSnapshot({
          info: {
            path: "/other",
            displayPath: null,
            displayName: "Other",
            configured: true,
            missing: false,
          },
          entries: [{ ...entry(900), id: "other.excalidraw", name: "other.excalidraw" }],
          prefs: { lastOpenedFileId: null, recentFileIds: [] },
        });
      }
      const state = useStore.getState();
      const active = sessionOwner.getSession();
      const content = active?.getSerializedContent();
      const dirty = active?.isDirty();
      pending.resolve(entry(300));
      expect(await recovering).toBe(false);
      if (change === "root") {
        expect(useStore.getState()).toBe(state);
      } else {
        const next = useStore.getState();
        expect(next).not.toBe(state);
        expect(next.entries).toEqual([entry(300)]);
        expect(next.error).toBe(state.error);
        expect(next.externalConflict).toBe(state.externalConflict);
        expect(next.dirtyById).toBe(state.dirtyById);
        expect(next.openFileId).toBe(state.openFileId);
      }
      expect(active?.getSerializedContent()).toBe(content);
      expect(active?.isDirty()).toBe(dirty);
    },
  );

  it("upserts the recovered entry when the root is intact but the conflict moved on", async () => {
    const { pending } = prepareRecovery({ mode: "off" });
    const recovering = useStore.getState().recoverMissingOpenFile();
    await vi.advanceTimersByTimeAsync(0);

    const other = { ...entry(200), id: "other.excalidraw", name: "other.excalidraw" };
    useStore.setState({ entries: [other], openFileId: other.id, externalConflict: null });

    pending.resolve(entry(300));
    expect(await recovering).toBe(false);

    const state = useStore.getState();
    expect(state.entries).toEqual([entry(300), other]);
    expect(state.openFileId).toBe(other.id);
    expect(state.externalConflict).toBeNull();
  });

  it("acknowledges an unchanged recovery without a refresh or redundant write", async () => {
    const { session, pending, list } = prepareRecovery({ mode: "interval", ms: 5000 });
    const recovering = useStore.getState().recoverMissingOpenFile();
    pending.resolve(entry(300));
    expect(await recovering).toBe(true);
    expect(session.isDirty()).toBe(false);
    expect(useStore.getState().dirtyById).toEqual({});
    expect(useStore.getState().externalConflict).toBeNull();
    expect(useStore.getState().entries).toEqual([entry(300)]);
    expect(useStore.getState().error).toBeNull();
    expect(list).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30000);
    expect(write).not.toHaveBeenCalled();
  });

  it("retains a pending-frame edit without persisting it in off mode", async () => {
    const { session, pending, hasPendingFrame } = prepareRecovery({ mode: "off" });
    const recovering = useStore.getState().recoverMissingOpenFile();
    session.onChange([{ id: "B", type: "ellipse" } as OrderedExcalidrawElement], appState, files);
    expect(hasPendingFrame()).toBe(true);
    pending.resolve(entry(300));
    expect(await recovering).toBe(true);
    expect(hasPendingFrame()).toBe(false);
    expect(session.isDirty()).toBe(true);
    expect(useStore.getState().dirtyById).toEqual({ [fileId]: true });
    await vi.advanceTimersByTimeAsync(30000);
    expect(write).not.toHaveBeenCalled();
    expect(session.isDirty()).toBe(true);
  });
});

describe("reload-from-disk command", () => {
  it("asks before discarding a dirty scene and aborts when cancelled", async () => {
    const { session } = openSession(fileId, { mode: "interval", ms: 5000 });
    session.onChange(elements, appState, files);

    await reloadCommand.perform({ store: useStore.getState(), session });

    expect(unsavedChanges).toHaveBeenCalledExactlyOnceWith("switch");
    expect(useStore.getState().editorGeneration).toBe(7);
    expect(session.isDirty()).toBe(true);
    expect(JSON.parse(session.getSerializedContent()!)).toEqual({ elements, appState, files });
    expect(write).not.toHaveBeenCalled();
  });
});

describe("applyEntries with drawing sessions", () => {
  it("retains an unevaluated always-autosave edit when the open file changes externally", () => {
    const { session } = openSession();
    session.onChange(elements, appState, files);
    expect(session.isDirty()).toBe(false);
    expect(useStore.getState().dirtyById).toEqual({});

    useStore.getState().applyEntries(externalEvent("changed"));

    expect(useStore.getState().externalConflict).toEqual({
      type: "changed",
      fileId,
      diskModifiedAt: 200,
    });
    expect(useStore.getState().openFileId).toBe(fileId);
    expect(useStore.getState().editorGeneration).toBe(7);
    expect(session.isDirty()).toBe(true);
    expect(JSON.parse(session.getSerializedContent()!)).toEqual({ elements, appState, files });
  });

  it("uses clean behavior after the latest edit has been saved successfully", async () => {
    const { session } = openSession();
    session.onChange(elements, appState, files);
    expect(await session.saveNow()).toBe("saved");
    expect(session.isDirty()).toBe(false);
    useStore.getState().setFileDirty(fileId, true);

    useStore.getState().applyEntries(externalEvent("changed"));

    expect(useStore.getState().externalConflict).toBeNull();
    expect(useStore.getState().openFileId).toBe(fileId);
    expect(useStore.getState().editorGeneration).toBe(8);
  });

  it.each([false, true])("uses marker fallback without a matching session: marker %s", (dirty) => {
    openSession("b.excalidraw");
    useStore.getState().setRawDirty(fileId, dirty);

    useStore.getState().applyEntries(externalEvent("changed"));

    expect(useStore.getState().externalConflict).toEqual(
      dirty ? { type: "changed", fileId, diskModifiedAt: 200 } : null,
    );
    expect(useStore.getState().openFileId).toBe(fileId);
    expect(useStore.getState().editorGeneration).toBe(dirty ? 7 : 8);
  });
});
