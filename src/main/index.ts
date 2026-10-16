for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") return;
    process.emitWarning(`stdio stream error: ${error.message}`);
  });
}

import { electronApp, optimizer, is } from "@electron-toolkit/utils";
import { FILES_CHANGED, WATCHER_ERROR } from "@shared/channels";
import type { FilesChangedEvent, WatcherErrorEvent } from "@shared/ipc";
import {
  app,
  dialog,
  session,
  shell,
  nativeTheme,
  powerMonitor,
  BrowserWindow,
  Menu,
  type MenuItemConstructorOptions,
} from "electron";

import { getDrawings, pickDrawings } from "./drawings";
import {
  createEntry,
  deleteEntry,
  listEntries,
  readDrawingFile,
  renameEntry,
  writeDrawingFile,
  writeDrawingFileRecover,
  type FsMutationHooks,
} from "./files";
import {
  installAppProtocolHandler,
  isTrustedRendererUrl,
  registerAppScheme,
  registerIpcHandlers,
} from "./ipc";
import { initLogger, log } from "./logger";
import { applyTheme, getSettings, setSettings, applyWindowBgColor } from "./settings";
import { getLastOpenedFileId, getRecentFileIds } from "./store";
import { pruneThumbnailCache, readThumbnailRecords, writeThumbnailRecord } from "./thumbnails";
import { createDrawingsWatcher, type DrawingsWatcher } from "./watcher";
import {
  LIBRARY_PARTITION,
  cancelQuit,
  createGreetingWindow,
  destroyWindow,
  ensureMainWindow,
  enterOsShutdownMode,
  getMainWindow,
  isCloseFlowActive,
  isOsShutdown,
  isQuittingNow,
  isWindowReady,
  markWindowReady,
  onDirtyState,
  onFlushStarted,
  requestQuitViaRenderer,
  showUnsavedChangesDialog,
} from "./window";

process.on("uncaughtException", (error) => {
  log.error("[main:uncaughtException]", error);
  dialog.showErrorBox("xcalidraw crashed", error instanceof Error ? error.message : String(error));
  app.exit(1);
});

process.on("unhandledRejection", (reason) => {
  log.error("[main:unhandledRejection]", reason);
  dialog.showErrorBox(
    "xcalidraw crashed",
    reason instanceof Error ? reason.message : String(reason),
  );
  app.exit(1);
});

const MAX_CRASH_RELOADS = 3;
const CRASH_RELOAD_WINDOW_MS = 60_000;
const MAX_TRACKED_CRASH_WINDOWS = 20;
const crashReloadAttempts = new Map<number, number[]>();

const recordCrashReloadAttempt = (windowId: number, now: number): boolean => {
  const windowStart = now - CRASH_RELOAD_WINDOW_MS;
  const recent = (crashReloadAttempts.get(windowId) ?? []).filter((at) => at > windowStart);
  if (recent.length >= MAX_CRASH_RELOADS) {
    crashReloadAttempts.delete(windowId);
    crashReloadAttempts.set(windowId, recent);
    return false;
  }
  recent.push(now);
  crashReloadAttempts.delete(windowId);
  crashReloadAttempts.set(windowId, recent);
  while (crashReloadAttempts.size > MAX_TRACKED_CRASH_WINDOWS) {
    const oldest = crashReloadAttempts.keys().next().value;
    if (oldest === undefined) break;
    crashReloadAttempts.delete(oldest);
  }
  return true;
};

