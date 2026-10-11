import { codedError } from "./errors";
import type { RendererSafeError } from "./errors";

export const FILE_NOT_FOUND_MESSAGE = "File not found";

export type RendererStoreKey = "lastOpenedFileId" | "libraryItems" | "recentFiles";

export type ContextMenuRequest = {
  items: { id: string; label: string }[];
  x: number;
  y: number;
};

export type ChannelMap = {
  "drawings:get": { args: []; result: DrawingInfo; operation: "load" };
  "drawings:load": { args: []; result: DrawingsSnapshot; operation: "load" };
  "drawings:pick": { args: []; result: DrawingInfo | null; operation: "folder" };
  "files:list": { args: []; result: FileEntry[]; operation: "read" };
  "files:read": { args: [id: string]; result: string; operation: "read" };
  "files:write": { args: [id: string, content: string]; result: FileEntry; operation: "save" };
  "files:write-recover": {
    args: [id: string, content: string];
    result: FileEntry;
    operation: "recover";
  };
  "files:rename": { args: [id: string, newName: string]; result: FileEntry; operation: "rename" };
  "files:create": {
    args: [parentId: string | null, name: string, kind: "file" | "directory"];
    result: FileEntry;
    operation: "create";
  };
  "files:delete": { args: [id: string, mode?: FileDeleteMode]; result: void; operation: "delete" };
  "store:get": { args: [key: RendererStoreKey]; result: string | null; operation: "unexpected" };
  "store:set": {
    args: [key: RendererStoreKey, value: string | null];
    result: void;
    operation: "unexpected";
  };
  "store:delete": { args: [key: RendererStoreKey]; result: void; operation: "unexpected" };
  "settings:get": { args: []; result: AppSettings; operation: "settings" };
  "settings:set": { args: [update: SettingsUpdate]; result: AppSettings; operation: "settings" };
  "thumbnails:get": { args: [ids: string[]]; result: ThumbnailRecord[]; operation: "read" };
  "thumbnails:put": { args: [record: ThumbnailRecord]; result: void; operation: "save" };
  "context-menu:show": {
    args: [request: ContextMenuRequest];
    result: string | null;
    operation: "unexpected";
  };
  "dialog:unsaved-changes": {
    args: [reason?: UnsavedReason];
    result: UnsavedChoice;
    operation: "unexpected";
  };
  "dialog:file-recover": {
    args: [fileName: string];
    result: "recover" | "discard" | "cancel";
    operation: "unexpected";
  };
  "dialog:file-changed": {
    args: [fileName: string];
    result: "reload" | "overwrite" | "cancel";
    operation: "unexpected";
  };
  "app:quit": { args: []; result: void; operation: "unexpected" };
  "updates:check": { args: []; result: UpdateStatus; operation: "unexpected" };
  "updates:download": { args: []; result: UpdateStatus; operation: "unexpected" };
  "updates:install": { args: []; result: void; operation: "unexpected" };
  "updates:status:get": { args: []; result: UpdateStatus; operation: "unexpected" };
  "window:close": { args: [requestId: number]; result: void; operation: "unexpected" };
  "window:report-fatal": {
    args: [payload: RendererSafeError];
    result: void;
    operation: "unexpected";
  };
};

export type ChannelName = keyof ChannelMap;

export const FILE_DELETE_MODES = ["trash", "permanent"] as const;
export type FileDeleteMode = (typeof FILE_DELETE_MODES)[number];

export type ThemePreference = "light" | "dark" | "system";
export const DEFAULT_THEME: ThemePreference = "system";

export type DrawingInfo = {
  path: string | null;
  displayName: string | null;
  configured: boolean;
  missing: boolean;
};

export type Prefs = {
  lastOpenedFileId: string | null;
  recentFileIds: string[];
};

export type FileEntry = {
  id: string;
  name: string;
  kind: "file" | "directory";
  parentId: string | null;
  modifiedAt: number;
  size: number;
  ino: string;
  dev: string;
};

export const hasStableFileIdentity = (entry: Pick<FileEntry, "ino" | "dev">) =>
  entry.ino.length > 0 && entry.dev.length > 0 && (entry.ino !== "0" || entry.dev !== "0");

export const parentIdOf = (id: string) => {
  const idx = id.lastIndexOf("/");
  return idx === -1 ? null : id.slice(0, idx);
};

const entryCollator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

export const compareEntryIds = (a: string, b: string) =>
  entryCollator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);

export const sortFileEntries = (entries: FileEntry[]): FileEntry[] =>
  entries.toSorted((a, b) => compareEntryIds(a.id, b.id));

export type DrawingsSnapshot = {
  info: DrawingInfo;
  entries: FileEntry[];
  prefs: Prefs;
};

export type UnsavedReason = "quit" | "switch";
export type UnsavedChoice = "save" | "discard" | "cancel";
export type WindowCloseRequest = {
  requestId: number;
  kind: "check" | "flush";
};

