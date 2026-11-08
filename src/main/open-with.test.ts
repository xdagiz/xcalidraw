import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { OpenPathOutcome } from "@shared/ipc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createOpenPathQueue,
  extractOpenPaths,
  importExternalDrawing,
  resolveDrawingIdForPath,
  type OpenPathQueueDeps,
} from "./open-with";

describe("extractOpenPaths", () => {
  it("dedupes and skips flags and non-drawing args", () => {
    expect(
      extractOpenPaths(
        ["/tmp/a.excalidraw", "-x", "--flag=value", "/tmp/a.excalidraw", "notes.txt"],
        "/w",
      ),
    ).toEqual(["/tmp/a.excalidraw"]);
  });
});

describe("resolveDrawingIdForPath", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "xcalidraw-open-with-"));
    await mkdir(path.join(root, "nested"));
    await writeFile(path.join(root, "nested", "a.excalidraw"), "{}\n");
    await writeFile(path.join(root, "readme.txt"), "hi\n");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("rejects non-drawing files and missing paths", async () => {
    await expect(resolveDrawingIdForPath(root, path.join(root, "readme.txt"))).resolves.toBeNull();
    await expect(
      resolveDrawingIdForPath(root, path.join(root, "nope.excalidraw")),
    ).resolves.toBeNull();
  });

  it("resolves symlinks to the real file inside the root", async () => {
    const link = path.join(root, "link.excalidraw");
    await symlink(path.join(root, "nested", "a.excalidraw"), link);
    await expect(resolveDrawingIdForPath(root, link)).resolves.toBe("nested/a.excalidraw");
  });
});

const makeImportDeps = () => {
  const calls: { create: string[]; written: [string, string][] } = { create: [], written: [] };
  const entries: { id: string; kind: string; name: string }[] = [];
  const deps = {
    createEntry: async (parentId: string | null, name: string) => {
      calls.create.push(`${parentId}:${name}`);
      const id = name;
      entries.push({ id, kind: "file", name });
      return { id };
    },
    writeDrawingFile: async (id: string, content: string) => {
      calls.written.push([id, content]);
    },
    listEntries: async () => entries,
  };
  return { calls, deps };
};

describe("importExternalDrawing", () => {
  it("creates a root-level entry with the original name and writes content", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "xcalidraw-import-"));
    try {
      const file = path.join(dir, "trip.excalidraw");
      await writeFile(file, '{"elements":[]}\n');
      const { calls, deps } = makeImportDeps();
      await expect(importExternalDrawing(file, deps)).resolves.toBe("trip.excalidraw");
      expect(calls.create).toEqual(["null:trip.excalidraw"]);
      expect(calls.written).toEqual([["trip.excalidraw", '{"elements":[]}\n']]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("dedupes against existing root entries", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "xcalidraw-import-"));
    try {
      const file = path.join(dir, "trip.excalidraw");
      await writeFile(file, "{}\n");
      const { calls, deps } = makeImportDeps();
      deps.listEntries = async () => [
        { id: "trip.excalidraw", kind: "file", name: "trip.excalidraw" },
        { id: "folder", kind: "directory", name: "trip (2).excalidraw" },
      ];
      await expect(importExternalDrawing(file, deps)).resolves.toBe("trip (3).excalidraw");
      expect(calls.create).toEqual(["null:trip (3).excalidraw"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

type TestDeps = OpenPathQueueDeps & {
  __sends: { win: string; outcomes: OpenPathOutcome[] }[];
};

const makeDeps = (overrides: Partial<OpenPathQueueDeps> = {}): TestDeps => {
  const sends: { win: string; outcomes: OpenPathOutcome[] }[] = [];
  return {
    getRoot: async () => "/root",
    getReadyWindow: () => ({ isDestroyed: () => false, webContents: { send: () => undefined } }),
    send: (win, outcomes) => {
      sends.push({ win: win.isDestroyed() ? "destroyed" : "main", outcomes });
    },
    resolveId: async (root, absPath) =>
      absPath.startsWith(root) ? absPath.slice(root.length + 1) : null,
    importDrawing: async (absPath) => `imported:${path.basename(absPath)}`,
    __sends: sends,
    ...overrides,
  };
};

describe("createOpenPathQueue", () => {
  it("reports per-path errors without dropping the batch", async () => {
    const deps = makeDeps({
      resolveId: async () => null,
      importDrawing: async (absPath) => {
        if (absPath.includes("bad")) throw new Error("boom");
        return `imported:${path.basename(absPath)}`;
      },
    });
    const queue = createOpenPathQueue(deps);
    queue.enqueue(["/x/bad.excalidraw", "/x/good.excalidraw"]);
    queue.flush();
    await vi.waitFor(() => {
      expect(deps.__sends).toEqual([
        { win: "main", outcomes: [{ status: "error", name: "bad.excalidraw", message: "boom" }] },
        { win: "main", outcomes: [{ status: "open", id: "imported:good.excalidraw" }] },
      ]);
    });
  });

  it("dedupes repeated paths", async () => {
    const deps = makeDeps();
    const queue = createOpenPathQueue(deps);
    queue.enqueue(["/root/a.excalidraw"]);
    queue.enqueue(["/root/a.excalidraw", "/root/b.excalidraw"]);
    queue.flush();
    await vi.waitFor(() => {
      expect(deps.__sends).toEqual([
        { win: "main", outcomes: [{ status: "open", id: "a.excalidraw" }] },
        { win: "main", outcomes: [{ status: "open", id: "b.excalidraw" }] },
      ]);
    });
  });
});
