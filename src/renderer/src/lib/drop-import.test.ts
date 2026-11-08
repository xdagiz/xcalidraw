import { describe, expect, it } from "vite-plus/test";

import {
  MAX_DROP_FILES,
  isSceneFile,
  readDroppedScenes,
  readSceneDraft,
  sceneFileName,
  uniqueImportName,
} from "./drop-import";

const scene = JSON.stringify({ type: "excalidraw", version: 2, elements: [], files: {} });

const fakeFile = (name: string, text: string) => ({ name, text: async () => text });

describe("drop import", () => {
  it("detects scene files case-insensitively", () => {
    expect(isSceneFile("Board.excalidraw")).toBe(true);
    expect(isSceneFile("BOARD.EXCALIDRAW")).toBe(true);
    expect(isSceneFile("board.json")).toBe(false);
  });

  it("normalizes scene file names", () => {
    expect(sceneFileName("Board.excalidraw")).toBe("Board.excalidraw");
    expect(sceneFileName("  Board.EXCALIDRAW  ")).toBe("Board.excalidraw");
    expect(sceneFileName("board.json")).toBe("board.excalidraw");
    expect(sceneFileName(".excalidraw")).toBe("Untitled.excalidraw");
  });

  it("rejects invalid payloads and oversized drawings", () => {
    const notJson = readSceneDraft("bad.excalidraw", "{ nope");
    expect("reason" in notJson && notJson.reason).toBe("Not a valid drawing file");

    const notScene = readSceneDraft("bad.excalidraw", JSON.stringify([1, 2, 3]));
    expect("reason" in notScene).toBe(true);

    const huge = readSceneDraft("big.excalidraw", "x".repeat(11 * 1024 * 1024));
    expect("reason" in huge).toBe(true);
  });

  it("accepts a valid scene and keeps its content verbatim", () => {
    const result = readSceneDraft("Board.excalidraw", scene);
    expect("content" in result && result.content).toBe(scene);
    expect("name" in result && result.name).toBe("Board.excalidraw");
  });

  it("uniquifies names against siblings", () => {
    expect(uniqueImportName([], "Board.excalidraw")).toBe("Board.excalidraw");
    expect(uniqueImportName(["Board.excalidraw"], "Board.excalidraw")).toBe(
      "Board copy.excalidraw",
    );
    expect(
      uniqueImportName(["Board.excalidraw", "Board copy.excalidraw"], "Board.excalidraw"),
    ).toBe("Board copy 2.excalidraw");
  });

  it("splits dropped files into drafts and rejections", async () => {
    const { drafts, rejected } = await readDroppedScenes([
      fakeFile("Board.excalidraw", scene),
      fakeFile("photo.png", "nope"),
      fakeFile("broken.excalidraw", "{}"),
    ]);

    expect(drafts).toEqual([{ name: "Board.excalidraw", content: scene }]);
    expect(rejected.map((item) => item.name)).toEqual(["photo.png", "broken.excalidraw"]);
  });

  it("caps the number of imported files", async () => {
    const files = Array.from({ length: MAX_DROP_FILES + 1 }, (_value, index) =>
      fakeFile(`Board ${index}.excalidraw`, scene),
    );
    const { drafts, rejected } = await readDroppedScenes(files);

    expect(drafts).toHaveLength(MAX_DROP_FILES);
    expect(rejected).toHaveLength(1);
  });
});
