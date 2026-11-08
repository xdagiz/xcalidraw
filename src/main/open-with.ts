import { open, realpath, stat } from "node:fs/promises";
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
  listSiblings: (root: string) => Promise<readonly { id: string; name: string }[]>;
  createDrawingWithContent: (
    root: string,
    name: string,
    content: string,
  ) => Promise<{ id: string }>;
};

const notFound = () =>
  codedError(FILE_NOT_FOUND_MESSAGE, { code: "NOT_FOUND", reason: "missing-file" });

const tooLarge = () =>
  codedError(`Content exceeds ${MAX_DRAWING_CONTENT_BYTES} bytes`, {
    code: "TOO_LARGE",
    reason: "content-too-large",
    limit: MAX_DRAWING_CONTENT_BYTES,
  });

const readDrawingContent = async (absPath: string) => {
  const handle = await open(absPath, "r").catch(() => {
    throw notFound();
  });

  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw notFound();
    if (stats.size > MAX_DRAWING_CONTENT_BYTES) throw tooLarge();

    const buffer = Buffer.allocUnsafe(MAX_DRAWING_CONTENT_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_DRAWING_CONTENT_BYTES) throw tooLarge();

    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close().catch(() => undefined);
  }
};

export const importExternalDrawing = async (
  absPath: string,
  root: string,
  deps: ImportDrawingDeps,
) => {
  const content = await readDrawingContent(absPath);
  assertDrawingJson(content);

  const siblings = (await deps.listSiblings(root)).filter((entry) => parentIdOf(entry.id) === null);
  const name = nextImportName(
    siblings.map((entry) => entry.name),
    basename(absPath).trim(),
  );

  const entry = await deps.createDrawingWithContent(root, name, content);
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
  importDrawing: (absPath: string, root: string) => Promise<string>;
  onError?: (error: unknown) => void;
};

export const OPEN_PATH_RETRY_MS = 1000;

type PendingOpen = { path: string; outcome?: OpenPathOutcome };

export const createOpenPathQueue = (deps: OpenPathQueueDeps) => {
  const pending: PendingOpen[] = [];
  let flushing = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const cancelRetry = () => {
    if (retryTimer === null) return;
    clearTimeout(retryTimer);
    retryTimer = null;
  };

  const scheduleRetry = () => {
    if (retryTimer !== null || pending.length === 0) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void flush().catch((error) => deps.onError?.(error));
    }, OPEN_PATH_RETRY_MS);
    retryTimer.unref?.();
  };

  const enqueue = (paths: readonly string[]) => {
    for (const absPath of paths) {
      if (pending.some((item) => item.path === absPath)) continue;
      pending.push({ path: absPath });
    }
  };

  const resolveOutcome = async (item: PendingOpen, root: string) => {
    try {
      const resolved = await deps.resolveId(root, item.path);
      const id = resolved ?? (await deps.importDrawing(item.path, root));
      item.outcome = { status: "open", id };
    } catch (error) {
      item.outcome = {
        status: "error",
        name: basename(item.path),
        message: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const flush = async () => {
    if (flushing) return;
    flushing = true;
    try {
      while (pending.length > 0) {
        const item = pending[0];
        if (!item) break;

        if (!deps.getReadyWindow()) {
          scheduleRetry();
          return;
        }

        if (!item.outcome) {
          const root = await deps.getRoot();
          if (!root) {
            scheduleRetry();
            return;
          }

          await resolveOutcome(item, root);
        }

        const win = deps.getReadyWindow();
        const outcome = item.outcome;
        if (!win || win.isDestroyed() || !outcome) {
          scheduleRetry();
          return;
        }

        deps.send(win, [outcome]);
        pending.shift();
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
