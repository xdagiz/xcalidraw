import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { BinaryFiles, AppState } from "@excalidraw/excalidraw/types";
import type { AutosaveSetting } from "@shared/ipc";
import { describe, it, expect, beforeEach, afterEach, vi } from "vite-plus/test";

vi.mock("@excalidraw/excalidraw", () => ({
  serializeAsJSON: (
    elements: unknown,
    appState: Record<string, unknown>,
    files: unknown,
    type?: "local" | "database",
  ) => {
    const exportedAppState =
      type === "local"
        ? Object.fromEntries(Object.entries(appState).filter(([key]) => key !== "theme"))
        : appState;
    return JSON.stringify({
      type: "excalidraw",
      version: 2,
      source: "https://excalidraw.com",
      elements,
      appState: exportedAppState,
      files,
    });
  },
}));

import {
  createDrawingSession,
  drawingSignature,
  type FrameScheduler,
  MAX_SAVE_RETRIES,
} from "./drawing-session";

const el = (id: string) => ({ id, type: "rectangle" }) as unknown as OrderedExcalidrawElement;

const manualScheduler = () => {
  let fire: (() => void) | null = null;
  const scheduleFrame: FrameScheduler = (callback) => {
    fire = callback;
    return () => {
      fire = null;
    };
  };
  return {
    scheduleFrame,
    fireFrame: () => {
      const callback = fire;
      fire = null;
      callback?.();
    },
    hasPending: () => fire !== null,
  };
};

const appState = (
  vbg = "#ffffff",
  grid?: Partial<Pick<AppState, "gridSize" | "gridStep" | "gridModeEnabled">>,
): AppState => ({ isLoading: false, viewBackgroundColor: vbg, ...grid }) as unknown as AppState;

const emptyFiles = {} as BinaryFiles;

type Session = ReturnType<typeof createDrawingSession>;

const makeSession = (overrides?: {
  save?: (id: string, content: string) => Promise<boolean>;
  onDirtyChange?: (id: string, dirty: boolean) => void;
  onSaveGaveUp?: (fileId: string) => void;
  initialBaseline?: string | null;
  initialAutosave?: AutosaveSetting;
  scheduleFrame?: FrameScheduler;
}): { session: Session; dirty: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn> } => {
  const dirty = vi.fn();
  const save = overrides?.save ? vi.fn(overrides.save) : vi.fn().mockResolvedValue(true);
  const session = createDrawingSession({
    fileId: "f1",
    save,
    onDirtyChange: overrides?.onDirtyChange ?? dirty,
    onSaveGaveUp: overrides?.onSaveGaveUp,
    initialBaseline: overrides?.initialBaseline,
    initialAutosave: overrides?.initialAutosave ?? { mode: "interval", ms: 5000 },
    scheduleFrame: overrides?.scheduleFrame,
  });
  return { session, dirty, save };
};

