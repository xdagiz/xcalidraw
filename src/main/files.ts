import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { BigIntStats, Dirent, Stats, constants as fsConstants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open as fsOpen,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import { codedError, errorCodeOf } from "@shared/errors";
import {
  FILE_NOT_FOUND_MESSAGE,
  MAX_DRAWING_CONTENT_BYTES,
  nextCopyName,
  parentIdOf,
  validateDrawingRecord,
  type FileDeleteMode,
  type FileEntry,
  sortFileEntries,
} from "@shared/ipc";

import { getDrawings } from "./drawings";

export const MAX_WALK_ENTRIES = 20_000;
const MAX_MUTATION_QUEUE = 100;

const isWindows = process.platform === "win32";
const isMac = process.platform === "darwin";

const normalizeId = (id: string) => (isMac ? id.normalize("NFC") : id);
const normalizeFsName = (name: string) => (isMac ? name.normalize("NFC") : name);

const throwExists = (cause?: unknown): never => {
  const error = codedError("A file or folder with that name already exists", {
    code: "INVALID",
    reason: "exists",
  });
  if (cause !== undefined) Object.assign(error, { cause });
  throw error;
};

const contains = (parent: string, child: string) => {
  const p = isWindows ? parent.toLowerCase() : parent;
  const c = isWindows ? child.toLowerCase() : child;
  const rel = path.relative(p, c);
  return rel === "" || (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`));
};

const realpathFromExistingAncestor = async (targetAbs: string) => {
  const missing: string[] = [];
  let current = targetAbs;
  for (;;) {
    try {
      const real = await realpath(current);
      return missing.length === 0 ? real : path.join(real, ...missing.toReversed());
    } catch (error) {
      if (errorCodeOf(error) !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
};

const assertSafeIdString = (id: string) => {
  if (id.includes("\0")) {
    throw codedError("Invalid path", { code: "INVALID", reason: "bad-path", field: "id" });
  }

  if (path.isAbsolute(id)) {
    throw codedError("Absolute paths not allowed", {
      code: "INVALID",
      reason: "bad-path",
      field: "id",
    });
  }

  if (/^[a-zA-Z]:/.test(id)) {
    throw codedError("Drive letters not allowed", {
      code: "INVALID",
      reason: "bad-path",
      field: "id",
    });
  }

  if (id.startsWith("\\\\") || id.startsWith("//")) {
    throw codedError("UNC paths not allowed", { code: "INVALID", reason: "bad-path", field: "id" });
  }

  if (id.includes("\\")) {
    throw codedError("Invalid path", { code: "INVALID", reason: "bad-path", field: "id" });
  }

  const segments = id.split("/");
  for (const [index, segment] of segments.entries()) {
    if (segment === "." && segments.length > 1) {
      throw codedError("Invalid path", { code: "INVALID", reason: "bad-path", field: "id" });
    }

    if (segment === ".." && index > 0) {
      throw codedError("Invalid path", { code: "INVALID", reason: "bad-path", field: "id" });
    }
  }
};

const getCanonicalRoot = async () => {
  const rawRoot = await requireDrawingsRoot();
  return realpath(rawRoot);
};

const assertInsideRealRoot = async (rootReal: string, candidateAbs: string) => {
  const candidateReal = await realpathFromExistingAncestor(candidateAbs);
  if (!contains(rootReal, candidateReal)) {
    throw codedError("Path escapes drawings root", { code: "INVALID", reason: "outside-root" });
  }
  return candidateReal;
};

const assertParentsNotSymlinks = async (
  rootLex: string,
  rootReal: string,
  candidateAbs: string,
) => {
  const parent = path.dirname(candidateAbs);
  const rel = path.relative(rootLex, parent);
  if (rel === "") return;
  if (path.isAbsolute(rel) || rel.startsWith("..")) return;

  let current = rootLex;
  for (const segment of rel.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const lst = await lstat(current).catch(() => null);
    if (!lst) {
      const parentReal = await realpath(path.dirname(current)).catch(() => null);
      if (parentReal && !contains(rootReal, parentReal)) {
        throw codedError("Symlink in path", { code: "INVALID", reason: "symlink" });
      }
      continue;
    }

    if (lst.isSymbolicLink()) {
      throw codedError("Symlink in path", { code: "INVALID", reason: "symlink" });
    }

    if (lst.isDirectory()) {
      const realCurrent = await realpath(current).catch(() => null);
      if (realCurrent && !contains(rootReal, realCurrent)) {
        throw codedError("Path escapes drawings root", { code: "INVALID", reason: "outside-root" });
      }
    }
  }
};

const assertNotSymlink = async (absPath: string) => {
  let lst: Stats;
  try {
    lst = await lstat(absPath);
  } catch (error) {
    if (errorCodeOf(error) === "ENOENT") return;
    throw error;
  }

  if (lst.isSymbolicLink()) {
    throw codedError("Symlinks not allowed", { code: "INVALID", reason: "symlink" });
  }

  if (lst.isFile() && lst.nlink > 1) {
    throw codedError("Hardlinks not allowed", { code: "INVALID", reason: "hardlink" });
  }
};

export type FsMutationHooks = {
  beforeMutate?: (absPaths: string[]) => void;
};

export const atomicWriteFile = async (absPath: string, data: string, hooks?: FsMutationHooks) => {
  const dir = path.dirname(absPath);
  const tmp = path.join(
    dir,
    `.${path.basename(absPath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );

  hooks?.beforeMutate?.([absPath, tmp]);

  const flags =
    fsConstants.O_WRONLY |
    fsConstants.O_CREAT |
    fsConstants.O_TRUNC |
    fsConstants.O_EXCL |
    (isWindows ? 0 : fsConstants.O_NOFOLLOW);

  let fh: Awaited<ReturnType<typeof fsOpen>> | undefined;
  try {
    fh = await fsOpen(tmp, flags, 0o600);
    await fh.writeFile(data, "utf8");
    await fh.datasync();
    await fh.close();
    fh = undefined;
  } catch (error) {
    await fh?.close().catch(() => {});
    await unlink(tmp).catch(() => {});
    throw error;
  }

  try {
    await rename(tmp, absPath);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }

  if (!isWindows) {
    const dirFh = await fsOpen(dir, "r").catch(() => null);
    if (dirFh) {
      await dirFh.sync().catch(() => {});
      await dirFh.close().catch(() => {});
    }
  }
};

const isExcalidrawFileName = (name: string) => name.toLowerCase().endsWith(".excalidraw");

const validateEntryName = (name: string) => {
  const leaf = name.trim();
  if (!leaf) {
    throw codedError("Name cannot be empty", {
      code: "INVALID",
      reason: "bad-name",
      field: "name",
    });
  }

  if (leaf.includes("/") || leaf.includes("\\")) {
    throw codedError("Name cannot contain path separators", {
      code: "INVALID",
      reason: "bad-name",
      field: "name",
    });
  }

  if (leaf === "." || leaf === ".." || leaf.startsWith(".")) {
    throw codedError("Names cannot start with a dot", {
      code: "INVALID",
      reason: "bad-name",
      field: "name",
    });
  }

  return leaf;
};

const toRelativeId = (root: string, absPath: string) =>
  path.relative(root, absPath).split(path.sep).filter(Boolean).join("/");

const entryFromAbs = async (
  root: string,
  absPath: string,
  kind: "file" | "directory",
): Promise<FileEntry> => {
  const id = toRelativeId(root, absPath);
  const stats = await lstat(absPath, { bigint: true });
  return {
    id,
    name: normalizeFsName(path.basename(absPath)),
    kind,
    parentId: parentIdOf(id),
    modifiedAt: Number(stats.mtimeMs),
    size: kind === "file" ? Number(stats.size) : 0,
    ino: stats.ino.toString(),
    dev: stats.dev.toString(),
  };
};

const resolveInsideRoot = async (id: string) => {
  const normalizedId = normalizeId(id);
  assertSafeIdString(normalizedId);

  const root = await requireDrawingsRoot();
  const rootReal = await getCanonicalRoot();
  const absPath = path.resolve(root, ...normalizedId.split("/").filter(Boolean));
  if (!contains(path.resolve(root), absPath)) {
    throw codedError("Path escapes drawings root", { code: "INVALID", reason: "outside-root" });
  }

  const candidateReal = await assertInsideRealRoot(rootReal, absPath);
  await assertParentsNotSymlinks(root, rootReal, absPath);
  await assertNotSymlink(absPath);

  return { root, rootReal, absPath, candidateReal };
};

const walkEntriesCapped = async (root: string, cap: number): Promise<FileEntry[]> => {
  const out: FileEntry[] = [];
  const rootReal = await getCanonicalRoot();

  let entryCount = 0;
  const countEntry = () => {
    entryCount += 1;
    if (entryCount > cap) {
      throw codedError(`The drawings folder contains too many files (max ${cap})`, {
        code: "TOO_LARGE",
        reason: "too-many-entries",
        limit: cap,
      });
    }
  };

  const pending: string[] = [root];
  while (pending.length > 0) {
    const dirAbs = pending.pop();
    if (dirAbs === undefined) continue;

    let dirents: Dirent[];
    try {
      dirents = await readdir(dirAbs, { withFileTypes: true });
    } catch (error) {
      if (dirAbs !== root && errorCodeOf(error) === "ENOENT") continue;
      throw error;
    }

    for (const dirent of dirents) {
      if (dirent.name.startsWith(".")) {
        continue;
      }

      const absPath = path.join(dirAbs, dirent.name);

      let lst: Stats | BigIntStats;
      try {
        lst = await lstat(absPath, { bigint: true });
      } catch (error) {
        if (errorCodeOf(error) === "ENOENT") continue;
        throw error;
      }

      if (lst.isSymbolicLink()) continue;

      const id = toRelativeId(root, absPath);

      if (lst.isDirectory()) {
        if (isWindows) {
          const realChild = await realpath(absPath).catch(() => null);
          if (realChild === null || !contains(rootReal, realChild)) continue;
        }

        countEntry();
        out.push({
          id,
          name: normalizeFsName(dirent.name),
          kind: "directory",
          parentId: parentIdOf(id),
          modifiedAt: Number(lst.mtimeMs),
          size: 0,
          ino: lst.ino.toString(),
          dev: lst.dev.toString(),
        });

        pending.push(absPath);
        continue;
      }

      if (lst.isFile() && isExcalidrawFileName(dirent.name)) {
        countEntry();
        out.push({
          id,
          name: normalizeFsName(dirent.name),
          kind: "file",
          parentId: parentIdOf(id),
          modifiedAt: Number(lst.mtimeMs),
          size: Number(lst.size),
          ino: lst.ino.toString(),
          dev: lst.dev.toString(),
        });
      }
    }
  }

  return sortFileEntries(out);
};

const walkEntries = async (root: string): Promise<FileEntry[]> => {
  return walkEntriesCapped(root, MAX_WALK_ENTRIES);
};

export const countEntriesFlat = async (rootAbs: string, cap: number) => {
  let count = 0;
  const countEntry = () => {
    count += 1;
    if (count > cap) {
      throw codedError(`The drawings folder contains too many files (max ${cap})`, {
        code: "TOO_LARGE",
        reason: "too-many-entries",
        limit: cap,
      });
    }
  };

  const pending: string[] = [rootAbs];
  while (pending.length > 0) {
    const dirAbs = pending.pop();
    if (dirAbs === undefined) continue;

    let dirents: Dirent[];
    try {
      dirents = await readdir(dirAbs, { withFileTypes: true });
    } catch (error) {
      if (dirAbs !== rootAbs && errorCodeOf(error) === "ENOENT") continue;
      throw error;
    }

    for (const dirent of dirents) {
      if (dirent.name.startsWith(".")) continue;
      const absPath = path.join(dirAbs, dirent.name);
      let lst: Stats;
      try {
        lst = await lstat(absPath);
      } catch (error) {
        if (errorCodeOf(error) === "ENOENT") continue;
        throw error;
      }

      if (lst.isSymbolicLink()) continue;
      if (lst.isDirectory()) {
        countEntry();
        pending.push(absPath);
        continue;
      }

      if (lst.isFile() && isExcalidrawFileName(dirent.name)) countEntry();
    }
  }

  return count;
};

const requireDrawingsRoot = async () => {
  const info = await getDrawings();
  if (info.missing) {
    throw codedError("Drawings folder is missing", { code: "NOT_FOUND", reason: "missing-root" });
  }

  if (!info.configured || !info.path) {
    throw codedError("Drawings folder not configured", {
      code: "NOT_FOUND",
      reason: "missing-root",
    });
  }

  return path.resolve(info.path);
};

const EMPTY_DRAWING_CONTENT =
  '{"type":"excalidraw","version":2,"source":"xcalidraw","elements":[],"appState":{},"files":{}}';

const assertDrawingJson = (content: string) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw codedError("Drawing content is not valid JSON", {
      code: "INVALID",
      reason: "invalid-json",
    });
  }
  try {
    validateDrawingRecord(parsed);
  } catch (error) {
    throw codedError(error instanceof Error ? error.message : "Invalid drawing", {
      code: "INVALID",
      reason: "invalid-record",
    });
  }
};

const assertContentSize = (content: string) => {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_DRAWING_CONTENT_BYTES) {
    throw codedError(`Content exceeds ${MAX_DRAWING_CONTENT_BYTES} bytes`, {
      code: "TOO_LARGE",
      reason: "content-too-large",
      limit: MAX_DRAWING_CONTENT_BYTES,
    });
  }
};

