import {
  link,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { FILE_NOT_FOUND_MESSAGE } from "@shared/ipc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const ctx = vi.hoisted(() => ({
  root: "",
  configured: true,
}));

vi.mock("./drawings", () => ({
  getDrawings: async () => ({
    path: ctx.root || null,
    displayPath: ctx.root || null,
    displayName: "drawings",
    configured: ctx.configured && Boolean(ctx.root),
    missing: false,
  }),
}));

import {
  copyEntry,
  createEntry,
  deleteEntry,
  listEntries,
  moveEntry,
  readDrawingFile,
  renameEntry,
  writeDrawingFile,
  writeDrawingFileRecover,
} from "./files";

const SCENE = '{"elements":[],"files":{}}\n';

describe("files", () => {
  beforeEach(async () => {
    ctx.configured = true;
    ctx.root = await mkdtemp(path.join(tmpdir(), "xcalidraw-files-"));
  });

  afterEach(async () => {
    if (ctx.root) await rm(ctx.root, { recursive: true, force: true });
    ctx.root = "";
  });

  it("lists .excalidraw files and directories, skipping dotfiles", async () => {
    await writeFile(path.join(ctx.root, "a.excalidraw"), SCENE);
    await mkdir(path.join(ctx.root, "nested"));
    await writeFile(path.join(ctx.root, "nested", "b.excalidraw"), SCENE);
    await writeFile(path.join(ctx.root, "readme.txt"), "nope");
    await writeFile(path.join(ctx.root, ".hidden.excalidraw"), SCENE);

    const entries = await listEntries();
    expect(entries.map((e) => e.id)).toEqual(["a.excalidraw", "nested", "nested/b.excalidraw"]);
  });

  it("rejects paths that escape the drawings root", async () => {
    await expect(readDrawingFile("../secret.excalidraw")).rejects.toThrow(
      "Path escapes drawings root",
    );
    await expect(writeDrawingFile("..%2fsecret.excalidraw", SCENE)).rejects.toThrow(
      FILE_NOT_FOUND_MESSAGE,
    );
  });

  it("treats ids as literal file names", async () => {
    await writeFile(path.join(ctx.root, "100%.excalidraw"), SCENE);
    await expect(readDrawingFile("100%.excalidraw")).resolves.toBe(SCENE);

    await writeFile(path.join(ctx.root, "a%20b.excalidraw"), SCENE);
    await expect(readDrawingFile("a%20b.excalidraw")).resolves.toBe(SCENE);
    await expect(readDrawingFile("a b.excalidraw")).rejects.toThrow();

    await writeDrawingFile("100%.excalidraw", SCENE);
    await expect(readDrawingFile("100%.excalidraw")).resolves.toBe(SCENE);
  });

  it("reads and writes existing drawing files", async () => {
    await writeFile(path.join(ctx.root, "a.excalidraw"), SCENE);
    await expect(readDrawingFile("a.excalidraw")).resolves.toBe(SCENE);

    await writeDrawingFile("a.excalidraw", '{"elements":[{"id":"x"}],"files":{}}');
    const onDisk = await readFile(path.join(ctx.root, "a.excalidraw"), "utf8");
    expect(onDisk).toContain('"id":"x"');
    expect(onDisk.endsWith("\n")).toBe(true);
  });

  it("refuses to write a drawing that does not exist", async () => {
    await expect(writeDrawingFile("missing.excalidraw", SCENE)).rejects.toThrow(
      FILE_NOT_FOUND_MESSAGE,
    );
  });

  it("recover creates missing drawing files, including nested directories", async () => {
    await writeDrawingFileRecover("folder/new.excalidraw", SCENE);
    await expect(readDrawingFile("folder/new.excalidraw")).resolves.toBe(SCENE);
  });

  it("rejects non-excalidraw files and invalid drawing JSON", async () => {
    await writeFile(path.join(ctx.root, "notes.txt"), "hi");
    await expect(readDrawingFile("notes.txt")).rejects.toThrow(
      "Only .excalidraw files can be read",
    );
    await expect(writeDrawingFile("notes.txt", SCENE)).rejects.toThrow(
      "Only .excalidraw files can be written",
    );

    await writeFile(path.join(ctx.root, "bad.excalidraw"), "{nope");
    await expect(readDrawingFile("bad.excalidraw")).rejects.toThrow(
      "Drawing content is not valid JSON",
    );
  });

  it("renames within the same folder and appends the extension", async () => {
    await mkdir(path.join(ctx.root, "folder"));
    await writeFile(path.join(ctx.root, "folder", "a.excalidraw"), SCENE);

    const entry = await renameEntry("folder/a.excalidraw", "b");

    expect(entry.id).toBe("folder/b.excalidraw");
    await expect(readDrawingFile("folder/b.excalidraw")).resolves.toBe(SCENE);
    await expect(readDrawingFile("folder/a.excalidraw")).rejects.toThrow();

    const same = await renameEntry("folder/b.excalidraw", "b.excalidraw");
    expect(same.id).toBe("folder/b.excalidraw");
  });

  it("renames directories without extension coercion and still rejects collisions", async () => {
    await mkdir(path.join(ctx.root, "folder"));
    await mkdir(path.join(ctx.root, "other"));
    await writeFile(path.join(ctx.root, "a.excalidraw"), SCENE);
    await writeFile(path.join(ctx.root, "b.excalidraw"), SCENE);

    const entry = await renameEntry("folder", "renamed");
    expect(entry.id).toBe("renamed");
    expect(entry.kind).toBe("directory");
    await expect(renameEntry("a.excalidraw", "b")).rejects.toThrow(
      "A file or folder with that name already exists",
    );
    await expect(renameEntry("renamed", "other")).rejects.toThrow(
      "A file or folder with that name already exists",
    );
    await expect(renameEntry("a.excalidraw", "../escape")).rejects.toThrow(
      "Name cannot contain path separators",
    );

    const entries = await listEntries();
    expect(entries.map((e) => e.id)).toEqual(["a.excalidraw", "b.excalidraw", "other", "renamed"]);
  });

  it("performs case-only renames via a two-step move", async () => {
    await mkdir(path.join(ctx.root, "MixedCase"));

    const entry = await renameEntry("MixedCase", "mixedcase");

    expect(entry.id).toBe("mixedcase");
    const entries = await listEntries();
    expect(entries.map((e) => e.id)).toEqual(["mixedcase"]);
  });

  it("rejects case-only renames that collide with a distinct entry", async () => {
    await mkdir(path.join(ctx.root, "MixedCase"));
    await mkdir(path.join(ctx.root, "mixedcase"));
    await writeFile(path.join(ctx.root, "CaseFile.excalidraw"), SCENE);
    await writeFile(path.join(ctx.root, "casefile.excalidraw"), SCENE);

    await expect(renameEntry("MixedCase", "mixedcase")).rejects.toThrow(
      "A file or folder with that name already exists",
    );
    await expect(renameEntry("CaseFile.excalidraw", "casefile")).rejects.toThrow(
      "A file or folder with that name already exists",
    );

    const entries = await listEntries();
    expect(entries.map((e) => e.id)).toContain("MixedCase");
    expect(entries.map((e) => e.id)).toContain("mixedcase");
    await expect(readDrawingFile("CaseFile.excalidraw")).resolves.toBe(SCENE);
    await expect(readDrawingFile("casefile.excalidraw")).resolves.toBe(SCENE);
  });

  it("moves a file into another folder and to the root", async () => {
    await mkdir(path.join(ctx.root, "folder"));
    await mkdir(path.join(ctx.root, "dest"));
    await writeFile(path.join(ctx.root, "folder", "a.excalidraw"), SCENE);

    const moved = await moveEntry("folder/a.excalidraw", "dest");
    expect(moved.id).toBe("dest/a.excalidraw");
    await expect(readDrawingFile("dest/a.excalidraw")).resolves.toBe(SCENE);
    await expect(readDrawingFile("folder/a.excalidraw")).rejects.toThrow();

    const rooted = await moveEntry("dest/a.excalidraw", null);
    expect(rooted.id).toBe("a.excalidraw");
    await expect(readDrawingFile("a.excalidraw")).resolves.toBe(SCENE);
  });

  it("moves a directory and keeps the nested drawing", async () => {
    await mkdir(path.join(ctx.root, "src", "nested"), { recursive: true });
    await mkdir(path.join(ctx.root, "dest"));
    await writeFile(path.join(ctx.root, "src", "nested", "a.excalidraw"), SCENE);

    const moved = await moveEntry("src", "dest");

    expect(moved.id).toBe("dest/src");
    expect(moved.kind).toBe("directory");
    await expect(readDrawingFile("dest/src/nested/a.excalidraw")).resolves.toBe(SCENE);
  });

  it("rejects a move into the source, into a child, or onto a taken name", async () => {
    await mkdir(path.join(ctx.root, "src", "nested"), { recursive: true });
    await mkdir(path.join(ctx.root, "dest"));
    await writeFile(path.join(ctx.root, "src", "a.excalidraw"), SCENE);
    await writeFile(path.join(ctx.root, "dest", "a.excalidraw"), SCENE);

    await expect(moveEntry("src", "src")).rejects.toThrow("Cannot move a folder into itself");
    await expect(moveEntry("src", "src/nested")).rejects.toThrow(
      "Cannot move a folder into itself",
    );
    await expect(moveEntry("src/a.excalidraw", "dest")).rejects.toThrow(
      "A file or folder with that name already exists",
    );
    await expect(readDrawingFile("src/a.excalidraw")).resolves.toBe(SCENE);
  });

  it("does not write when a move stays in the same parent", async () => {
    await mkdir(path.join(ctx.root, "folder"));
    const filePath = path.join(ctx.root, "folder", "a.excalidraw");
    await writeFile(filePath, SCENE);
    const before = await lstat(filePath);

    const same = await moveEntry("folder/a.excalidraw", "folder");

    expect(same.id).toBe("folder/a.excalidraw");
    const after = await lstat(filePath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("copies a file onto a taken name and copies a directory tree", async () => {
    await writeFile(path.join(ctx.root, "Note.excalidraw"), SCENE);
    await writeFile(path.join(ctx.root, "Note copy.excalidraw"), SCENE);
    await mkdir(path.join(ctx.root, "notes", "sub"), { recursive: true });
    await writeFile(path.join(ctx.root, "notes", "sub", "b.excalidraw"), SCENE);

    const copied = await copyEntry("Note.excalidraw", null);
    expect(copied.map((entry) => entry.id)).toEqual(["Note copy 2.excalidraw"]);
    await expect(readDrawingFile("Note copy 2.excalidraw")).resolves.toBe(SCENE);

    const tree = await copyEntry("notes", null);
    expect(tree[0]?.id).toBe("notes copy");
    expect(tree.map((entry) => entry.id).toSorted()).toEqual([
      "notes copy",
      "notes copy/sub",
      "notes copy/sub/b.excalidraw",
    ]);
    await expect(readDrawingFile("notes copy/sub/b.excalidraw")).resolves.toBe(SCENE);
    await expect(readDrawingFile("notes/sub/b.excalidraw")).resolves.toBe(SCENE);
  });

  it("removes the new folder when a copy fails midway", async () => {
    await mkdir(path.join(ctx.root, "src"));
    await writeFile(path.join(ctx.root, "src", "a.excalidraw"), SCENE);
    let calls = 0;

    await expect(
      copyEntry("src", null, {
        beforeMutate: () => {
          calls += 1;
          if (calls === 2) throw new Error("boom");
        },
      }),
    ).rejects.toThrow("boom");

    const entries = await listEntries();
    expect(entries.map((entry) => entry.id)).toEqual(["src", "src/a.excalidraw"]);
  });

  it("trashes files and folders through the injected trash target", async () => {
    await mkdir(path.join(ctx.root, "folder"));
    await writeFile(path.join(ctx.root, "folder", "nested.excalidraw"), SCENE);
    await writeFile(path.join(ctx.root, "a.excalidraw"), SCENE);

    const trashed: string[] = [];
    const trashItem = async (trashPath: string) => {
      trashed.push(trashPath);
      await rm(trashPath, { recursive: true });
    };

    await deleteEntry("a.excalidraw", "trash", undefined, trashItem);
    await deleteEntry("folder", "trash", undefined, trashItem);

    expect(trashed).toEqual([path.join(ctx.root, "a.excalidraw"), path.join(ctx.root, "folder")]);
    await expect(readDrawingFile("a.excalidraw")).rejects.toThrow();
    await expect(deleteEntry(".")).rejects.toThrow("Cannot delete drawings root");
  });

  it("permanently deletes directories recursively when asked", async () => {
    await mkdir(path.join(ctx.root, "gone", "inner"), { recursive: true });
    await writeFile(path.join(ctx.root, "gone", "inner", "a.excalidraw"), SCENE);

    await deleteEntry("gone", "permanent");

    const entries = await listEntries();
    expect(entries.map((e) => e.id)).toEqual([]);
  });

  it("fails trash mode when no trash target is available", async () => {
    await writeFile(path.join(ctx.root, "a.excalidraw"), SCENE);

    await expect(deleteEntry("a.excalidraw", "trash")).rejects.toThrow("Trash is unavailable");
  });

  it("creates a drawing at the root, appending the extension", async () => {
    const entry = await createEntry(null, "Untitled", "file");

    expect(entry.id).toBe("Untitled.excalidraw");
    expect(entry.kind).toBe("file");
    expect((await listEntries()).map((e) => e.id)).toContain("Untitled.excalidraw");
    await expect(readDrawingFile("Untitled.excalidraw")).resolves.toContain('"elements":[]');
  });

  it("creates a nested drawing inside an existing folder", async () => {
    await mkdir(path.join(ctx.root, "nested"));

    const entry = await createEntry("nested", "Sketch", "file");

    expect(entry.id).toBe("nested/Sketch.excalidraw");
    expect(entry.parentId).toBe("nested");
  });

  it("creates directories without extension coercion", async () => {
    const entry = await createEntry(null, "Cats", "directory");

    expect(entry.id).toBe("Cats");
    expect(entry.kind).toBe("directory");
    const listed = (await listEntries()).find((e) => e.id === "Cats");
    expect(listed?.kind).toBe("directory");
  });

  it("rejects duplicate names at the destination", async () => {
    await writeFile(path.join(ctx.root, "a.excalidraw"), SCENE);

    await expect(createEntry(null, "a.excalidraw", "file")).rejects.toThrow(
      "A file or folder with that name already exists",
    );
    await expect(createEntry(null, "a", "file")).rejects.toThrow(
      "A file or folder with that name already exists",
    );
  });

  it("rejects names with path separators and missing parents", async () => {
    await expect(createEntry(null, "bad/name", "file")).rejects.toThrow(
      "Name cannot contain path separators",
    );
    await expect(createEntry("ghost", "x.excalidraw", "file")).rejects.toThrow();
    await expect(createEntry(null, "   ", "directory")).rejects.toThrow("Name cannot be empty");
  });

  it("rejects dot-prefixed names that would be hidden from the library", async () => {
    await writeFile(path.join(ctx.root, "visible.excalidraw"), SCENE);
    await mkdir(path.join(ctx.root, "folder"));

    await expect(createEntry(null, ".hidden", "file")).rejects.toThrow(
      "Names cannot start with a dot",
    );
    await expect(createEntry(null, ".hidden", "directory")).rejects.toThrow(
      "Names cannot start with a dot",
    );
    await expect(renameEntry("visible.excalidraw", ".hidden")).rejects.toThrow(
      "Names cannot start with a dot",
    );
    await expect(renameEntry("folder", ".hidden")).rejects.toThrow("Names cannot start with a dot");
  });

  it("rejects reading a file symlink that points outside the root", async () => {
    const outside = path.join(await realpath(tmpdir()), "jail-outside-secret.txt");
    await rm(outside, { force: true });
    await writeFile(outside, SCENE);
    await symlink(outside, path.join(ctx.root, "pwned.excalidraw"));

    await expect(readDrawingFile("pwned.excalidraw")).rejects.toThrow(/Symlink|Path escapes/i);

    await rm(outside, { force: true });
  });

  it("writeDrawingFileRecover never writes through a symlinked directory", async () => {
    const outside = path.join(await realpath(tmpdir()), "jail-outside-recover");
    await rm(outside, { recursive: true, force: true });
    await mkdir(outside);
    await symlink(outside, path.join(ctx.root, "linkDir"));

    await expect(writeDrawingFileRecover("linkDir/new.excalidraw", SCENE)).rejects.toThrow(
      /Symlink|Path escapes/i,
    );

    const created = await readFile(path.join(outside, "new.excalidraw"), "utf8").catch(() => null);
    expect(created).toBeNull();

    await rm(outside, { recursive: true, force: true });
  });

  it("rejects hardlinked files on read", async () => {
    const outside = path.join(await realpath(tmpdir()), "jail-outside-hard.excalidraw");
    await rm(outside, { force: true });
    await writeFile(outside, SCENE);
    await link(outside, path.join(ctx.root, "hard.excalidraw"));

    await expect(readDrawingFile("hard.excalidraw")).rejects.toThrow(/Hardlink/i);

    await rm(outside, { force: true });
  });

  it("does not enumerate entries through a directory symlink", async () => {
    const outside = path.join(await realpath(tmpdir()), "jail-outside-dir");
    await rm(outside, { recursive: true, force: true });
    await mkdir(outside);
    await writeFile(path.join(outside, "loot.excalidraw"), SCENE);
    await symlink(outside, path.join(ctx.root, "linkDir"));

    const entries = await listEntries();
    const ids = entries.map((e) => e.id);
    expect(ids).not.toContain("linkDir");
    expect(ids).not.toContain("linkDir/loot.excalidraw");

    await rm(outside, { recursive: true, force: true });
  });
});
