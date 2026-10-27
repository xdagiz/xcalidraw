import { codedError } from "@shared/errors";
import { DEFAULT_SETTINGS, normalizeAutosaveSetting } from "@shared/ipc";
import type { AppSettings, SettingsUpdate, ThemePreference } from "@shared/ipc";
import { BrowserWindow, nativeTheme } from "electron";

import { store } from "./store";

const THEME_PREFERENCES: readonly ThemePreference[] = ["light", "dark", "system"];

const isThemePreference = (value: unknown): value is ThemePreference =>
  THEME_PREFERENCES.some((preference) => preference === value);

export const validateSettingsUpdate = (payload: Record<string, unknown>): SettingsUpdate => {
  const update: SettingsUpdate = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined) continue;
    switch (key) {
      case "theme": {
        if (!isThemePreference(value)) {
          throw codedError(`Invalid theme preference: ${JSON.stringify(value)}`, {
            code: "INVALID",
            reason: "invalid-payload",
            field: "theme",
          });
        }
        update.theme = value;
        break;
      }
      case "autosave": {
        const normalized = normalizeAutosaveSetting(value);
        const record =
          value !== null && typeof value === "object" && !Array.isArray(value)
            ? (value as { mode?: unknown; ms?: unknown })
            : null;
        const isCanonical =
          record !== null &&
          record.mode === normalized.mode &&
          (normalized.mode !== "interval" || record.ms === (normalized as { ms: unknown }).ms);
        if (!isCanonical) {
          throw codedError(`Invalid autosave setting: ${JSON.stringify(value)}`, {
            code: "INVALID",
            reason: "invalid-payload",
            field: "autosave",
          });
        }
        update.autosave = normalized;
        break;
      }
      case "reopenLastDrawing":
        if (typeof value !== "boolean") {
          throw codedError(`${key} must be a boolean`, {
            code: "INVALID",
            reason: "invalid-payload",
            field: key,
          });
        }
        update[key] = value;
        break;
      case "showRecents":
        if (typeof value !== "boolean") {
          throw codedError(`${key} must be a boolean`, {
            code: "INVALID",
            reason: "invalid-payload",
            field: key,
          });
        }
        update[key] = value;
        break;
      case "autoDownloadUpdates":
      case "mcpServer":
        if (typeof value !== "boolean") {
          throw codedError(`${key} must be a boolean`, {
            code: "INVALID",
            reason: "invalid-payload",
            field: key,
          });
        }
        update[key] = value;
        break;
      default:
        throw codedError(`Unknown setting: ${key}`, {
          code: "INVALID",
          reason: "invalid-payload",
          field: key,
        });
    }
  }
  return update;
};

export const getSettings = (): AppSettings => ({
  theme: store.get("theme") ?? DEFAULT_SETTINGS.theme,
  autosave: normalizeAutosaveSetting(store.get("autosave")),
  reopenLastDrawing: store.get("reopenLastDrawing") ?? DEFAULT_SETTINGS.reopenLastDrawing,
  showRecents: store.get("showRecents") ?? DEFAULT_SETTINGS.showRecents,
  autoDownloadUpdates: store.get("autoDownloadUpdates") ?? DEFAULT_SETTINGS.autoDownloadUpdates,
  mcpServer: store.get("mcpServer") ?? DEFAULT_SETTINGS.mcpServer,
});

export const windowBgColor = () => (nativeTheme.shouldUseDarkColors ? "#181818" : "#ffffff");

export const applyWindowBgColor = () => {
  const backgroundColor = windowBgColor();
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.setBackgroundColor(backgroundColor);
  }
};

export const applyTheme = () => {
  nativeTheme.themeSource = getSettings().theme;
  applyWindowBgColor();
};

export const setSettings = (update: SettingsUpdate): AppSettings => {
  const clean = validateSettingsUpdate(update);
  const next = getSettings();
  let themeChanged = false;

  if (clean.theme !== undefined) {
    next.theme = clean.theme;
    store.set("theme", clean.theme);
    themeChanged = true;
  }

  if (clean.autosave !== undefined) {
    const autosave = normalizeAutosaveSetting(clean.autosave);
    next.autosave = autosave;
    store.set("autosave", autosave);
  }

  if (clean.reopenLastDrawing !== undefined) {
    next.reopenLastDrawing = clean.reopenLastDrawing;
    store.set("reopenLastDrawing", clean.reopenLastDrawing);
  }

  if (clean.showRecents !== undefined) {
    next.showRecents = clean.showRecents;
    store.set("showRecents", clean.showRecents);
  }

  if (clean.autoDownloadUpdates !== undefined) {
    next.autoDownloadUpdates = clean.autoDownloadUpdates;
    store.set("autoDownloadUpdates", clean.autoDownloadUpdates);
  }

  if (clean.mcpServer !== undefined) {
    next.mcpServer = clean.mcpServer;
    store.set("mcpServer", clean.mcpServer);
  }

  if (themeChanged) applyTheme();
  return next;
};