export const readDrawingFile = async (id: string) => {
  const { candidateReal } = await resolveInsideRoot(id);

  if (!isExcalidrawFileName(path.basename(id))) {
    throw codedError("Only .excalidraw files can be read", {
      code: "INVALID",
      reason: "bad-extension",
      field: "id",
    });
  }

  const flags = isWindows ? fsConstants.O_RDONLY : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;

  let fh: Awaited<ReturnType<typeof fsOpen>>;
  try {
    fh = await fsOpen(candidateReal, flags);
  } catch (error) {
    const code = errorCodeOf(error);
    if (code === "ELOOP" || code === "ENOTDIR") {
      throw codedError("Path escapes drawings root", { code: "INVALID", reason: "outside-root" });
    }
    throw error;
  }

  try {
    const stats = await fh.stat();
    if (stats.isDirectory()) {
      throw codedError("Cannot read a directory as a drawing", {
        code: "INVALID",
        reason: "is-directory",
        field: "id",
      });
    }

    if (stats.isFile() && stats.nlink > 1) {
      throw codedError("Hardlinks not allowed", { code: "INVALID", reason: "hardlink" });
    }

    if (stats.size > MAX_DRAWING_CONTENT_BYTES) {
      throw codedError("File is too large to load", {
        code: "TOO_LARGE",
        reason: "file-too-large",
        limit: MAX_DRAWING_CONTENT_BYTES,
      });
    }

    const content = await fh.readFile("utf8");
    assertDrawingJson(content);
    return content;
  } finally {
    await fh.close().catch(() => {});
  }
};

