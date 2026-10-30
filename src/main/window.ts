import { join } from "node:path";

import { is } from "@electron-toolkit/utils";
import { LIBRARY_RETURNED, WINDOW_CLOSE_CANCELLED, WINDOW_WILL_CLOSE } from "@shared/channels";
import type {
  LibraryReturnedEvent,
  UnsavedChoice,
  UnsavedReason,
  WindowCloseRequest,
} from "@shared/ipc";
import { app, BrowserWindow, dialog, shell } from "electron";

import icon from "../../assets/icon.png?asset";
import { APP_GREETING_URL, APP_INDEX_URL, isTrustedRendererUrl } from "./ipc";
import { log } from "./logger";
import { windowBgColor } from "./settings";

type QuitState = "idle" | "pending";

type QuitCallbacks = {
  onApproved?: () => boolean | void;
  onCancelled?: () => void;
};

type CloseState = {
  awaitingRenderer: boolean;
  requestId: number;
  kind: "check" | "flush" | "flush-viewports" | null;
  timer: NodeJS.Timeout | null;
  lastArmedMs: number;
  silentDialogOpen: boolean;
  pendingAnswer: {
    requestId: number;
    dirty: boolean;
    skipPrompt: boolean;
  } | null;
  pendingFlushStarted: boolean;
};

let quitState: QuitState = "idle";
let quitCallbacks: QuitCallbacks | null = null;
let isQuitting = false;
let osShutdown = false;
let nextCloseRequestId = 0;
let mainWindow: BrowserWindow | null = null;
let libraryBrowserWindow: BrowserWindow | null = null;

const CHECK_TIMEOUT_MS = 5000;
const FLUSH_SILENCE_TIMEOUT_MS = 2000;
const FLUSH_WRITE_TIMEOUT_MS = 30_000;
const SHUTDOWN_CHECK_TIMEOUT_MS = 1000;
const SHUTDOWN_FLUSH_SILENCE_TIMEOUT_MS = 1000;
const SHUTDOWN_FLUSH_WRITE_TIMEOUT_MS = 3000;
const MAX_LIBRARY_HASH_LENGTH = 2048;
export const LIBRARY_BROWSE_HOST = "libraries.excalidraw.com";
export const LIBRARY_PARTITION = "xcalidraw-library";

const approvedCloses = new WeakSet<BrowserWindow>();
const readyWindows = new WeakSet<BrowserWindow>();
const closeStates = new WeakMap<BrowserWindow, CloseState>();

const closeStateFor = (win: BrowserWindow) => {
  const existing = closeStates.get(win);
  if (existing) return existing;

  const state: CloseState = {
    awaitingRenderer: false,
    requestId: 0,
    kind: null,
    timer: null,
    lastArmedMs: 0,
    silentDialogOpen: false,
    pendingAnswer: null,
    pendingFlushStarted: false,
  };

  closeStates.set(win, state);
  return state;
};

const clearTimer = (win: BrowserWindow) => {
  const state = closeStateFor(win);
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
};

const clearCloseRequest = (win: BrowserWindow) => {
  const state = closeStateFor(win);
  clearTimer(win);
  state.awaitingRenderer = false;
  state.kind = null;
  state.pendingAnswer = null;
  state.pendingFlushStarted = false;
};

export const isCloseFlowActive = (win: BrowserWindow) => {
  const state = closeStates.get(win);
  return state !== undefined && state.awaitingRenderer && !approvedCloses.has(win);
};

const sendToRenderer = (win: BrowserWindow, channel: string, ...args: unknown[]) => {
  if (win.isDestroyed() || win.webContents.isDestroyed() || win.webContents.isCrashed()) return;
  win.webContents.send(channel, ...args);
};

const isCurrentCloseRequest = (win: BrowserWindow, requestId: number) => {
  const state = closeStateFor(win);
  return state.awaitingRenderer && state.requestId === requestId;
};

export const showUnsavedChangesDialog = async (
  win: BrowserWindow | null,
  reason: UnsavedReason = "quit",
): Promise<UnsavedChoice> => {
  const options: Electron.MessageBoxOptions = {
    type: "warning",
    buttons: ["Save", "Don't save", "Cancel"],
    defaultId: 0,
    cancelId: 2,
    message: "You have unsaved changes.",
    detail:
      reason === "switch"
        ? "Do you want to save before leaving this drawing?"
        : "Do you want to save before quitting?",
  };

  const { response } = win
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options);

  if (response === 0) return "save";
  if (response === 1) return "discard";
  return "cancel";
};

