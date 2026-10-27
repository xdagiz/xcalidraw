import type { RendererSafeError } from "@shared/errors";
import type {
  AppSettings,
  DrawingInfo,
  DrawingsSnapshot,
  FileDeleteMode,
  FileEntry,
  FilesChangedEvent,
  LibraryReturnedEvent,
  RendererStoreKey,
  SettingsUpdate,
  StoreType,
  ThumbnailRecord,
  UnsavedChoice,
  UnsavedReason,
  UpdateStatus,
  WatcherErrorEvent,
  WindowCloseRequest,
} from "@shared/ipc";

export type ContextMenuItem = { id: string; label: string };
export type FileRecoverChoice = "recover" | "discard" | "cancel";
export type FileChangedChoice = "reload" | "overwrite" | "cancel";
export type StoreKey = keyof StoreType;
export type { RendererStoreKey };

export interface NativeApi {
  app: {
    quit: () => Promise<void>;
  };
  drawings: {
    get: () => Promise<DrawingInfo>;
    load: () => Promise<DrawingsSnapshot>;
    pick: () => Promise<DrawingInfo | null>;
  };
  files: {
    list: () => Promise<FileEntry[]>;
    read: (id: string) => Promise<string>;
    write: (id: string, content: string) => Promise<FileEntry>;
    writeRecover: (id: string, content: string) => Promise<FileEntry>;
    rename: (id: string, newName: string) => Promise<FileEntry>;
    create: (
      parentId: string | null,
      name: string,
      kind: "file" | "directory",
    ) => Promise<FileEntry>;
    delete: (id: string, mode?: FileDeleteMode) => Promise<void>;
    onChanged: (cb: (event: FilesChangedEvent) => void) => () => void;
    onWatcherError: (cb: (event: WatcherErrorEvent) => void) => () => void;
  };
  store: {
    get: (key: RendererStoreKey) => Promise<string | null>;
    set: (key: RendererStoreKey, value: string | null) => Promise<void>;
    delete: (key: RendererStoreKey) => Promise<void>;
  };
  settings: {
    get: () => Promise<AppSettings>;
    update: (updated: SettingsUpdate) => Promise<AppSettings>;
  };
  updates: {
    getStatus: () => Promise<UpdateStatus>;
    check: () => Promise<UpdateStatus>;
    download: () => Promise<UpdateStatus>;
    install: () => Promise<void>;
    onStatus: (cb: (status: UpdateStatus) => void) => () => void;
  };
  thumbnails: {
    get: (ids: string[]) => Promise<ThumbnailRecord[]>;
    put: (record: ThumbnailRecord) => Promise<void>;
  };
  library: {
    onReturned: (cb: (event: LibraryReturnedEvent) => void) => () => void;
  };
  mcp: {
    onRequest: (
      handler: (name: string, args: Record<string, unknown>) => Promise<unknown>,
    ) => () => void;
  };
  contextMenu: {
    show: (items: ContextMenuItem[], x: number, y: number) => Promise<string | null>;
  };
  dialog: {
    unsavedChanges: (reason?: UnsavedReason) => Promise<UnsavedChoice>;
    fileRecover: (fileName: string) => Promise<FileRecoverChoice>;
    fileChanged: (fileName: string) => Promise<FileChangedChoice>;
  };
  window: {
    onWillClose: (cb: (request: WindowCloseRequest) => void) => () => void;
    onCloseCancelled: (cb: () => void) => () => void;
    ready: () => void;
    close: (requestId: number) => Promise<void>;
    cancelQuit: (requestId: number) => void;
    reportDirtyState: (requestId: number, dirty: boolean, skipPrompt?: boolean) => void;
    flushStarted: (requestId: number) => void;
    reportFatal: (payload: RendererSafeError) => Promise<void>;
  };
}