export type StoreType = {
  drawingsPath?: string;
  lastOpenedFileId?: string | null;
  libraryItems?: string | null;
  recentFiles?: string | null;
  stagedUpdateVersion?: string | null;
  declinedUpdateVersion?: string | null;
  theme?: ThemePreference;
  autosave?: unknown;
  reopenLastDrawing?: boolean;
  showRecents?: boolean;
  autoDownloadUpdates?: boolean;
};

export type FilesChangedEvent = {
  entries: FileEntry[];
  revision: number;
  root: string | null;
  info?: DrawingInfo;
};

export type WatcherErrorEvent = {
  message: string;
};

export type UpdateStatus =
  | { state: "idle" }
  | { state: "available"; version: string }
  | { state: "downloading"; version: string; percent: number }
  | { state: "downloaded"; version: string }
  | { state: "installing"; version: string }
  | { state: "error"; version: string; message: string };

export const AUTOSAVE_PRESETS_MS = [1_000, 5_000, 15_000, 30_000] as const;
export const AUTOSAVE_ALWAYS_SETTLE_MS = 300;
export const AUTOSAVE_MODES = ["interval", "always", "off"] as const;

export type AutosaveMode = (typeof AUTOSAVE_MODES)[number];
export type AutosavePresetMs = (typeof AUTOSAVE_PRESETS_MS)[number];

export const DEFAULT_AUTOSAVE_INTERVAL_MS: AutosavePresetMs = 5_000;

export const isAutosavePresetMs = (value: number): value is AutosavePresetMs =>
  AUTOSAVE_PRESETS_MS.some((preset) => preset === value);

export type AutosaveSetting =
  | { mode: "interval"; ms: AutosavePresetMs }
  | { mode: "always" }
  | { mode: "off" };

export const DEFAULT_AUTOSAVE: AutosaveSetting = {
  mode: "always",
};

export const autosaveKey = (setting: AutosaveSetting) =>
  setting.mode === "interval" ? `interval:${setting.ms}` : setting.mode;

export const autosaveDebounceMs = (
  setting: Extract<AutosaveSetting, { mode: "interval" } | { mode: "always" }>,
) => (setting.mode === "interval" ? setting.ms : AUTOSAVE_ALWAYS_SETTLE_MS);

export const autosaveWaitMs = (setting: AutosaveSetting) =>
  setting.mode === "off" ? AUTOSAVE_ALWAYS_SETTLE_MS : autosaveDebounceMs(setting);

export const normalizeAutosaveSetting = (value: unknown): AutosaveSetting => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return DEFAULT_AUTOSAVE;
  const record = value as { mode?: unknown; ms?: unknown };
  if (record.mode === "always") return { mode: "always" };
  if (record.mode === "off") return { mode: "off" };
  if (
    record.mode === "interval" &&
    typeof record.ms === "number" &&
    isAutosavePresetMs(record.ms)
  ) {
    return { mode: "interval", ms: record.ms };
  }
  return DEFAULT_AUTOSAVE;
};

export const parseAutosaveKey = (key: string): AutosaveSetting | null => {
  if (key === "always") return { mode: "always" };
  if (key === "off") return { mode: "off" };
  if (!key.startsWith("interval:")) return null;
  const ms = Number(key.slice("interval:".length));
  if (!isAutosavePresetMs(ms)) return null;
  return { mode: "interval", ms };
};

export type AppSettings = {
  theme: ThemePreference;
  autosave: AutosaveSetting;
  reopenLastDrawing: boolean;
  showRecents: boolean;
  autoDownloadUpdates: boolean;
};

export type SettingsUpdate = Partial<AppSettings>;

export const DEFAULT_SETTINGS: AppSettings = {
  theme: DEFAULT_THEME,
  autosave: DEFAULT_AUTOSAVE,
  reopenLastDrawing: true,
  showRecents: true,
  autoDownloadUpdates: false,
};

export type ThumbnailRecord = {
  fileId: string;
  mtimeMs: number;
  size: number;
  ino?: string;
  dev?: string;
  light: string;
  dark: string;
};

export const MAX_THUMBNAIL_BATCH = 500;
export const MAX_DRAWING_CONTENT_BYTES = 10 * 1024 * 1024;

export const validateDrawingRecord = (record: unknown): void => {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw codedError("Drawing must be a JSON object", {
      code: "INVALID",
      reason: "invalid-record",
    });
  }
  if ("elements" in record && !Array.isArray(record.elements)) {
    throw codedError("Drawing elements must be an array when present", {
      code: "INVALID",
      reason: "invalid-record",
      field: "elements",
    });
  }
  if (
    "files" in record &&
    (record.files === null || typeof record.files !== "object" || Array.isArray(record.files))
  ) {
    throw codedError("Drawing files must be an object when present", {
      code: "INVALID",
      reason: "invalid-record",
      field: "files",
    });
  }
};

export type LibraryReturnedEvent = {
  hash: string;
};
