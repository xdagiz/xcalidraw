import type { FileEntry } from "@shared/ipc";
import { describe, expect, it } from "vite-plus/test";

import { canvasDropZone, dropDestinationLabel, resolveDropZone } from "./drop-destination";

const entry = (id: string, kind: "file" | "directory", name = id): FileEntry => ({
  id,
  name,
  kind,
  parentId: null,
  modifiedAt: 0,
  size: 0,
  ino: "",
  dev: "",
});

const entriesById = new Map<string, FileEntry>([
  ["notes", entry("notes", "directory", "notes")],
  ["notes/plan.excalidraw", entry("notes/plan.excalidraw", "file")],
]);

describe("drop destination", () => {
  it("falls back to the canvas when no sidebar hit exists", () => {
    expect(resolveDropZone(null)).toEqual(canvasDropZone);
  });

  it("routes sidebar hits to their parent folder", () => {
    expect(resolveDropZone({ parentId: "notes", rowId: "notes" })).toEqual({
      kind: "sidebar",
      parentId: "notes",
    });
    expect(resolveDropZone({ parentId: null, rowId: null })).toEqual({
      kind: "sidebar",
      parentId: null,
    });
  });

  it("labels the library root", () => {
    expect(dropDestinationLabel(null, entriesById)).toBe("your library");
  });

  it("labels folders by name", () => {
    expect(dropDestinationLabel("notes", entriesById)).toBe("notes");
  });

  it("falls back to the library for files and missing entries", () => {
    expect(dropDestinationLabel("notes/plan.excalidraw", entriesById)).toBe("your library");
    expect(dropDestinationLabel("gone", entriesById)).toBe("your library");
  });
});