const cancelPendingQuit = () => {
  if (quitState !== "pending") return;

  const callbacks = quitCallbacks;
  quitState = "idle";
  quitCallbacks = null;
  callbacks?.onCancelled?.();
};

const closeWindow = (win: BrowserWindow, reason?: string) => {
  if (win.isDestroyed()) return;

  approvedCloses.add(win);
  clearCloseRequest(win);

  const wasQuit = quitState === "pending";
  const callbacks = wasQuit ? quitCallbacks : null;
  quitState = "idle";
  quitCallbacks = null;

  if (reason) log.warn(`[close-guard] ${reason}`);
  if (wasQuit && callbacks?.onApproved) {
    isQuitting = true;
    let approved = false;
    try {
      approved = callbacks.onApproved() !== false;
    } catch (error) {
      log.error("[close-guard] quit approval callback failed", error);
    }

    if (!approved) {
      isQuitting = false;
      approvedCloses.delete(win);
      callbacks.onCancelled?.();
      sendToRenderer(win, WINDOW_CLOSE_CANCELLED);
    }
    return;
  }

  win.destroy();
  if (wasQuit) {
    isQuitting = true;
    app.quit();
  }
};

const armSilentTimer = (win: BrowserWindow, ms: number) => {
  const state = closeStateFor(win);
  if (state.timer) clearTimeout(state.timer);
  state.lastArmedMs = ms;
  state.timer = setTimeout(() => void onRendererSilent(win), ms);
};

const onRendererSilent = async (win: BrowserWindow) => {
  if (win.isDestroyed()) return;

  const state = closeStateFor(win);
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }

  if (approvedCloses.has(win)) return;
  if (!state.awaitingRenderer) return;

  if (osShutdown) {
    closeWindow(win, "closing window: os shutdown force close on unresponsive renderer");
    return;
  }

  if (state.silentDialogOpen) {
    armSilentTimer(win, CHECK_TIMEOUT_MS);
    return;
  }

  state.silentDialogOpen = true;
  let keepWaiting = false;

  try {
    const detail =
      state.kind === "flush"
        ? "The window stopped responding while xcalidraw was saving your changes. Close it anyway, or keep waiting for it to recover."
        : state.kind === "flush-viewports"
          ? "The window stopped responding while xcalidraw was saving your canvas view. Close it anyway, or keep waiting for it to recover."
          : "The window stopped responding while xcalidraw was checking for unsaved changes. Close it anyway, or keep waiting for it to recover.";
    const { response } = await dialog.showMessageBox(win, {
      type: "warning",
      buttons: ["Close anyway", "Keep waiting"],
      defaultId: 1,
      cancelId: 1,
      message: "xcalidraw isn't responding",
      detail,
    });
    keepWaiting = response !== 0;
  } catch (error) {
    log.error("[close-guard] unresponsive-window dialog failed", error);
    keepWaiting = false;
  }

  if (win.isDestroyed()) return;
  state.silentDialogOpen = false;

  const buffered = state.pendingAnswer;
  state.pendingAnswer = null;

  if (!keepWaiting) {
    if (state.pendingFlushStarted && isCurrentCloseRequest(win, state.requestId)) {
      state.pendingFlushStarted = false;
      onFlushStarted(win, state.requestId);
      return;
    }

    if (buffered && isCurrentCloseRequest(win, buffered.requestId)) {
      onDirtyState(win, buffered.requestId, buffered.dirty, buffered.skipPrompt);
      return;
    }

    closeWindow(win, "closing window: renderer did not answer the close request in time");
    return;
  }

  if (state.pendingFlushStarted && isCurrentCloseRequest(win, state.requestId)) {
    state.pendingFlushStarted = false;
    onFlushStarted(win, state.requestId);
    return;
  }

  if (buffered && isCurrentCloseRequest(win, buffered.requestId)) {
    onDirtyState(win, buffered.requestId, buffered.dirty, buffered.skipPrompt);
    return;
  }

  if (isCurrentCloseRequest(win, state.requestId)) {
    armSilentTimer(win, state.lastArmedMs > 0 ? state.lastArmedMs : CHECK_TIMEOUT_MS);
  }
};

