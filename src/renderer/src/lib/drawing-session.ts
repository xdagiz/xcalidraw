import { serializeAsJSON } from "@excalidraw/excalidraw";
import type { RestoredDataState } from "@excalidraw/excalidraw/data/restore";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { AutosaveMode, AutosaveSetting, UnsavedChoice, UnsavedReason } from "@shared/ipc";
import { DEFAULT_AUTOSAVE, autosaveDebounceMs, autosaveWaitMs } from "@shared/ipc";

import { debounceAsync } from "@/lib/debounce";

export const MAX_SAVE_RETRIES = 3;

export type SaveOrigin = "auto" | "explicit";
export type SaveResult = "saved" | "saved-with-changes" | "unchanged" | "failed" | "cancelled";

type DrawingSnapshot = [readonly OrderedExcalidrawElement[], AppState, BinaryFiles];

type SaveTarget = {
  snapshot: DrawingSnapshot;
  revision: number;
};

type SaveFailure = SaveTarget & {
  epochAtStart: number;
};

type FlushOpts = {
  force?: boolean;
  explicit?: boolean;
};

export type FrameScheduler = (callback: () => void) => () => void;

const requestFrame: FrameScheduler = (callback) => {
  if (typeof requestAnimationFrame === "function") {
    const id = requestAnimationFrame(callback);
    return () => cancelAnimationFrame(id);
  }

  const id = setTimeout(callback, 0);
  return () => clearTimeout(id);
};

export type DrawingSessionControls = {
  onChange: (
    elements: readonly OrderedExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
  ) => void;
  saveNow: (options?: { force?: boolean }) => Promise<SaveResult>;
  flush: (opts?: FlushOpts) => Promise<void>;
  setAutosavePaused: (paused: boolean) => void;
  getSerializedContent: () => string | null;
  setInitialBaseline: (signature: string | null) => void;
  invalidate: () => void;
  capturePersistence: () => { content: string; acknowledge: () => boolean } | null;
  getLifetime: () => object;
  retarget: (nextFileId: string) => void;
  ensureCleanOrConfirm: (
    reason: UnsavedReason,
    confirmUnsaved: (reason: UnsavedReason) => Promise<UnsavedChoice>,
  ) => Promise<boolean>;
  isDirty: () => boolean;
  evaluateNow: () => void;
  setAutosaveMode: (next: AutosaveSetting) => void;
  dispose: () => void;
};

type DrawingSessionDeps = {
  fileId: string;
  save: (id: string, content: string, origin?: SaveOrigin) => Promise<boolean>;
  onDirtyChange?: (id: string, dirty: boolean) => void;
  onRawDirtyChange?: (id: string, dirty: boolean) => void;
  onSaveGaveUp?: (fileId: string) => void;
  initialBaseline?: string | null;
  initialAutosave?: AutosaveSetting;
  scheduleFrame?: FrameScheduler;
  hasExternalConflict?: () => boolean;
};

export const drawingSignature = (
  elements: readonly OrderedExcalidrawElement[],
  appState: RestoredDataState["appState"],
  files: BinaryFiles | undefined,
) =>
  JSON.stringify({
    elements: elements ?? [],
    files: files ?? {},
    viewBackgroundColor: appState.viewBackgroundColor,
    gridSize: appState.gridSize,
    gridStep: appState.gridStep,
    gridModeEnabled: appState.gridModeEnabled,
  });

const serializeSnapshot = (
  elements: readonly OrderedExcalidrawElement[],
  appState: AppState,
  files: BinaryFiles,
) => serializeAsJSON(elements, appState, files, "local");

