import { Buffer } from "node:buffer";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
  APP_QUIT,
  CONTEXT_MENU_SHOW,
  DIALOG_FILE_CHANGED,
  DIALOG_FILE_RECOVER,
  DIALOG_UNSAVED_CHANGES,
  DRAWINGS_GET,
  DRAWINGS_LOAD,
  DRAWINGS_PICK,
  FILES_CREATE,
  FILES_DELETE,
  FILES_LIST,
  FILES_READ,
  FILES_RENAME,
  FILES_WRITE,
  FILES_WRITE_RECOVER,
  SETTINGS_GET,
  SETTINGS_SET,
  STORE_DELETE,
  STORE_GET,
  STORE_SET,
  THUMBNAILS_GET,
  THUMBNAILS_PUT,
  UPDATES_CHECK,
  UPDATES_DOWNLOAD,
  UPDATES_INSTALL,
  UPDATES_STATUS_GET,
  WINDOW_CANCEL_QUIT,
  WINDOW_CLOSE,
  WINDOW_DIRTY_STATE,
  WINDOW_FLUSH_STARTED,
  WINDOW_READY,
  WINDOW_REPORT_FATAL,
} from "@shared/channels";
import {
  codedError,
  isRecord,
  isSerializedAppError,
  toRendererSafe,
  toSerialized,
} from "@shared/errors";
import type { ErrorOperation, RendererSafeError } from "@shared/errors";
import { MAX_DRAWING_CONTENT_BYTES, MAX_THUMBNAIL_BATCH } from "@shared/ipc";
import type {
  AppSettings,
  ChannelMap,
  ChannelName,
  ContextMenuRequest,
  DrawingInfo,
  DrawingsSnapshot,
  FileDeleteMode,
  FileEntry,
  RendererStoreKey,
  SettingsUpdate,
  ThumbnailRecord,
  UnsavedChoice,
  UnsavedReason,
  UpdateStatus,
} from "@shared/ipc";
import { parseRecentFileHistory } from "@shared/recent-history";
import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol } from "electron";

import { log } from "./logger";
import { validateSettingsUpdate } from "./settings";
import { store } from "./store";
import { isValidThumbnailRecord } from "./thumbnails";

export const APP_ORIGIN = "app://renderer";
export const APP_HOST = "renderer";
export const APP_INDEX_URL = `${APP_ORIGIN}/index.html`;
export const APP_GREETING_URL = `${APP_ORIGIN}/greeting.html`;
export const MAX_LIBRARY_STORE_BYTES = 2 * 1024 * 1024;

const MAX_CONTEXT_MENU_ITEMS = 20;
const MAX_CONTEXT_MENU_TEXT_LENGTH = 200;

let lastFatalAt = 0;

const schemaString = (value: unknown, field: string) => {
  if (typeof value !== "string" || value.length === 0) {
    throw codedError(`${field} must be a non-empty string`, {
      code: "INVALID",
      reason: "invalid-payload",
      field,
    });
  }
  return value;
};

const schemaOptionalString = (value: unknown, field: string) => {
  if (value === null) return null;
  return schemaString(value, field);
};

const schemaBoolean = (value: unknown, field: string) => {
  if (typeof value !== "boolean") {
    throw codedError(`${field} must be a boolean`, {
      code: "INVALID",
      reason: "invalid-payload",
      field,
    });
  }
  return value;
};

const schemaContent = (value: unknown, field: string) => {
  const content = schemaString(value, field);
  if (Buffer.byteLength(content, "utf8") > MAX_DRAWING_CONTENT_BYTES) {
    throw codedError(`Content exceeds ${MAX_DRAWING_CONTENT_BYTES} bytes`, {
      code: "TOO_LARGE",
      reason: "content-too-large",
      limit: MAX_DRAWING_CONTENT_BYTES,
    });
  }
  return content;
};

const schemaIdArray = (value: unknown) => {
  if (!Array.isArray(value))
    throw codedError("ids must be an array", {
      code: "INVALID",
      reason: "invalid-payload",
      field: "ids",
    });
  if (value.length > MAX_THUMBNAIL_BATCH) {
    throw codedError(`Too many ids, max ${MAX_THUMBNAIL_BATCH}`, {
      code: "TOO_LARGE",
      reason: "too-many-ids",
      limit: MAX_THUMBNAIL_BATCH,
    });
  }
  return [...new Set(value.map((item) => schemaString(item, "id")))];
};

