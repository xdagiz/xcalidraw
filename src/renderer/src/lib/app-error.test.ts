import { describe, expect, it } from "vite-plus/test";

import { detailFor, saveErrorToastId, toAppError } from "./app-error";

describe("toAppError", () => {
  it("maps each operation to its user-facing copy", () => {
    expect(toAppError(new Error("ENOENT"), "read").title).toBe("Couldn’t open this drawing");
    expect(toAppError(new Error("EACCES"), "save").title).toBe("Couldn’t save this drawing");
    expect(toAppError(new Error("x"), "recover").title).toBe("Couldn’t recover this drawing");
    expect(toAppError(new Error("x"), "rename").title).toBe("Couldn’t rename this drawing");
    expect(toAppError(new Error("x"), "delete").title).toBe("Couldn’t delete this drawing");
    expect(toAppError(new Error("x"), "move").title).toBe("Couldn’t move this item");
    expect(toAppError(new Error("x"), "copy").title).toBe("Couldn’t copy this item");
    expect(toAppError(new Error("x"), "settings").title).toBe("Couldn’t update settings");
    expect(toAppError(new Error("x"), "unexpected").title).toBe("Something went wrong");
  });

  it("derives retryable from code and reason", () => {
    expect(toAppError(new Error("x"), "read").retryable).toBe(true);
    expect(
      toAppError(
        {
          $isAppError: true,
          name: "Error",
          message: "gone",
          code: "NOT_FOUND",
          operation: "read",
          retryable: false,
          details: { code: "NOT_FOUND", reason: "missing-file" },
        },
        "read",
      ).retryable,
    ).toBe(false);
    expect(
      toAppError(
        {
          $isAppError: true,
          name: "Error",
          message: "busy",
          code: "UNKNOWN",
          operation: "save",
          retryable: true,
          details: { code: "UNKNOWN", reason: "busy" },
        },
        "save",
      ).retryable,
    ).toBe(true);
  });

  it("strips the IPC error prefix without leaking it", () => {
    const error = toAppError(
      new Error("Error invoking remote method 'files:rename': Error: EACCES"),
      "rename",
    );
    expect(error.message).not.toContain("files:rename");
    expect(error.code).toBe("UNKNOWN");
  });

  it("derives a stable toast id and handles non-Error payloads", () => {
    expect(toAppError(new Error("x"), "rename").id).toBe("rename:UNKNOWN:io");
    expect(toAppError(new Error("x"), "save", { resourceId: "a/b.excalidraw" }).id).toBe(
      saveErrorToastId("a/b.excalidraw"),
    );
    expect(toAppError({ code: 42 }, "delete").detail).toBe(
      "Something went wrong with file access. Try again.",
    );
  });

  it("maps serialized codes to friendly details", () => {
    expect(
      toAppError(
        {
          $isAppError: true,
          name: "Error",
          message: "gone",
          code: "NOT_FOUND",
          operation: "read",
          retryable: false,
          details: { code: "NOT_FOUND", reason: "missing-file" },
        },
        "read",
      ).detail,
    ).toBe("The file no longer exists on disk.");
    expect(
      toAppError(
        {
          $isAppError: true,
          name: "Error",
          message: "big",
          code: "TOO_LARGE",
          operation: "read",
          retryable: false,
          details: { code: "TOO_LARGE", reason: "content-too-large" },
        },
        "read",
      ).detail,
    ).toBe("The drawing exceeds the 10 MB size limit.");
    expect(
      toAppError(
        {
          $isAppError: true,
          name: "Error",
          message: "too many",
          code: "TOO_LARGE",
          operation: "load",
          retryable: false,
          details: { code: "TOO_LARGE", reason: "too-many-entries" },
        },
        "load",
      ).detail,
    ).toContain("too many files");
    expect(
      toAppError(
        {
          $isAppError: true,
          name: "Error",
          message: "Library is too large to store",
          code: "TOO_LARGE",
          operation: "unexpected",
          retryable: false,
          details: { code: "TOO_LARGE", reason: "library-too-large" },
        },
        "unexpected",
      ).detail,
    ).toContain("library");
  });

  it("maps busy and trash failures without internal prefixes", () => {
    const busy = toAppError(
      {
        $isAppError: true,
        name: "Error",
        message: "Too many pending file operations",
        code: "UNKNOWN",
        operation: "save",
        retryable: true,
        details: { code: "UNKNOWN", reason: "busy" },
      },
      "save",
    );
    expect(busy.detail).toContain("busy");
    expect(busy.detail).not.toContain("TOO_BUSY");
    expect(busy.retryable).toBe(true);
    const trash = toAppError(
      {
        $isAppError: true,
        name: "Error",
        message: "Trash is unavailable",
        code: "UNKNOWN",
        operation: "delete",
        retryable: true,
        details: { code: "UNKNOWN", reason: "trash-unavailable" },
      },
      "delete",
    );
    expect(trash.detail).toContain("trash");
  });

  it("maps invalid reasons to friendly copy and surfaces it as message", () => {
    const exists = toAppError(
      {
        $isAppError: true,
        name: "Error",
        message: "A file or folder with that name already exists",
        code: "INVALID",
        operation: "create",
        retryable: false,
        details: { code: "INVALID", reason: "exists" },
      },
      "create",
    );
    expect(exists.detail).toContain("already exists");
    expect(exists.message).toBe(exists.detail);
    expect(exists.retryable).toBe(false);
    const symlink = toAppError(
      {
        $isAppError: true,
        name: "Error",
        message: "Symlink in path",
        code: "INVALID",
        operation: "read",
        retryable: false,
        details: { code: "INVALID", reason: "symlink" },
      },
      "read",
    );
    expect(symlink.detail).toContain("outside the drawings folder");
  });

  it("maps structured details without message sniffing", () => {
    expect(
      toAppError({ details: { code: "NOT_FOUND", reason: "missing-file" } }, "read").detail,
    ).toBe("The file no longer exists on disk.");
    expect(toAppError({ details: { code: "UNKNOWN", reason: "busy" } }, "read").detail).toBe(
      "xcalidraw is busy with file changes. Wait a moment and try again.",
    );
    expect(toAppError(new Error("some raw failure"), "read").detail).toBe(
      "Something went wrong with file access. Try again.",
    );
  });

  it("covers every reason with copy", () => {
    expect(detailFor({ code: "NOT_FOUND", reason: "missing-parent" })).toContain("parent");
    expect(detailFor({ code: "NOT_FOUND", reason: "missing-root" })).toContain("drawings folder");
    expect(detailFor({ code: "TOO_LARGE", reason: "thumbnail-too-large" })).toContain("thumbnail");
    expect(detailFor({ code: "INVALID", reason: "directory-not-empty" })).toContain("not empty");
    expect(detailFor({ code: "INVALID", reason: "into-self" })).toContain("into itself");
    expect(detailFor({ code: "UNKNOWN", reason: "watcher-failed" })).toContain("disk");
    expect(detailFor({ code: "UNKNOWN", reason: "disk-full" })).toContain("disk is full");
    expect(detailFor({ code: "CANCELLED", reason: "suppressed" })).toContain("cancelled");
  });
});