export const createDrawingSession = (deps: DrawingSessionDeps): DrawingSessionControls => {
  const {
    fileId,
    save,
    onDirtyChange,
    onRawDirtyChange,
    onSaveGaveUp,
    initialBaseline = null,
    initialAutosave = DEFAULT_AUTOSAVE,
    scheduleFrame = requestFrame,
  } = deps;

  let baseline: string | null = null;
  let diskBaseline = initialBaseline;
  let currentFileId = fileId;
  let retargetEpoch = 0;
  let latestDrawing: DrawingSnapshot | null = null;
  let latestSignature: string | null = null;
  let latestRevision = 0;
  let savesInFlight = 0;
  let saveSeq = 0;
  let appliedSeq = 0;
  let disposed = false;
  let lifetime = {};
  let persistedSeq = 0;
  let blocked = false;
  let dirty = false;
  let dirtyPublished = false;
  let gaveUp = false;
  let mode: AutosaveMode = initialAutosave.mode;
  let saveFailures = 0;
  let saveNowTail: Promise<void> = Promise.resolve();
  let explicitSaveInFlight = false;
  let cancelScheduledEvaluation: (() => void) | null = null;

  const setDirty = (next: boolean) => {
    const visible = mode === "always" && !gaveUp ? false : next;
    const rawChanged = dirty !== next;
    const visibleChanged = dirtyPublished !== visible;
    if (!rawChanged && !visibleChanged) return;
    dirty = next;
    dirtyPublished = visible;
    if (rawChanged) onRawDirtyChange?.(currentFileId, next);
    if (visibleChanged) onDirtyChange?.(currentFileId, visible);
  };

  let cachedInputs: {
    elements: readonly OrderedExcalidrawElement[];
    files: BinaryFiles | undefined;
    viewBackgroundColor: unknown;
    gridSize: unknown;
    gridStep: unknown;
    gridModeEnabled: unknown;
  } | null = null;
  let cachedSignature = "";

  const signatureFor = (
    elements: readonly OrderedExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles | undefined,
  ) => {
    if (
      cachedInputs !== null &&
      cachedInputs.elements === elements &&
      cachedInputs.files === files &&
      cachedInputs.viewBackgroundColor === appState.viewBackgroundColor &&
      cachedInputs.gridSize === appState.gridSize &&
      cachedInputs.gridStep === appState.gridStep &&
      cachedInputs.gridModeEnabled === appState.gridModeEnabled
    ) {
      return cachedSignature;
    }

    cachedInputs = {
      elements,
      files,
      viewBackgroundColor: appState.viewBackgroundColor,
      gridSize: appState.gridSize,
      gridStep: appState.gridStep,
      gridModeEnabled: appState.gridModeEnabled,
    };

    cachedSignature = drawingSignature(elements, appState, files);
    return cachedSignature;
  };

  const resolveTarget = (
    elements: readonly OrderedExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
    revision: number,
  ): SaveTarget => {
    if (latestDrawing && (revision !== latestRevision || latestDrawing[0] !== elements)) {
      return { snapshot: latestDrawing, revision: latestRevision };
    }
    return { snapshot: [elements, appState, files], revision };
  };

  const retryLatest = () => {
    if (!latestDrawing || disposed) return;
    const [le, la, lf] = latestDrawing;
    debounced(le, la, lf, latestRevision);
  };

  const retryAfterSaveFailure = ({ snapshot, revision, epochAtStart }: SaveFailure) => {
    if (disposed) return;
    setDirty(true);
    if (epochAtStart !== retargetEpoch) {
      saveFailures = 0;
      retryLatest();
      return;
    }

    saveFailures += 1;
    if (saveFailures > MAX_SAVE_RETRIES) {
      debounced.cancel();
      if (!gaveUp) {
        gaveUp = true;
        setDirty(true);
        onSaveGaveUp?.(currentFileId);
      }
      return;
    }

    if (latestDrawing) {
      retryLatest();
      return;
    }

    const [elements, appState, files] = snapshot;
    debounced(elements, appState, files, revision);
  };

  const persistDrawing = async (
    elements: readonly OrderedExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
    revision: number,
    origin: SaveOrigin = "auto",
  ) => {
    const { snapshot: targetSnapshot, revision: targetRevision } = resolveTarget(
      elements,
      appState,
      files,
      revision,
    );
    const [targetElements, targetAppState, targetFiles] = targetSnapshot;

    const epochAtStart = retargetEpoch;
    const targetSignature = signatureFor(targetElements, targetAppState, targetFiles);
    const mySeq = ++saveSeq;
    savesInFlight += 1;

    try {
      const json = serializeSnapshot(targetElements, targetAppState, targetFiles);
      const ok = await save(currentFileId, json, origin);
      if (disposed || mySeq <= (ok ? persistedSeq : appliedSeq)) return ok;
      appliedSeq = Math.max(appliedSeq, mySeq);
      if (ok) {
        runPendingEvaluation();
        persistedSeq = mySeq;
        saveFailures = 0;
        gaveUp = false;
        if (epochAtStart === retargetEpoch) {
          baseline = targetSignature;
          diskBaseline = targetSignature;
          setDirty(latestSignature !== baseline);
          if (!dirty) debounced.cancel();
          else if (mode !== "off") retryLatest();
        } else {
          setDirty(true);
          if (mode !== "off") retryLatest();
        }
      } else if (targetRevision === latestRevision) {
        retryAfterSaveFailure({
          snapshot: targetSnapshot,
          revision: targetRevision,
          epochAtStart,
        });
      }

      return ok;
    } catch {
      if (mySeq <= appliedSeq || disposed) return false;
      appliedSeq = mySeq;
      if (targetRevision === latestRevision) {
        retryAfterSaveFailure({
          snapshot: targetSnapshot,
          revision: targetRevision,
          epochAtStart,
        });
      }

      return false;
    } finally {
      savesInFlight -= 1;
    }
  };

  const persistLatest = async (
    elements: readonly OrderedExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
    revision: number,
    origin: SaveOrigin = "auto",
  ) => {
    if (blocked || disposed) return;
    await persistDrawing(elements, appState, files, revision, origin);
  };

  const debounced = debounceAsync(persistLatest, autosaveWaitMs(initialAutosave));

  const flush = async (opts?: FlushOpts) => {
    if (disposed) return;

    const force = opts?.force === true;
    const explicit = opts?.explicit === true;
    if (mode === "off" && !explicit) return;

    runPendingEvaluation();
    if (!force && blocked) return;
    if (!dirty && !force) {
      if (savesInFlight > 0) await debounced.flush({ force: true });
      return;
    }

    const temporarilyUnblocked = force && blocked;
    if (temporarilyUnblocked) blocked = false;

    try {
      if (force && latestDrawing) {
        debounced.cancel();
        const [elements, appState, files] = latestDrawing;
        debounced(elements, appState, files, latestRevision, "explicit");
        await debounced.flush({ force: true });
        return;
      }
      await debounced.flush({ force });
    } finally {
      if (temporarilyUnblocked) blocked = true;
    }
  };

  const saveNow = async (options?: { force?: boolean }): Promise<SaveResult> => {
    const requestedLifetime = lifetime;
    const run = async (): Promise<SaveResult> => {
      if (disposed || blocked || requestedLifetime !== lifetime || !latestDrawing)
        return "cancelled";
      runPendingEvaluation();
      const current = latestDrawing;
      const [currentElements, currentAppState, currentFiles] = current;
      const signature = signatureFor(currentElements, currentAppState, currentFiles);
      if (
        !options?.force &&
        !deps.hasExternalConflict?.() &&
        savesInFlight === 0 &&
        signature === diskBaseline
      ) {
        debounced.cancel();
        return "unchanged";
      }
      debounced.cancel();
      const saved = await persistDrawing(
        currentElements,
        currentAppState,
        currentFiles,
        latestRevision,
        "explicit",
      );
      if (disposed || requestedLifetime !== lifetime) return "cancelled";
      if (!saved) return "failed";
      runPendingEvaluation();
      return latestSignature === diskBaseline && savesInFlight === 0
        ? "saved"
        : "saved-with-changes";
    };
    if (!explicitSaveInFlight) {
      explicitSaveInFlight = true;
      const started = run();
      saveNowTail = started.then(
        () => undefined,
        () => undefined,
      );
      const drain = async () => {
        try {
          let observed = saveNowTail;
          for (;;) {
            await observed;
            if (observed === saveNowTail) break;
            observed = saveNowTail;
          }
        } finally {
          explicitSaveInFlight = false;
        }
      };
      void drain();
      return started;
    }
    const queued = saveNowTail.then(run);
    saveNowTail = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  };

  const getSerializedContent = () => {
    if (!latestDrawing) return null;
    const [elements, appState, files] = latestDrawing;
    return serializeSnapshot(elements, appState, files);
  };

  const evaluateLatest = () => {
    cancelScheduledEvaluation = null;
    if (disposed || !latestDrawing) return;

    const [elements, appState, files] = latestDrawing;
    if (appState.isLoading) return;

    const current = signatureFor(elements, appState, files);
    if (baseline === null) {
      baseline = current;
      latestSignature = current;
      if (diskBaseline != null && current !== diskBaseline) {
        latestRevision += 1;
        setDirty(true);
        console.debug("[session] first evaluate persisted normalized baseline");
        void persistDrawing(elements, appState, files, latestRevision);
      }

      return;
    }

    if (current === latestSignature) return;

    saveFailures = 0;
    latestSignature = current;
    latestRevision += 1;

    if (current === baseline && savesInFlight === 0) {
      setDirty(false);
      debounced.cancel();
      return;
    }

    setDirty(true);
    if (mode === "off") return;
    if (!blocked) debounced(elements, appState, files, latestRevision);
  };

  const scheduleEvaluation = () => {
    if (cancelScheduledEvaluation !== null || disposed) return;
    cancelScheduledEvaluation = scheduleFrame(evaluateLatest);
  };

  const runPendingEvaluation = () => {
    if (cancelScheduledEvaluation === null) return;
    cancelScheduledEvaluation();
    evaluateLatest();
  };

  const onChange = (
    elements: readonly OrderedExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
  ) => {
    if (disposed || appState.isLoading) return;
    latestDrawing = [elements, appState, files];

    if (baseline === null) {
      evaluateLatest();
      return;
    }

    scheduleEvaluation();
  };

  const block = () => {
    blocked = true;
    debounced.pause();
  };

  const unblock = () => {
    blocked = false;
    debounced.resume();
  };

  const setAutosavePaused = (paused: boolean) => {
    if (paused) {
      block();
    } else {
      unblock();
    }
  };

  const setAutosaveMode = (next: AutosaveSetting) => {
    const prev = mode;
    mode = next.mode;
    if (next.mode !== "off") debounced.setWait(autosaveDebounceMs(next));
    if (next.mode === "off") debounced.cancel();
    setDirty(latestSignature !== null && latestSignature !== baseline);
    if (next.mode !== "off" && prev === "off" && !blocked && !disposed && dirty && latestDrawing) {
      const [elements, appState, files] = latestDrawing;
      debounced(elements, appState, files, latestRevision);
    }
  };

  const abandon = () => {
    debounced.cancel();
    saveFailures = 0;
    gaveUp = false;
    if (latestDrawing) {
      const [elements, appState, files] = latestDrawing;
      baseline = signatureFor(elements, appState, files);
    }
    latestSignature = baseline;
    setDirty(false);
  };

  const capturePersistence = () => {
    if (disposed || !latestDrawing || latestDrawing[1].isLoading) return null;
    runPendingEvaluation();
    const [elements, appState, files] = latestDrawing;
    const content = serializeSnapshot(elements, appState, files);
    const signature = signatureFor(elements, appState, files);
    const capturedLifetime = lifetime;
    const mySeq = ++saveSeq;
    let acknowledged = false;
    return {
      content,
      acknowledge: () => {
        if (disposed || capturedLifetime !== lifetime || acknowledged || mySeq <= persistedSeq) {
          return false;
        }
        acknowledged = true;
        runPendingEvaluation();
        persistedSeq = mySeq;
        appliedSeq = Math.max(appliedSeq, mySeq);
        baseline = signature;
        diskBaseline = signature;
        saveFailures = 0;
        gaveUp = false;
        setDirty(latestSignature !== baseline);
        if (!dirty) debounced.cancel();
        else if (mode !== "off") retryLatest();
        return true;
      },
    };
  };

  const ensureCleanOrConfirm = async (
    reason: UnsavedReason,
    confirmUnsaved: (reason: UnsavedReason) => Promise<UnsavedChoice>,
  ) => {
    runPendingEvaluation();

    if (!dirty) {
      await flush({ force: false });
      return true;
    }

    block();

    try {
      const choice = await confirmUnsaved(reason);
      if (choice === "cancel") return false;

      if (choice === "discard") {
        abandon();
        return true;
      }

      await flush({ force: true, explicit: true });
      return !dirty;
    } finally {
      unblock();
    }
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    lifetime = {};

    if (cancelScheduledEvaluation !== null) {
      cancelScheduledEvaluation();
      cancelScheduledEvaluation = null;
    }

    debounced.cancel();
    latestDrawing = null;
    latestSignature = null;
    cachedInputs = null;
    cachedSignature = "";
  };

  return {
    onChange,
    saveNow,
    flush,
    setAutosavePaused,
    getSerializedContent,
    ensureCleanOrConfirm,
    isDirty: () => dirty,
    evaluateNow: runPendingEvaluation,
    setAutosaveMode,
    setInitialBaseline: (signature: string | null) => {
      if (disposed || baseline !== null) return;
      diskBaseline = signature;
    },
    invalidate: () => {
      lifetime = {};
      if (cancelScheduledEvaluation !== null) {
        cancelScheduledEvaluation();
        cancelScheduledEvaluation = null;
      }
      debounced.cancel();
      appliedSeq = saveSeq;
      persistedSeq = saveSeq;
      saveFailures = 0;
      gaveUp = false;
      latestDrawing = null;
      latestSignature = null;
      cachedInputs = null;
      cachedSignature = "";
      baseline = null;
      diskBaseline = null;
      setDirty(false);
    },
    capturePersistence,
    getLifetime: () => lifetime,
    retarget: (nextFileId: string) => {
      lifetime = {};
      currentFileId = nextFileId;
      retargetEpoch += 1;
    },
    dispose,
  };
};