const beginCloseFlow = (win: BrowserWindow) => {
  const state = closeStateFor(win);
  if (state.awaitingRenderer) return;

  state.awaitingRenderer = true;
  state.requestId = ++nextCloseRequestId;
  state.kind = "check";

  const request: WindowCloseRequest = { requestId: state.requestId, kind: "check" };
  sendToRenderer(win, WINDOW_WILL_CLOSE, request);
  armSilentTimer(win, osShutdown ? SHUTDOWN_CHECK_TIMEOUT_MS : CHECK_TIMEOUT_MS);
};

export const isQuittingNow = () => isQuitting;

export const abortApprovedQuit = (win: BrowserWindow | null) => {
  isQuitting = false;
  if (!win || win.isDestroyed()) return;

  approvedCloses.delete(win);
  sendToRenderer(win, WINDOW_CLOSE_CANCELLED);
};

export const enterOsShutdownMode = () => {
  osShutdown = true;
};

export const isOsShutdown = () => osShutdown;

export const resetOsShutdownForTest = () => {
  osShutdown = false;
};

export const isWindowReady = (win: BrowserWindow) => readyWindows.has(win);

export const markWindowReady = (win: BrowserWindow) => {
  readyWindows.add(win);
};

export const installCloseGuard = (win: BrowserWindow) => {
  win.once("closed", () => {
    readyWindows.delete(win);
    approvedCloses.delete(win);
    clearTimer(win);
    closeStates.delete(win);
  });

  const onRendererCrashed = () => {
    if (!isCloseFlowActive(win)) return;
    closeWindow(win, "force-closing window: renderer crashed during the close prompt");
  };

  const onRendererUnresponsive = () => {
    if (!isCloseFlowActive(win)) return;
    if (closeStateFor(win).silentDialogOpen) return;
    if (!osShutdown) {
      log.warn(
        "[close-guard] renderer unresponsive during the close prompt, showing keep-waiting dialog",
      );
    }
    void onRendererSilent(win);
  };

  win.webContents.on("unresponsive", onRendererUnresponsive);
  win.webContents.on("render-process-gone", onRendererCrashed);
  win.webContents.on("responsive", () => {
    log.warn("[close-guard] renderer responsive again", win.id);
  });

  win.on("close", (event) => {
    if (isQuitting) return;
    if (approvedCloses.has(win)) return;
    if (win.webContents.isDestroyed() || win.webContents.isCrashed()) return;
    if (!readyWindows.has(win)) return;

    event.preventDefault();
    beginCloseFlow(win);
  });
};

export const requestQuitViaRenderer = (win: BrowserWindow, callbacks?: QuitCallbacks) => {
  if (quitState === "pending") return false;
  quitState = "pending";
  quitCallbacks = callbacks ?? null;
  beginCloseFlow(win);
  return true;
};

export const onDirtyState = (
  win: BrowserWindow,
  requestId: number,
  dirty: boolean,
  skipPrompt: boolean,
) => {
  const state = closeStateFor(win);
  if (state.silentDialogOpen) {
    state.pendingAnswer = { requestId, dirty, skipPrompt };
    return;
  }

  if (!isCurrentCloseRequest(win, requestId) || state.kind !== "check") return;

  clearTimer(win);

  if (!dirty) {
    state.kind = "flush";
    const request: WindowCloseRequest = { requestId: state.requestId, kind: "flush" };
    sendToRenderer(win, WINDOW_WILL_CLOSE, request);
    armSilentTimer(win, osShutdown ? SHUTDOWN_FLUSH_SILENCE_TIMEOUT_MS : FLUSH_SILENCE_TIMEOUT_MS);
    return;
  }

  if (skipPrompt || osShutdown) {
    state.kind = "flush";
    const request: WindowCloseRequest = { requestId: state.requestId, kind: "flush" };
    sendToRenderer(win, WINDOW_WILL_CLOSE, request);
    armSilentTimer(win, osShutdown ? SHUTDOWN_FLUSH_SILENCE_TIMEOUT_MS : FLUSH_SILENCE_TIMEOUT_MS);
    return;
  }

  void (async () => {
    let choice: UnsavedChoice;
    try {
      choice = await showUnsavedChangesDialog(win, "quit");
    } catch (error) {
      log.error("[close-guard] unsaved-changes dialog failed", error);
      if (osShutdown) {
        closeWindow(win, "closing window: os shutdown force close after dialog failure");
        return;
      }
      clearCloseRequest(win);
      cancelPendingQuit();
      sendToRenderer(win, WINDOW_CLOSE_CANCELLED);
      return;
    }

    if (win.isDestroyed() || !isCurrentCloseRequest(win, requestId)) return;

    if (osShutdown) {
      state.kind = "flush";
      const request: WindowCloseRequest = { requestId: state.requestId, kind: "flush" };
      sendToRenderer(win, WINDOW_WILL_CLOSE, request);
      armSilentTimer(win, SHUTDOWN_FLUSH_SILENCE_TIMEOUT_MS);
      return;
    }

    if (choice === "cancel") {
      clearCloseRequest(win);
      cancelPendingQuit();
      sendToRenderer(win, WINDOW_CLOSE_CANCELLED);
      return;
    }

    if (choice === "discard") {
      state.kind = "flush-viewports";
      const request: WindowCloseRequest = {
        requestId: state.requestId,
        kind: "flush-viewports",
      };
      sendToRenderer(win, WINDOW_WILL_CLOSE, request);
      armSilentTimer(win, FLUSH_SILENCE_TIMEOUT_MS);
      return;
    }

    state.kind = "flush";
    const request: WindowCloseRequest = { requestId: state.requestId, kind: "flush" };
    sendToRenderer(win, WINDOW_WILL_CLOSE, request);
    armSilentTimer(win, FLUSH_SILENCE_TIMEOUT_MS);
  })();
};