const schemaDeleteMode = (value: unknown): FileDeleteMode => {
  if (value !== "trash" && value !== "permanent") {
    throw codedError("Delete mode must be trash or permanent", {
      code: "INVALID",
      reason: "invalid-payload",
      field: "mode",
    });
  }
  return value;
};

const schemaInteger = (value: unknown, field: string) => {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw codedError(`${field} must be a finite integer`, {
      code: "INVALID",
      reason: "invalid-payload",
      field,
    });
  }
  return value;
};

export const requireContextMenuRequest = (request: unknown): ContextMenuRequest => {
  if (!isRecord(request)) {
    throw codedError("Context menu request must be an object", {
      code: "INVALID",
      reason: "invalid-payload",
      field: "request",
    });
  }
  const { items, x, y } = request;
  if (!Array.isArray(items) || items.length === 0) {
    throw codedError("Context menu items must be a non-empty array", {
      code: "INVALID",
      reason: "invalid-payload",
      field: "items",
    });
  }
  if (items.length > MAX_CONTEXT_MENU_ITEMS) {
    throw codedError(`Context menu items must be at most ${MAX_CONTEXT_MENU_ITEMS}`, {
      code: "TOO_LARGE",
      reason: "content-too-large",
      limit: MAX_CONTEXT_MENU_ITEMS,
    });
  }
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    !Number.isFinite(x) ||
    !Number.isFinite(y)
  ) {
    throw codedError("Context menu position must be finite numbers", {
      code: "INVALID",
      reason: "invalid-payload",
      field: "x",
    });
  }
  if (x < 0 || y < 0) {
    throw codedError("Context menu position must not be negative", {
      code: "INVALID",
      reason: "invalid-payload",
      field: "x",
    });
  }
  return {
    items: items.map((item) => {
      if (!isRecord(item)) {
        throw codedError("Context menu item must be an object", {
          code: "INVALID",
          reason: "invalid-payload",
          field: "items",
        });
      }
      if (
        typeof item.id !== "string" ||
        item.id.length === 0 ||
        item.id.length > MAX_CONTEXT_MENU_TEXT_LENGTH
      ) {
        throw codedError("Context menu item id must be a non-empty string", {
          code: "INVALID",
          reason: "invalid-payload",
          field: "id",
        });
      }
      if (
        typeof item.label !== "string" ||
        item.label.length === 0 ||
        item.label.length > MAX_CONTEXT_MENU_TEXT_LENGTH
      ) {
        throw codedError("Context menu item label must be a non-empty string", {
          code: "INVALID",
          reason: "invalid-payload",
          field: "label",
        });
      }
      return { id: item.id, label: item.label };
    }),
    x,
    y,
  };
};

export const registerAppScheme = () => {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "app",
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
};

const rendererDir = join(import.meta.dirname, "../renderer");

const pageFor = (pathname: string) => {
  const relative = decodeURIComponent(pathname).replace(/^\/+/, "");
  const withIndex = relative === "" || relative.endsWith("/") ? `${relative}index.html` : relative;
  const filePath = resolve(rendererDir, withIndex);
  if (filePath !== rendererDir && !filePath.startsWith(rendererDir + sep)) return null;
  return filePath;
};