const ensureNotDirectory = async (absPath: string) => {
  const existing = await lstat(absPath).catch(() => null);
  if (existing?.isDirectory()) {
    throw codedError("Cannot write over a directory", { code: "INVALID", reason: "is-directory" });
  }

  if (existing?.isSymbolicLink()) {
    throw codedError("Invalid file", { code: "INVALID", reason: "symlink" });
  }

  if (existing?.isFile() && existing.nlink > 1) {
    throw codedError("Invalid file", { code: "INVALID", reason: "hardlink" });
  }
};

let mutationTail: Promise<void> = Promise.resolve();
let mutationDepth = 0;

const withFileMutationLock = <T>(task: () => Promise<T>): Promise<T> => {
  if (mutationDepth >= MAX_MUTATION_QUEUE) {
    const busy = codedError("Too many pending file operations", {
      code: "UNKNOWN",
      reason: "busy",
    });
    return Promise.reject(busy);
  }

  mutationDepth += 1;
  const run = mutationTail.then(task, task);
  mutationTail = run.then(
    () => undefined,
    () => undefined,
  );

  return run.then(
    (value) => {
      mutationDepth -= 1;
      return value;
    },
    (error) => {
      mutationDepth -= 1;
      throw error;
    },
  );
};

export const writeDrawingFile = async (
  id: string,
  content: string,
  hooks?: FsMutationHooks,
): Promise<FileEntry> =>
  withFileMutationLock(async () => {
    if (typeof content !== "string") {
      throw codedError("Content must be a string", {
        code: "INVALID",
        reason: "invalid-arg",
        field: "content",
      });
    }

    assertContentSize(content);
    assertDrawingJson(content);

    const { root, rootReal, absPath, candidateReal } = await resolveInsideRoot(id);

    if (!isExcalidrawFileName(path.basename(id))) {
      throw codedError("Only .excalidraw files can be written", {
        code: "INVALID",
        reason: "bad-extension",
        field: "id",
      });
    }

    const existing = await lstat(absPath).catch(() => null);
    if (!existing) {
      throw codedError(FILE_NOT_FOUND_MESSAGE, { code: "NOT_FOUND", reason: "missing-file" });
    }

    if (existing.isDirectory()) {
      throw codedError("Cannot write over a directory", {
        code: "INVALID",
        reason: "is-directory",
      });
    }

    await assertInsideRealRoot(rootReal, absPath);
    await assertParentsNotSymlinks(root, rootReal, absPath);
    await assertNotSymlink(absPath);

    await atomicWriteFile(candidateReal, content.endsWith("\n") ? content : `${content}\n`, hooks);
    return entryFromAbs(root, absPath, "file");
  });

