import type { AutosaveSetting } from "@shared/ipc";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createCloseFlow, waitForCanvasActionSettled, type CloseFlowDeps } from "./close-flow";
import { isCloseHandshakeActive, setCloseHandshakeActive } from "./close-handshake";

const subscribeOver = (getPending: () => boolean) => {
  const listeners = new Set<(pending: boolean) => void>();
  return {
    subscribe: (listener: (pending: boolean) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: () => {
      for (const listener of listeners) listener(getPending());
    },
    listenerCount: () => listeners.size,
  };
};

const setup = (mode: AutosaveSetting["mode"] = "interval") => {
  const state: ReturnType<CloseFlowDeps["getState"]> = {
    dirtyById: {},
    pendingCanvasAction: false,
    scratchUnsaved: false,
    settings: { autosave: mode === "interval" ? { mode, ms: 5000 } : { mode } },
    externalConflict: null,
    resolveChangedConflict: vi.fn().mockResolvedValue("cancel"),
    resolveMissingConflict: vi.fn().mockResolvedValue("cancel"),
  };
  const windowApi = {
    reportDirtyState: vi.fn(),
    flushStarted: vi.fn(),
    cancelQuit: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
  let session: ReturnType<CloseFlowDeps["getSession"]> = null;
  const addToast = vi.fn();
  const reportError = vi.fn();
  const flushViewports = vi.fn().mockResolvedValue(undefined);
  const canvasAction = subscribeOver(() => state.pendingCanvasAction);
  const handler = createCloseFlow({
    getState: () => state,
    getSession: () => session,
    windowApi,
    waitForCanvasActionSettled: () =>
      waitForCanvasActionSettled(() => state.pendingCanvasAction, canvasAction.subscribe),
    flushViewports,
    addToast,
    reportError,
  });
  const adoptSession = () => {
    const adopted = {
      evaluateNow: vi.fn(),
      isDirty: vi.fn().mockReturnValue(false),
      setAutosavePaused: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
    };
    session = adopted;
    return adopted;
  };
  return {
    state,
    windowApi,
    addToast,
    reportError,
    flushViewports,
    handler,
    adoptSession,
    canvasActionEmit: canvasAction.emit,
  };
};

const expectCreationCancelled = (flow: ReturnType<typeof setup>) => {
  expect(flow.windowApi.close).not.toHaveBeenCalled();
  expect(flow.windowApi.cancelQuit).toHaveBeenCalledExactlyOnceWith(42);
  expect(flow.addToast).toHaveBeenCalledExactlyOnceWith({
    title: "Still creating your drawing",
    description: "Close again in a moment. Your strokes are safe.",
    type: "info",
  });
  expect(isCloseHandshakeActive()).toBe(false);
};

afterEach(() => {
  setCloseHandshakeActive(false);
  vi.useRealTimers();
});

describe("close flow", () => {
  it("saves the adopted session before closing after creation settles", async () => {
    vi.useFakeTimers();
    const flow = setup();
    flow.state.pendingCanvasAction = true;
    flow.state.scratchUnsaved = true;
    const closing = flow.handler({ kind: "flush", requestId: 42 });
    expect(flow.windowApi.flushStarted).toHaveBeenCalledWith(42);
    expect(flow.windowApi.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    const session = flow.adoptSession();
    const saving = Promise.withResolvers<void>();
    session.flush.mockReturnValue(saving.promise);
    flow.state.pendingCanvasAction = false;
    flow.state.scratchUnsaved = false;
    flow.canvasActionEmit();
    await vi.advanceTimersByTimeAsync(0);
    expect(session.flush).toHaveBeenCalledExactlyOnceWith({ force: true, explicit: true });
    expect(flow.windowApi.close).not.toHaveBeenCalled();
    saving.resolve();
    await closing;
    expect(flow.flushViewports).toHaveBeenCalledOnce();
    expect(flow.windowApi.close).toHaveBeenCalledExactlyOnceWith(42);
    expect(flow.windowApi.cancelQuit).not.toHaveBeenCalled();
    expect(isCloseHandshakeActive()).toBe(false);
  });

  it("cancels quit when captured strokes have no owning session", async () => {
    const flow = setup();
    flow.state.scratchUnsaved = true;
    await flow.handler({ kind: "flush", requestId: 42 });
    expectCreationCancelled(flow);
  });

  it.each(["changed", "missing"] as const)(
    "routes a dirty session to %s conflict resolution",
    async (type) => {
      const flow = setup();
      const session = flow.adoptSession();
      session.isDirty.mockReturnValue(true);
      flow.state.externalConflict =
        type === "changed"
          ? { type, fileId: "a.excalidraw", diskModifiedAt: 1 }
          : { type, fileId: "a.excalidraw" };
      await flow.handler({ kind: "check", requestId: 42 });
      expect(session.evaluateNow).toHaveBeenCalledOnce();
      expect(session.setAutosavePaused).toHaveBeenCalledWith(true);
      expect(flow.windowApi.reportDirtyState).toHaveBeenCalledWith(42, true, true);
      await flow.handler({ kind: "flush", requestId: 42 });
      expect(flow.windowApi.close).not.toHaveBeenCalled();
      expect(flow.windowApi.cancelQuit).toHaveBeenCalledWith(42);
      expect(isCloseHandshakeActive()).toBe(false);
      if (type === "changed") {
        expect(flow.state.resolveChangedConflict).toHaveBeenCalledWith({ force: true });
      } else {
        expect(flow.state.resolveMissingConflict).toHaveBeenCalledWith(undefined, { force: true });
      }
    },
  );

  it("cancels with a toast when a still-dirty session has no conflict to resolve", async () => {
    const flow = setup();
    const session = flow.adoptSession();
    session.isDirty.mockReturnValue(true);
    await flow.handler({ kind: "flush", requestId: 42 });
    expect(flow.windowApi.close).not.toHaveBeenCalled();
    expect(flow.windowApi.cancelQuit).toHaveBeenCalledWith(42);
    expect(flow.state.resolveChangedConflict).not.toHaveBeenCalled();
    expect(flow.state.resolveMissingConflict).not.toHaveBeenCalled();
    expect(flow.addToast).toHaveBeenCalledExactlyOnceWith({
      title: "Couldn't save your drawing",
      description: "Close again to retry, or press Ctrl+S.",
      type: "error",
    });
    expect(isCloseHandshakeActive()).toBe(false);
  });
});

describe("canvas action waiter", () => {
  it("returns false when creation is still pending at the budget", async () => {
    vi.useFakeTimers();
    const channel = subscribeOver(() => true);
    const waiting = waitForCanvasActionSettled(() => true, channel.subscribe);
    await vi.advanceTimersByTimeAsync(4000);
    expect(await waiting).toBe(false);
    expect(channel.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
