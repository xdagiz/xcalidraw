import { EventEmitter } from "node:events";

import type { WindowCloseRequest } from "@shared/ipc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  quit: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  showMessageBox: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { quit: mocks.quit },
  BrowserWindow: {},
  dialog: { showMessageBox: mocks.showMessageBox },
  shell: {},
}));

vi.mock("@electron-toolkit/utils", () => ({ is: { dev: false } }));

vi.mock("./ipc", () => ({
  APP_GREETING_URL: "app://renderer/greeting.html",
  APP_INDEX_URL: "app://renderer/index.html",
  isTrustedRendererUrl: () => true,
}));

vi.mock("./logger", () => ({
  log: { warn: mocks.warn, error: mocks.error },
}));

vi.mock("./settings", () => ({
  windowBgColor: () => "#ffffff",
}));

import { WINDOW_CLOSE_CANCELLED, WINDOW_WILL_CLOSE } from "@shared/channels";

class FakeWindow extends EventEmitter {
  destroyed = false;
  readonly webContents = Object.assign(new EventEmitter(), {
    isDestroyed: () => this.destroyed,
    isCrashed: (): boolean => false,
    send: vi.fn(),
  });

  isDestroyed = () => this.destroyed;

  destroy = () => {
    this.destroyed = true;
    this.emit("closed");
  };
}

const flushTicks = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

const closeEvent = () => ({ preventDefault: vi.fn() });

const sentRequestId = (win: FakeWindow, callIndex: number): number => {
  const willCloseCalls = win.webContents.send.mock.calls.filter(
    ([channel]) => channel === WINDOW_WILL_CLOSE,
  ) as [string, WindowCloseRequest][];
  const payload = willCloseCalls[callIndex][1];
  return payload.requestId;
};

const holdUnresponsiveResponses = () => {
  const releases: Array<(v: { response: number }) => void> = [];
  const unresponsiveCalls = () =>
    mocks.showMessageBox.mock.calls.filter(
      ([, options]) => (options as { message: string }).message === "xcalidraw isn't responding",
    );
  mocks.showMessageBox.mockImplementation(async (_win: unknown, options: { message: string }) => {
    if (options.message === "xcalidraw isn't responding") {
      return new Promise((resolve) => {
        releases.push(resolve);
      });
    }
    return { response: 0 };
  });
  return { releases, unresponsiveCalls };
};

const dialogChoices = [
  { label: "Keep waiting", response: 1 },
  { label: "Close anyway", response: 0 },
];