export const writeDrawingFileRecover = async (
  id: string,
  content: string,
  hooks?: FsMutationHooks,
): Promise<FileEntry> =>
  withFileMutationLock(async () => {
    if (typeof content !== "string") {
      throw codedError("Content must be a string", {
        code: "INVALID",
        reason: "invalid-arg",
        field: "content",
      });
    }

    assertContentSize(content);
    assertDrawingJson(content);

    const { root, rootReal, absPath, candidateReal } = await resolveInsideRoot(id);

    if (!isExcalidrawFileName(path.basename(id))) {
      throw codedError("Only .excalidraw files can be written", {
        code: "INVALID",
        reason: "bad-extension",
        field: "id",
      });
    }

    await assertParentsNotSymlinks(root, rootReal, absPath);

    const parentRealAfter = await realpath(path.dirname(absPath)).catch(() => null);
    if (parentRealAfter && !contains(rootReal, parentRealAfter)) {
      throw codedError("Symlink in path", { code: "INVALID", reason: "symlink" });
    }

    await assertInsideRealRoot(rootReal, absPath);
    await assertParentsNotSymlinks(root, rootReal, absPath);
    await ensureNotDirectory(absPath);

    await mkdir(path.dirname(candidateReal), { recursive: true });
    const parentRealAfterMkdir = await realpath(path.dirname(absPath)).catch(() => null);
    if (parentRealAfterMkdir && !contains(rootReal, parentRealAfterMkdir)) {
      throw codedError("Symlink in path", { code: "INVALID", reason: "symlink" });
    }
    await atomicWriteFile(candidateReal, content.endsWith("\n") ? content : `${content}\n`, hooks);
    return entryFromAbs(root, absPath, "file");
  });

