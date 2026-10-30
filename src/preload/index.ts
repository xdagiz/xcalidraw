import {
  APP_QUIT,
  CONTEXT_MENU_SHOW,
  DIALOG_FILE_CHANGED,
  DIALOG_FILE_RECOVER,
  DIALOG_UNSAVED_CHANGES,
  DRAWINGS_GET,
  DRAWINGS_LOAD,
  DRAWINGS_PICK,
  FILES_CHANGED,
  FILES_COPY,
  FILES_CREATE,
  FILES_DELETE,
  FILES_LIST,
  FILES_MOVE,
  FILES_READ,
  FILES_RENAME,
  FILES_WRITE,
  FILES_WRITE_RECOVER,
  LIBRARY_RETURNED,
  MCP_REQUEST,
  MCP_RESPONSE,
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
  UPDATES_STATUS,
  UPDATES_STATUS_GET,
  WATCHER_ERROR,
  WINDOW_CANCEL_QUIT,
  WINDOW_CLOSE,
  WINDOW_CLOSE_CANCELLED,
  WINDOW_DIRTY_STATE,
  WINDOW_FLUSH_STARTED,
  WINDOW_READY,
  WINDOW_REPORT_FATAL,
  WINDOW_WILL_CLOSE,
} from "@shared/channels";
import { codedError, isRecord, isRendererSafeError, isSerializedAppError } from "@shared/errors";
import type { RendererSafeError } from "@shared/errors";
import type { ChannelMap, ChannelName } from "@shared/ipc";
import type {
  FilesChangedEvent,
  LibraryReturnedEvent,
  McpRequest,
  UpdateStatus,
  WatcherErrorEvent,
  WindowCloseRequest,
} from "@shared/ipc";
import { contextBridge, ipcRenderer } from "electron";

import { NativeApi } from "./types";

type InvokeReturn = ReturnType<typeof ipcRenderer.invoke>;

const fromSerialized = (serialized: RendererSafeError): RendererSafeError => ({ ...serialized });

const isResult = (
  value: unknown,
): value is { ok: true; value: unknown } | { ok: false; error: unknown } => {
  if (!isRecord(value)) return false;
  if (!("ok" in value)) return false;

  const ok = value.ok;
  if (typeof ok !== "boolean") return false;
  if (ok) return "value" in value;

  return "error" in value;
};

const unwrap = async (promise: InvokeReturn): InvokeReturn => {
  const result = await promise;
  if (isResult(result)) {
    if (!result.ok) {
      const error = result.error;
      if (isRendererSafeError(error) || isSerializedAppError(error)) throw fromSerialized(error);
      if (error instanceof Error) throw error;
      throw codedError("Unknown error", { code: "UNKNOWN", reason: "io" });
    }

    return result.value;
  }

  throw codedError("Unknown error", { code: "UNKNOWN", reason: "io" });
};

const invoke = <K extends ChannelName>(
  channel: K,
  ...args: ChannelMap[K]["args"]
): Promise<ChannelMap[K]["result"]> => unwrap(ipcRenderer.invoke(channel, ...args));