export const onFlushStarted = (win: BrowserWindow, requestId: number) => {
  const state = closeStateFor(win);
  if (state.silentDialogOpen) {
    state.pendingFlushStarted = true;
    return;
  }

  if (
    !isCurrentCloseRequest(win, requestId) ||
    (state.kind !== "flush" && state.kind !== "flush-viewports")
  ) {
    return;
  }

  armSilentTimer(win, osShutdown ? SHUTDOWN_FLUSH_WRITE_TIMEOUT_MS : FLUSH_WRITE_TIMEOUT_MS);
};

export const cancelQuit = (win: BrowserWindow, requestId: number) => {
  if (osShutdown) return;
  if (!isCurrentCloseRequest(win, requestId)) return;

  clearCloseRequest(win);
  cancelPendingQuit();
  sendToRenderer(win, WINDOW_CLOSE_CANCELLED);
};

export const destroyWindow = (win: BrowserWindow, requestId: number) => {
  if (!isCurrentCloseRequest(win, requestId)) return;

  closeWindow(win);
};

export const getMainWindow = (): BrowserWindow | null => mainWindow;

export function ensureMainWindow(): BrowserWindow {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow();
  } else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }

  return mainWindow;
}

export const isLibraryBrowseUrl = (urlString: string) => {
  try {
    const url = new URL(urlString);
    return url.protocol === "https:" && url.host === LIBRARY_BROWSE_HOST;
  } catch {
    return false;
  }
};

export const parseLibraryReturnHash = (urlString: string) => {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return null;
  }

  if (url.pathname !== "/" && url.pathname !== "/index.html") return null;

  const rawHash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  if (!rawHash) return null;

  const params = new URLSearchParams(rawHash);
  if (!params.get("addLibrary")) return null;

  return url.hash;
};

const isAllowedLibraryUrl = (urlString: string) => {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return false;
  }

  return url.protocol === "https:" && url.host === LIBRARY_BROWSE_HOST;
};

export const validateLibraryReturnHash = (urlString: string) => {
  const hash = parseLibraryReturnHash(urlString);
  if (!hash) return null;
  if (hash.length > MAX_LIBRARY_HASH_LENGTH) return null;

  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const libraryUrl = params.get("addLibrary");
  if (!libraryUrl) return null;

  try {
    return isAllowedLibraryUrl(decodeURIComponent(libraryUrl)) ? hash : null;
  } catch {
    return null;
  }
};

const closeLibraryBrowserWindow = () => {
  if (libraryBrowserWindow && !libraryBrowserWindow.isDestroyed()) {
    libraryBrowserWindow.destroy();
  }
  libraryBrowserWindow = null;
};

const forwardLibraryReturn = (hash: string) => {
  const target = getMainWindow();
  if (
    !target ||
    target.isDestroyed() ||
    target.webContents.isDestroyed() ||
    target.webContents.isCrashed()
  ) {
    return;
  }

  const event: LibraryReturnedEvent = { hash };
  target.webContents.send(LIBRARY_RETURNED, event);
};