app.on("render-process-gone", (_event, webContents, details) => {
  if (details.reason === "clean-exit") return;
  log.error("[render-process-gone]", details);

  const win = BrowserWindow.fromWebContents(webContents);
  if (win === null || win.isDestroyed()) return;
  if (isCloseFlowActive(win)) return;

  if (!recordCrashReloadAttempt(win.id, Date.now())) {
    log.error("[render-process-gone] repeated crashes, offering quit only", details);
    void dialog
      .showMessageBox({
        type: "error",
        buttons: ["Quit"],
        defaultId: 0,
        cancelId: 0,
        message: "xcalidraw renderer keeps crashing",
        detail:
          "The window crashed repeatedly. Your saved drawings are safe, but unsaved changes may be lost.",
      })
      .then(() => {
        app.quit();
      })
      .catch((error) => log.error("[render-process-gone] dialog failed", error));
    return;
  }

  void dialog
    .showMessageBox({
      type: "error",
      buttons: ["Reload window", "Quit"],
      defaultId: 0,
      cancelId: 1,
      message: "xcalidraw renderer crashed",
      detail: `${details.reason} (${details.exitCode}). Your saved drawings are safe, but unsaved changes may be lost.`,
    })
    .then(({ response }) => {
      if (win.isDestroyed()) return;
      if (response === 0) {
        try {
          win.webContents.reload();
        } catch (error) {
          log.error("[render-process-gone] reload failed", error);
        }
        return;
      }
      app.quit();
    })
    .catch((error) => log.error("[render-process-gone] dialog failed", error));
});

app.on("child-process-gone", (_event, details) => {
  log.error("[child-process-gone]", details);
});

let watcher: DrawingsWatcher | null = null;
let lastWatcherErrorAt = 0;
let queuedWatcherError: string | null = null;
let queuedWatcherTimer: NodeJS.Timeout | null = null;
let shutdownHardQuitTimer: NodeJS.Timeout | null = null;

const WATCHER_ERROR_INTERVAL_MS = 10_000;
const SHUTDOWN_HARD_QUIT_MS = 6000;

const LIBRARY_CSP = [
  "default-src 'self'",
  "script-src 'self' https://www.googletagmanager.com",
  "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
  "img-src 'self' data:",
  "font-src 'self' data: https://excalidraw.com",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
].join("; ");

const APP_ALLOWED_PERMISSIONS = new Set([
  "fullscreen",
  "clipboard-read",
  "clipboard-sanitized-write",
]);

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) app.quit();

registerAppScheme();

function broadcastFilesChanged(event: FilesChangedEvent) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    if (win.webContents.isDestroyed() || win.webContents.isCrashed()) continue;
    if (win.webContents.session === session.fromPartition(LIBRARY_PARTITION)) continue;
    win.webContents.send(FILES_CHANGED, event);
  }
}

function sendWatcherError(event: WatcherErrorEvent) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    if (win.webContents.isDestroyed() || win.webContents.isCrashed()) continue;
    if (win.webContents.session === session.fromPartition(LIBRARY_PARTITION)) continue;
    win.webContents.send(WATCHER_ERROR, event);
  }
}

function broadcastWatcherError(error: unknown) {
  log.error("[watcher]", error);

  const message = error instanceof Error ? error.message : String(error);
  const now = Date.now();
  const remaining = WATCHER_ERROR_INTERVAL_MS - (now - lastWatcherErrorAt);

  if (remaining <= 0) {
    lastWatcherErrorAt = now;
    sendWatcherError({ message });
    return;
  }

  queuedWatcherError = message;
  if (queuedWatcherTimer) return;

  queuedWatcherTimer = setTimeout(() => {
    queuedWatcherTimer = null;
    if (!queuedWatcherError) return;
    lastWatcherErrorAt = Date.now();
    sendWatcherError({ message: queuedWatcherError });
    queuedWatcherError = null;
  }, remaining);
}

function createWatcher() {
  return createDrawingsWatcher(
    {
      onChange: broadcastFilesChanged,
      onRootInvalid: async (_reason, revision) => {
        const info = await getDrawings();
        broadcastFilesChanged({
          entries: [],
          revision,
          root: null,
          info,
        });
      },
      onError: (error) => {
        broadcastWatcherError(error);
      },
    },
    {
      listEntries,
      getDrawings,
    },
  );
}

function ensureWatcher() {
  if (!watcher) watcher = createWatcher();
  return watcher;
}

async function pruneThumbnails() {
  try {
    const entries = await listEntries();
    await pruneThumbnailCache(new Set(entries.map((entry) => entry.id)));
  } catch (error) {
    log.error("[thumbnails] prune failed", error);
  }
}

