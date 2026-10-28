import { describe, expect, it, vi } from "vite-plus/test";

import { itemsOf, parseIndex, searchIndex, summarizeItem } from "./library";

vi.mock("electron", () => ({ net: {} }));
vi.mock("./store", () => ({ store: {} }));

describe("itemsOf", () => {
  it("reads named v2 items and unnamed v1 groups", () => {
    expect(itemsOf({ libraryItems: [{ name: "Server", elements: [{ id: "a" }] }] })).toEqual([
      { name: "Server", elements: [{ id: "a" }] },
    ]);
    expect(itemsOf({ library: [[{ id: "a" }], "junk"] })).toEqual([{ elements: [{ id: "a" }] }]);
    expect(itemsOf("nope")).toEqual([]);
  });
});

describe("summarizeItem", () => {
  it("measures the item and surfaces its text", () => {
    const item = {
      elements: [
        { type: "rectangle", x: 10, y: 10, width: 100, height: 50 },
        { type: "text", x: 20, y: 20, width: 40, height: 20, text: "DB" },
      ],
    };
    expect(summarizeItem(item, 3)).toEqual({
      index: 3,
      labels: ["DB"],
      width: 100,
      height: 50,
      elementCount: 2,
    });
  });
});

describe("searchIndex", () => {
  const libraries = parseIndex([
    { id: "1", name: "Cloud", description: "aws icons", source: "a.excalidrawlib" },
    { id: "2", name: "AWS Architecture", description: "", source: "b.excalidrawlib" },
    { id: "3", name: "Stickers", description: "", source: "c.excalidrawlib" },
    { name: "missing id" },
  ]);

  it("ranks name matches above description matches", () => {
    expect(searchIndex(libraries, "aws").map((library) => library.id)).toEqual(["2", "1"]);
  });

  it("lists libraries when the query is empty", () => {
    expect(searchIndex(libraries, "  ")).toHaveLength(3);
  });
});