describe("createDrawingSession", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("establishes baseline on the first post-load onChange", () => {
    const { session, dirty, save } = makeSession();

    session.onChange([el("a")], appState(), emptyFiles);

    expect(dirty).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("marks dirty and autosaves on user changes after the baseline", async () => {
    const { session, dirty, save } = makeSession();

    session.onChange([el("a")], appState(), emptyFiles);
    session.onChange([el("a"), el("b")], appState(), emptyFiles);
    await vi.advanceTimersByTimeAsync(0);

    expect(dirty).toHaveBeenCalledWith("f1", true);

    await vi.advanceTimersByTimeAsync(5100);

    expect(save).toHaveBeenCalledWith("f1", expect.any(String), "auto");
    expect(dirty).toHaveBeenLastCalledWith("f1", false);
  });

  it("does not dirty the drawing for viewport-only changes", async () => {
    const { session, dirty, save } = makeSession();
    const initialBaseline = drawingSignature([el("a")], appState(), emptyFiles);
    session.setInitialBaseline(initialBaseline);
    session.onChange([el("a")], appState(), emptyFiles);
    const viewportAppState = {
      ...appState(),
      scrollX: 120,
      scrollY: -80,
      zoom: { value: 2 },
    } as unknown as AppState;
    session.onChange([el("a")], viewportAppState, emptyFiles);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(6000);

    expect(dirty).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("clears dirty when the user reverts to the baseline", async () => {
    const { session, dirty, save } = makeSession();

    session.onChange([el("a")], appState(), emptyFiles);
    session.onChange([el("a"), el("b")], appState(), emptyFiles);
    await vi.advanceTimersByTimeAsync(0);
    expect(dirty).toHaveBeenCalledWith("f1", true);

    session.onChange([el("a")], appState(), emptyFiles);
    await vi.advanceTimersByTimeAsync(0);
    expect(dirty).toHaveBeenLastCalledWith("f1", false);

    await vi.advanceTimersByTimeAsync(5100);
    expect(save).not.toHaveBeenCalled();
  });

  it("marks dirty when only grid settings change (elements unchanged)", async () => {
    const { session, dirty } = makeSession();

    session.onChange([el("a")], appState(), emptyFiles);
    session.onChange([el("a")], appState("#ffffff", { gridModeEnabled: true }), emptyFiles);
    await vi.advanceTimersByTimeAsync(0);
    expect(dirty).toHaveBeenCalledWith("f1", true);

    session.onChange([el("a")], appState(), emptyFiles);
    await vi.advanceTimersByTimeAsync(0);
    expect(dirty).toHaveBeenLastCalledWith("f1", false);
  });

  it("marks dirty until it persists when the first commit differs from the disk baseline", async () => {
    const diskBaseline = drawingSignature([el("raw")], appState("#000000"), emptyFiles);
    const { session, dirty, save } = makeSession({ initialBaseline: diskBaseline });

    session.onChange([el("a")], appState("#ffffff"), emptyFiles);
    await vi.advanceTimersByTimeAsync(0);

    expect(dirty).toHaveBeenCalledWith("f1", true);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("f1", expect.any(String), "auto");
  });

  it("does not write when the first commit matches the disk baseline", async () => {
    const sig = drawingSignature([el("a")], appState("#ffffff"), emptyFiles);
    const { session, dirty, save } = makeSession({ initialBaseline: sig });

    session.onChange([el("a")], appState("#ffffff"), emptyFiles);
    await vi.advanceTimersByTimeAsync(0);

    expect(dirty).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("applies setInitialBaseline before the first commit", async () => {
    const { session, dirty, save } = makeSession();

    vi.advanceTimersByTime(150);
    session.setInitialBaseline("disk-version");
    session.onChange([el("a")], appState("#ffffff"), emptyFiles);
    await vi.advanceTimersByTimeAsync(0);

    expect(dirty).toHaveBeenCalledWith("f1", true);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("defers autosave while blocked, then resumes it after a cancelled confirm", async () => {
    const { session, dirty, save } = makeSession();

    session.onChange([el("a")], appState(), emptyFiles);
    session.onChange([el("a"), el("b")], appState(), emptyFiles);

    const confirm = vi.fn().mockResolvedValue("cancel");
    const allowed = await session.ensureCleanOrConfirm("quit", confirm);

    expect(allowed).toBe(false);
    expect(dirty).toHaveBeenLastCalledWith("f1", true);

    await vi.advanceTimersByTimeAsync(5100);

    expect(save).toHaveBeenCalledTimes(1);
    expect(dirty).toHaveBeenLastCalledWith("f1", false);
  });

  it("force flush writes while autosave is paused (the Save path during the dialog)", async () => {
    const { session, dirty, save } = makeSession();

    session.onChange([el("a")], appState(), emptyFiles);
    session.onChange([el("a"), el("b")], appState(), emptyFiles);

    session.setAutosavePaused(true);
    await session.flush({ force: true });

    expect(save).toHaveBeenCalledTimes(1);
    expect(dirty).toHaveBeenLastCalledWith("f1", false);
  });

  it("skips an unchanged loaded drawing without writing", async () => {
    const { session, save } = makeSession({
      initialBaseline: drawingSignature([el("a")], appState(), emptyFiles),
    });
    session.onChange([el("a")], appState(), emptyFiles);
    expect(await session.saveNow()).toBe("unchanged");
    expect(save).not.toHaveBeenCalled();
  });

  it("skips a repeated save after persistence succeeds", async () => {
    const { session, save } = makeSession();
    session.onChange([el("a")], appState(), emptyFiles);
    expect(await session.saveNow()).toBe("saved");
    expect(await session.saveNow()).toBe("unchanged");
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("evaluates a pending stroke before deciding whether to save", async () => {
    const frame = manualScheduler();
    const { session, save } = makeSession({
      initialBaseline: drawingSignature([el("a")], appState(), emptyFiles),
      scheduleFrame: frame.scheduleFrame,
    });
    session.onChange([el("a")], appState(), emptyFiles);
    session.onChange([el("a"), el("b")], appState(), emptyFiles);
    expect(await session.saveNow()).toBe("saved");
    expect(JSON.parse(save.mock.calls[0][1]).elements).toEqual([el("a"), el("b")]);
  });

  it("reports newer edits without chasing them when autosave is off", async () => {
    const pending = Promise.withResolvers<boolean>();
    const { session, save } = makeSession({
      save: () => pending.promise,
      initialAutosave: { mode: "off" },
    });
    session.onChange([el("a")], appState(), emptyFiles);
    const saving = session.saveNow();
    session.onChange([el("b")], appState(), emptyFiles);
    pending.resolve(true);
    expect(await saving).toBe("saved-with-changes");
    await vi.advanceTimersByTimeAsync(10000);
    expect(save).toHaveBeenCalledTimes(1);
    expect(session.isDirty()).toBe(true);
  });

  it("rechecks duplicate queued saves after the first write succeeds", async () => {
    const pending = Promise.withResolvers<boolean>();
    const { session, save } = makeSession({ save: () => pending.promise });
    session.onChange([el("a")], appState(), emptyFiles);
    const first = session.saveNow();
    const second = session.saveNow();
    pending.resolve(true);
    expect(await first).toBe("saved");
    expect(await second).toBe("unchanged");
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("saveNow persists the latest drawing immediately", async () => {
    const { session, dirty, save } = makeSession({
      initialBaseline: drawingSignature([el("a")], appState(), emptyFiles),
    });

    session.onChange([el("a")], appState(), emptyFiles);
    session.onChange([el("a"), el("b")], appState(), emptyFiles);
    await vi.advanceTimersByTimeAsync(0);
    expect(dirty).toHaveBeenCalledWith("f1", true);

    const saved = await session.saveNow();

    expect(saved).toBe("saved");
    expect(save).toHaveBeenCalledTimes(1);
    expect(dirty).toHaveBeenLastCalledWith("f1", false);
  });

  it("saveNow writes even when no scene was ever loaded from disk if a drawing exists (new file)", async () => {
    const { session, dirty, save } = makeSession();

    session.onChange([el("a")], appState(), emptyFiles);

    const saved = await session.saveNow();

    expect(saved).toBe("saved");
    expect(save).toHaveBeenCalled();
    expect(dirty).not.toHaveBeenCalled();
  });

  it("saveNow reports failed persistence", async () => {
    const save = vi.fn().mockResolvedValue(false);
    const { session } = makeSession({
      save,
      initialBaseline: drawingSignature([el("a")], appState(), emptyFiles),
    });

    session.onChange([el("a")], appState(), emptyFiles);
    session.onChange([el("a"), el("b")], appState(), emptyFiles);

    const saved = await session.saveNow();

    expect(saved).toBe("failed");
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("invalidate lets a later load re-establish the baseline without a spurious save", async () => {
    const diskBaseline = drawingSignature([el("a")], appState("#ffffff"), emptyFiles);
    const { session, dirty, save } = makeSession();

    // Failed load: a placeholder scene captures the baseline (no disk baseline
    // exists yet), then the editor clears it so the next successful load takes
    // over instead of being ignored.
    session.onChange([el("x")], appState("#000000"), emptyFiles);
    expect(save).not.toHaveBeenCalled();

    session.invalidate();

    expect(session.isDirty()).toBe(false);
    expect(session.getSerializedContent()).toBeNull();
    await vi.advanceTimersByTimeAsync(5100);
    expect(save).not.toHaveBeenCalled();

    session.setInitialBaseline(diskBaseline);
    session.onChange([el("a")], appState("#ffffff"), emptyFiles);
    await vi.advanceTimersByTimeAsync(0);

    expect(dirty).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("flush with force persists user changes during confirm", async () => {
    const { session, dirty, save } = makeSession();

    session.onChange([el("a")], appState(), emptyFiles);
    session.onChange([el("a"), el("b")], appState(), emptyFiles);

    const allowed = await session.ensureCleanOrConfirm("switch", vi.fn().mockResolvedValue("save"));

    expect(allowed).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    expect(dirty).toHaveBeenLastCalledWith("f1", false);
  });

  it("discard abandons changes and cleans the dirty flag", async () => {
    const { session, dirty, save } = makeSession();

    session.onChange([el("a")], appState(), emptyFiles);
    session.onChange([el("a"), el("b")], appState(), emptyFiles);
    await vi.advanceTimersByTimeAsync(0);
    expect(dirty).toHaveBeenCalledWith("f1", true);

    const allowed = await session.ensureCleanOrConfirm(
      "switch",
      vi.fn().mockResolvedValue("discard"),
    );

    expect(allowed).toBe(true);
    expect(save).not.toHaveBeenCalled();
    expect(dirty).toHaveBeenLastCalledWith("f1", false);
  });

  it("marks recovered content persisted and cancels its pending autosave", async () => {
    const { session, dirty, save } = makeSession();

    session.onChange([el("a")], appState(), emptyFiles);
    session.onChange([el("a"), el("b")], appState(), emptyFiles);
    await vi.advanceTimersByTimeAsync(0);
    expect(dirty).toHaveBeenLastCalledWith("f1", true);

    expect(session.capturePersistence()?.acknowledge()).toBe(true);

    expect(session.isDirty()).toBe(false);
    expect(dirty).toHaveBeenLastCalledWith("f1", false);
    await vi.advanceTimersByTimeAsync(5100);
    expect(save).not.toHaveBeenCalled();
  });

  it.each(["invalidate", "retarget", "dispose"] as const)(
    "rejects a snapshot acknowledgement after %s",
    (operation) => {
      const { session } = makeSession({ initialAutosave: { mode: "off" } });
      session.onChange([el("a")], appState(), emptyFiles);
      session.onChange([el("b")], appState(), emptyFiles);
      const snapshot = session.capturePersistence()!;
      if (operation === "retarget") {
        session.retarget("f2");
        session.retarget("f1");
      } else session[operation]();
      if (operation === "invalidate") {
        session.onChange([el("loaded")], appState(), emptyFiles);
        session.onChange([el("new-edit")], appState(), emptyFiles);
        session.evaluateNow();
      }
      const content = session.getSerializedContent();
      const dirty = session.isDirty();
      expect(snapshot.acknowledge()).toBe(false);
      expect(session.getSerializedContent()).toBe(content);
      expect(session.isDirty()).toBe(dirty);
    },
  );

  it("refuses to capture persistence while the scene is still loading", () => {
    const { session } = makeSession();
    session.onChange([el("a")], { ...appState(), isLoading: true }, emptyFiles);
    expect(session.capturePersistence()).toBeNull();
    session.onChange([el("a")], appState(), emptyFiles);
    expect(session.capturePersistence()).not.toBeNull();
  });

  it("captures the pending scene and rejects an older acknowledgement once a newer one persisted", () => {
    const frame = manualScheduler();
    const { session } = makeSession({
      initialAutosave: { mode: "off" },
      scheduleFrame: frame.scheduleFrame,
    });
    session.onChange([el("a")], appState(), emptyFiles);
    session.onChange([el("b")], appState(), emptyFiles);
    expect(frame.hasPending()).toBe(true);
    const older = session.capturePersistence()!;
    expect(frame.hasPending()).toBe(false);
    expect(JSON.parse(older.content).elements).toEqual([{ id: "b", type: "rectangle" }]);
    session.onChange([el("c")], appState(), emptyFiles);
    const newer = session.capturePersistence()!;
    expect(newer.acknowledge()).toBe(true);
    expect(older.acknowledge()).toBe(false);
    session.onChange([el("c")], appState(), emptyFiles);
    session.evaluateNow();
    expect(session.isDirty()).toBe(false);
  });

  it("flush persists immediately without force when dirty", async () => {
    const { session, dirty, save } = makeSession();

    session.onChange([el("a")], appState(), emptyFiles);
    session.onChange([el("a"), el("b")], appState(), emptyFiles);

    await session.flush();

    expect(save).toHaveBeenCalledTimes(1);
    expect(dirty).toHaveBeenLastCalledWith("f1", false);
  });

  it("persists a return to the baseline after an older save is already in flight", async () => {
    let resolveFirstSave!: (ok: boolean) => void;
    const save = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            resolveFirstSave = resolve;
          }),
      )
      .mockResolvedValueOnce(true);
    const { session, dirty } = makeSession({ save });

    session.onChange([el("a")], appState("#000000"), emptyFiles);
    session.onChange([el("a"), el("b")], appState("#ffffff"), emptyFiles);
    await vi.advanceTimersByTimeAsync(5100);
    expect(save).toHaveBeenCalledTimes(1);

    // Reverting while the first write is unresolved must queue the final state.
    session.onChange([el("a")], appState("#000000"), emptyFiles);
    await vi.advanceTimersByTimeAsync(0);
    resolveFirstSave(true);
    await vi.advanceTimersByTimeAsync(5100);

    expect(save).toHaveBeenCalledTimes(2);
    const lastSave = JSON.parse(save.mock.calls.at(-1)![1]);
    expect(save.mock.calls.at(-1)![0]).toBe("f1");
    expect(save.mock.calls.at(-1)![2]).toBe("auto");
    expect(lastSave.appState.viewBackgroundColor).toBe("#000000");
    expect(lastSave.elements).toEqual([{ id: "a", type: "rectangle" }]);
    expect(dirty).toHaveBeenLastCalledWith("f1", false);
  });

  it("retries a failed save after the autosave interval", async () => {
    const save = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const { session, dirty } = makeSession({ save });

    session.onChange([el("a")], appState(), emptyFiles);
    session.onChange([el("a"), el("b")], appState(), emptyFiles);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(5100);
    expect(save).toHaveBeenCalledTimes(1);
    expect(dirty).toHaveBeenLastCalledWith("f1", true);

    await vi.advanceTimersByTimeAsync(5100);
    expect(save).toHaveBeenCalledTimes(2);
    expect(dirty).toHaveBeenLastCalledWith("f1", false);
  });

  it("stops retrying after MAX_SAVE_RETRIES consecutive failures", async () => {
    const save = vi.fn().mockResolvedValue(false);
    const { session } = makeSession({ save });

    session.onChange([el("a")], appState(), emptyFiles);
    session.onChange([el("a"), el("b")], appState(), emptyFiles);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(5100);

    for (let i = 0; i < MAX_SAVE_RETRIES + 1; i++) {
      await vi.advanceTimersByTimeAsync(5100);
    }

    expect(save).toHaveBeenCalledTimes(1 + MAX_SAVE_RETRIES);

    await vi.advanceTimersByTimeAsync(5100);
    expect(save).toHaveBeenCalledTimes(1 + MAX_SAVE_RETRIES);
  });

  it("resets the retry budget when a new edit arrives after giving up", async () => {
    const save = vi.fn().mockResolvedValue(false);
    const { session } = makeSession({ save });

    session.onChange([el("a")], appState(), emptyFiles);
    session.onChange([el("a"), el("b")], appState(), emptyFiles);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5100);
    for (let retry = 0; retry < MAX_SAVE_RETRIES; retry += 1) {
      await vi.advanceTimersByTimeAsync(5100);
    }
    expect(save).toHaveBeenCalledTimes(1 + MAX_SAVE_RETRIES);

    session.onChange([el("a"), el("b"), el("new-edit")], appState(), emptyFiles);
    await vi.advanceTimersByTimeAsync(0);
    for (let retry = 0; retry < MAX_SAVE_RETRIES + 1; retry += 1) {
      await vi.advanceTimersByTimeAsync(5100);
    }

    expect(save).toHaveBeenCalledTimes(2 * (1 + MAX_SAVE_RETRIES));
  });

  it("publishes a dirty marker once always-mode autosave has given up", async () => {
    const gaveUp = vi.fn();
    const { session, dirty } = makeSession({
      save: () => Promise.resolve(false),
      onSaveGaveUp: gaveUp,
      initialAutosave: { mode: "always" },
    });

    session.onChange([el("a")], appState(), emptyFiles);
    session.onChange([el("a"), el("b")], appState(), emptyFiles);
    await vi.advanceTimersByTimeAsync(0);

    for (let attempt = 0; attempt < MAX_SAVE_RETRIES + 1; attempt += 1) {
      await vi.advanceTimersByTimeAsync(300);
    }

    expect(gaveUp).toHaveBeenCalledExactlyOnceWith("f1");
    expect(session.isDirty()).toBe(true);
    expect(dirty).toHaveBeenLastCalledWith("f1", true);
  });

  it("clears the published marker once a later save succeeds", async () => {
    const save = vi.fn();
    for (let failure = 0; failure <= MAX_SAVE_RETRIES; failure += 1) {
      save.mockResolvedValueOnce(false);
    }
    save.mockResolvedValue(true);
    const dirty = vi.fn();
    const session = createDrawingSession({
      fileId: "f1",
      save,
      onDirtyChange: dirty,
      initialAutosave: { mode: "always" },
    });

    session.onChange([el("a")], appState(), emptyFiles);
    session.onChange([el("a"), el("b")], appState(), emptyFiles);
    await vi.advanceTimersByTimeAsync(0);

    for (let attempt = 0; attempt < MAX_SAVE_RETRIES + 1; attempt += 1) {
      await vi.advanceTimersByTimeAsync(300);
    }

    expect(dirty).toHaveBeenLastCalledWith("f1", true);
    expect(session.isDirty()).toBe(true);

    await session.saveNow();
    await vi.advanceTimersByTimeAsync(0);

    expect(dirty).toHaveBeenLastCalledWith("f1", false);
    expect(session.isDirty()).toBe(false);
  });

  it("keeps the marker published across edits after giving up, clears it when a later save succeeds", async () => {
    const save = vi.fn();
    for (let failure = 0; failure <= MAX_SAVE_RETRIES; failure += 1) {
      save.mockResolvedValueOnce(false);
    }
    save.mockResolvedValue(true);
    const dirty = vi.fn();
    const session = createDrawingSession({
      fileId: "f1",
      save,
      onDirtyChange: dirty,
      initialAutosave: { mode: "always" },
    });

    session.onChange([el("a")], appState(), emptyFiles);
    session.onChange([el("a"), el("b")], appState(), emptyFiles);
    await vi.advanceTimersByTimeAsync(0);

    for (let attempt = 0; attempt <= MAX_SAVE_RETRIES; attempt += 1) {
      await vi.advanceTimersByTimeAsync(300);
    }

    expect(dirty).toHaveBeenLastCalledWith("f1", true);

    session.onChange([el("a"), el("b"), el("c")], appState(), emptyFiles);
    await vi.advanceTimersByTimeAsync(0);

    expect(dirty).toHaveBeenLastCalledWith("f1", true);
    expect(session.isDirty()).toBe(true);

    await session.saveNow();
    await vi.advanceTimersByTimeAsync(0);

    expect(dirty).toHaveBeenLastCalledWith("f1", false);
    expect(session.isDirty()).toBe(false);
  });

  it("retries a save whose target moved mid-flight under the new id without counting a failure", async () => {
    const deferred: { resolve?: (ok: boolean) => void } = {};
    const save = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            deferred.resolve = resolve;
          }),
      )
      .mockResolvedValue(true);
    const gaveUp = vi.fn();
    const dirty = vi.fn();
    const session = createDrawingSession({
      fileId: "f1",
      save,
      onDirtyChange: dirty,
      onSaveGaveUp: gaveUp,
      initialAutosave: { mode: "interval", ms: 5000 },
    });

    session.onChange([el("a")], appState(), emptyFiles);
    session.onChange([el("a"), el("b")], appState(), emptyFiles);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(5100);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0]).toBe("f1");

    session.retarget("f2");
    deferred.resolve?.(false);
    await vi.advanceTimersByTimeAsync(0);

    expect(gaveUp).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5100);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][0]).toBe("f2");
    expect(dirty).toHaveBeenLastCalledWith("f2", false);
  });

  it("keeps dirty and retries under the new id when retarget lands mid-save", async () => {
    const deferred: { resolve?: (ok: boolean) => void } = {};
    const save = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            deferred.resolve = resolve;
          }),
      )
      .mockResolvedValue(true);
    const dirty = vi.fn();
    const session = createDrawingSession({
      fileId: "f1",
      save,
      onDirtyChange: dirty,
      initialAutosave: { mode: "interval", ms: 5000 },
    });

    session.onChange([el("a")], appState(), emptyFiles);
    session.onChange([el("a"), el("b")], appState(), emptyFiles);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(5100);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0]).toBe("f1");

    session.retarget("f2");
    deferred.resolve?.(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(save).toHaveBeenCalledTimes(1);
    expect(dirty.mock.calls.some((call) => call[1] === false)).toBe(false);

    await vi.advanceTimersByTimeAsync(5100);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][0]).toBe("f2");
    expect(dirty).toHaveBeenLastCalledWith("f2", false);
  });

  it("saveNow calls report their own result under concurrency", async () => {
    const resolvers: Array<(ok: boolean) => void> = [];
    const save = vi.fn<(id: string, content: string) => Promise<boolean>>(
      () =>
        new Promise<boolean>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const { session } = makeSession({
      save,
      initialBaseline: drawingSignature([el("a")], appState(), emptyFiles),
    });

    session.onChange([el("a")], appState(), emptyFiles);
    session.onChange([el("a"), el("b")], appState(), emptyFiles);
    await vi.advanceTimersByTimeAsync(0);

    const first = session.saveNow();
    const second = session.saveNow();
    session.onChange([el("c")], appState(), emptyFiles);

    expect(save).toHaveBeenCalledTimes(1);

    resolvers[0]?.(true);
    await expect(first).resolves.toBe("saved-with-changes");
    await vi.advanceTimersByTimeAsync(0);

    expect(save).toHaveBeenCalledTimes(2);

    expect(JSON.parse(save.mock.calls[1][1]).elements).toEqual([el("c")]);
    resolvers[1]?.(false);
    await expect(second).resolves.toBe("failed");
  });

  it("setAutosaveMode keeps a pending save on its original deadline", async () => {
    const { session, save } = makeSession();

    session.onChange([el("a")], appState(), emptyFiles);
    session.onChange([el("a"), el("b")], appState(), emptyFiles);
    await vi.advanceTimersByTimeAsync(0);

    session.setAutosaveMode({ mode: "interval", ms: 30000 });

    await vi.advanceTimersByTimeAsync(5100);
    expect(save).toHaveBeenCalledTimes(1);

    session.onChange([el("a"), el("b"), el("c")], appState(), emptyFiles);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(5100);
    expect(save).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(25000);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("setAutosaveMode speeds up a pending save when shortened", async () => {
    const { session, save } = makeSession();

    session.setAutosaveMode({ mode: "interval", ms: 30000 });

    session.onChange([el("a")], appState(), emptyFiles);
    session.onChange([el("a"), el("b")], appState(), emptyFiles);
    await vi.advanceTimersByTimeAsync(0);

    session.setAutosaveMode({ mode: "interval", ms: 1000 });

    await vi.advanceTimersByTimeAsync(1100);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("keeps autosave paused across an interval change", async () => {
    const { session, save } = makeSession();

    session.onChange([el("a")], appState(), emptyFiles);
    session.onChange([el("a"), el("b")], appState(), emptyFiles);
    await vi.advanceTimersByTimeAsync(0);

    session.setAutosavePaused(true);
    session.setAutosaveMode({ mode: "interval", ms: 30000 });

    await vi.advanceTimersByTimeAsync(60000);
    expect(save).not.toHaveBeenCalled();

    session.setAutosavePaused(false);
    await vi.advanceTimersByTimeAsync(5100);
    expect(save).toHaveBeenCalledTimes(1);

    session.onChange([el("a"), el("b"), el("c")], appState(), emptyFiles);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30100);
    expect(save).toHaveBeenCalledTimes(2);
  });

  describe("welcome scratch prime flow", () => {
    const emptyBaseline = () => drawingSignature([], appState(), emptyFiles);

    it("primes clean on the empty scene, then debounces the first stroke on the settings interval", async () => {
      const { session, dirty, save } = makeSession({ initialBaseline: emptyBaseline() });
      session.setAutosaveMode({ mode: "interval", ms: 30000 });

      session.onChange([], appState(), emptyFiles);
      await vi.advanceTimersByTimeAsync(0);

      expect(dirty).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();

      session.onChange([el("a")], appState(), emptyFiles);
      await vi.advanceTimersByTimeAsync(0);

      expect(dirty).toHaveBeenCalledWith("f1", true);
      expect(save).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(29900);
      expect(save).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(200);
      expect(save).toHaveBeenCalledTimes(1);
      expect(save).toHaveBeenCalledWith("f1", expect.any(String), "auto");
      expect(dirty).toHaveBeenLastCalledWith("f1", false);
    });

    it("runs the pending save at once on flush before the interval elapses", async () => {
      const { session, dirty, save } = makeSession({ initialBaseline: emptyBaseline() });
      session.setAutosaveMode({ mode: "interval", ms: 30000 });

      session.onChange([], appState(), emptyFiles);
      session.onChange([el("a")], appState(), emptyFiles);
      await vi.advanceTimersByTimeAsync(0);
      expect(dirty).toHaveBeenCalledWith("f1", true);

      await vi.advanceTimersByTimeAsync(5000);
      expect(save).not.toHaveBeenCalled();

      await session.flush();

      expect(save).toHaveBeenCalledTimes(1);
      expect(dirty).toHaveBeenLastCalledWith("f1", false);

      await vi.advanceTimersByTimeAsync(30000);
      expect(save).toHaveBeenCalledTimes(1);
    });

    it("persists at once when the prime scene differs from the disk baseline", async () => {
      const diskBaseline = drawingSignature([], appState("#000000"), emptyFiles);
      const { session, dirty, save } = makeSession({ initialBaseline: diskBaseline });

      session.onChange([], appState(), emptyFiles);
      await vi.advanceTimersByTimeAsync(0);

      expect(dirty).toHaveBeenCalledWith("f1", true);
      expect(save).toHaveBeenCalledTimes(1);
      expect(save).toHaveBeenCalledWith("f1", expect.any(String), "auto");
    });
  });

  describe("deferred signature evaluation", () => {
    const makeBaselineSession = (frame: ReturnType<typeof manualScheduler>) =>
      makeSession({
        initialBaseline: drawingSignature([el("a")], appState(), emptyFiles),
        scheduleFrame: frame.scheduleFrame,
      });

    it("coalesces a stroke burst into one evaluation and saves the latest state", async () => {
      const frame = manualScheduler();
      const { session, dirty, save } = makeBaselineSession(frame);

      session.onChange([el("a")], appState(), emptyFiles);

      for (let i = 0; i < 50; i++) {
        session.onChange([el("a"), el(`stroke-${i}`)], appState(`#${i}`), emptyFiles);
      }

      await vi.advanceTimersByTimeAsync(10000);
      expect(save).not.toHaveBeenCalled();
      expect(dirty).not.toHaveBeenCalled();

      frame.fireFrame();
      expect(dirty).toHaveBeenCalledWith("f1", true);

      await vi.advanceTimersByTimeAsync(5100);

      expect(save).toHaveBeenCalledTimes(1);
      expect(save).toHaveBeenCalledWith("f1", expect.stringContaining("#49"), "auto");
    });

    it("evaluates the latest real snapshot when a loading snapshot arrives mid-flight", async () => {
      const frame = manualScheduler();
      const { session, dirty, save } = makeBaselineSession(frame);

      session.onChange([el("a")], appState(), emptyFiles);
      session.onChange([el("a"), el("b")], appState("#123456"), emptyFiles);
      session.onChange([el("a"), el("b")], { ...appState("#999999"), isLoading: true }, emptyFiles);

      frame.fireFrame();

      expect(dirty).toHaveBeenCalledWith("f1", true);

      await vi.advanceTimersByTimeAsync(5100);
      expect(save).toHaveBeenCalledTimes(1);
      expect(save).toHaveBeenCalledWith("f1", expect.stringContaining("#123456"), "auto");
      expect(save).not.toHaveBeenCalledWith(
        "f1",
        expect.stringContaining("#999999"),
        expect.anything(),
      );
    });

    it("flush persists unevaluated changes without waiting for the frame", async () => {
      const frame = manualScheduler();
      const { session, dirty, save } = makeBaselineSession(frame);

      session.onChange([el("a")], appState(), emptyFiles);
      session.onChange([el("a"), el("b")], appState(), emptyFiles);
      expect(frame.hasPending()).toBe(true);

      await session.flush({ force: true });

      expect(save).toHaveBeenCalledTimes(1);
      expect(dirty).toHaveBeenLastCalledWith("f1", false);
      expect(frame.hasPending()).toBe(false);
    });

    it("confirm dialog observes fresh dirty state without a frame", async () => {
      const frame = manualScheduler();
      const { session } = makeBaselineSession(frame);

      session.onChange([el("a"), el("b")], appState(), emptyFiles);

      const confirm = vi.fn().mockResolvedValue("cancel");
      const allowed = await session.ensureCleanOrConfirm("quit", confirm);

      expect(confirm).toHaveBeenCalledTimes(1);
      expect(allowed).toBe(false);
    });

    it("evaluateNow resolves fresh dirty state without a frame", () => {
      const frame = manualScheduler();
      const { session, dirty } = makeBaselineSession(frame);

      session.onChange([el("a")], appState(), emptyFiles);
      session.onChange([el("a"), el("b")], appState(), emptyFiles);
      expect(frame.hasPending()).toBe(true);

      session.evaluateNow();

      expect(dirty).toHaveBeenCalledWith("f1", true);
      expect(frame.hasPending()).toBe(false);
    });

    it("dispose drops the pending evaluation without saving", async () => {
      const frame = manualScheduler();
      const { session, dirty, save } = makeBaselineSession(frame);

      session.onChange([el("a")], appState(), emptyFiles);
      session.onChange([el("a"), el("b")], appState(), emptyFiles);
      session.dispose();
      frame.fireFrame();

      await vi.advanceTimersByTimeAsync(5100);

      expect(save).not.toHaveBeenCalled();
      expect(dirty).not.toHaveBeenCalled();
    });
  });
});
