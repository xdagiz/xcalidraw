import type { WindowCloseRequest } from "@shared/ipc";

import type { toast } from "@/components/ui/toast";

import { closeDecision, setCloseHandshakeActive } from "./close-handshake";
import type { BoundDrawingSession } from "./session-owner";
import type { State } from "./store";

export type CloseFlowDeps = {
  getState: () => Pick<
    State,
    | "dirtyById"
    | "pendingCanvasAction"
    | "scratchUnsaved"
    | "externalConflict"
    | "resolveChangedConflict"
    | "resolveMissingConflict"
  > & {
    settings: Pick<State["settings"], "autosave">;
  };
  getSession: () => Pick<
    BoundDrawingSession,
    "evaluateNow" | "isDirty" | "setAutosavePaused" | "flush"
  > | null;
  windowApi: Pick<
    Window["api"]["window"],
    "reportDirtyState" | "flushStarted" | "cancelQuit" | "close"
  >;
  waitForCanvasActionSettled: () => Promise<boolean>;
  flushViewports: () => Promise<void>;
  addToast: typeof toast.add;
  reportError: (error: unknown, operation: "save") => void;
};

export const QUIT_SETTLE_BUDGET_MS = 4000;

export const waitForCanvasActionSettled = (
  isPending: () => boolean,
  subscribe: (listener: (pending: boolean) => void) => () => void,
) =>
  new Promise<boolean>((resolve) => {
    if (!isPending()) {
      resolve(true);
      return;
    }
    const timeout = setTimeout(() => {
      unsubscribe();
      resolve(false);
    }, QUIT_SETTLE_BUDGET_MS);
    const unsubscribe = subscribe((pending) => {
      if (pending) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(true);
    });
  });

export const createCloseFlow = (deps: CloseFlowDeps) => async (request: WindowCloseRequest) => {
  setCloseHandshakeActive(true);

  if (request.kind === "check") {
    const session = deps.getSession();
    session?.evaluateNow();
    const state = deps.getState();
    const decision = closeDecision({
      visibleDirtyCount: Object.keys(state.dirtyById).length,
      sessionDirty: session?.isDirty() ?? false,
      scratchDirty: state.scratchUnsaved || state.pendingCanvasAction,
      autosaveMode: state.settings.autosave.mode,
      hasConflict: state.externalConflict !== null,
    });
    if (decision.mustFlush) session?.setAutosavePaused(true);
    deps.windowApi.reportDirtyState(request.requestId, decision.mustFlush, decision.skipPrompt);
    return;
  }

  if (request.kind === "flush-viewports") {
    deps.windowApi.flushStarted(request.requestId);
    await deps.flushViewports().catch((error: unknown) => {
      console.error("Failed to persist viewport preferences:", error);
    });
    await deps.windowApi.close(request.requestId);
    setCloseHandshakeActive(false);
    return;
  }

  deps.windowApi.flushStarted(request.requestId);
  if (deps.getState().pendingCanvasAction) {
    await deps.waitForCanvasActionSettled();
  }
  const session = deps.getSession();
  const latest = deps.getState();
  if (latest.pendingCanvasAction || (!session && latest.scratchUnsaved)) {
    deps.windowApi.cancelQuit(request.requestId);
    setCloseHandshakeActive(false);
    deps.addToast({
      title: "Still creating your drawing",
      description: "Close again in a moment. Your strokes are safe.",
      type: "info",
    });
    return;
  }
  try {
    if (session) {
      session.evaluateNow();
      if (session.isDirty()) {
        await session.flush({ force: true, explicit: true });
      } else {
        await session.flush({ explicit: true });
      }
    }
  } catch (error) {
    deps.reportError(error, "save");
    deps.windowApi.cancelQuit(request.requestId);
    setCloseHandshakeActive(false);
    return;
  }

  if (session?.isDirty()) {
    deps.windowApi.cancelQuit(request.requestId);
    setCloseHandshakeActive(false);
    const state = deps.getState();
    if (state.externalConflict?.type === "changed") {
      void state.resolveChangedConflict({ force: true });
    } else if (state.externalConflict?.type === "missing") {
      void state.resolveMissingConflict(undefined, { force: true });
    } else {
      deps.addToast({
        title: "Couldn't save your drawing",
        description: "Close again to retry, or press Ctrl+S.",
        type: "error",
      });
    }
    return;
  }

  await deps.flushViewports().catch((error: unknown) => {
    console.error("Failed to persist viewport preferences:", error);
  });
  await deps.windowApi.close(request.requestId);
  setCloseHandshakeActive(false);
};