function openLibraryBrowserWindow(url: string) {
  const child = new BrowserWindow({
    width: 1024,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: windowBgColor(),
    ...(process.platform === "linux" ? { icon } : {}),
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: LIBRARY_PARTITION,
    },
  });

  libraryBrowserWindow = child;
  child.once("closed", () => {
    if (libraryBrowserWindow === child) libraryBrowserWindow = null;
  });

  showWhenReady(child);
  wireRendererDiagnostics(child);

  child.webContents.setWindowOpenHandler(({ url: popupUrl }) => {
    if (isTrustedRendererUrl(popupUrl)) {
      const hash = validateLibraryReturnHash(popupUrl);
      if (hash) {
        forwardLibraryReturn(hash);
        child.close();
      }
      return { action: "deny" };
    }

    const external = isSafeExternalUrl(popupUrl);
    if (external) void shell.openExternal(external);
    return { action: "deny" };
  });

  child.webContents.on("will-navigate", (event, target) => {
    if (isLibraryBrowseUrl(target)) return;

    event.preventDefault();

    if (isTrustedRendererUrl(target)) {
      const hash = validateLibraryReturnHash(target);
      if (hash) {
        forwardLibraryReturn(hash);
        child.close();
      }
      return;
    }

    const external = isSafeExternalUrl(target);
    if (external) void shell.openExternal(external);
  });

  void child.loadURL(url);
}

// https://github.com/electron/electron/issues/48859
function showWhenReady(win: BrowserWindow) {
  let shown = false;
  const show = () => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    win.show();
  };

  win.once("ready-to-show", show);
  win.webContents.once("did-finish-load", show);
}

const isSafeExternalUrl = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:"
      ? url.href
      : null;
  } catch {
    return null;
  }
};

function wireNavigationPolicy(win: BrowserWindow) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isLibraryBrowseUrl(url)) {
      if (libraryBrowserWindow && !libraryBrowserWindow.isDestroyed()) {
        libraryBrowserWindow.show();
        libraryBrowserWindow.focus();
      } else {
        openLibraryBrowserWindow(url);
      }
      return { action: "deny" };
    }

    const external = isSafeExternalUrl(url);
    if (external) void shell.openExternal(external);
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    if (isTrustedRendererUrl(url)) return;
    event.preventDefault();
    const external = isSafeExternalUrl(url);
    if (external) void shell.openExternal(external);
  });
}

const baseWebPreferences = () => ({
  preload: join(import.meta.dirname, "../preload/index.cjs"),
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
});

function wireRendererDiagnostics(win: BrowserWindow) {
  win.webContents.on("preload-error", (_event, preloadPath, error) =>
    log.error("Preload failed:", preloadPath, error),
  );

  win.webContents.on("unresponsive", () => {
    log.warn("[webContents] unresponsive", win.id);
  });
}

function loadRendererPage(win: BrowserWindow, devPath: string, prodUrl: string) {
  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    const base = process.env["ELECTRON_RENDERER_URL"].replace(/\/$/, "");
    void win.loadURL(devPath ? `${base}/${devPath}` : base);
    return;
  }

  void win.loadURL(prodUrl);
}

export function createMainWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    backgroundColor: windowBgColor(),
    ...(process.platform === "linux" ? { icon } : {}),
    webPreferences: baseWebPreferences(),
  });

  if (process.platform !== "darwin") {
    win.setMenuBarVisibility(false);
  }

  showWhenReady(win);
  installCloseGuard(win);

  win.once("closed", () => {
    closeLibraryBrowserWindow();
    if (mainWindow === win) mainWindow = null;
  });

  wireNavigationPolicy(win);
  wireRendererDiagnostics(win);
  loadRendererPage(win, "", APP_INDEX_URL);

  return win;
}

export function createGreetingWindow() {
  const greetingWindow = new BrowserWindow({
    width: 600,
    height: 400,
    frame: false,
    resizable: false,
    center: true,
    show: false,
    backgroundColor: windowBgColor(),
    ...(process.platform === "linux" ? { type: "splash" } : {}),
    webPreferences: baseWebPreferences(),
  });

  showWhenReady(greetingWindow);
  wireNavigationPolicy(greetingWindow);
  wireRendererDiagnostics(greetingWindow);
  loadRendererPage(greetingWindow, "greeting.html", APP_GREETING_URL);

  return greetingWindow;
}