function withWatchIgnore<TArgs extends unknown[], TRet>(
  mutator: (...args: [...TArgs, FsMutationHooks?]) => TRet,
) {
  return (...args: [...TArgs]): TRet => {
    const w = ensureWatcher();
    return mutator(...args, {
      beforeMutate: (paths) => w.ignorePaths(paths),
    });
  };
}

const fastShutdownQuit = async () => {
  if (queuedWatcherTimer) {
    clearTimeout(queuedWatcherTimer);
    queuedWatcherTimer = null;
  }
  queuedWatcherError = null;
  const win = getMainWindow();
  if (
    isQuittingNow() ||
    !win ||
    win.isDestroyed() ||
    win.webContents.isCrashed() ||
    !isWindowReady(win)
  ) {
    void watcher?.stop();
    app.quit();
    return;
  }
  requestQuitViaRenderer(win);
  if (shutdownHardQuitTimer) clearTimeout(shutdownHardQuitTimer);
  shutdownHardQuitTimer = setTimeout(() => {
    shutdownHardQuitTimer = null;
    const current = getMainWindow();
    if (!current || current.isDestroyed()) return;
    log.warn("[shutdown] hard quit after flush budget");
    try {
      current.destroy();
    } finally {
      app.quit();
    }
  }, SHUTDOWN_HARD_QUIT_MS);
};

const installShutdownHandler = () => {
  powerMonitor.on("shutdown", (e?: { preventDefault: () => void }) => {
    e?.preventDefault();
    enterOsShutdownMode();
    void fastShutdownQuit().catch((error) => log.error("[shutdown] quit failed", error));
  });
};

const surfacePrimaryUi = async () => {
  if (isOsShutdown()) return;
  const main = getMainWindow();
  if (main && !main.isDestroyed()) {
    if (main.isMinimized()) main.restore();
    main.show();
    main.focus();
    return;
  }

  const existing = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed());
  const trusted = existing.find(
    (win) => !win.webContents.isDestroyed() && isTrustedRendererUrl(win.webContents.getURL()),
  );
  const win = trusted ?? existing[0];
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return;
  }

  const info = await getDrawings();
  if (info.configured && info.path) {
    const w = ensureWatcher();
    void w.start(info.path).catch((error) => log.error("[watcher] start failed", error));
    ensureMainWindow();
  } else {
    createGreetingWindow();
  }
};

const installPermissionHandlers = () => {
  const handlePermissionRequest = (
    webContents: Electron.WebContents,
    permission: string,
    callback: (granted: boolean) => void,
    details?: Electron.PermissionRequest,
  ) => {
    if (!APP_ALLOWED_PERMISSIONS.has(permission)) {
      callback(false);
      return;
    }

    callback(isTrustedRendererUrl(details?.requestingUrl || webContents.getURL()));
  };

  const handlePermissionCheck = (
    webContents: Electron.WebContents | null,
    permission: string,
    _requestingOrigin: string,
    details?: Electron.PermissionCheckHandlerHandlerDetails,
  ) => {
    if (!APP_ALLOWED_PERMISSIONS.has(permission)) return false;
    if (webContents === null) return false;
    return isTrustedRendererUrl(details?.requestingUrl || webContents.getURL());
  };

  for (const ses of [session.defaultSession, session.fromPartition(LIBRARY_PARTITION)]) {
    ses.setPermissionRequestHandler(handlePermissionRequest);
    ses.setPermissionCheckHandler(handlePermissionCheck);
  }
};

const installLibraryCsp = () => {
  session.fromPartition(LIBRARY_PARTITION).webRequest.onHeadersReceived((details, callback) => {
    let url: URL;
    try {
      url = new URL(details.url);
    } catch {
      callback({});
      return;
    }

    if (url.protocol !== "https:" || url.host !== "libraries.excalidraw.com") {
      callback({});
      return;
    }

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [LIBRARY_CSP],
      },
    });
  });
};

