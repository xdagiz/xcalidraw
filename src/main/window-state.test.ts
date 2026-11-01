import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  userData: "",
  displays: [] as Electron.Display[],
}));

vi.mock("electron", () => ({
  app: { getPath: () => mocks.userData },
  screen: {
    getAllDisplays: () => mocks.displays,
    getDisplayMatching: () => mocks.displays[0],
  },
}));

const defaults = { width: 1200, height: 800 };

const display = (x: number, y: number, width: number, height: number) =>
  ({ bounds: { x, y, width, height } }) as Electron.Display;

type FakeWindow = {
  destroyed: boolean;
  minimized: boolean;
  maximized: boolean;
  fullscreen: boolean;
  normalBounds: Electron.Rectangle;
  isDestroyed: () => boolean;
  isMinimized: () => boolean;
  isMaximized: () => boolean;
  isFullScreen: () => boolean;
  getNormalBounds: () => Electron.Rectangle;
  destroy: () => void;
};

const createFakeWindow = (overrides: Partial<FakeWindow> = {}) => {
  const win = new EventEmitter() as EventEmitter & FakeWindow;

  Object.assign(win, {
    destroyed: false,
    minimized: false,
    maximized: false,
    fullscreen: false,
    normalBounds: { x: 0, y: 0, width: 1200, height: 800 },
    isDestroyed: () => win.destroyed,
    isMinimized: () => win.minimized,
    isMaximized: () => win.maximized,
    isFullScreen: () => win.fullscreen,
    getNormalBounds: () => win.normalBounds,
    destroy: () => {
      win.destroyed = true;
      win.maximized = false;
      win.fullscreen = false;
      win.emit("closed");
    },
  } satisfies FakeWindow);

  return Object.assign(win, overrides);
};

describe("window state", () => {
  let mod: typeof import("./window-state");

  beforeEach(async () => {
    mocks.userData = await mkdtemp(join(tmpdir(), "xcalidraw-window-state-"));
    mocks.displays = [display(0, 0, 1920, 1080)];
    ({ ...mod } = await import("./window-state"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(mocks.userData, { recursive: true, force: true });
    mocks.userData = "";
  });

  it("returns null for missing, unreadable, and invalid state", async () => {
    expect(mod.readWindowState()).toBeNull();

    await writeFile(join(mocks.userData, "window-state.json"), "{ not json }");
    expect(mod.readWindowState()).toBeNull();

    await writeFile(join(mocks.userData, "window-state.json"), JSON.stringify({ width: "big" }));
    expect(mod.readWindowState()).toBeNull();

    await writeFile(join(mocks.userData, "window-state.json"), JSON.stringify([1, 2]));
    expect(mod.readWindowState()).toBeNull();
  });

  it("never restores off-screen: clamps on the matching display and falls back when it is gone", () => {
    expect(
      mod.resolveWindowState(
        {
          x: -100,
          y: -100,
          width: 3000,
          height: 1600,
          displayBounds: { x: 0, y: 0, width: 2560, height: 1440 },
        },
        defaults,
        [display(0, 0, 2560, 1440)],
      ),
    ).toEqual({ x: 0, y: 0, width: 2560, height: 1440 });

    expect(
      mod.resolveWindowState(
        { x: 9999, y: 9999, width: 800, height: 600, isMaximized: true },
        defaults,
        [display(0, 0, 1920, 1080)],
      ),
    ).toEqual({ width: 1200, height: 800, isMaximized: true });

    expect(
      mod.resolveWindowState(
        {
          x: 0,
          y: 0,
          width: 2560,
          height: 1440,
          displayBounds: { x: 0, y: 0, width: 3840, height: 2160 },
        },
        defaults,
        [display(0, 0, 1920, 1080)],
      ),
    ).toEqual({ width: 1200, height: 800 });

    expect(
      mod.resolveWindowState({ width: 800, height: 600, isFullScreen: true }, defaults, [
        display(0, 0, 1920, 1080),
      ]),
    ).toEqual({ width: 1200, height: 800, isFullScreen: true });

    const sideBySide = [display(0, 0, 1920, 1080), display(1920, 0, 1920, 1080)];
    expect(
      mod.resolveWindowState({ x: 1000, y: 100, width: 1000, height: 800 }, defaults, sideBySide),
    ).toEqual({ x: 1000, y: 100, width: 1000, height: 800 });

    const withGap = [display(0, 0, 1920, 1080), display(2020, 0, 1920, 1080)];
    expect(
      mod.resolveWindowState(
        {
          x: 1000,
          y: 100,
          width: 1000,
          height: 800,
          displayBounds: { x: 0, y: 0, width: 1920, height: 1080 },
        },
        defaults,
        withGap,
      ),
    ).toEqual({ x: 460, y: 140, width: 1000, height: 800 });
  });

  it("round trips and restores saved geometry, including negative coordinates", () => {
    const state = {
      x: -2400,
      y: 100,
      width: 800,
      height: 600,
      displayBounds: { x: -2560, y: 0, width: 2560, height: 1440 },
      isMaximized: true,
    };
    mod.writeWindowState(state);
    expect(mod.readWindowState()).toEqual(state);

    const displays = [display(-2560, 0, 2560, 1440), display(0, 0, 1920, 1080)];
    expect(mod.resolveWindowState(mod.readWindowState(), defaults, displays)).toEqual({
      x: -2400,
      y: 100,
      width: 800,
      height: 600,
      isMaximized: true,
    });
  });

  it("persists the latest bounds when closed fires without a close event", () => {
    vi.useFakeTimers();
    const win = createFakeWindow({
      maximized: true,
      fullscreen: true,
      normalBounds: { x: 30, y: 40, width: 900, height: 640 },
    });
    mod.manageWindowState(win as unknown as Electron.BrowserWindow, defaults);

    win.emit("move");
    vi.advanceTimersByTime(100);

    expect(mod.readWindowState()).toEqual({
      x: 30,
      y: 40,
      width: 900,
      height: 640,
      displayBounds: { x: 0, y: 0, width: 1920, height: 1080 },
      isMaximized: true,
      isFullScreen: true,
    });

    win.normalBounds = { x: 60, y: 80, width: 800, height: 600 };
    win.emit("move");
    win.destroy();

    expect(mod.readWindowState()).toEqual({
      x: 60,
      y: 80,
      width: 800,
      height: 600,
      displayBounds: { x: 0, y: 0, width: 1920, height: 1080 },
      isMaximized: true,
      isFullScreen: true,
    });

    const transitioned = createFakeWindow({
      normalBounds: { x: 10, y: 20, width: 700, height: 500 },
    });
    mod.manageWindowState(transitioned as unknown as Electron.BrowserWindow, defaults);
    transitioned.emit("move");
    transitioned.fullscreen = true;
    transitioned.emit("enter-full-screen");
    transitioned.destroy();

    expect(mod.readWindowState()).toEqual({
      x: 10,
      y: 20,
      width: 700,
      height: 500,
      displayBounds: { x: 0, y: 0, width: 1920, height: 1080 },
      isFullScreen: true,
    });
  });

  it("does not rewrite an untouched saved state", () => {
    const saved = {
      x: 120,
      y: 220,
      width: 900,
      height: 650,
      displayBounds: { x: 0, y: 0, width: 1920, height: 1080 },
    };
    mod.writeWindowState(saved);

    const win = createFakeWindow();
    mod.manageWindowState(win as unknown as Electron.BrowserWindow, defaults);
    win.destroy();

    expect(mod.readWindowState()).toEqual(saved);
  });
});
