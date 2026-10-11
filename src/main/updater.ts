import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import { UPDATES_STATUS } from "@shared/channels";
import type { UpdateStatus } from "@shared/ipc";
import { app, BrowserWindow, dialog, session } from "electron";
import electronUpdater from "electron-updater";

import { log } from "./logger";
import { getSettings } from "./settings";
import { store } from "./store";
import {
  compareUpdateVersions,
  isSameUpdateVersion,
  planAvailableUpdate,
  planCompletedUpdateCheck,
  planDownloadedUpdate,
  statusAfterUpdateError,
  type UpdateCheckTrigger,
} from "./updater-state";
import {
  abortApprovedQuit,
  getMainWindow,
  LIBRARY_PARTITION,
  requestQuitViaRenderer,
} from "./window";

const { autoUpdater } = electronUpdater;

type UpdateInfo = { readonly version: string };
type ProgressInfo = { readonly percent: number };
type CachedUpdateInfo = { readonly fileName: string };
type UpdateCacheHelper = { readonly cacheDirForPendingUpdate: string };
type AutoUpdaterWithDownloadHelper = {
  getOrCreateDownloadHelper: () => Promise<UpdateCacheHelper>;
};

type UpdateCheckOptions = {
  readonly alertOnFail: boolean;
  readonly trigger: UpdateCheckTrigger;
};

const UPDATE_POLL_INTERVAL_MS = 4 * 60 * 60 * 1000;
const UPDATE_ERROR_MESSAGE = "Update check failed. Please try again later.";

let updateStatus: UpdateStatus = { state: "idle" };
let stagedVersion: string | null = null;
let declinedVersion: string | null = null;
let pendingVersion: string | null = null;
let activeTrigger: UpdateCheckTrigger = "boot";
let promptOpen = false;
let checkInFlight: Promise<UpdateStatus> | null = null;
let pollTimer: NodeJS.Timeout | null = null;
let installRequestPending = false;
let installCallInProgress = false;
let installCallFailed = false;

const readStoredVersion = (key: "stagedUpdateVersion" | "declinedUpdateVersion") => {
  try {
    const value = store.get(key);
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch (error) {
    log.warn("[updater] failed to read persisted version", error);
    return null;
  }
};

const persistVersions = () => {
  try {
    store.set("stagedUpdateVersion", stagedVersion);
    store.set("declinedUpdateVersion", declinedVersion);
  } catch (error) {
    log.warn("[updater] failed to persist versions", error);
  }
};

const isAutoUpdaterWithDownloadHelper = (
  updater: unknown,
): updater is AutoUpdaterWithDownloadHelper =>
  updater !== null &&
  typeof updater === "object" &&
  "getOrCreateDownloadHelper" in updater &&
  typeof updater.getOrCreateDownloadHelper === "function";

const isCachedUpdateInfo = (value: unknown): value is CachedUpdateInfo =>
  value !== null &&
  typeof value === "object" &&
  "fileName" in value &&
  typeof value.fileName === "string";

const isErrorWithCode = (error: unknown): error is Error & { code: string } =>
  error instanceof Error && "code" in error && typeof error.code === "string";

const hasCachedUpdateArtifact = async () => {
  try {
    const updater: unknown = autoUpdater;
    if (!isAutoUpdaterWithDownloadHelper(updater)) return false;

    const helper = await updater.getOrCreateDownloadHelper();
    const metadataPath = join(helper.cacheDirForPendingUpdate, "update-info.json");
    const metadata: unknown = JSON.parse(await readFile(metadataPath, "utf8"));
    if (!isCachedUpdateInfo(metadata)) return false;

    const fileName = metadata.fileName;
    if (!fileName || fileName === "." || fileName === ".." || basename(fileName) !== fileName) {
      return false;
    }

    return (await stat(join(helper.cacheDirForPendingUpdate, fileName))).isFile();
  } catch (error) {
    if (!isErrorWithCode(error) || error.code !== "ENOENT") {
      log.warn("[updater] failed to verify cached update artifact", error);
    }
    return false;
  }
};

const loadPersistedVersions = () => {
  stagedVersion = readStoredVersion("stagedUpdateVersion");
  declinedVersion = readStoredVersion("declinedUpdateVersion");
};

const parentWindow = () => {
  const win = getMainWindow();
  return win && !win.isDestroyed() ? win : undefined;
};

const showAlert = (options: Electron.MessageBoxOptions) => {
  const parent = parentWindow();
  const task = parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
  void task.catch((error) => log.warn("[updater] dialog failed", error));
};

const broadcastStatus = () => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    if (win.webContents.isDestroyed() || win.webContents.isCrashed()) continue;
    if (win.webContents.session === session.fromPartition(LIBRARY_PARTITION)) continue;
    win.webContents.send(UPDATES_STATUS, updateStatus);
  }
};

