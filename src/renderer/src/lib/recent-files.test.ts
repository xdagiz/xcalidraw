import { parentIdOf, type FileEntry } from "@shared/ipc";
import { describe, expect, it } from "vite-plus/test";

import {
  RECENTS_LIMIT,
  pushRecentId,
  remapRecentIds,
  removeRecentIds,
  selectRecentFiles,
} from "./recent-files";

const entry = (id: string, kind: "file" | "directory" = "file"): FileEntry => ({
  id,
  name: id.split("/").pop() ?? id,
  kind,
  parentId: parentIdOf(id),
  modifiedAt: 100,
  size: 10,
  ino: "1",
  dev: "1",
});

describe("pushRecentId", () => {
  it("appends a new id at the head", () => {
    expect(pushRecentId(["a", "b"], "c")).toEqual(["c", "a", "b"]);
  });

  it("moves an existing id to the head without duplicates", () => {
    expect(pushRecentId(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
    expect(pushRecentId(["b"], "b")).toEqual(["b"]);
  });

  it("evicts from the tail once the cap is reached", () => {
    let ids: string[] = [];
    for (let i = 0; i < RECENTS_LIMIT; i += 1) ids = pushRecentId(ids, `id-${i}`);
    expect(ids).toHaveLength(RECENTS_LIMIT);

    ids = pushRecentId(ids, "id-new");
    expect(ids[0]).toBe("id-new");
    expect(ids).not.toContain("id-0");
    expect(ids).toContain(`id-${RECENTS_LIMIT - 1}`);
  });
});

describe("removeRecentIds", () => {
  it("prunes ids matching the predicate and keeps order", () => {
    const ids = ["keep-1", "drop/a", "keep-2", "drop/b"];
    const next = removeRecentIds(ids, (id) => id === "drop/a" || id === "drop/b");
    expect(next).toEqual(["keep-1", "keep-2"]);
  });
});

describe("remapRecentIds", () => {
  it("maps each id while preserving relative order", () => {
    const remapped = remapRecentIds(["a", "x", "b"], (id) => (id === "x" ? "y" : id));
    expect(remapped).toEqual(["a", "y", "b"]);
  });

  it("drops mappings to empty strings", () => {
    const remapped = remapRecentIds(["gone", "stays"], (id) => (id === "gone" ? "" : id));
    expect(remapped).toEqual(["stays"]);
  });

  it("collapses duplicate mappings onto the first occurrence", () => {
    const remapped = remapRecentIds(["a", "b", "c"], () => "same");
    expect(remapped).toEqual(["same"]);
  });
});

describe("selectRecentFiles", () => {
  const entries = [entry("file-a"), entry("dir-1", "directory"), entry("file-b"), entry("file-c")];

  it("keeps only existing file-kind entries in recency order", () => {
    const selected = selectRecentFiles(["file-b", "vanished", "dir-1", "file-a"], entries);
    expect(selected.map((e) => e.id)).toEqual(["file-b", "file-a"]);
  });

  it("caps the selection at the limit", () => {
    const count = RECENTS_LIMIT + 4;
    const ids = Array.from({ length: count }, (_, i) => `file-${i}`);
    const pool = ids.map((id) => entry(id));

    const selected = selectRecentFiles(ids, pool);

    expect(selected).toHaveLength(RECENTS_LIMIT);
    expect(selected[0]?.id).toBe("file-0");
    expect(selected.some((e) => e.id === `file-${count - 1}`)).toBe(false);
  });
});
