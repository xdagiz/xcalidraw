import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@/components/ui/toast", () => ({ toast: { add: vi.fn(), close: vi.fn() } }));

import { useStore } from "./store";

const scene = JSON.stringify({ type: "excalidraw", version: 2, elements: [] });

const dropped = (name = "sketch.excalidraw") => ({ name, text: async () => scene });

const createFileWithContent = vi.fn(async () => "notes/sketch.excalidraw");
const setOpenFileId = vi.fn(async () => true);

beforeEach(() => {
  useStore.setState(useStore.getInitialState(), true);
  vi.stubGlobal("window", { api: { store: { set: vi.fn() } } });

  createFileWithContent.mockClear();
  setOpenFileId.mockClear();
  setOpenFileId.mockResolvedValue(true);

  useStore.setState({ createFileWithContent, setOpenFileId });
});

afterEach(() => {
  useStore.setState(useStore.getInitialState(), true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("import file drops", () => {
  it("imports into the requested folder", async () => {
    const result = await useStore.getState().importFileDrops("notes", [dropped()]);
    expect(createFileWithContent).toHaveBeenCalledWith("notes", "sketch.excalidraw", scene);
    expect(result.imported).toEqual([{ id: "notes/sketch.excalidraw", name: "sketch.excalidraw" }]);
  });

  it("never opens the imported drawing under the never policy", async () => {
    const result = await useStore
      .getState()
      .importFileDrops("notes", [dropped()], { open: "never" });
    expect(result.imported).toHaveLength(1);
    expect(setOpenFileId).not.toHaveBeenCalled();
  });

  it("always opens the imported drawing under the always policy", async () => {
    useStore.setState({ openFileId: "existing.excalidraw" });
    await useStore.getState().importFileDrops(null, [dropped()], { open: "always" });
    expect(setOpenFileId).toHaveBeenCalledWith("notes/sketch.excalidraw");
  });

  it("opens only when nothing is open under the auto policy", async () => {
    await useStore.getState().importFileDrops(null, [dropped()]);
    expect(setOpenFileId).toHaveBeenCalledTimes(1);

    setOpenFileId.mockClear();
    useStore.setState({ openFileId: "existing.excalidraw" });
    await useStore.getState().importFileDrops(null, [dropped()]);
    expect(setOpenFileId).not.toHaveBeenCalled();
  });

  it("keeps the import result when opening fails", async () => {
    setOpenFileId.mockResolvedValue(false);
    const result = await useStore.getState().importFileDrops(null, [dropped()], { open: "always" });
    expect(result.imported).toHaveLength(1);
    expect(result.failed).toHaveLength(0);
  });
});