const setUpdateStatus = (status: UpdateStatus) => {
  updateStatus = status;
  broadcastStatus();
};

export const getUpdateStatus = (): UpdateStatus => updateStatus;

const startUpdateInstall = (): boolean => {
  if (updateStatus.state !== "downloaded") return false;

  const installingVersion = updateStatus.version;
  setUpdateStatus({ state: "installing", version: installingVersion });
  installCallFailed = false;
  installCallInProgress = true;

  try {
    autoUpdater.quitAndInstall(false, true);
  } catch (error) {
    log.warn("[updater] quit and install failed", error);
    installCallFailed = true;
    setUpdateStatus({ state: "downloaded", version: installingVersion });
  } finally {
    installCallInProgress = false;
  }

  return !installCallFailed;
};

export const installUpdate = () => {
  if (!app.isPackaged || updateStatus.state !== "downloaded" || installRequestPending) return;

  const win = parentWindow();
  if (!win) {
    startUpdateInstall();
    return;
  }

  installRequestPending = true;
  const started = requestQuitViaRenderer(win, {
    onApproved: () => {
      installRequestPending = false;
      return startUpdateInstall();
    },
    onCancelled: () => {
      installRequestPending = false;
    },
  });
  if (!started) installRequestPending = false;
};

export const downloadUpdate = (): UpdateStatus => {
  if (!app.isPackaged) return updateStatus;
  if (updateStatus.state !== "available") return updateStatus;

  const { version } = updateStatus;
  setUpdateStatus({ state: "downloading", version, percent: 0 });

  void autoUpdater.downloadUpdate().catch((error) => {
    log.warn("[updater] download failed", error);
    setUpdateStatus(statusAfterUpdateError(updateStatus, UPDATE_ERROR_MESSAGE));
  });

  return updateStatus;
};

const promptInstallUpdate = async (version: string) => {
  if (promptOpen) return;
  promptOpen = true;

  try {
    const parent = parentWindow();
    const options: Electron.MessageBoxOptions = {
      type: "info",
      title: "Update ready",
      message: `xcalidraw ${version} is ready to install.`,
      detail:
        "Restart now to apply the update, or continue working. You can install the downloaded update at any time.",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
    };

    const { response } = parent
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options);
    if (response === 0) {
      installUpdate();
      return;
    }

    declinedVersion = version;
    persistVersions();
  } catch (error) {
    log.warn("[updater] install prompt failed", error);
  } finally {
    promptOpen = false;
  }
};

const doRunUpdateCheck = async ({
  alertOnFail,
  trigger,
}: UpdateCheckOptions): Promise<UpdateStatus> => {
  if (!app.isPackaged) {
    if (alertOnFail) {
      showAlert({
        type: "info",
        title: "Updates unavailable",
        message: "Auto-update is only enabled in packaged builds.",
      });
    }
    return updateStatus;
  }

  const stagedPrompt = trigger === "manual" ? stagedVersion : null;

  if (trigger === "manual") {
    activeTrigger = trigger;
  } else if (updateStatus.state !== "available" && updateStatus.state !== "downloading") {
    activeTrigger = trigger;
  }

  try {
    const result = await autoUpdater.checkForUpdates();
    if (!result) {
      log.warn("[updater] check returned no result");
      if (stagedPrompt) {
        const skippedPrompt = planCompletedUpdateCheck({
          stagedVersion: stagedPrompt,
          declinedVersion,
          trigger,
          updateAvailable: false,
          availableVersion: null,
        }).promptVersion;

        if (skippedPrompt) {
          await promptInstallUpdate(skippedPrompt);
          return updateStatus;
        }
      }

      if (alertOnFail) {
        showAlert({
          type: "info",
          title: "Updates unavailable",
          message: "Could not check for updates right now. Please try again later.",
        });
      }

      return updateStatus;
    }

    const updateAvailable = result.isUpdateAvailable;
    const rawVersion = updateAvailable ? result.updateInfo?.version : null;
    const availableVersion =
      typeof rawVersion === "string" && rawVersion.length > 0 ? rawVersion : null;
    const promptAfterCheck = planCompletedUpdateCheck({
      stagedVersion: stagedPrompt,
      declinedVersion,
      trigger,
      updateAvailable,
      availableVersion,
    }).promptVersion;

    if (promptAfterCheck) {
      await promptInstallUpdate(promptAfterCheck);
      return updateStatus;
    }

    if (alertOnFail && !updateAvailable) {
      showAlert({
        type: "info",
        title: "No updates",
        message: `You are on the latest version (${app.getVersion()}).`,
      });
    }

    return updateStatus;
  } catch (error) {
    log.warn("[updater] check failed", error);
    setUpdateStatus(statusAfterUpdateError(updateStatus, UPDATE_ERROR_MESSAGE));

    if (alertOnFail) {
      showAlert({
        type: "error",
        title: "Update check failed",
        message: "Could not reach the update server.",
        detail: "Check your connection and try again.",
      });
    }

    return updateStatus;
  }
};

