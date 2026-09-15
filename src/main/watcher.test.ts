import type { DrawingInfo, FileEntry } from "@shared/ipc";
import type { FSWatcher } from "chokidar";
import { describe, it, expect, beforeEach, afterEach, vi } from "vite-plus/test";

import { createDrawingsWatcher, type WatcherDeps } from "./watcher";

type ChokidarListener = (...args: unknown[]) => void;

function createFakeWatcher(): FSWatcher & {
  _emit: (event: string, path: string) => void;
  _error: (err: unknown) => void;
} {
  const listeners = new Map<string, Set<ChokidarListener>>();

  const on = (event: string, listener: ChokidarListener): FSWatcher => {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event)!.add(listener);
    return instance;
  };

  const close = async () => listeners.clear();

  const instance: FSWatcher & {
    _emit: (...args: unknown[]) => void;
    _error: (err: unknown) => void;
  } = {
    on,
    close,
    _emit: (event: string, p: string) => {
      const allListeners = listeners.get("all");
      if (allListeners) {
        for (const cb of allListeners) cb(event, p);
      }
    },
    _error: (err: unknown) => {
      const errListeners = listeners.get("error");
      if (errListeners) {
        for (const cb of errListeners) cb(err);
      }
    },
    add: vi.fn(),
    unwatch: vi.fn(),
    getWatched: vi.fn().mockReturnValue({}),
  } as unknown as FSWatcher & {
    _emit: (...args: unknown[]) => void;
    _error: (err: unknown) => void;
  };

  return instance;
}

const info: DrawingInfo = {
  path: "/home/user/drawings",
  displayPath: "~/drawings",
  displayName: "drawings",
  configured: true,
  missing: false,
};

const makeEntry = (id: string, overrides: Partial<FileEntry> = {}): FileEntry => ({
  id,
  name: id.split("/").pop() ?? id,
  kind: "file",
  parentId: null,
  modifiedAt: 100,
  size: 100,
  ino: "1",
  dev: "1",
  ...overrides,
});

const mockEntries: FileEntry[] = [
  makeEntry("drawing1.excalidraw"),
  makeEntry("drawing2.excalidraw"),
  makeEntry("folder/drawing3.excalidraw", { parentId: "folder" }),
];

async function tick(ms: number) {
  vi.advanceTimersByTime(ms);
  await vi.waitFor(() => Promise.resolve());
}

function setupWatcher(opts?: {
  fakeWatch?: () => ReturnType<typeof createFakeWatcher>;
  coalesceMs?: number;
  defaultIgnoreTtlMs?: number;
  overrideDeps?: Partial<WatcherDeps>;
}) {
  const onChange = vi.fn();
  const onRootInvalid = vi.fn();
  const onError = vi.fn();

  const fakeWatcher = opts?.fakeWatch?.() ?? createFakeWatcher();

  const deps: WatcherDeps = {
    listEntries: vi.fn().mockResolvedValue(mockEntries),
    getDrawings: vi.fn().mockResolvedValue(info),
    watch: opts?.fakeWatch
      ? (() => {
          const fw = fakeWatcher;
          return () => fw;
        })()
      : () => fakeWatcher,
    now: () => Date.now(),
    coalesceMs: opts?.coalesceMs ?? 50, // faster for tests
    defaultIgnoreTtlMs: opts?.defaultIgnoreTtlMs ?? 200,
    ...opts?.overrideDeps,
  };

  const watcher = createDrawingsWatcher({ onChange, onRootInvalid, onError }, deps);
  return { watcher, fakeWatcher, onChange, onRootInvalid, onError, deps };
}

