import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";

import type { BoundDrawingSession } from "./session-owner";

export type PendingScene = {
  elements: readonly OrderedExcalidrawElement[];
  appState: AppState;
  files: BinaryFiles;
};

export type ScratchState =
  | { phase: "idle" }
  | { phase: "capturing"; scene: PendingScene | null }
  | { phase: "creating"; fileId: string; scene: PendingScene | null }
  | { phase: "reserved"; fileId: string; session: BoundDrawingSession; scene: PendingScene | null }
  | { phase: "bound"; fileId: string; session: BoundDrawingSession };

export type ScratchDeps = {
  createEntry: () => Promise<string | null>;
  readFile: (id: string) => Promise<string>;
  deleteFile: (id: string) => void;
  deleteViewport: (fileId: string) => void;
  acquireSession: (fileId: string, diskBaseline: string | null) => BoundDrawingSession;
  releaseIfOwned: (session: BoundDrawingSession) => void;
  isOpenFileId: () => string | null;
  openReservedFile: (id: string) => Promise<boolean>;
  clearFileMarkers: (fileId: string) => void;
  setPendingCanvasAction: (pending: boolean) => void;
  setScratchUnsaved: (unsaved: boolean) => void;
  notifyError: (error: unknown) => void;
  computeDiskBaseline: (raw: string) => string;
  seedSession: (session: BoundDrawingSession, scene: PendingScene | null) => void;
};

export type ScratchController = {
  getState: () => ScratchState;
  getSession: () => BoundDrawingSession | null;
  getScene: () => PendingScene | null;
  isReserved: (fileId: string) => boolean;
  isCanvasSeeded: (fileId: string) => boolean;
  capture: (
    elements: readonly OrderedExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
  ) => void;
  start: () => void;
  bindFile: (fileId: string) => void;
  retargetFile: (fromFileId: string, toFileId: string) => boolean;
  invalidate: () => void;
};

const hasContent = (scene: PendingScene | null) =>
  scene !== null && scene.elements.some((element) => !element.isDeleted);

export const createScratchController = (deps: ScratchDeps): ScratchController => {
  let state: ScratchState = { phase: "idle" };
  let epoch = 0;
  let starting = false;
  let canvasSeededFileId: string | null = null;

  const discardOp = (fileId: string, preserveScene: PendingScene | null) => {
    const current = state;
    const owns =
      (current.phase === "creating" || current.phase === "reserved") && current.fileId === fileId;
    if (!owns) return;

    deps.deleteFile(fileId);
    deps.clearFileMarkers(fileId);
    deps.setPendingCanvasAction(false);
    if (preserveScene && hasContent(preserveScene)) {
      state = { phase: "capturing", scene: preserveScene };
      deps.setScratchUnsaved(true);
    } else {
      state = { phase: "idle" };
      deps.setScratchUnsaved(false);
    }
  };

  const abortCurrent = () => {
    starting = false;
    canvasSeededFileId = null;

    const current = state;
    state = { phase: "idle" };

    deps.setPendingCanvasAction(false);
    deps.setScratchUnsaved(false);

    switch (current.phase) {
      case "creating":
        deps.clearFileMarkers(current.fileId);
        deps.deleteFile(current.fileId);
        break;
      case "reserved":
        deps.releaseIfOwned(current.session);
        deps.clearFileMarkers(current.fileId);
        deps.deleteFile(current.fileId);
        break;
      case "bound":
        deps.releaseIfOwned(current.session);
        deps.clearFileMarkers(current.fileId);
        if (deps.isOpenFileId() !== current.fileId) deps.deleteViewport(current.fileId);
        break;
      case "capturing":
      case "idle":
        break;
    }
  };

  const currentScene = () =>
    state.phase === "capturing" || state.phase === "creating" || state.phase === "reserved"
      ? state.scene
      : null;

  const currentFileId = () =>
    state.phase === "creating" || state.phase === "reserved" ? state.fileId : null;

  const start = async () => {
    if (starting || state.phase === "creating" || state.phase === "reserved") return;
    starting = true;

    const gen = ++epoch;
    const startOpenFileId = deps.isOpenFileId();
    let ownFileId: string | null = null;
    deps.setPendingCanvasAction(true);

    try {
      const id = await deps.createEntry();
      if (!id) throw new Error("Could not create drawing");
      ownFileId = id;

      state = { phase: "creating", fileId: id, scene: currentScene() };
      if (gen !== epoch) {
        discardOp(id, currentScene());
        return;
      }
      starting = false;

      const raw = await deps.readFile(id);
      if (gen !== epoch) {
        discardOp(id, currentScene());
        return;
      }

      const baseline = deps.computeDiskBaseline(raw);
      const session = deps.acquireSession(id, baseline);
      state = { phase: "reserved", fileId: id, session, scene: currentScene() };
      if (gen !== epoch) {
        discardOp(id, currentScene());
        return;
      }

      deps.seedSession(session, currentScene());

      if (deps.isOpenFileId() !== startOpenFileId) {
        discardOp(id, currentScene());
        return;
      }

      const opened = await deps.openReservedFile(id);
      if (gen !== epoch) {
        discardOp(id, currentScene());
        return;
      }

      if (!opened) throw new Error("The drawing was removed before it could be opened");
    } catch (error) {
      if (gen !== epoch) {
        if (ownFileId) discardOp(ownFileId, currentScene());
        return;
      }

      starting = false;
      const fileId = currentFileId();
      const scene = currentScene();
      if (fileId) {
        discardOp(fileId, scene);
      } else {
        deps.setPendingCanvasAction(false);
        deps.setScratchUnsaved(hasContent(scene));
      }

      deps.notifyError(error);
    }
  };

  return {
    getState: () => state,
    getSession: () => {
      if (state.phase === "reserved" || state.phase === "bound") return state.session;
      return null;
    },
    getScene: currentScene,
    isReserved: (fileId) => state.phase === "reserved" && state.fileId === fileId,
    isCanvasSeeded: (fileId) => {
      if (state.phase === "reserved" && state.fileId === fileId) return true;
      return canvasSeededFileId === fileId;
    },
    capture: (elements, appState, files) => {
      const current = state;
      const scene: PendingScene = { elements, appState, files };

      if (current.phase === "reserved" || current.phase === "bound") {
        current.session.onChange(elements, appState, files);
        return;
      }

      if (current.phase === "creating") {
        state = { phase: "creating", fileId: current.fileId, scene };
        deps.setScratchUnsaved(hasContent(scene));
        return;
      }

      state = { phase: "capturing", scene };
      deps.setScratchUnsaved(hasContent(scene));
      if (hasContent(scene)) void start();
    },
    start: () => void start(),
    bindFile: (fileId) => {
      if (state.phase === "reserved" && state.fileId === fileId) {
        state = { phase: "bound", fileId, session: state.session };
        canvasSeededFileId = fileId;
        deps.setScratchUnsaved(false);
        return;
      }
      abortCurrent();
      const session = deps.acquireSession(fileId, null);
      state = { phase: "bound", fileId, session };
    },
    retargetFile: (fromFileId, toFileId) => {
      if (state.phase !== "bound" || state.fileId !== fromFileId) return false;
      state = { phase: "bound", fileId: toFileId, session: state.session };
      if (canvasSeededFileId === fromFileId) canvasSeededFileId = toFileId;
      return true;
    },
    invalidate: () => {
      epoch += 1;
      abortCurrent();
    },
  };
};
