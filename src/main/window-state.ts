import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { app, screen, type BrowserWindow, type Display, type Rectangle } from "electron";

import { log } from "./logger";

const WINDOW_STATE_FILE = "window-state.json";
const WINDOW_STATE_DEBOUNCE_MS = 100;

export const DEFAULT_WINDOW_SIZE: { width: number; height: number } = {
  width: 1200,
  height: 800,
};

export type PersistedWindowState = {
  x?: number;
  y?: number;
  width: number;
  height: number;
  displayBounds?: Rectangle;
  isMaximized?: boolean;
  isFullScreen?: boolean;
};

const isInteger = (value: unknown): value is number => Number.isInteger(value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isErrorWithCode = (error: unknown): error is Error & { code: string } =>
  error instanceof Error && "code" in error && typeof error.code === "string";

const parseRect = (raw: unknown) => {
  if (!isRecord(raw)) return null;
  if (
    !isInteger(raw.x) ||
    !isInteger(raw.y) ||
    !isInteger(raw.width) ||
    !isInteger(raw.height) ||
    raw.width <= 0 ||
    raw.height <= 0
  ) {
    return null;
  }
  return { x: raw.x, y: raw.y, width: raw.width, height: raw.height };
};

export const parseWindowState = (raw: unknown) => {
  if (!isRecord(raw)) return null;
  const source = raw;
  if (
    !isInteger(source.width) ||
    !isInteger(source.height) ||
    source.width <= 0 ||
    source.height <= 0
  ) {
    return null;
  }

  const state: PersistedWindowState = { width: source.width, height: source.height };
  if (isInteger(source.x)) state.x = source.x;
  if (isInteger(source.y)) state.y = source.y;

  const displayBounds = parseRect(source.displayBounds);
  if (displayBounds) state.displayBounds = displayBounds;

  if (source.isMaximized === true) state.isMaximized = true;
  if (source.isFullScreen === true) state.isFullScreen = true;

  return state;
};

const pointInBounds = (bounds: Rectangle, x: number, y: number) =>
  x >= bounds.x && x < bounds.x + bounds.width && y >= bounds.y && y < bounds.y + bounds.height;

const rectCoveredByDisplays = (rect: Rectangle, displays: readonly Display[]) => {
  if (rect.width <= 0 || rect.height <= 0) return false;

  const xs = new Set<number>([rect.x, rect.x + rect.width]);
  const ys = new Set<number>([rect.y, rect.y + rect.height]);

  for (const { bounds } of displays) {
    for (const x of [bounds.x, bounds.x + bounds.width]) {
      if (x > rect.x && x < rect.x + rect.width) xs.add(x);
    }
    for (const y of [bounds.y, bounds.y + bounds.height]) {
      if (y > rect.y && y < rect.y + rect.height) ys.add(y);
    }
  }

  const cols = [...xs].toSorted((a, b) => a - b);
  const rows = [...ys].toSorted((a, b) => a - b);

  for (let i = 0; i < cols.length - 1; i++) {
    for (let j = 0; j < rows.length - 1; j++) {
      if (!displays.some(({ bounds }) => pointInBounds(bounds, cols[i], rows[j]))) {
        return false;
      }
    }
  }

  return true;
};

export const resolveWindowState = (
  persisted: PersistedWindowState | null,
  defaults: { width: number; height: number },
  displays: readonly Display[],
): PersistedWindowState => {
  const flags: Pick<PersistedWindowState, "isMaximized" | "isFullScreen"> = {};
  if (persisted?.isMaximized === true) flags.isMaximized = true;
  if (persisted?.isFullScreen === true) flags.isFullScreen = true;

  if (persisted) {
    const { x, y, width, height, displayBounds } = persisted;

    if (x !== undefined && y !== undefined) {
      if (rectCoveredByDisplays({ x, y, width, height }, displays)) {
        return { x, y, width, height, ...flags };
      }

      if (displayBounds) {
        const savedDisplay = displays.find(
          (display) =>
            display.bounds.x === displayBounds.x &&
            display.bounds.y === displayBounds.y &&
            display.bounds.width === displayBounds.width &&
            display.bounds.height === displayBounds.height,
        );
        if (savedDisplay) {
          const clampedWidth = Math.min(width, displayBounds.width);
          const clampedHeight = Math.min(height, displayBounds.height);
          return {
            x: displayBounds.x + Math.round((displayBounds.width - clampedWidth) / 2),
            y: displayBounds.y + Math.round((displayBounds.height - clampedHeight) / 2),
            width: clampedWidth,
            height: clampedHeight,
            ...flags,
          };
        }
      }
    }
  }

  return { width: defaults.width, height: defaults.height, ...flags };
};

const windowStatePath = () => join(app.getPath("userData"), WINDOW_STATE_FILE);

export const readWindowState = () => {
  let raw: string;
  try {
    raw = readFileSync(windowStatePath(), "utf8");
  } catch (error) {
    if (!isErrorWithCode(error) || error.code !== "ENOENT") {
      log.error("[window-state] read failed", error);
    }
    return null;
  }

  try {
    return parseWindowState(JSON.parse(raw));
  } catch (error) {
    log.error("[window-state] parse failed", error);
    return null;
  }
};

export const writeWindowState = (state: PersistedWindowState) => {
  const path = windowStatePath();
  const atomicTmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(atomicTmp, `${JSON.stringify(state)}\n`);
    renameSync(atomicTmp, path);
  } catch (error) {
    log.error("[window-state] write failed", error);
  }
};

const captureBounds = (win: BrowserWindow) => {
  if (win.isDestroyed() || win.isMinimized()) return null;

  const bounds = win.getNormalBounds();
  const state: PersistedWindowState = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    displayBounds: screen.getDisplayMatching(bounds).bounds,
  };
  if (win.isMaximized()) state.isMaximized = true;
  if (win.isFullScreen()) state.isFullScreen = true;

  return state;
};

export const manageWindowState = (win: BrowserWindow, initialState: PersistedWindowState) => {
  let state = initialState;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const capture = () => {
    const captured = captureBounds(win);
    if (!captured) return;
    state = captured;
    dirty = true;
  };

  const flush = () => {
    if (dirty) writeWindowState(state);
  };

  const schedule = () => {
    capture();
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, WINDOW_STATE_DEBOUNCE_MS);
  };

  const clearTimer = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  win.on("resize", schedule);
  win.on("move", schedule);
  win.on("maximize", schedule);
  win.on("unmaximize", schedule);
  win.on("enter-full-screen", schedule);
  win.on("leave-full-screen", schedule);
  win.on("close", capture);
  win.on("closed", () => {
    clearTimer();
    win.off("resize", schedule);
    win.off("move", schedule);
    win.off("maximize", schedule);
    win.off("unmaximize", schedule);
    win.off("enter-full-screen", schedule);
    win.off("leave-full-screen", schedule);
    win.off("close", capture);
    flush();
  });
};
