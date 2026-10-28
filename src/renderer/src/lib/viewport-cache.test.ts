import { describe, expect, it } from "vite-plus/test";

import { applyViewport, createViewportCache, viewportOf } from "./viewport-cache";

const root = "/drawings";

describe("createViewportCache", () => {
  it("roundtrips viewports and detects changes", () => {
    const cache = createViewportCache();
    const viewport = { scrollX: 10, scrollY: -20, zoom: 2.5 };
    expect(cache.set(root, "a.excalidraw", viewport)).toBe(true);
    expect(cache.get(root, "a.excalidraw")).toEqual(viewport);
    expect(cache.set(root, "a.excalidraw", viewport)).toBe(false);
  });

  it("isolates identical file ids in different roots", () => {
    const cache = createViewportCache();
    cache.set("/one", "a.excalidraw", { scrollX: 10, scrollY: 20, zoom: 2 });
    cache.set("/two", "a.excalidraw", { scrollX: 30, scrollY: 40, zoom: 3 });
    expect(cache.get("/one", "a.excalidraw")).toEqual({ scrollX: 10, scrollY: 20, zoom: 2 });
    expect(cache.get("/two", "a.excalidraw")).toEqual({ scrollX: 30, scrollY: 40, zoom: 3 });
  });

  it("rejects invalid viewport values", () => {
    const cache = createViewportCache();
    expect(cache.set(root, "a.excalidraw", { scrollX: Number.NaN, scrollY: 0, zoom: 1 })).toBe(
      false,
    );
    expect(cache.set(root, "b.excalidraw", { scrollX: 0, scrollY: 0, zoom: 31 })).toBe(false);
  });

  it("remaps and deletes a renamed subtree without matching sibling names", () => {
    const cache = createViewportCache();
    const viewport = { scrollX: 1, scrollY: 2, zoom: 1 };
    cache.set(root, "folder/a.excalidraw", viewport);
    cache.set(root, "folder/nested/b.excalidraw", viewport);
    cache.set(root, "folder-other/c.excalidraw", viewport);
    cache.remapSubtree(root, "folder", "renamed");
    expect(cache.get(root, "renamed/a.excalidraw")).toEqual(viewport);
    expect(cache.get(root, "renamed/nested/b.excalidraw")).toEqual(viewport);
    expect(cache.get(root, "folder/a.excalidraw")).toBeUndefined();
    cache.deleteSubtree(root, "renamed");
    expect(cache.get(root, "renamed/a.excalidraw")).toBeUndefined();
    expect(cache.get(root, "folder-other/c.excalidraw")).toEqual(viewport);
  });
});

describe("viewportOf", () => {
  it("extracts the bare zoom value", () => {
    expect(viewportOf({ scrollX: 5, scrollY: 6, zoom: { value: 1.5 } })).toEqual({
      scrollX: 5,
      scrollY: 6,
      zoom: 1.5,
    });
  });

  it("falls back to zoom 1 when missing", () => {
    expect(viewportOf({ scrollX: 5, scrollY: 6 })).toEqual({ scrollX: 5, scrollY: 6, zoom: 1 });
  });
});

describe("applyViewport", () => {
  it("merges scroll and zoom into appState", () => {
    const appState = { scrollX: 0, scrollY: 0, zoom: { value: 1 }, viewBackgroundColor: "#fff" };
    const merged = applyViewport(appState, { scrollX: 100, scrollY: -50, zoom: 3 });
    expect(merged).toEqual({
      scrollX: 100,
      scrollY: -50,
      zoom: { value: 3 },
      viewBackgroundColor: "#fff",
    });
    expect(merged).not.toBe(appState);
  });

  it("preserves extra zoom properties", () => {
    const appState = { scrollX: 0, scrollY: 0, zoom: { value: 1, translation: { x: 1, y: 2 } } };
    const merged = applyViewport(appState, { scrollX: 1, scrollY: 2, zoom: 2 });
    expect(merged.zoom).toEqual({ value: 2, translation: { x: 1, y: 2 } });
  });

  it("returns the input untouched when there is no viewport", () => {
    const appState = { scrollX: 1, scrollY: 2, zoom: { value: 1 } };
    expect(applyViewport(appState, undefined)).toBe(appState);
  });

  it("builds a zoom object when appState has none", () => {
    const appState = { scrollX: 0, scrollY: 0, zoom: null };
    const merged = applyViewport(appState, { scrollX: 4, scrollY: 5, zoom: 2 });
    expect(merged.zoom).toEqual({ value: 2 });
  });
});
