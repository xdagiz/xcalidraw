import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { FileEntry } from "@shared/ipc";
import { describe, expect, it } from "vite-plus/test";

import { createMcpHandler, type McpCanvas, type McpHandlerDeps } from "./mcp-bridge";

const entry = (id: string): FileEntry => ({
  id,
  name: id,
  kind: "file",
  parentId: null,
  modifiedAt: 0,
  size: 0,
  ino: "1",
  dev: "1",
});

const fakeApi = (elements: unknown[]): ExcalidrawImperativeAPI =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only the read path is exercised
  ({ getSceneElements: () => elements }) as unknown as ExcalidrawImperativeAPI;

const setup = (overrides: Partial<McpHandlerDeps> = {}) => {
  let openFileId: string | null = null;
  let canvas: McpCanvas | null = null;
  let ready = false;
  const deps: McpHandlerDeps = {
    getCanvas: () => canvas,
    getOpenFileId: () => openFileId,
    getEntries: () => [entry("/d/a.excalidraw")],
    openFile: async (id) => {
      openFileId = id;
      canvas = { api: fakeApi([]), fileId: id, isReady: () => ready };
      return true;
    },
    createFile: async () => null,
    sleep: async () => {
      ready = true;
    },
    ...overrides,
  };
  return createMcpHandler(deps);
};

describe("createMcpHandler", () => {
  it("asks the agent to open a drawing when none is open", async () => {
    await expect(setup()("get_open_drawing", {})).rejects.toThrow("No drawing is open");
  });

  it("rejects unknown drawings and tools", async () => {
    const handle = setup();
    await expect(handle("open_drawing", { id: "/d/missing.excalidraw" })).rejects.toThrow(
      "list_drawings",
    );
    await expect(handle("format_disk", {})).rejects.toThrow("Unknown tool");
  });

  it("waits for the scene to load before answering", async () => {
    const result = await setup()("open_drawing", { id: "/d/a.excalidraw" });
    expect(result).toEqual({ id: "/d/a.excalidraw", name: "/d/a.excalidraw", elements: [] });
  });

  it("reports when the user keeps the current drawing", async () => {
    const handle = setup({ openFile: async () => false });
    await expect(handle("open_drawing", { id: "/d/a.excalidraw" })).rejects.toThrow("kept");
  });

  it("only lets agents change style and geometry", async () => {
    const handle = setup();
    await expect(
      handle("update_elements", { elements: [{ id: "x", type: "ellipse" }] }),
    ).rejects.toThrow("Only these fields");
    await expect(handle("update_elements", { elements: [{ x: 1 }] })).rejects.toThrow("id");
  });
});
