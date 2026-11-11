import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@/components/ui/toast", () => ({ toast: { add: vi.fn(), close: vi.fn() } }));

import { useStore } from "./store";

const root = "/drawings";
const fileId = "requested.excalidraw";
const openFile = vi.fn().mockResolvedValue(true);

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  useStore.setState(useStore.getInitialState(), true);
  openFile.mockClear();
  useStore.setState({
    startupLoaded: true,
    isLoadingDrawings: false,
    drawings: {
      path: root,
      displayPath: root,
      displayName: "drawings",
      configured: true,
      missing: false,
    },
    entries: [
      {
        id: fileId,
        name: fileId,
        kind: "file",
        parentId: null,
        modifiedAt: 1,
        size: 1,
        ino: "1",
        dev: "1",
      },
    ],
    setOpenFileId: openFile,
  });
});

afterEach(() => {
  useStore.setState(useStore.getInitialState(), true);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("openFileWhenReady", () => {
  it("waits for the current folder load even after startup completed", async () => {
    useStore.setState({ isLoadingDrawings: true });
    const pending = useStore.getState().openFileWhenReady(fileId, root);
    await vi.advanceTimersByTimeAsync(0);
    expect(openFile).not.toHaveBeenCalled();

    useStore.setState({ isLoadingDrawings: false });
    await expect(pending).resolves.toBe(true);
    expect(openFile).toHaveBeenCalledWith(fileId, root);
  });

  it("opens immediately when no folder load is active", async () => {
    await expect(useStore.getState().openFileWhenReady(fileId, root)).resolves.toBe(true);
    expect(openFile).toHaveBeenCalledWith(fileId, root);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns immediately after a failed initial load", async () => {
    useStore.setState({ startupLoaded: false });
    await expect(useStore.getState().openFileWhenReady(fileId, root)).resolves.toBe(false);
    expect(openFile).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
