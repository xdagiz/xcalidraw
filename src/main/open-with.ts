import { stat, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

import { APP_OPEN_PATHS } from "@shared/channels";
import { assertDrawingJson } from "@shared/drawing-content";
import { isExcalidrawFileName } from "@shared/drawing-path";
import { codedError } from "@shared/errors";
import { FILE_NOT_FOUND_MESSAGE, MAX_DRAWING_CONTENT_BYTES, parentIdOf } from "@shared/ipc";
import type { OpenPathOutcome, OpenPathsEvent } from "@shared/ipc";

export const extractOpenPaths = (argv: readonly string[], cwd = process.cwd()) => {
  const paths: string[] = [];
  for (const arg of argv) {
    if (!arg || arg.startsWith("-")) continue;
    if (!isExcalidrawFileName(arg)) continue;
    const absPath = resolve(cwd, arg);
    if (!paths.includes(absPath)) paths.push(absPath);
  }
  return paths;
};

export const resolveDrawingIdForPath = async (root: string, absPath: string) => {
  const real = await realpath(absPath).catch(() => null);
  if (!real) return null;

  const stats = await stat(real).catch(() => null);
  if (!stats?.isFile() || !isExcalidrawFileName(basename(real))) return null;

  const rel = relative(root, real);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;

  return rel.split(sep).filter(Boolean).join("/");
};

const nextImportName = (takenNames: readonly string[], originalName: string) => {
  const taken = new Set(takenNames.map((name) => name.toLowerCase()));
  if (!taken.has(originalName.toLowerCase())) return originalName;

  const dot = originalName.lastIndexOf(".");
  const stem = dot > 0 ? originalName.slice(0, dot) : originalName;
  const ext = dot > 0 ? originalName.slice(dot) : "";

  for (let index = 2; ; index += 1) {
    const candidate = `${stem} (${index})${ext}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
};

export type ImportDrawingDeps = {
  createEntry: (
    parentId: string | null,
    name: string,
    kind: "file" | "directory",
  ) => Promise<{ id: string }>;
  writeDrawingFile: (id: string, content: string) => Promise<unknown>;
  listEntries: () => Promise<readonly { id: string; kind: string; name: string }[]>;
};

export const importExternalDrawing = async (absPath: string, deps: ImportDrawingDeps) => {
  const stats = await stat(absPath).catch(() => null);
  if (!stats?.isFile()) {
    throw codedError(FILE_NOT_FOUND_MESSAGE, { code: "NOT_FOUND", reason: "missing-file" });
  }

  if (stats.size > MAX_DRAWING_CONTENT_BYTES) {
    throw codedError(`Content exceeds ${MAX_DRAWING_CONTENT_BYTES} bytes`, {
      code: "TOO_LARGE",
      reason: "content-too-large",
      limit: MAX_DRAWING_CONTENT_BYTES,
    });
  }

  const content = await readFile(absPath, "utf8");
  assertDrawingJson(content);

  const siblings = (await deps.listEntries()).filter((entry) => parentIdOf(entry.id) === null);
  const name = nextImportName(
    siblings.map((entry) => entry.name),
    basename(absPath),
  );

  const entry = await deps.createEntry(null, name, "file");
  await deps.writeDrawingFile(entry.id, content);

  return entry.id;
};

export type OpenPathWindow = {
  isDestroyed: () => boolean;
  webContents: {
    send: (channel: typeof APP_OPEN_PATHS, payload: OpenPathsEvent) => void;
  };
};

export type OpenPathQueueDeps = {
  getRoot: () => Promise<string | null>;
  getReadyWindow: () => OpenPathWindow | null;
  send: (win: OpenPathWindow, outcomes: OpenPathOutcome[]) => void;
  resolveId: (root: string, absPath: string) => Promise<string | null>;
  importDrawing: (absPath: string) => Promise<string>;
  onError?: (error: unknown) => void;
};

export const OPEN_PATH_RETRY_MS = 1000;

export const createOpenPathQueue = (deps: OpenPathQueueDeps) => {
  const queued: string[] = [];
  let flushing = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const cancelRetry = () => {
    if (retryTimer === null) return;
    clearTimeout(retryTimer);
    retryTimer = null;
  };

  const scheduleRetry = () => {
    if (retryTimer !== null || queued.length === 0) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void flush().catch((error) => deps.onError?.(error));
    }, OPEN_PATH_RETRY_MS);
    retryTimer.unref?.();
  };

  const enqueue = (paths: readonly string[]) => {
    for (const absPath of paths) {
      if (!queued.includes(absPath)) queued.push(absPath);
    }
  };

  const flush = async () => {
    if (flushing) return;
    flushing = true;
    try {
      while (queued.length > 0) {
        if (!deps.getReadyWindow()) return;

        const root = await deps.getRoot();
        if (!root) {
          scheduleRetry();
          return;
        }

        const absPath = queued.shift();
        if (absPath === undefined) return;

        let outcome: OpenPathOutcome;
        try {
          const resolved = await deps.resolveId(root, absPath);
          const id = resolved ?? (await deps.importDrawing(absPath));
          outcome = { status: "open", id };
        } catch (error) {
          outcome = {
            status: "error",
            name: basename(absPath),
            message: error instanceof Error ? error.message : String(error),
          };
        }

        const win = deps.getReadyWindow();
        if (!win || win.isDestroyed()) {
          queued.unshift(absPath);
          scheduleRetry();
          return;
        }
        deps.send(win, [outcome]);
      }
      cancelRetry();
    } finally {
      flushing = false;
    }
  };

  return {
    enqueue,
    flush: () => {
      void flush().catch((error) => deps.onError?.(error));
    },
  };
};