export const runUpdateCheck = (options: UpdateCheckOptions) => {
  if (checkInFlight) return checkInFlight;

  const task = doRunUpdateCheck(options).finally(() => {
    if (checkInFlight === task) checkInFlight = null;
  });

  checkInFlight = task;
  return task;
};

export const stopAutoUpdater = () => {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
};

export const applyUpdatePreferences = () => {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = getSettings().autoDownloadUpdates;
  if (autoUpdater.autoDownload && updateStatus.state === "available") {
    downloadUpdate();
  }
};

export const setupAutoUpdater = async () => {
  if (!app.isPackaged) return;

  loadPersistedVersions();

  if (stagedVersion) {
    if (compareUpdateVersions(stagedVersion, app.getVersion()) === 1) {
      if (await hasCachedUpdateArtifact()) {
        setUpdateStatus({ state: "downloaded", version: stagedVersion });
      } else {
        stagedVersion = null;
        persistVersions();
      }
    } else {
      stagedVersion = null;
      persistVersions();
    }
  }

  autoUpdater.logger = log;
  autoUpdater.autoInstallOnAppQuit = false;
  applyUpdatePreferences();

  autoUpdater.on("update-available", (info: UpdateInfo) => {
    pendingVersion = info.version;
    const status = planAvailableUpdate(stagedVersion, info.version);
    setUpdateStatus(status);

    if (
      status.state === "downloaded" &&
      stagedVersion &&
      isSameUpdateVersion(info.version, stagedVersion) &&
      !autoUpdater.autoDownload
    ) {
      void autoUpdater.downloadUpdate().catch((error) => {
        log.warn("[updater] cached update restoration failed", error);
      });
    }
  });

  autoUpdater.on("download-progress", (progress: ProgressInfo) => {
    const fallback = updateStatus.state === "idle" ? null : updateStatus.version;
    const version = pendingVersion ?? fallback;
    if (!version) return;
    if (updateStatus.state !== "available" && updateStatus.state !== "downloading") return;
    const percent = Math.min(100, Math.max(0, Math.round(progress.percent)));
    setUpdateStatus({ state: "downloading", version, percent });
  });

  autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
    const decision = planDownloadedUpdate({
      stagedVersion,
      declinedVersion,
      incomingVersion: info.version,
      trigger: activeTrigger,
    });

    stagedVersion = decision.stagedVersion;
    declinedVersion = decision.declinedVersion;
    pendingVersion = null;
    activeTrigger = "boot";

    persistVersions();
    setUpdateStatus(decision.status);
    if (decision.promptVersion) void promptInstallUpdate(decision.promptVersion);
  });

  autoUpdater.on("error", (error: Error) => {
    log.warn("[updater] error", error);
    pendingVersion = null;
    activeTrigger = "boot";
    if (updateStatus.state === "installing") {
      if (installCallInProgress) {
        installCallFailed = true;
      } else {
        abortApprovedQuit(parentWindow() ?? null);
      }
    }
    setUpdateStatus(statusAfterUpdateError(updateStatus, UPDATE_ERROR_MESSAGE));
  });

  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  pollTimer = setInterval(() => {
    void runUpdateCheck({ alertOnFail: false, trigger: "interval" });
  }, UPDATE_POLL_INTERVAL_MS);

  if (typeof pollTimer.unref === "function") pollTimer.unref();
};
