import type { FileEntry } from "@shared/ipc";
import { describe, expect, it } from "vite-plus/test";

import {
  EXPANDED_FOLDERS_STORAGE_KEY,
  ancestorIdsOf,
  buildSortedChildIndex,
  canReparent,
  dropParentAtOffset,
  findTypeaheadMatch,
  flattenVisibleEntries,
  nextCopyName,
  pasteParentId,
  readExpandedFolderIds,
  remapExpandedIds,
  sortSiblings,
  writeExpandedFolderIds,
} from "./tree";

const entry = (id: string, kind: "file" | "directory" = "file"): FileEntry => ({
  id,
  name: id.split("/").pop() ?? id,
  kind,
  parentId: id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : null,
  modifiedAt: 100,
  size: 10,
  ino: "1",
  dev: "1",
});

const namesOf = (children: FileEntry[] | undefined) => (children ?? []).map((e) => e.name);

describe("sortSiblings", () => {
  it("orders directories before files", () => {
    const sorted = sortSiblings([entry("b.excalidraw"), entry("a", "directory")]);

    expect(sorted.map((e) => e.id)).toEqual(["a", "b.excalidraw"]);
  });

  it("sorts case-insensitively within each kind", () => {
    const sorted = sortSiblings([
      entry("Zebra.excalidraw"),
      entry("apple", "directory"),
      entry("Banana.excalidraw"),
      entry("cherry", "directory"),
    ]);

    expect(sorted.map((e) => e.name)).toEqual([
      "apple",
      "cherry",
      "Banana.excalidraw",
      "Zebra.excalidraw",
    ]);
  });

  it("uses natural number order for names", () => {
    const sorted = sortSiblings([entry("sketch 10.excalidraw"), entry("sketch 2.excalidraw")]);

    expect(sorted.map((e) => e.name)).toEqual(["sketch 2.excalidraw", "sketch 10.excalidraw"]);
  });
});

describe("buildSortedChildIndex", () => {
  it("groups children under their parents and roots under null", () => {
    const entries = [
      entry("root.excalidraw"),
      entry("vacation/beach.excalidraw"),
      entry("vacation", "directory"),
    ];

    const index = buildSortedChildIndex(entries);

    expect(namesOf(index.get(null))).toEqual(["vacation", "root.excalidraw"]);
    expect(namesOf(index.get("vacation"))).toEqual(["beach.excalidraw"]);
  });

  it("sorts children inside every folder", () => {
    const entries = [
      entry("zoo/sketch 10.excalidraw"),
      entry("zoo/sketch 2.excalidraw"),
      entry("zoo/nested", "directory"),
    ];

    const index = buildSortedChildIndex(entries);

    expect(namesOf(index.get("zoo"))).toEqual([
      "nested",
      "sketch 2.excalidraw",
      "sketch 10.excalidraw",
    ]);
  });
});

describe("flattenVisibleEntries", () => {
  const entries = [
    entry("alpha", "directory"),
    entry("alpha/one.excalidraw"),
    entry("alpha/nested", "directory"),
    entry("alpha/nested/deep.excalidraw"),
    entry("beta", "directory"),
    entry("beta/two.excalidraw"),
  ];
  const childIndex = buildSortedChildIndex(entries);

  it("shows only roots when nothing is expanded", () => {
    const flat = flattenVisibleEntries(childIndex, new Set());

    expect(flat.map((row) => row.entry.id)).toEqual(["alpha", "beta"]);
    expect(flat.map((row) => [row.level, row.posInSet, row.setSize, row.isExpanded])).toEqual([
      [0, 0, 2, false],
      [0, 1, 2, false],
    ]);
  });

  it("inlines expanded children in order with correct depth metadata", () => {
    const flat = flattenVisibleEntries(childIndex, new Set(["alpha"]));

    expect(flat.map((row) => row.entry.id)).toEqual([
      "alpha",
      "alpha/nested",
      "alpha/one.excalidraw",
      "beta",
    ]);
    expect(flat.map((row) => [row.level, row.posInSet, row.setSize, row.isExpanded])).toEqual([
      [0, 0, 2, true],
      [1, 0, 2, false],
      [1, 1, 2, false],
      [0, 1, 2, false],
    ]);
  });

  it("recurses into nested expanded folders", () => {
    const flat = flattenVisibleEntries(childIndex, new Set(["alpha", "alpha/nested"]));

    expect(flat.map((row) => row.entry.id)).toEqual([
      "alpha",
      "alpha/nested",
      "alpha/nested/deep.excalidraw",
      "alpha/one.excalidraw",
      "beta",
    ]);
    expect(flat.map((row) => row.level)).toEqual([0, 1, 2, 1, 0]);
  });
});