export const renameEntry = async (
  id: string,
  newName: string,
  hooks?: FsMutationHooks,
): Promise<FileEntry> =>
  withFileMutationLock(async () => {
    const { root, rootReal, absPath, candidateReal } = await resolveInsideRoot(id);

    const lst = await lstat(absPath, { bigint: true });
    if (lst.isSymbolicLink()) {
      throw codedError("Symlinks not allowed", { code: "INVALID", reason: "symlink" });
    }

    if (lst.isFile() && Number(lst.nlink) > 1) {
      throw codedError("Hardlinks not allowed", { code: "INVALID", reason: "hardlink" });
    }

    const isDirectory = lst.isDirectory();

    if (!isDirectory && !isExcalidrawFileName(path.basename(id))) {
      throw codedError("Only .excalidraw files can be renamed", {
        code: "INVALID",
        reason: "bad-extension",
        field: "id",
      });
    }

    const leaf = validateEntryName(newName);
    if (isDirectory && isExcalidrawFileName(leaf)) {
      throw codedError("Folder names cannot end with .excalidraw", {
        code: "INVALID",
        reason: "bad-extension",
        field: "newName",
      });
    }

    const nameWithExt = isDirectory || isExcalidrawFileName(leaf) ? leaf : `${leaf}.excalidraw`;
    const nextAbs = path.join(path.dirname(absPath), nameWithExt);

    if (!contains(path.resolve(root), nextAbs)) {
      throw codedError("Path escapes drawings root", { code: "INVALID", reason: "outside-root" });
    }

    const nextReal = await assertInsideRealRoot(rootReal, nextAbs);
    await assertParentsNotSymlinks(root, rootReal, nextAbs);

    if (nextAbs === absPath) return entryFromAbs(root, absPath, isDirectory ? "directory" : "file");
    const kind = isDirectory ? "directory" : "file";

    if (nextAbs.toLowerCase() === absPath.toLowerCase()) {
      const nextLst = await lstat(nextAbs, { bigint: true }).catch(() => null);
      if (nextLst && (nextLst.dev !== lst.dev || nextLst.ino !== lst.ino)) {
        throwExists();
      }
      const tempAbs = path.join(
        path.dirname(candidateReal),
        `.${path.basename(candidateReal)}.renaming-${randomUUID()}.tmp`,
      );
      hooks?.beforeMutate?.([candidateReal, tempAbs, nextReal]);
      await rename(candidateReal, tempAbs);
      try {
        await rename(tempAbs, nextReal);
      } catch (error) {
        await rename(tempAbs, candidateReal).catch(() => {});
        throw error;
      }
      return entryFromAbs(root, nextAbs, kind);
    }

    hooks?.beforeMutate?.([candidateReal, nextReal]);
    // Same-device rename is atomic with no hardlink window where both names
    // resolve to one inode. The EXDEV copy+fsync+unlink fallback below has a
    // crash window where both paths exist as separate files.
    if (!isDirectory) {
      const nextExists = await lstat(nextAbs).catch(() => null);
      if (nextExists) throwExists();

      try {
        await rename(candidateReal, nextReal);
      } catch (error) {
        const code = errorCodeOf(error);
        if (code === "EEXIST" || code === "ENOTEMPTY") throwExists(error);
        if (code !== "EXDEV") throw error;

        try {
          await copyFile(candidateReal, nextReal, fsConstants.COPYFILE_EXCL);
        } catch (copyError) {
          if (errorCodeOf(copyError) === "EEXIST") throwExists(copyError);
          throw copyError;
        }

        const copiedFh = await fsOpen(nextReal, "r").catch(() => null);
        if (copiedFh) {
          await copiedFh.sync().catch(() => {});
          await copiedFh.close().catch(() => {});
        }

        try {
          await unlink(candidateReal);
        } catch (unlinkError) {
          await unlink(nextReal).catch(() => {});
          throw unlinkError;
        }
      }

      return entryFromAbs(root, nextAbs, kind);
    } else {
      const exists = await lstat(nextAbs).catch(() => null);
      if (exists) throwExists();
      try {
        await rename(candidateReal, nextReal);
      } catch (renameError) {
        const renameCode = errorCodeOf(renameError);
        if (renameCode === "EEXIST" || renameCode === "ENOTEMPTY") throwExists(renameError);
        throw renameError;
      }
    }

    return entryFromAbs(root, nextAbs, kind);
  });