void app.whenReady().then(async () => {
  if (!gotTheLock) return;

  electronApp.setAppUserModelId("com.xcalidraw.app");
  initLogger();
  installLibraryCsp();
  installPermissionHandlers();
  installShutdownHandler();
  installAppProtocolHandler();

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === "darwin"
        ? ([{ role: "appMenu" }] as MenuItemConstructorOptions[])
        : []),
      ...(process.platform === "darwin"
        ? []
        : [{ label: "File", submenu: [{ role: "quit" }] as MenuItemConstructorOptions[] }]),
      { role: "editMenu" },
      {
        label: "View",
        submenu: [
          { role: "resetZoom", label: "Actual Size", accelerator: "Alt+0" },
          { role: "zoomIn", label: "Zoom In", accelerator: "Alt+=" },
          { role: "zoomOut", label: "Zoom Out", accelerator: "Alt+-" },
          ...(is.dev
            ? ([
                { type: "separator" },
                { role: "reload" },
                { role: "forceReload" },
                { role: "toggleDevTools" },
              ] as MenuItemConstructorOptions[])
            : []),
        ],
      },
      { role: "windowMenu" },
    ]),
  );

  applyTheme();
  nativeTheme.on("updated", applyWindowBgColor);

  app.on("browser-window-created", (_, win) => {
    optimizer.watchWindowShortcuts(win, { zoom: true });
    win.once("closed", () => {
      crashReloadAttempts.delete(win.id);
    });
  });

  registerIpcHandlers({
    getDrawings,
    loadDrawings: async () => {
      const info = await getDrawings();
      const entries = await listEntries();
      return {
        info,
        entries,
        prefs: {
          lastOpenedFileId: getLastOpenedFileId(),
          recentFileIds: getRecentFileIds(info.path),
        },
      };
    },
    listEntries,
    readDrawingFile,
    writeDrawingFile: withWatchIgnore(writeDrawingFile),
    renameEntry: withWatchIgnore(renameEntry),
    createEntry: withWatchIgnore(createEntry),
    deleteEntry: withWatchIgnore(
      (id: string, mode: Parameters<typeof deleteEntry>[1], hooks: FsMutationHooks | undefined) =>
        deleteEntry(id, mode, hooks, (trashPath) => shell.trashItem(trashPath)),
    ),
    writeDrawingFileRecover: withWatchIgnore(writeDrawingFileRecover),
    destroyWindow,
    markWindowReady,
    cancelQuit,
    onDirtyState,
    onFlushStarted,
    showUnsavedChangesDialog,
    getSettings,
    updateSettings: setSettings,
    getThumbnails: readThumbnailRecords,
    saveThumbnail: writeThumbnailRecord,
    pickDrawings: async (parentWindow) => {
      const info = await pickDrawings(parentWindow);
      if (info) {
        const w = ensureWatcher();
        if (info.configured && info.path) {
          if (w.getRoot() !== info.path) {
            await w.restart(info.path);
            void w.refreshNow().catch((error) => log.error("[watcher] refresh failed", error));
          }
          void pruneThumbnails();
        } else {
          await w.stop();
        }

        const active = ensureMainWindow();
        if (parentWindow && parentWindow !== active && !parentWindow.isDestroyed()) {
          parentWindow.close();
        }
      }

      return info;
    },
  });

  const info = await getDrawings();

  if (info.configured && info.path) {
    const w = ensureWatcher();
    await w.start(info.path);
    void pruneThumbnails();
    ensureMainWindow();
  } else {
    createGreetingWindow();
  }

  app.on("second-instance", () => {
    void surfacePrimaryUi().catch((error) => log.error("[ui] surface failed", error));
  });

  app.on("activate", () => {
    void surfacePrimaryUi().catch((error) => log.error("[ui] surface failed", error));
  });
});

app.on("before-quit", (event) => {
  if (queuedWatcherTimer) {
    clearTimeout(queuedWatcherTimer);
    queuedWatcherTimer = null;
  }
  queuedWatcherError = null;
  const win = getMainWindow();
  if (
    isQuittingNow() ||
    !win ||
    win.isDestroyed() ||
    win.webContents.isCrashed() ||
    !isWindowReady(win)
  ) {
    void watcher?.stop();
    return;
  }

  event.preventDefault();
  requestQuitViaRenderer(win);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