describe("findTypeaheadMatch", () => {
  const names = ["alpha", "Beta", "boat", "cat"];

  it("finds the first forward match after the start index", () => {
    expect(findTypeaheadMatch(names, 0, "b")).toBe(1);
    expect(findTypeaheadMatch(names, 1, "c")).toBe(3);
  });

  it("wraps around past the end", () => {
    expect(findTypeaheadMatch(names, 2, "a")).toBe(0);
    expect(findTypeaheadMatch(names, 3, "b")).toBe(1);
  });

  it("matches accumulated prefixes case-insensitively", () => {
    expect(findTypeaheadMatch(names, 0, "be")).toBe(1);
    expect(findTypeaheadMatch(names, 0, "BO")).toBe(2);
    expect(findTypeaheadMatch(names, 1, "boat")).toBe(2);
  });

  it("cycles repeated letters through successive matches", () => {
    const cycleNames = ["ab", "cd", "ae", "af"];

    const first = findTypeaheadMatch(cycleNames, 0, "a");
    const second = findTypeaheadMatch(cycleNames, first ?? -1, "a");

    expect(first).toBe(2);
    expect(second).toBe(3);
    expect(findTypeaheadMatch(cycleNames, second ?? -1, "a")).toBe(0);
  });

  it("returns null on a miss", () => {
    expect(findTypeaheadMatch(names, 0, "zzz")).toBeNull();
  });

  it("returns null for an empty query or empty list", () => {
    expect(findTypeaheadMatch(names, 0, "")).toBeNull();
    expect(findTypeaheadMatch([], 0, "a")).toBeNull();
  });
});

describe("ancestorIdsOf", () => {
  it("returns ancestors ordered root first", () => {
    expect(ancestorIdsOf("a/b/c.excalidraw")).toEqual(["a", "a/b"]);
  });

  it("returns empty for root-level ids", () => {
    expect(ancestorIdsOf("a.excalidraw")).toEqual([]);
  });
});

const memoryStorage = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => (data.has(key) ? (data.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
};

describe("pasteParentId", () => {
  it("pastes into a focused folder, the parent of a focused file, or the root", () => {
    expect(pasteParentId(null)).toBeNull();
    expect(pasteParentId(entry("notes", "directory"))).toBe("notes");
    expect(pasteParentId(entry("notes/a.excalidraw"))).toBe("notes");
    expect(pasteParentId(entry("a.excalidraw"))).toBeNull();
  });
});

describe("canReparent", () => {
  const entries = [
    entry("notes", "directory"),
    entry("notes/nested", "directory"),
    entry("notes/a.excalidraw"),
    entry("other", "directory"),
  ];

  it("rejects a move into the source or one of its descendants", () => {
    expect(canReparent("notes", "notes", entries)).toEqual({ ok: false, reason: "into-self" });
    expect(canReparent("notes", "notes/nested", entries)).toEqual({
      ok: false,
      reason: "into-self",
    });
  });

  it("treats the current parent as a no-op and allows a different folder", () => {
    expect(canReparent("notes/a.excalidraw", "notes", entries)).toEqual({
      ok: false,
      reason: "same-parent",
    });
    expect(canReparent("notes/a.excalidraw", "other", entries)).toEqual({ ok: true });
    expect(canReparent("notes/a.excalidraw", null, entries)).toEqual({ ok: true });
  });
});

describe("nextCopyName", () => {
  it("keeps the drawing extension and skips names that are taken", () => {
    const siblings = [entry("Note.excalidraw"), entry("Note copy.excalidraw")];

    expect(nextCopyName(siblings, "Note.excalidraw", "file")).toBe("Note copy 2.excalidraw");
    expect(nextCopyName([entry("Note.excalidraw")], "Note.excalidraw", "file")).toBe(
      "Note copy.excalidraw",
    );
  });

  it("names folder copies without an extension", () => {
    expect(nextCopyName([entry("Notes", "directory")], "Notes", "directory")).toBe("Notes copy");
    expect(
      nextCopyName(
        [entry("Notes", "directory"), entry("Notes copy", "directory")],
        "Notes",
        "directory",
      ),
    ).toBe("Notes copy 2");
  });
});

describe("remapExpandedIds", () => {
  it("rewrites the moved folder and its descendants and leaves other ids alone", () => {
    expect(remapExpandedIds(["notes", "notes/nested", "other"], "notes", "archive/notes")).toEqual(
      new Set(["archive/notes", "archive/notes/nested", "other"]),
    );
  });
});

describe("dropParentAtOffset", () => {
  const rows = [
    { id: "notes", kind: "directory" as const, parentId: null },
    { id: "notes/a.excalidraw", kind: "file" as const, parentId: "notes" },
  ];

  it("drops on a folder, on a file's parent, or on the root past the list", () => {
    expect(dropParentAtOffset(rows, 0, 28)).toBe("notes");
    expect(dropParentAtOffset(rows, 28, 28)).toBe("notes");
    expect(dropParentAtOffset(rows, -1, 28)).toBeNull();
    expect(dropParentAtOffset(rows, 56, 28)).toBeNull();
  });
});

describe("expanded folder storage", () => {
  it("roundtrips expanded ids", () => {
    const storage = memoryStorage();

    writeExpandedFolderIds(storage, ["a", "a/b"]);

    expect(readExpandedFolderIds(storage)).toEqual(new Set(["a", "a/b"]));
  });

  it("returns an empty set for missing or malformed values", () => {
    expect(readExpandedFolderIds(memoryStorage())).toEqual(new Set());
    expect(readExpandedFolderIds(memoryStorage({ k: "not json" }))).toEqual(new Set());
    expect(
      readExpandedFolderIds(memoryStorage({ [EXPANDED_FOLDERS_STORAGE_KEY]: '[1,null,"a"]' })),
    ).toEqual(new Set(["a"]));
  });

  it("tolerates a throwing storage", () => {
    const throwing = {
      getItem: () => {
        throw new Error("boom");
      },
      setItem: () => {
        throw new Error("boom");
      },
    };

    expect(readExpandedFolderIds(throwing)).toEqual(new Set());
    expect(() => writeExpandedFolderIds(throwing, ["a"])).not.toThrow();
  });
});