const throwIntoSelf = () => {
  throw codedError("Cannot move a folder into itself", {
    code: "INVALID",
    reason: "into-self",
  });
};

const idContains = (rootId: string, id: string) => id === rootId || id.startsWith(`${rootId}/`);

const resolveParentAbs = async (parentId: string | null, root: string, rootReal: string) => {
  if (parentId === null) return root;

  const normalizedParent = normalizeId(parentId);
  assertSafeIdString(normalizedParent);
  const parentAbs = path.resolve(root, ...normalizedParent.split("/").filter(Boolean));
  if (!contains(path.resolve(root), parentAbs)) {
    throw codedError("Path escapes drawings root", { code: "INVALID", reason: "outside-root" });
  }

  await assertInsideRealRoot(rootReal, parentAbs);
  await assertParentsNotSymlinks(root, rootReal, parentAbs);
  const parentStats = await lstat(parentAbs).catch(() => null);
  if (!parentStats || !parentStats.isDirectory() || parentStats.isSymbolicLink()) {
    throw codedError("Parent folder not found", { code: "NOT_FOUND", reason: "missing-parent" });
  }

  return parentAbs;
};

const fsyncFile = async (absPath: string) => {
  const fh = await fsOpen(absPath, "r").catch(() => null);
  if (!fh) return;
  await fh.sync().catch(() => {});
  await fh.close().catch(() => {});
};

type PlannedCopy = { abs: string; rel: string; kind: "file" | "directory" };

const assertRealInside = async (rootReal: string, absPath: string) => {
  const real = await realpath(absPath).catch(() => null);
  if (!real || !contains(rootReal, real)) {
    throw codedError("Path escapes drawings root", { code: "INVALID", reason: "outside-root" });
  }
};

const planCopyNodes = async (
  rootReal: string,
  sourceAbs: string,
  isDirectory: boolean,
): Promise<PlannedCopy[]> => {
  if (!isDirectory) return [{ abs: sourceAbs, rel: "", kind: "file" }];

  const nodes: PlannedCopy[] = [{ abs: sourceAbs, rel: "", kind: "directory" }];
  const pending = [nodes[0]];
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current) continue;

    let dirents: Dirent[];
    try {
      dirents = await readdir(current.abs, { withFileTypes: true });
    } catch (error) {
      if (errorCodeOf(error) === "ENOENT") continue;
      throw error;
    }

    for (const dirent of dirents) {
      if (dirent.name.startsWith(".")) continue;
      const abs = path.join(current.abs, dirent.name);
      const lst = await lstat(abs).catch((error: unknown) => {
        if (errorCodeOf(error) === "ENOENT") return null;
        throw error;
      });
      if (!lst || lst.isSymbolicLink()) continue;

      const rel = current.rel ? `${current.rel}/${dirent.name}` : dirent.name;
      if (lst.isDirectory()) {
        await assertRealInside(rootReal, abs);
        const node: PlannedCopy = { abs, rel, kind: "directory" };
        nodes.push(node);
        pending.push(node);
        continue;
      }

      if (lst.isFile() && isExcalidrawFileName(dirent.name)) {
        if (lst.nlink > 1) {
          throw codedError("Hardlinks not allowed", { code: "INVALID", reason: "hardlink" });
        }
        await assertRealInside(rootReal, abs);
        nodes.push({ abs, rel, kind: "file" });
      }
    }
  }

  return nodes;
};

const reserveCopyLeaf = async (
  parentAbs: string,
  sourceName: string,
  kind: "file" | "directory",
) => {
  const listed = await readdir(parentAbs).catch(() => [] as string[]);
  const taken = new Set(listed.map((listedName) => normalizeFsName(listedName)));

  for (let guard = 0; guard < 1000; guard += 1) {
    const candidate = nextCopyName(
      [...taken].map((listedName) => ({ name: listedName })),
      sourceName,
      kind,
    );
    const destAbs = path.join(parentAbs, candidate);
    const exists = await lstat(destAbs).catch(() => null);
    if (!exists) return candidate;
    taken.add(normalizeFsName(candidate));
  }

  throw codedError("A file or folder with that name already exists", {
    code: "INVALID",
    reason: "exists",
  });
};