export const installAppProtocolHandler = () => {
  protocol.handle("app", async (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return new Response("Bad request", { status: 400 });
    }

    if (url.host !== APP_HOST) return new Response("Not found", { status: 404 });

    let filePath: string | null;
    try {
      filePath = pageFor(url.pathname);
    } catch {
      return new Response("Bad request", { status: 400 });
    }

    if (filePath === null) return new Response("Forbidden", { status: 403 });

    try {
      const response = await net.fetch(pathToFileURL(filePath).toString());
      return response.ok ? response : new Response("Not found", { status: 404 });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
};

type Deps = {
  getDrawings: () => Promise<DrawingInfo>;
  loadDrawings: () => Promise<DrawingsSnapshot>;
  listEntries: (root?: string) => Promise<FileEntry[]>;
  pickDrawings: (parentWindow: BrowserWindow | null) => Promise<DrawingInfo | null>;
  readDrawingFile: (id: string) => Promise<string>;
  writeDrawingFile: (id: string, content: string) => Promise<FileEntry>;
  writeDrawingFileRecover: (id: string, content: string) => Promise<FileEntry>;
  renameEntry: (id: string, newName: string) => Promise<FileEntry>;
  createEntry: (
    parentId: string | null,
    name: string,
    kind: "file" | "directory",
  ) => Promise<FileEntry>;
  deleteEntry: (id: string, mode: FileDeleteMode) => Promise<void>;
  destroyWindow: (win: BrowserWindow, requestId: number) => void;
  markWindowReady: (win: BrowserWindow) => void;
  cancelQuit: (win: BrowserWindow, requestId: number) => void;
  onDirtyState: (
    win: BrowserWindow,
    requestId: number,
    dirty: boolean,
    skipPrompt: boolean,
  ) => void;
  onFlushStarted: (win: BrowserWindow, requestId: number) => void;
  showUnsavedChangesDialog: (
    win: BrowserWindow | null,
    reason: UnsavedReason,
  ) => Promise<UnsavedChoice>;
  getSettings: () => AppSettings;
  updateSettings: (update: SettingsUpdate) => AppSettings;
  getThumbnails: (ids: string[]) => Promise<ThumbnailRecord[]>;
  saveThumbnail: (record: ThumbnailRecord) => Promise<void>;
  getUpdateStatus: () => UpdateStatus;
  checkForUpdates: () => Promise<UpdateStatus>;
  downloadUpdate: () => UpdateStatus;
  installUpdate: () => void;
};

const windowFromEvent = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return null;
  return win;
};

export const isTrustedRendererUrl = (urlString: string) => {
  try {
    if (!app.isPackaged) {
      const rendererUrl = process.env["ELECTRON_RENDERER_URL"];
      if (rendererUrl) {
        return new URL(urlString).origin === new URL(rendererUrl).origin;
      }
    }

    const url = new URL(urlString);
    return url.protocol === "app:" && url.host === APP_HOST;
  } catch {
    return false;
  }
};

export const normalizeContextMenuPos = (x: number, y: number, zoomFactor: number) => {
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(zoomFactor) ||
    x < 0 ||
    y < 0
  ) {
    return null;
  }

  return {
    x: Math.floor(x * zoomFactor),
    y: Math.floor(y * zoomFactor),
  };
};

export function assertRendererStoreKey(key: unknown): asserts key is RendererStoreKey {
  if (key !== "lastOpenedFileId" && key !== "libraryItems" && key !== "recentFiles") {
    throw codedError("Store key is not allowed", {
      code: "INVALID",
      reason: "invalid-payload",
      field: "key",
    });
  }
}

type Result<T> = { ok: true; value: T } | { ok: false; error: RendererSafeError };

const withIpcResult = async <T>(
  operation: ErrorOperation,
  fn: () => Promise<T> | T,
): Promise<Result<T>> => {
  try {
    const value = await fn();
    return { ok: true, value };
  } catch (error) {
    const full = toSerialized(error, operation);
    const safe = toRendererSafe(full);
    if (full.code === "UNKNOWN") {
      log.warn("[ipc:error]", operation, full);
    } else {
      log.debug("[ipc:error]", operation, safe);
    }
    return { ok: false, error: safe };
  }
};

export const shouldQuitAfterFatal = (now = Date.now()) => {
  const previous = lastFatalAt;
  lastFatalAt = now;
  return previous === 0 || now - previous >= 60_000;
};

const handle = <K extends ChannelName>(
  channel: K,
  operation: ChannelMap[K]["operation"],
  listener: (
    event: Electron.IpcMainInvokeEvent,
    ...args: ChannelMap[K]["args"]
  ) => ChannelMap[K]["result"] | Promise<ChannelMap[K]["result"]>,
) => {
  ipcMain.handle(channel, (event, ...args: ChannelMap[K]["args"]) =>
    withIpcResult(operation, () => listener(event, ...args)),
  );
};

const on = (
  channel: string,
  listener: (event: Electron.IpcMainEvent, ...args: unknown[]) => void,
) => {
  ipcMain.on(channel, (event, ...args) => {
    try {
      listener(event, ...args);
    } catch (error) {
      console.error(`[ipcMain.on] ${channel} listener error:`, error);
    }
  });
};