describe("createDrawingsWatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("manages root state across start, stop, and restart", async () => {
    const { watcher } = setupWatcher();

    expect(watcher.isWatching()).toBe(false);
    expect(watcher.getRoot()).toBeNull();

    await watcher.start("/home/user/drawings");
    expect(watcher.isWatching()).toBe(true);
    expect(watcher.getRoot()).toBe("/home/user/drawings");

    await watcher.stop();
    expect(watcher.isWatching()).toBe(false);
    expect(watcher.getRoot()).toBeNull();

    await watcher.restart(null);
    expect(watcher.getRoot()).toBeNull();
  });

  it("restart switches roots and starting the same root is a no-op", async () => {
    const { watcher } = setupWatcher();

    await watcher.start("/home/user/old");
    const rev1 = watcher.getRevision();

    await watcher.start("/home/user/old");
    expect(watcher.getRevision()).toBe(rev1);

    await watcher.restart("/home/user/new");
    expect(watcher.isWatching()).toBe(true);
    expect(watcher.getRoot()).toBe("/home/user/new");
  });

  it("emits onChange after coalesce timer fires", async () => {
    const { watcher, fakeWatcher, onChange, deps } = setupWatcher();

    await watcher.start("/home/user/drawings");
    expect(onChange).not.toHaveBeenCalled();

    void fakeWatcher._emit("change", "/home/user/drawings/drawing1.excalidraw");

    // Timer not yet fired.
    expect(onChange).not.toHaveBeenCalled();

    // Advance past coalesce window.
    await tick(60);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(deps.listEntries).toHaveBeenCalledOnce();
    const payload = onChange.mock.calls[0][0];
    expect(payload.entries).toEqual(mockEntries);
    expect(payload.revision).toBe(1);
    expect(payload.root).toBe("/home/user/drawings");
    expect(payload.info).toEqual(info);
  });

  it("coalesces multiple events within the window", async () => {
    const { watcher, fakeWatcher, onChange, deps } = setupWatcher();

    await watcher.start("/home/user/drawings");

    void fakeWatcher._emit("change", "/home/user/drawings/a.excalidraw");
    void fakeWatcher._emit("change", "/home/user/drawings/b.excalidraw");
    void fakeWatcher._emit("unlink", "/home/user/drawings/c.excalidraw");

    await tick(60);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(deps.listEntries).toHaveBeenCalledTimes(1);
  });

  it("retries a failed listing without publishing a partial file list", async () => {
    const listEntries = vi
      .fn()
      .mockRejectedValueOnce(new Error("EACCES"))
      .mockResolvedValue(mockEntries);
    const { watcher, fakeWatcher, onChange, onError } = setupWatcher({
      overrideDeps: { listEntries },
    });

    await watcher.start("/home/user/drawings");
    void fakeWatcher._emit("change", "/home/user/drawings/a.excalidraw");
    await tick(60);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();

    await tick(500);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].entries).toEqual(mockEntries);
  });

  it("re-emits when new events arrive during a pending re-list", async () => {
    vi.useRealTimers();

    const { watcher, fakeWatcher, onChange, deps } = setupWatcher({
      coalesceMs: 10,
    });

    const listSpy = deps.listEntries as ReturnType<typeof vi.fn>;

    let resolveFirst!: (v: FileEntry[]) => void;
    let firstCalled = false;

    listSpy.mockImplementation((_root: string) => {
      if (!firstCalled) {
        firstCalled = true;
        return new Promise<FileEntry[]>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve(mockEntries);
    });

    await watcher.start("/home/user/drawings");

    void fakeWatcher._emit("change", "/home/user/drawings/a.excalidraw");
    await new Promise((r) => setTimeout(r, 20));

    void fakeWatcher._emit("change", "/home/user/drawings/b.excalidraw");
    resolveFirst(mockEntries);

    await new Promise((r) => setTimeout(r, 0));
    expect(onChange).toHaveBeenCalledTimes(1);

    await new Promise((r) => setTimeout(r, 20));
    expect(onChange).toHaveBeenCalledTimes(2);

    vi.useFakeTimers();
  });

  it("drops ignored paths until the TTL expires", async () => {
    const { watcher, fakeWatcher, onChange } = setupWatcher({
      defaultIgnoreTtlMs: 100,
    });

    await watcher.start("/home/user/drawings");
    watcher.ignorePaths(["/home/user/drawings/temp.excalidraw"]);
    void fakeWatcher._emit("change", "/home/user/drawings/temp.excalidraw");

    await tick(60);
    expect(onChange).not.toHaveBeenCalled();

    await tick(200);
    void fakeWatcher._emit("change", "/home/user/drawings/temp.excalidraw");

    await tick(60);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("filters events to excalidraw files and directories only", async () => {
    const { watcher, fakeWatcher, onChange } = setupWatcher();

    await watcher.start("/home/user/drawings");

    void fakeWatcher._emit("change", "/home/user/drawings/.hidden.excalidraw");
    void fakeWatcher._emit("add", "/home/user/drawings/.DS_Store");
    void fakeWatcher._emit("change", "/home/user/drawings/readme.txt");
    void fakeWatcher._emit("add", "/home/user/drawings/config.json");
    await tick(60);
    expect(onChange).not.toHaveBeenCalled();

    void fakeWatcher._emit("change", "/home/user/drawings/Drawing.EXCALIDRAW");
    await tick(60);
    expect(onChange).toHaveBeenCalledTimes(1);

    void fakeWatcher._emit("addDir", "/home/user/drawings/new-folder");
    await tick(60);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("configures chokidar with followSymlinks disabled and depth capped", async () => {
    const fakeWatcher = createFakeWatcher();
    let captured: Record<string, unknown> | null = null;
    const watchSpy = (_root: string, opts: Record<string, unknown>) => {
      captured = opts;
      return fakeWatcher;
    };

    const { watcher } = setupWatcher({
      overrideDeps: { watch: watchSpy as unknown as WatcherDeps["watch"] },
    });

    await watcher.start("/tmp/xcalidraw-roots");

    expect(captured).not.toBeNull();
    expect(captured!.followSymlinks).toBe(false);
    expect(captured!.depth).toBe(99);
    expect(captured!.ignorePermissionErrors).toBe(true);
    expect(captured!.atomic).toBe(true);
  });

  it("drops events whose path shares a prefix with the root but lies outside it", async () => {
    const { watcher, fakeWatcher, onChange } = setupWatcher();

    await watcher.start("/tmp/xcalidraw");

    void fakeWatcher._emit("change", "/tmp/xcalidraw-evil/.secret.excalidraw");
    await tick(60);
    expect(onChange).not.toHaveBeenCalled();

    void fakeWatcher._emit("change", "/tmp/xcalidraw/a.excalidraw");
    await tick(60);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("keeps revision monotonic across restart", async () => {
    const { watcher, fakeWatcher } = setupWatcher();

    await watcher.start("/home/user/drawings");
    void fakeWatcher._emit("change", "/home/user/drawings/a.excalidraw");
    await tick(60);
    expect(watcher.getRevision()).toBe(1);

    await watcher.restart("/home/user/other");
    expect(watcher.getRevision()).toBe(1);

    void fakeWatcher._emit("change", "/home/user/other/b.excalidraw");
    await tick(60);
    expect(watcher.getRevision()).toBe(2);
  });

  it("drops an in-flight listing that survives a restart to a new root", async () => {
    vi.useRealTimers();

    const oldEntries = [makeEntry("old.excalidraw")];
    const newEntries = [makeEntry("new.excalidraw")];
    let releaseOld!: (v: FileEntry[]) => void;
    const listEntries = vi.fn(async (root: string): Promise<FileEntry[]> => {
      if (root === "/home/user/drawings") {
        return new Promise<FileEntry[]>((resolve) => {
          releaseOld = resolve;
        });
      }
      return newEntries;
    });

    const { watcher, fakeWatcher, onChange } = setupWatcher({
      coalesceMs: 10,
      overrideDeps: { listEntries },
    });

    await watcher.start("/home/user/drawings");
    void fakeWatcher._emit("change", "/home/user/drawings/old.excalidraw");
    await new Promise((r) => setTimeout(r, 30));
    expect(listEntries).toHaveBeenCalledWith("/home/user/drawings");
    expect(onChange).not.toHaveBeenCalled();

    await watcher.restart("/home/user/new");
    await watcher.refreshNow();
    expect(onChange).not.toHaveBeenCalled();

    releaseOld(oldEntries);
    await new Promise((r) => setTimeout(r, 30));

    expect(onChange).toHaveBeenCalledTimes(1);
    const payload = onChange.mock.calls[0][0];
    expect(payload.entries).toEqual(newEntries);
    expect(payload.root).toBe("/home/user/new");
    expect(payload.revision).toBe(1);
    expect(listEntries).toHaveBeenLastCalledWith("/home/user/new");

    await watcher.stop();
    vi.useFakeTimers();
  });

  it("drops an in-flight listing after stop without emitting", async () => {
    vi.useRealTimers();

    let releaseOld!: (v: FileEntry[]) => void;
    const listEntries = vi.fn(
      (_root: string) =>
        new Promise<FileEntry[]>((resolve) => {
          releaseOld = resolve;
        }),
    );

    const { watcher, fakeWatcher, onChange } = setupWatcher({
      coalesceMs: 10,
      overrideDeps: { listEntries },
    });

    await watcher.start("/home/user/drawings");
    void fakeWatcher._emit("change", "/home/user/drawings/a.excalidraw");
    await new Promise((r) => setTimeout(r, 30));

    await watcher.stop();
    releaseOld([makeEntry("stale.excalidraw")]);
    await new Promise((r) => setTimeout(r, 30));

    expect(onChange).not.toHaveBeenCalled();
    vi.useFakeTimers();
  });

  it("re-lists the new root when the stale in-flight listing fails", async () => {
    vi.useRealTimers();

    const newEntries = [makeEntry("new.excalidraw")];
    let rejectOld!: (err: Error) => void;
    const listEntries = vi.fn(async (root: string): Promise<FileEntry[]> => {
      if (root === "/home/user/drawings") {
        return new Promise<FileEntry[]>((_resolve, reject) => {
          rejectOld = reject;
        });
      }
      return newEntries;
    });

    const { watcher, fakeWatcher, onChange } = setupWatcher({
      coalesceMs: 10,
      overrideDeps: { listEntries },
    });

    await watcher.start("/home/user/drawings");
    void fakeWatcher._emit("change", "/home/user/drawings/old.excalidraw");
    await new Promise((r) => setTimeout(r, 30));

    await watcher.restart("/home/user/new");
    await watcher.refreshNow();

    rejectOld(new Error("stale walk failed"));
    await new Promise((r) => setTimeout(r, 30));

    expect(onChange).toHaveBeenCalledTimes(1);
    const payload = onChange.mock.calls[0][0];
    expect(payload.entries).toEqual(newEntries);
    expect(payload.root).toBe("/home/user/new");

    await watcher.stop();
    vi.useFakeTimers();
  });

  it("refreshNow immediately triggers onChange", async () => {
    const { watcher, onChange, deps } = setupWatcher();

    await watcher.start("/home/user/drawings");
    await watcher.refreshNow();

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(deps.listEntries).toHaveBeenCalledOnce();
  });

  it("calls onRootInvalid with 'missing' when stat returns ENOENT", async () => {
    const enoentErr = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    const statMock = vi.fn().mockRejectedValue(enoentErr);
    const { watcher, fakeWatcher, onRootInvalid } = setupWatcher({
      overrideDeps: { statFn: statMock },
    });

    await watcher.start("/home/user/drawings");
    fakeWatcher._error(new Error("watch error EACCES"));

    await vi.waitFor(() => Promise.resolve());

    expect(onRootInvalid).toHaveBeenCalledWith("missing", 1);
    expect(watcher.getRevision()).toBe(1);
    expect(watcher.isWatching()).toBe(false);
  });

  it("keeps watching on non-ENOENT stat errors (transient access failures)", async () => {
    const eaccesErr = Object.assign(new Error("EACCES"), { code: "EACCES" });
    const statMock = vi.fn().mockRejectedValue(eaccesErr);
    const { watcher, fakeWatcher, onRootInvalid, onError } = setupWatcher({
      overrideDeps: { statFn: statMock },
    });

    await watcher.start("/home/user/drawings");
    fakeWatcher._error(new Error("watch error EACCES"));

    await vi.waitFor(() => Promise.resolve());

    expect(onError).toHaveBeenCalled();
    expect(onRootInvalid).not.toHaveBeenCalled();
    expect(watcher.isWatching()).toBe(true);
  });

  it("does not stop a restarted watcher when a stale error from the old root resolves", async () => {
    vi.useRealTimers();

    const enoentErr = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    let rejectStat!: (err: unknown) => void;
    const statFn = vi.fn(
      (): Promise<{ isDirectory: () => boolean }> =>
        new Promise((_resolve, reject) => {
          rejectStat = reject;
        }),
    );

    const { watcher, fakeWatcher, onRootInvalid } = setupWatcher({
      overrideDeps: { statFn },
    });

    await watcher.start("/home/user/old");
    fakeWatcher._error(new Error("stale watch error"));
    await new Promise((r) => setTimeout(r, 0));
    expect(statFn).toHaveBeenCalled();

    await watcher.restart("/home/user/new");
    expect(watcher.getRoot()).toBe("/home/user/new");

    rejectStat(enoentErr);
    await new Promise((r) => setTimeout(r, 30));

    expect(watcher.getRoot()).toBe("/home/user/new");
    expect(watcher.isWatching()).toBe(true);
    expect(onRootInvalid).not.toHaveBeenCalled();
    vi.useFakeTimers();
  });

  it("does not stop a restarted watcher when the stale stat reports a non-directory", async () => {
    vi.useRealTimers();

    let resolveStat!: (v: { isDirectory: () => boolean }) => void;
    const statFn = vi.fn(
      (): Promise<{ isDirectory: () => boolean }> =>
        new Promise((resolve) => {
          resolveStat = resolve;
        }),
    );

    const { watcher, fakeWatcher, onRootInvalid } = setupWatcher({
      overrideDeps: { statFn },
    });

    await watcher.start("/home/user/old");
    fakeWatcher._error(new Error("stale watch error"));
    await new Promise((r) => setTimeout(r, 0));
    expect(statFn).toHaveBeenCalled();

    await watcher.restart("/home/user/new");
    expect(watcher.getRoot()).toBe("/home/user/new");

    resolveStat({ isDirectory: () => false });
    await new Promise((r) => setTimeout(r, 30));

    expect(watcher.getRoot()).toBe("/home/user/new");
    expect(watcher.isWatching()).toBe(true);
    expect(onRootInvalid).not.toHaveBeenCalled();
    vi.useFakeTimers();
  });

  it("refreshNow immediately triggers onChange", async () => {
    const { watcher, onChange, deps } = setupWatcher();

    await watcher.start("/home/user/drawings");
    await watcher.refreshNow();

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(deps.listEntries).toHaveBeenCalledOnce();
  });
});