export const moveEntry = async (
  id: string,
  parentId: string | null,
  hooks?: FsMutationHooks,
): Promise<FileEntry> =>
  withFileMutationLock(async () => {
    const { root, rootReal, absPath, candidateReal } = await resolveInsideRoot(id);
    const lst = await lstat(absPath);
    if (lst.isSymbolicLink()) {
      throw codedError("Symlinks not allowed", { code: "INVALID", reason: "symlink" });
    }

    if (lst.isFile() && lst.nlink > 1) {
      throw codedError("Hardlinks not allowed", { code: "INVALID", reason: "hardlink" });
    }

    const isDirectory = lst.isDirectory();
    if (!isDirectory && !isExcalidrawFileName(path.basename(id))) {
      throw codedError("Only .excalidraw files can be moved", {
        code: "INVALID",
        reason: "bad-extension",
        field: "id",
      });
    }

    if (parentId !== null && idContains(id, normalizeId(parentId))) throwIntoSelf();

    const parentAbs = await resolveParentAbs(parentId, root, rootReal);
    const parentReal = parentId === null ? rootReal : await realpath(parentAbs);
    if (contains(candidateReal, parentReal)) throwIntoSelf();

    const kind = isDirectory ? "directory" : "file";
    if (path.resolve(parentAbs) === path.resolve(path.dirname(absPath))) {
      return entryFromAbs(root, absPath, kind);
    }

    const nextAbs = path.join(parentAbs, path.basename(absPath));
    if (!contains(path.resolve(root), nextAbs)) {
      throw codedError("Path escapes drawings root", { code: "INVALID", reason: "outside-root" });
    }

    const nextReal = await assertInsideRealRoot(rootReal, nextAbs);
    await assertParentsNotSymlinks(root, rootReal, nextAbs);
    const exists = await lstat(nextAbs).catch(() => null);
    if (exists) throwExists();

    hooks?.beforeMutate?.([candidateReal, nextReal]);
    try {
      await rename(candidateReal, nextReal);
    } catch (error) {
      const code = errorCodeOf(error);
      if (code === "EEXIST" || code === "ENOTEMPTY") throwExists(error);
      if (isDirectory || code !== "EXDEV") throw error;

      try {
        await copyFile(candidateReal, nextReal, fsConstants.COPYFILE_EXCL);
      } catch (copyError) {
        if (errorCodeOf(copyError) === "EEXIST") throwExists(copyError);
        throw copyError;
      }

      await fsyncFile(nextReal);
      try {
        await unlink(candidateReal);
      } catch (unlinkError) {
        await unlink(nextReal).catch(() => {});
        throw unlinkError;
      }
    }

    return entryFromAbs(root, nextAbs, kind);
  });

export const copyEntry = async (
  id: string,
  parentId: string | null,
  hooks?: FsMutationHooks,
): Promise<FileEntry[]> =>
  withFileMutationLock(async () => {
    const { root, rootReal, absPath } = await resolveInsideRoot(id);
    const lst = await lstat(absPath);
    if (lst.isSymbolicLink()) {
      throw codedError("Symlinks not allowed", { code: "INVALID", reason: "symlink" });
    }

    if (lst.isFile() && lst.nlink > 1) {
      throw codedError("Hardlinks not allowed", { code: "INVALID", reason: "hardlink" });
    }

    const isDirectory = lst.isDirectory();
    if (!isDirectory && !isExcalidrawFileName(path.basename(id))) {
      throw codedError("Only .excalidraw files can be copied", {
        code: "INVALID",
        reason: "bad-extension",
        field: "id",
      });
    }

    const parentAbs = await resolveParentAbs(parentId, root, rootReal);
    const nodes = await planCopyNodes(rootReal, absPath, isDirectory);
    const leaf = await reserveCopyLeaf(
      parentAbs,
      path.basename(absPath),
      isDirectory ? "directory" : "file",
    );

    const created: FileEntry[] = [];
    let started = false;
    let createdRoot: string | null = null;

    try {
      for (const node of nodes) {
        const destAbs = node.rel
          ? path.join(parentAbs, leaf, ...node.rel.split("/"))
          : path.join(parentAbs, leaf);
        if (!contains(path.resolve(root), destAbs)) {
          throw codedError("Path escapes drawings root", {
            code: "INVALID",
            reason: "outside-root",
          });
        }

        const destReal = await assertInsideRealRoot(rootReal, destAbs);
        await assertParentsNotSymlinks(root, rootReal, destAbs);

        if (createdRoot === null) createdRoot = destReal;
        hooks?.beforeMutate?.([destReal]);
        if (node.kind === "directory") {
          await mkdir(destReal);
        } else {
          await copyFile(node.abs, destReal, fsConstants.COPYFILE_EXCL);
          await fsyncFile(destReal);
        }

        started = true;
        created.push(await entryFromAbs(root, destAbs, node.kind));
      }
    } catch (error) {
      if (started && createdRoot) await rm(createdRoot, { recursive: true, force: true });
      throw error;
    }

    return created;
  });

