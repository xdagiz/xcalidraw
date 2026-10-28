import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { FileEntry } from "@shared/ipc";
import { describe, expect, it, vi } from "vite-plus/test";

import { createMcpHandler, withFreshIds, type McpCanvas, type McpHandlerDeps } from "./mcp-bridge";

vi.mock("@excalidraw/excalidraw", () => ({}));

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
    ).rejects.toThrow("can't be changed");
    await expect(handle("update_elements", { elements: [{ x: 1 }] })).rejects.toThrow("id");
  });

  it("checks each field's type and range", async () => {
    const handle = setup();
    for (const changes of [{ x: "bad" }, { text: 42 }, { opacity: 150 }, { fillStyle: "plaid" }]) {
      await expect(
        handle("update_elements", { elements: [{ id: "x", ...changes }] }),
      ).rejects.toThrow("Invalid");
    }
  });

  it("refuses to edit when the user switches drawings mid-call", async () => {
    let openFileId: string | null = "/d/a.excalidraw";
    const canvas: McpCanvas = { api: fakeApi([]), fileId: openFileId, isReady: () => true };
    const handle = setup({
      getOpenFileId: () => openFileId,
      getCanvas: () => canvas,
    });
    const pending = handle("delete_elements", { ids: ["x"] });
    openFileId = "/d/b.excalidraw";
    await expect(pending).rejects.toThrow("changed");
  });

  it("refuses to insert into a drawing other than the one pinned", async () => {
    const canvas: McpCanvas = { api: fakeApi([]), fileId: "/d/b.excalidraw", isReady: () => true };
    const handle = setup({ getOpenFileId: () => "/d/b.excalidraw", getCanvas: () => canvas });
    await expect(
      handle("insert_elements", { drawingId: "/d/a.excalidraw", elements: [{ id: "x" }] }),
    ).rejects.toThrow("changed");
  });
});

describe("withFreshIds", () => {
  it("gives every element a new id and keeps their links pointing at each other", () => {
    let n = 0;
    const copy = withFreshIds(
      [
        {
          id: "box",
          type: "rectangle",
          groupIds: ["g"],
          boundElements: [{ id: "label", type: "text" }],
        },
        { id: "label", type: "text", containerId: "box", groupIds: ["g"] },
        {
          id: "arrow",
          type: "arrow",
          startBinding: { elementId: "box" },
          endBinding: { elementId: "gone" },
        },
      ],
      () => `n${n++}`,
    );
    const [box, label, arrow] = copy;
    expect(new Set(copy.map((element) => element.id)).has("box")).toBe(false);
    expect(label.containerId).toBe(box.id);
    expect(box.boundElements).toEqual([{ id: label.id, type: "text" }]);
    expect(arrow.startBinding).toEqual({ elementId: box.id });
    expect(arrow.endBinding).toBeNull();
    expect(box.groupIds).toEqual(label.groupIds);
    expect(arrow.groupIds).toHaveLength(1);
  });
});