export const registerIpcHandlers = (deps: Deps) => {
  handle(DRAWINGS_GET, "load", () => deps.getDrawings());
  handle(DRAWINGS_LOAD, "load", () => deps.loadDrawings());

  handle(STORE_GET, "unexpected", (_event, key) => {
    assertRendererStoreKey(key);
    const value = store.get(key);
    return typeof value === "string" ? value : null;
  });

  handle(STORE_SET, "unexpected", (_event, key, raw) => {
    assertRendererStoreKey(key);

    let value: string | null;
    if (key === "libraryItems") {
      if (raw === null) {
        value = null;
      } else {
        if (typeof raw !== "string" || raw.length === 0) {
          throw codedError("value must be a non-empty string", {
            code: "INVALID",
            reason: "invalid-payload",
            field: "value",
          });
        }
        if (Buffer.byteLength(raw, "utf8") > MAX_LIBRARY_STORE_BYTES) {
          throw codedError(`Library is too large to store (max ${MAX_LIBRARY_STORE_BYTES} bytes)`, {
            code: "TOO_LARGE",
            reason: "library-too-large",
            limit: MAX_LIBRARY_STORE_BYTES,
          });
        }
        value = raw;
      }
    } else if (key === "recentFiles") {
      if (raw === null) {
        value = null;
      } else {
        if (
          typeof raw !== "string" ||
          Buffer.byteLength(raw, "utf8") > 64 * 1024 ||
          parseRecentFileHistory(raw) === null
        ) {
          throw codedError("value must be a valid recent-file history", {
            code: "INVALID",
            reason: "invalid-payload",
            field: "value",
          });
        }
        value = raw;
      }
    } else {
      value = schemaOptionalString(raw, "value");
    }

    store.set(key, value);
  });

  handle(STORE_DELETE, "unexpected", (_event, key) => {
    assertRendererStoreKey(key);
    store.delete(key);
  });

  handle(FILES_LIST, "read", () => deps.listEntries());

  handle(FILES_READ, "read", (_event, id) => {
    return deps.readDrawingFile(schemaString(id, "id"));
  });

  handle(FILES_RENAME, "rename", (_event, id, newName) => {
    return deps.renameEntry(schemaString(id, "id"), schemaString(newName, "newName"));
  });

  handle(FILES_CREATE, "create", (_event, parentRaw, name, kindRaw) => {
    const parentId = parentRaw === null ? null : schemaString(parentRaw, "parentId");
    const validName = schemaString(name, "name");
    if (kindRaw !== "file" && kindRaw !== "directory") {
      throw codedError("Kind must be file or directory", {
        code: "INVALID",
        reason: "invalid-payload",
        field: "kind",
      });
    }
    return deps.createEntry(parentId, validName, kindRaw);
  });

  handle(FILES_WRITE, "save", (_event, id, content) => {
    return deps.writeDrawingFile(schemaString(id, "id"), schemaContent(content, "content"));
  });

  handle(FILES_DELETE, "delete", (_event, id, modeRaw) => {
    const validId = schemaString(id, "id");
    const mode = modeRaw === undefined ? "trash" : schemaDeleteMode(modeRaw);
    return deps.deleteEntry(validId, mode);
  });

  handle(DRAWINGS_PICK, "folder", (event) => deps.pickDrawings(windowFromEvent(event)));
  handle(APP_QUIT, "unexpected", () => app.quit());

  handle(CONTEXT_MENU_SHOW, "unexpected", async (event, request) => {
    const win = windowFromEvent(event);
    if (!win) return null;

    const { items, x: xRaw, y: yRaw } = requireContextMenuRequest(request);

    return new Promise<string | null>((resolveSelection) => {
      let resolved = false;
      const settle = (value: string | null) => {
        if (resolved) return;
        resolved = true;
        resolveSelection(value);
      };

      const template = items.map((item) => ({
        label: item.label,
        enabled: true,
        click: () => settle(item.id),
      }));

      const menu = Menu.buildFromTemplate(template);
      const zoomFactor = win.webContents.getZoomFactor();
      const position = normalizeContextMenuPos(xRaw, yRaw, zoomFactor);

      win.once("closed", () => settle(null));

      menu.popup({
        window: win,
        ...position,
        callback: () => settle(null),
      });
    });
  });

  handle(SETTINGS_GET, "settings", () => deps.getSettings());

  handle(SETTINGS_SET, "settings", (_event, payload) => {
    if (!isRecord(payload))
      throw codedError("Settings update must be an object", {
        code: "INVALID",
        reason: "invalid-payload",
        field: "update",
      });
    return deps.updateSettings(validateSettingsUpdate(payload));
  });

  handle(WINDOW_CLOSE, "unexpected", (event, requestId) => {
    const win = windowFromEvent(event);
    if (!win) return;
    deps.destroyWindow(win, schemaInteger(requestId, "requestId"));
  });

  on(WINDOW_READY, (event) => {
    const win = windowFromEvent(event);
    if (win) deps.markWindowReady(win);
  });

  on(WINDOW_CANCEL_QUIT, (event, ...args) => {
    const win = windowFromEvent(event);
    if (win) deps.cancelQuit(win, schemaInteger(args[0], "requestId"));
  });

  on(WINDOW_DIRTY_STATE, (event, ...args) => {
    const win = windowFromEvent(event);
    if (win)
      deps.onDirtyState(
        win,
        schemaInteger(args[0], "requestId"),
        schemaBoolean(args[1], "dirty"),
        args[2] === undefined ? false : schemaBoolean(args[2], "skipPrompt"),
      );
  });

  on(WINDOW_FLUSH_STARTED, (event, ...args) => {
    const win = windowFromEvent(event);
    if (win) deps.onFlushStarted(win, schemaInteger(args[0], "requestId"));
  });

  handle(DIALOG_UNSAVED_CHANGES, "unexpected", (event, reason) => {
    const normalized = reason === "switch" ? "switch" : "quit";
    return deps.showUnsavedChangesDialog(windowFromEvent(event), normalized);
  });

  handle(FILES_WRITE_RECOVER, "recover", (_event, id, content) => {
    return deps.writeDrawingFileRecover(schemaString(id, "id"), schemaContent(content, "content"));
  });

  handle(DIALOG_FILE_RECOVER, "unexpected", async (event, fileNameRaw) => {
    const win = windowFromEvent(event);
    const fileName = typeof fileNameRaw === "string" ? fileNameRaw : "";
    const options: Electron.MessageBoxOptions = {
      type: "warning",
      buttons: ["Recover file", "Discard changes", "Cancel"],
      defaultId: 0,
      cancelId: 2,
      message: `"${fileName}" was deleted on disk.`,
    };

    const { response } = win
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options);

    if (response === 0) return "recover";
    if (response === 1) return "discard";
    return "cancel";
  });

  handle(DIALOG_FILE_CHANGED, "unexpected", async (event, fileNameRaw) => {
    const win = windowFromEvent(event);
    const fileName = typeof fileNameRaw === "string" ? fileNameRaw : "";
    const options: Electron.MessageBoxOptions = {
      type: "warning",
      buttons: ["Reload from disk", "Keep my changes", "Cancel"],
      defaultId: 0,
      cancelId: 2,
      message: `"${fileName}" was changed on disk.`,
      detail:
        "You have unsaved edits in this drawing. Reload discards your edits; keep writes your version to disk now.",
    };

    const { response } = win
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options);

    if (response === 0) return "reload";
    if (response === 1) return "overwrite";
    return "cancel";
  });

  handle(THUMBNAILS_GET, "read", (_event, ids) => deps.getThumbnails(schemaIdArray(ids)));

  handle(THUMBNAILS_PUT, "save", (_event, record) => {
    if (!isValidThumbnailRecord(record))
      throw codedError("Invalid thumbnail record", {
        code: "INVALID",
        reason: "invalid-payload",
        field: "record",
      });
    return deps.saveThumbnail(record);
  });

  handle(WINDOW_REPORT_FATAL, "unexpected", (_event, payload) => {
    if (!isSerializedAppError(payload))
      throw codedError("Invalid fatal payload", {
        code: "INVALID",
        reason: "invalid-payload",
        field: "payload",
      });
    log.error("[renderer:fatal]", payload);

    const shouldQuit = shouldQuitAfterFatal(Date.now());
    if (shouldQuit) {
      void dialog
        .showMessageBox({
          type: "error",
          buttons: ["Quit", "Continue"],
          defaultId: 0,
          cancelId: 1,
          message: "xcalidraw encountered a fatal error",
          detail: payload.message,
        })
        .then(({ response }) => {
          if (response === 0) app.quit();
        });
    }
  });

  handle(UPDATES_STATUS_GET, "unexpected", () => deps.getUpdateStatus());
  handle(UPDATES_CHECK, "unexpected", () => deps.checkForUpdates());
  handle(UPDATES_DOWNLOAD, "unexpected", () => deps.downloadUpdate());
  handle(UPDATES_INSTALL, "unexpected", () => deps.installUpdate());
};
