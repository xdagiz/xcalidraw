import { viewportStoreFrom } from "@shared/viewport";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createViewportCache } from "./viewport-cache";
import { createViewportPersistence } from "./viewport-persistence";
import { createViewportRecorder } from "./viewport-recorder";

const root = "/drawings";
const viewport = { scrollX: 12, scrollY: -8, zoom: 2.5 };

const makePersistence = (initial: string | null = null) => {
  let stored = initial;
  const get = vi.fn(async () => stored);
  const set = vi.fn(async (value: string) => {
    stored = value;
  });
  const persistence = createViewportPersistence({ get, set }, 250);
  return { persistence, set, readStored: () => stored };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("createViewportPersistence", () => {
  it("loads a saved viewport by root and file id", async () => {
    const initial = JSON.stringify({
      version: 1,
      entries: [{ rootPath: root, fileId: "a.excalidraw", viewport, updatedAt: 1 }],
    });
    const { persistence } = makePersistence(initial);
    expect(await persistence.get(root, "a.excalidraw")).toEqual(viewport);
    expect(await persistence.get("/other", "a.excalidraw")).toBeUndefined();
  });

  it("debounces writes and persists only the latest viewport", async () => {
    vi.useFakeTimers();
    const { persistence, set, readStored } = makePersistence();
    await persistence.set(root, "a.excalidraw", viewport);
    await persistence.set(root, "a.excalidraw", { ...viewport, zoom: 3 });
    expect(set).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(250);
    expect(set).toHaveBeenCalledTimes(1);
    expect(viewportStoreFrom(readStored())?.entries[0]).toMatchObject({
      rootPath: root,
      fileId: "a.excalidraw",
      viewport: { ...viewport, zoom: 3 },
    });
  });

  it("persists a reserved viewport before the bound editor repeats it", async () => {
    vi.useFakeTimers();
    const cache = createViewportCache();
    const { persistence, set } = makePersistence();
    const recordViewport = createViewportRecorder(cache, persistence);

    await recordViewport(root, "scratch.excalidraw", viewport);
    await recordViewport(root, "scratch.excalidraw", viewport);
    await persistence.flush();

    expect(set).toHaveBeenCalledOnce();
    expect(await persistence.get(root, "scratch.excalidraw")).toEqual(viewport);
  });

  it("persists a viewport that is already cached but missing from storage", async () => {
    const cache = createViewportCache();
    const { persistence } = makePersistence();
    const recordViewport = createViewportRecorder(cache, persistence);
    cache.set(root, "a.excalidraw", viewport);

    await recordViewport(root, "a.excalidraw", viewport);
    await persistence.flush();

    expect(await persistence.get(root, "a.excalidraw")).toEqual(viewport);
  });

  it("does not rewrite an unchanged viewport", async () => {
    vi.useFakeTimers();
    const { persistence, set } = makePersistence();
    await persistence.set(root, "a.excalidraw", viewport);
    await persistence.flush();
    expect(set).toHaveBeenCalledOnce();

    await persistence.set(root, "a.excalidraw", { ...viewport });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(250);
    expect(set).toHaveBeenCalledOnce();
  });

  it("flushes pending writes immediately", async () => {
    vi.useFakeTimers();
    const { persistence, set } = makePersistence();
    await persistence.set(root, "a.excalidraw", viewport);
    await persistence.flush();
    expect(set).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("falls back on invalid stored data and rejects invalid viewport updates", async () => {
    const invalid = JSON.stringify({
      version: 1,
      entries: [
        {
          rootPath: root,
          fileId: "a.excalidraw",
          viewport: { ...viewport, zoom: 31 },
          updatedAt: 1,
        },
      ],
    });
    const { persistence, set } = makePersistence(invalid);
    expect(await persistence.get(root, "a.excalidraw")).toBeUndefined();
    await persistence.set(root, "a.excalidraw", { ...viewport, zoom: 0 });
    await persistence.flush();
    expect(set).not.toHaveBeenCalled();
  });

  it("remaps, prunes, and deletes file subtrees without touching siblings or other roots", async () => {
    const { persistence } = makePersistence();
    await persistence.set(root, "folder/a.excalidraw", viewport);
    await persistence.set(root, "folder/nested/b.excalidraw", { ...viewport, zoom: 3 });
    await persistence.set(root, "folder-other/c.excalidraw", viewport);
    await persistence.set("/other", "folder/a.excalidraw", viewport);

    await persistence.remapSubtree(root, "folder", "renamed");
    expect(await persistence.get(root, "renamed/a.excalidraw")).toEqual(viewport);
    expect(await persistence.get(root, "folder/a.excalidraw")).toBeUndefined();

    await persistence.pruneRoot(
      root,
      new Set(["renamed/a.excalidraw", "folder-other/c.excalidraw"]),
    );
    expect(await persistence.get(root, "renamed/nested/b.excalidraw")).toBeUndefined();
    await persistence.deleteSubtree(root, "renamed");
    expect(await persistence.get(root, "renamed/a.excalidraw")).toBeUndefined();
    expect(await persistence.get(root, "folder-other/c.excalidraw")).toEqual(viewport);
    expect(await persistence.get("/other", "folder/a.excalidraw")).toEqual(viewport);
    await persistence.flush();
  });
});