describe("close guard", () => {
  let closeGuard: typeof import("./window");

  beforeEach(async () => {
    vi.resetModules();
    closeGuard = await import("./window");
    mocks.quit.mockReset();
    mocks.warn.mockReset();
    mocks.error.mockReset();
    mocks.showMessageBox.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const setupWindow = () => {
    const win = new FakeWindow();
    const browserWindow = win as unknown as Electron.BrowserWindow;
    closeGuard.installCloseGuard(browserWindow);
    closeGuard.markWindowReady(browserWindow);
    return { win, browserWindow };
  };

  const enterFlushPhase = async (
    win: FakeWindow,
    browserWindow: Electron.BrowserWindow,
  ): Promise<number> => {
    win.emit("close", closeEvent());
    const requestId = sentRequestId(win, 0);
    closeGuard.onDirtyState(browserWindow, requestId, true, false);
    await flushTicks();
    return requestId;
  };

  it("flushes a clean close before destroying the window", () => {
    const { win, browserWindow } = setupWindow();

    win.emit("close", closeEvent());
    const requestId = sentRequestId(win, 0);
    closeGuard.onDirtyState(browserWindow, requestId, false, false);

    expect(win.destroyed).toBe(false);
    expect(sentRequestId(win, 1)).toBe(requestId);
    expect(win.webContents.send).toHaveBeenNthCalledWith(2, WINDOW_WILL_CLOSE, {
      requestId,
      kind: "flush",
    });

    closeGuard.onFlushStarted(browserWindow, requestId);
    closeGuard.destroyWindow(browserWindow, requestId);

    expect(win.destroyed).toBe(true);
  });

  it("flushes viewports before closing after the user discards changes", async () => {
    const { win, browserWindow } = setupWindow();
    mocks.showMessageBox.mockResolvedValue({ response: 1 });

    win.emit("close", closeEvent());
    const requestId = sentRequestId(win, 0);
    closeGuard.onDirtyState(browserWindow, requestId, true, false);
    await flushTicks();

    expect(win.destroyed).toBe(false);
    expect(win.webContents.send).toHaveBeenNthCalledWith(2, WINDOW_WILL_CLOSE, {
      requestId,
      kind: "flush-viewports",
    });

    closeGuard.destroyWindow(browserWindow, requestId);

    expect(win.destroyed).toBe(true);
  });

  it("lets a discarded close's viewport flush outlast the silence window", async () => {
    vi.useFakeTimers();
    const { win, browserWindow } = setupWindow();
    mocks.showMessageBox.mockResolvedValue({ response: 1 });

    win.emit("close", closeEvent());
    const requestId = sentRequestId(win, 0);
    closeGuard.onDirtyState(browserWindow, requestId, true, false);
    await flushTicks();
    closeGuard.onFlushStarted(browserWindow, requestId);

    await vi.advanceTimersByTimeAsync(2000);

    expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
    expect(win.destroyed).toBe(false);

    closeGuard.destroyWindow(browserWindow, requestId);

    expect(win.destroyed).toBe(true);
  });

  it("runs a quit callback only after the renderer approves the close", () => {
    const { win, browserWindow } = setupWindow();
    const onApproved = vi.fn(() => true);

    closeGuard.requestQuitViaRenderer(browserWindow, { onApproved });
    const requestId = sentRequestId(win, 0);

    expect(onApproved).not.toHaveBeenCalled();
    closeGuard.onDirtyState(browserWindow, requestId, false, false);

    expect(onApproved).not.toHaveBeenCalled();
    expect(win.destroyed).toBe(false);
    closeGuard.onFlushStarted(browserWindow, requestId);
    closeGuard.destroyWindow(browserWindow, requestId);

    expect(onApproved).toHaveBeenCalledOnce();
    expect(win.destroyed).toBe(false);
    expect(closeGuard.isQuittingNow()).toBe(true);

    closeGuard.abortApprovedQuit(browserWindow);

    expect(closeGuard.isQuittingNow()).toBe(false);
    expect(win.webContents.send).toHaveBeenCalledWith(WINDOW_CLOSE_CANCELLED);
  });

  it("cancels a pending quit callback when the user cancels the close prompt", async () => {
    const { win, browserWindow } = setupWindow();
    const onCancelled = vi.fn();
    mocks.showMessageBox.mockResolvedValue({ response: 2 });

    closeGuard.requestQuitViaRenderer(browserWindow, { onCancelled });
    const requestId = sentRequestId(win, 0);
    closeGuard.onDirtyState(browserWindow, requestId, true, false);
    await flushTicks();

    expect(onCancelled).toHaveBeenCalledOnce();
    expect(closeGuard.isQuittingNow()).toBe(false);
    expect(win.destroyed).toBe(false);
  });

  it("restores the window when an approved quit callback cannot start", () => {
    const { win, browserWindow } = setupWindow();
    const onCancelled = vi.fn();

    closeGuard.requestQuitViaRenderer(browserWindow, {
      onApproved: () => false,
      onCancelled,
    });
    const requestId = sentRequestId(win, 0);
    closeGuard.onDirtyState(browserWindow, requestId, false, false);

    expect(onCancelled).not.toHaveBeenCalled();
    closeGuard.onFlushStarted(browserWindow, requestId);
    closeGuard.destroyWindow(browserWindow, requestId);

    expect(onCancelled).toHaveBeenCalledOnce();
    expect(closeGuard.isQuittingNow()).toBe(false);
    expect(win.destroyed).toBe(false);
  });

  it.each(dialogChoices)(
    "processes a dirty-state answer that arrives while the not-responding dialog is open, after the user chooses $label",
    async ({ response }) => {
      vi.useFakeTimers();
      const { win, browserWindow } = setupWindow();
      const { releases, unresponsiveCalls } = holdUnresponsiveResponses();

      win.emit("close", closeEvent());
      const requestId = sentRequestId(win, 0);
      vi.advanceTimersByTime(5000);
      await flushTicks();
      expect(unresponsiveCalls().length).toBe(1);

      closeGuard.onDirtyState(browserWindow, requestId, true, false);
      await flushTicks();
      expect(win.destroyed).toBe(false);
      expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);

      releases[0]?.({ response });
      await flushTicks();

      expect(win.destroyed).toBe(false);
      expect(mocks.showMessageBox).toHaveBeenCalledTimes(2);
      expect(mocks.showMessageBox.mock.calls[1][1]).toMatchObject({
        message: "You have unsaved changes.",
      });
    },
  );

  it.each(dialogChoices)(
    "replays a flush-started signal that arrives while the not-responding dialog is open, after the user chooses $label",
    async ({ response }) => {
      vi.useFakeTimers();
      const { win, browserWindow } = setupWindow();
      const { releases, unresponsiveCalls } = holdUnresponsiveResponses();

      const requestId = await enterFlushPhase(win, browserWindow);
      vi.advanceTimersByTime(2000);
      await flushTicks();
      expect(unresponsiveCalls().length).toBe(1);

      closeGuard.onFlushStarted(browserWindow, requestId);
      await flushTicks();
      expect(mocks.showMessageBox).toHaveBeenCalledTimes(2);

      releases[0]?.({ response });
      await flushTicks();

      expect(win.destroyed).toBe(false);

      vi.advanceTimersByTime(2000);
      await flushTicks();
      expect(mocks.showMessageBox).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(28000);
      await flushTicks();

      expect(unresponsiveCalls().length).toBe(2);
      expect(win.destroyed).toBe(false);
    },
  );
});