const api: NativeApi = {
  app: {
    quit: () => invoke(APP_QUIT),
  },
  drawings: {
    get: () => invoke(DRAWINGS_GET),
    load: () => invoke(DRAWINGS_LOAD),
    pick: () => invoke(DRAWINGS_PICK),
  },
  files: {
    list: () => invoke(FILES_LIST),
    read: (id) => invoke(FILES_READ, id),
    write: (id, content) => invoke(FILES_WRITE, id, content),
    writeRecover: (id, content) => invoke(FILES_WRITE_RECOVER, id, content),
    rename: (id, newName) => invoke(FILES_RENAME, id, newName),
    move: (id, parentId) => invoke(FILES_MOVE, id, parentId),
    copy: (id, parentId) => invoke(FILES_COPY, id, parentId),
    create: (parentId, name, kind) => invoke(FILES_CREATE, parentId, name, kind),
    delete: (id, mode) => invoke(FILES_DELETE, id, mode),
    onChanged: (cb) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: FilesChangedEvent) =>
        cb(payload);
      ipcRenderer.on(FILES_CHANGED, listener);
      return () => ipcRenderer.removeListener(FILES_CHANGED, listener);
    },
    onWatcherError: (cb) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: WatcherErrorEvent) =>
        cb(payload);
      ipcRenderer.on(WATCHER_ERROR, listener);
      return () => ipcRenderer.removeListener(WATCHER_ERROR, listener);
    },
  },
  store: {
    get: (key) => invoke(STORE_GET, key),
    set: (key, value) => invoke(STORE_SET, key, value),
    delete: (key) => invoke(STORE_DELETE, key),
  },
  settings: {
    get: () => invoke(SETTINGS_GET),
    update: (updates) => invoke(SETTINGS_SET, updates),
  },
  updates: {
    getStatus: () => invoke(UPDATES_STATUS_GET),
    check: () => invoke(UPDATES_CHECK),
    download: () => invoke(UPDATES_DOWNLOAD),
    install: () => invoke(UPDATES_INSTALL),
    onStatus: (cb) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: UpdateStatus) => cb(payload);
      ipcRenderer.on(UPDATES_STATUS, listener);
      return () => ipcRenderer.removeListener(UPDATES_STATUS, listener);
    },
  },
  thumbnails: {
    get: (ids) => invoke(THUMBNAILS_GET, ids),
    put: (record) => invoke(THUMBNAILS_PUT, record),
  },
  library: {
    onReturned: (cb) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: LibraryReturnedEvent) =>
        cb(payload);
      ipcRenderer.on(LIBRARY_RETURNED, listener);
      return () => ipcRenderer.removeListener(LIBRARY_RETURNED, listener);
    },
  },
  mcp: {
    onRequest: (handler) => {
      const listener = async (
        _event: Electron.IpcRendererEvent,
        { id, name, args }: McpRequest,
      ) => {
        try {
          ipcRenderer.send(MCP_RESPONSE, { id, result: await handler(name, args) });
        } catch (error) {
          ipcRenderer.send(MCP_RESPONSE, {
            id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      };
      ipcRenderer.on(MCP_REQUEST, listener);
      return () => ipcRenderer.removeListener(MCP_REQUEST, listener);
    },
  },
  contextMenu: {
    show: (items, x, y) => invoke(CONTEXT_MENU_SHOW, { items, x, y }),
  },
  dialog: {
    unsavedChanges: (reason) => invoke(DIALOG_UNSAVED_CHANGES, reason),
    fileRecover: (fileName) => invoke(DIALOG_FILE_RECOVER, fileName),
    fileChanged: (fileName) => invoke(DIALOG_FILE_CHANGED, fileName),
  },
  window: {
    onWillClose: (cb) => {
      const listener = (_event: Electron.IpcRendererEvent, request: WindowCloseRequest) =>
        cb(request);
      ipcRenderer.on(WINDOW_WILL_CLOSE, listener);
      return () => ipcRenderer.removeListener(WINDOW_WILL_CLOSE, listener);
    },
    onCloseCancelled: (cb) => {
      const listener = () => cb();
      ipcRenderer.on(WINDOW_CLOSE_CANCELLED, listener);
      return () => {
        ipcRenderer.removeListener(WINDOW_CLOSE_CANCELLED, listener);
      };
    },
    ready: () => ipcRenderer.send(WINDOW_READY),
    close: (requestId) => invoke(WINDOW_CLOSE, requestId),
    cancelQuit: (requestId) => ipcRenderer.send(WINDOW_CANCEL_QUIT, requestId),
    reportDirtyState: (requestId, dirty, skipPrompt) =>
      ipcRenderer.send(WINDOW_DIRTY_STATE, requestId, dirty, skipPrompt),
    flushStarted: (requestId) => ipcRenderer.send(WINDOW_FLUSH_STARTED, requestId),
    reportFatal: (payload) => invoke(WINDOW_REPORT_FATAL, payload),
  },
};

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("api", api);
  } catch (error) {
    console.error(error);
  }
} else {
  Object.assign(globalThis, { api });
}
