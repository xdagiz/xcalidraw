import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import { describe, expect, it, vi } from "vite-plus/test";

import { createScratchController, type PendingScene, type ScratchDeps } from "./scratch-session";
import type { BoundDrawingSession } from "./session-owner";

const el = (id: string) => ({ id, type: "rectangle" }) as unknown as OrderedExcalidrawElement;
const appState = { isLoading: false, viewBackgroundColor: "#ffffff" } as AppState;
const files = {} as BinaryFiles;

const fakeSession = () =>
  ({
    onChange: vi.fn(),
    setInitialBaseline: vi.fn(),
  }) as unknown as BoundDrawingSession;

const harness = (overrides: Partial<ScratchDeps> = {}) => {
  const calls = {
    deleted: [] as string[],
    viewports: [] as string[],
    released: [] as BoundDrawingSession[],
    cleared: [] as string[],
    pending: [] as boolean[],
    unsaved: [] as boolean[],
    errors: [] as unknown[],
    seeded: [] as [BoundDrawingSession, PendingScene | null][],
  };

  let openFileId: string | null = null;
  const session = fakeSession();
  const acquireSession = vi.fn(() => session);

  const deps: ScratchDeps = {
    createEntry: vi.fn().mockResolvedValue("new.excalidraw"),
    readFile: vi.fn().mockResolvedValue("{}"),
    deleteFile: (id) => calls.deleted.push(id),
    deleteViewport: (id) => calls.viewports.push(id),
    acquireSession,
    releaseIfOwned: (s) => calls.released.push(s),
    isOpenFileId: () => openFileId,
    openReservedFile: vi.fn().mockResolvedValue(true),
    clearFileMarkers: (id) => calls.cleared.push(id),
    setPendingCanvasAction: (v) => calls.pending.push(v),
    setScratchUnsaved: (v) => calls.unsaved.push(v),
    notifyError: (e) => calls.errors.push(e),
    computeDiskBaseline: () => "baseline",
    seedSession: (s, sc) => calls.seeded.push([s, sc]),
    ...overrides,
  };

  const controller = createScratchController(deps);

  return {
    controller,
    calls,
    session,
    deps,
    setOpenFileId: (v: string | null) => {
      openFileId = v;
    },
  };
};

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("scratch controller", () => {
  it("does not create a second file when a stroke lands mid-create", async () => {
    let releaseCreate!: (v: string | null) => void;
    const createEntry = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          releaseCreate = resolve;
        }),
    );
    const h = harness({ createEntry });

    h.controller.capture([el("a")], appState, files);
    await flush();
    expect(createEntry).toHaveBeenCalledTimes(1);

    h.controller.capture([el("a"), el("b")], appState, files);
    h.controller.capture([el("a"), el("b"), el("c")], appState, files);
    await flush();

    expect(createEntry).toHaveBeenCalledTimes(1);

    releaseCreate("new.excalidraw");
    await flush();
    expect(h.controller.getState().phase).toBe("reserved");
  });

  it("keeps the in-flight file when a stroke lands while reading it back", async () => {
    let releaseRead!: (v: string) => void;
    const h = harness({
      readFile: () =>
        new Promise<string>((resolve) => {
          releaseRead = resolve;
        }),
    });

    h.controller.capture([el("a")], appState, files);
    await flush();
    expect(h.controller.getState().phase).toBe("creating");

    h.controller.capture([el("a"), el("b")], appState, files);
    expect(h.controller.getState().phase).toBe("creating");

    releaseRead("{}");
    await flush();

    expect(h.deps.createEntry).toHaveBeenCalledTimes(1);
    expect(h.controller.getState().phase).toBe("reserved");
  });

  it("unblocks creation after createEntry throws so a later stroke can retry", async () => {
    let shouldFail = true;
    const createEntry = vi.fn(() => {
      if (shouldFail) return Promise.reject(new Error("disk full"));
      return Promise.resolve("new.excalidraw");
    });
    const h = harness({ createEntry });

    h.controller.capture([el("a")], appState, files);
    await flush();
    expect(h.calls.errors).toHaveLength(1);

    shouldFail = false;
    h.controller.capture([el("a"), el("b")], appState, files);
    await flush();

    expect(createEntry).toHaveBeenCalledTimes(2);
    expect(h.controller.getState().phase).toBe("reserved");
  });

  it("captures a first stroke without touching the filesystem", () => {
    const h = harness();

    h.controller.capture([el("a")], appState, files);

    expect(h.controller.getState().phase).toBe("capturing");
    expect(h.calls.unsaved).toEqual([true]);
    expect(h.calls.deleted).toEqual([]);
  });

  it("runs the happy path to a bound session", async () => {
    const h = harness();

    h.controller.capture([el("a")], appState, files);
    await flush();

    expect(h.deps.createEntry).toHaveBeenCalledTimes(1);
    expect(h.deps.readFile).toHaveBeenCalledWith("new.excalidraw");
    expect(h.deps.openReservedFile).toHaveBeenCalledWith("new.excalidraw");
    expect(h.calls.seeded).toHaveLength(1);
    expect(h.calls.deleted).toEqual([]);
    expect(h.calls.errors).toEqual([]);
  });

  it("deletes the created file when invalidated mid-create", async () => {
    let releaseRead!: (v: string) => void;
    const h = harness({
      readFile: () =>
        new Promise<string>((resolve) => {
          releaseRead = resolve;
        }),
    });

    h.controller.capture([el("a")], appState, files);
    await flush();
    expect(h.controller.getState().phase).toBe("creating");

    h.controller.invalidate();
    releaseRead("{}");
    await flush();

    expect(h.calls.deleted).toEqual(["new.excalidraw"]);
    expect(h.controller.getState().phase).toBe("idle");
    expect(h.deps.acquireSession).not.toHaveBeenCalled();
  });

  it("releases the session and deletes the file when invalidated after acquire", async () => {
    let releaseOpen!: (v: boolean) => void;
    const h = harness({
      openReservedFile: () =>
        new Promise<boolean>((resolve) => {
          releaseOpen = resolve;
        }),
    });

    h.controller.capture([el("a")], appState, files);
    await flush();
    expect(h.controller.getState().phase).toBe("reserved");

    h.controller.invalidate();
    releaseOpen(true);
    await flush();

    expect(h.calls.released).toEqual([h.session]);
    expect(h.calls.deleted).toEqual(["new.excalidraw"]);
    expect(h.calls.cleared).toContainEqual("new.excalidraw");
    expect(h.controller.getState().phase).toBe("idle");
  });

  it("deletes the file when computeDiskBaseline throws", async () => {
    const h = harness({
      computeDiskBaseline: () => {
        throw new Error("bad json");
      },
    });

    h.controller.capture([el("a")], appState, files);
    await flush();

    expect(h.calls.deleted).toEqual(["new.excalidraw"]);
    expect(h.calls.errors).toHaveLength(1);
  });

  it("keeps the captured scene when a stale create resolves after a second one started", async () => {
    const releases: ((v: string) => void)[] = [];
    const h = harness({
      createEntry: () => new Promise<string>((resolve) => releases.push(resolve)),
    });

    h.controller.capture([el("a")], appState, files);
    await flush();

    h.controller.invalidate();

    h.controller.capture([el("a"), el("b")], appState, files);
    await flush();

    releases[0]("stale.excalidraw");
    await flush();

    expect(h.calls.deleted).toEqual(["stale.excalidraw"]);

    releases[1]("fresh.excalidraw");
    await flush();

    expect(h.calls.seeded).toHaveLength(1);
    expect(h.calls.seeded[0][1]?.elements).toHaveLength(2);
    expect(h.calls.deleted).toEqual(["stale.excalidraw"]);
  });

  it("does not let a superseded create unblock a second one", async () => {
    const releases: ((v: string) => void)[] = [];
    const h = harness({
      createEntry: () => new Promise<string>((resolve) => releases.push(resolve)),
    });

    h.controller.capture([el("a")], appState, files);
    await flush();

    h.controller.invalidate();

    h.controller.capture([el("a"), el("b")], appState, files);
    await flush();

    expect(releases).toHaveLength(2);

    releases[0]("stale.excalidraw");
    await flush();

    expect(h.calls.deleted).toEqual(["stale.excalidraw"]);

    h.controller.capture([el("a"), el("b"), el("c")], appState, files);
    await flush();

    expect(releases).toHaveLength(2);

    releases[1]("fresh.excalidraw");
    await flush();

    expect(h.calls.seeded).toHaveLength(1);
    expect(h.calls.seeded[0][1]?.elements).toHaveLength(3);
  });

  it("preserves the captured scene when the reserved file fails to open", async () => {
    const h = harness({
      openReservedFile: vi.fn().mockResolvedValue(false),
    });

    h.controller.capture([el("a")], appState, files);
    await flush();

    expect(h.calls.deleted).toEqual(["new.excalidraw"]);
    expect(h.calls.errors).toHaveLength(1);
    expect(h.controller.getState().phase).toBe("capturing");
    expect(h.calls.unsaved).toContain(true);
  });

  it("drops the scene and deletes the file when the open file drifts", async () => {
    const h = harness();

    h.controller.capture([el("a")], appState, files);
    await flush();
    expect(h.controller.getState().phase).toBe("reserved");

    h.setOpenFileId("other.excalidraw");
    h.controller.invalidate();

    expect(h.calls.deleted).toEqual(["new.excalidraw"]);
    expect(h.controller.getState().phase).toBe("idle");
  });

  it("keeps the file on unmount but drops a stale viewport", async () => {
    const h = harness();

    h.controller.bindFile("open.excalidraw");
    expect(h.controller.getState().phase).toBe("bound");
    expect(h.deps.acquireSession).toHaveBeenCalledTimes(1);

    h.controller.invalidate();

    expect(h.calls.released).toEqual([h.session]);
    expect(h.calls.deleted).toEqual([]);
    expect(h.calls.viewports).toEqual(["open.excalidraw"]);
  });

  it("keeps the viewport when the bound file is still open", () => {
    const h = harness();
    h.setOpenFileId("open.excalidraw");

    h.controller.bindFile("open.excalidraw");
    h.controller.invalidate();

    expect(h.calls.viewports).toEqual([]);
    expect(h.calls.deleted).toEqual([]);
  });

  it("marks a drawing materialised from the canvas as canvas seeded", async () => {
    const h = harness();

    h.controller.capture([el("a")], appState, files);
    await flush();

    expect(h.controller.getState().phase).toBe("reserved");
    expect(h.controller.isCanvasSeeded("new.excalidraw")).toBe(true);
    expect(h.controller.isCanvasSeeded("other.excalidraw")).toBe(false);

    h.controller.bindFile("new.excalidraw");

    expect(h.controller.getState().phase).toBe("bound");
    expect(h.controller.isCanvasSeeded("new.excalidraw")).toBe(true);
  });

  it("stops treating a drawing as canvas seeded once it is released", async () => {
    const h = harness();

    h.controller.capture([el("a")], appState, files);
    await flush();
    h.controller.bindFile("new.excalidraw");

    h.controller.invalidate();

    expect(h.controller.isCanvasSeeded("new.excalidraw")).toBe(false);
  });

  it("does not mark a drawing opened from disk as canvas seeded", () => {
    const h = harness();

    h.controller.bindFile("open.excalidraw");

    expect(h.controller.isCanvasSeeded("open.excalidraw")).toBe(false);
  });
});