export const createEntry = async (
  parentId: string | null,
  name: string,
  kind: "file" | "directory",
  hooks?: FsMutationHooks,
): Promise<FileEntry> =>
  withFileMutationLock(async () => {
    const leaf = validateEntryName(name);
    if (kind === "directory" && isExcalidrawFileName(leaf)) {
      throw codedError("Folder names cannot end with .excalidraw", {
        code: "INVALID",
        reason: "bad-extension",
        field: "name",
      });
    }

    const root = await requireDrawingsRoot();
    const rootReal = await getCanonicalRoot();

    let parentAbs = root;
    if (parentId !== null) {
      const normalizedParent = normalizeId(parentId);
      assertSafeIdString(normalizedParent);

      parentAbs = path.resolve(root, ...normalizedParent.split("/").filter(Boolean));
      if (!contains(path.resolve(root), parentAbs)) {
        throw codedError("Path escapes drawings root", { code: "INVALID", reason: "outside-root" });
      }

      await assertInsideRealRoot(rootReal, parentAbs);
      await assertParentsNotSymlinks(root, rootReal, parentAbs);

      const parentStats = await lstat(parentAbs).catch(() => null);
      if (!parentStats || !parentStats.isDirectory() || parentStats.isSymbolicLink()) {
        throw codedError("Parent folder not found", {
          code: "NOT_FOUND",
          reason: "missing-parent",
        });
      }
    }

    const nameForFs = kind === "file" && !isExcalidrawFileName(leaf) ? `${leaf}.excalidraw` : leaf;
    const nextAbs = path.join(parentAbs, nameForFs);
    if (!contains(path.resolve(root), nextAbs)) {
      throw codedError("Path escapes drawings root", { code: "INVALID", reason: "outside-root" });
    }

    const nextReal = await assertInsideRealRoot(rootReal, nextAbs);
    await assertParentsNotSymlinks(root, rootReal, nextAbs);

    const exists = await lstat(nextAbs).catch(() => null);
    if (exists) throwExists();

    if (kind === "directory") {
      hooks?.beforeMutate?.([nextReal]);
      await mkdir(nextReal);
    } else {
      await atomicWriteFile(nextReal, `${EMPTY_DRAWING_CONTENT}\n`, hooks);
    }

    return entryFromAbs(root, nextAbs, kind);
  });

export const deleteEntry = async (
  id: string,
  mode: FileDeleteMode = "trash",
  hooks?: FsMutationHooks,
  trashItem?: (path: string) => Promise<void>,
) =>
  withFileMutationLock(async () => {
    const { rootReal, candidateReal } = await resolveInsideRoot(id);
    if (candidateReal === rootReal) {
      throw codedError("Cannot delete drawings root", {
        code: "INVALID",
        reason: "invalid-arg",
        field: "id",
      });
    }

    hooks?.beforeMutate?.([candidateReal]);

    const lst = await lstat(candidateReal).catch(() => null);
    if (!lst) return;

    if (lst.isSymbolicLink()) {
      await unlink(candidateReal);
      return;
    }

    if (mode === "permanent") {
      await rm(candidateReal, { recursive: true, force: false, maxRetries: 2 });
      return;
    }

    if (!trashItem) {
      throw codedError("Trash is unavailable", { code: "UNKNOWN", reason: "trash-unavailable" });
    }

    await trashItem(candidateReal);
  });

export const listEntries = async (root?: string): Promise<FileEntry[]> => {
  const info = await getDrawings();
  if (!info.configured || !info.path) return [];

  const configured = path.resolve(info.path);
  let canonicalConfigured: string;
  try {
    canonicalConfigured = await realpath(configured);
  } catch (error) {
    if (errorCodeOf(error) === "ENOENT") return [];
    throw error;
  }

  if (root) {
    const resolved = path.resolve(root);
    const realRequested = await realpath(resolved).catch(() => null);
    const inside =
      realRequested !== null
        ? contains(canonicalConfigured, realRequested)
        : contains(configured, resolved);
    if (!inside) {
      throw codedError("Path escapes drawings root", { code: "INVALID", reason: "outside-root" });
    }
  }

  return walkEntries(configured);
};
