import { renameSync } from "node:fs";
import { join } from "node:path";

import { AUTOSAVE_PRESETS_MS, DEFAULT_AUTOSAVE, DEFAULT_THEME, StoreType } from "@shared/ipc";
import { recentFileIdsForRoot } from "@shared/recent-history";
import { app } from "electron";
import Store from "electron-store";

import { log } from "./logger";

const schema = {
  drawingsPath: {
    type: ["string", "null"],
  },
  lastOpenedFileId: {
    type: ["string", "null"],
  },
  libraryItems: {
    type: ["string", "null"],
    default: null,
  },
  recentFiles: {
    type: ["string", "null"],
    default: null,
  },
  stagedUpdateVersion: {
    type: ["string", "null"],
    default: null,
  },
  declinedUpdateVersion: {
    type: ["string", "null"],
    default: null,
  },
  theme: {
    type: "string",
    enum: ["light", "dark", "system"],
    default: DEFAULT_THEME,
  },
  autosave: {
    type: "object",
    properties: {
      mode: { type: "string", enum: ["interval", "always", "off"] },
      ms: { type: "number", enum: [...AUTOSAVE_PRESETS_MS] },
    },
    required: ["mode"],
    additionalProperties: false,
    default: DEFAULT_AUTOSAVE,
  },
  reopenLastDrawing: {
    type: "boolean",
    default: true,
  },
  showRecents: {
    type: "boolean",
    default: true,
  },
  autoDownloadUpdates: {
    type: "boolean",
    default: false,
  },
};

const createStore = (): Store<StoreType> => {
  try {
    return new Store<StoreType>({ name: "settings", schema });
  } catch (error) {
    const backupPath = join(app.getPath("userData"), `settings.corrupt-${Date.now()}.json`);
    try {
      renameSync(join(app.getPath("userData"), "settings.json"), backupPath);
      log.error("[settings] corrupt settings.json moved to", backupPath, error);
    } catch (moveError) {
      log.error("[settings] corrupt settings.json could not be moved", moveError);
    }
    return new Store<StoreType>({ name: "settings", schema });
  }
};

export const store = createStore();

export const getDrawingPath = () => nonEmptyString(store.get("drawingsPath"));

export const setDrawingPath = (newPath: string) => store.set("drawingsPath", newPath);

export const getLastOpenedFileId = () => nonEmptyString(store.get("lastOpenedFileId"));

export const getRecentFileIds = (rootPath: string | null) =>
  recentFileIdsForRoot(store.get("recentFiles"), rootPath);

const nonEmptyString = (val: unknown) => (typeof val === "string" && val.length > 0 ? val : null);
