import {
  assertNever,
  isErrorDetails,
  isRecord,
  isRendererSafeError,
  isRetryableDetails,
  isSerializedAppError,
} from "@shared/errors";
import type { ErrorDetails, ErrorOperation } from "@shared/errors";

export type AppError = {
  id: string;
  operation: ErrorOperation;
  title: string;
  message: string;
  retryable: boolean;
  detail: string;
  code: ErrorDetails["code"];
  reason: ErrorDetails["reason"];
  details: ErrorDetails;
};

const messageFor = (operation: ErrorOperation): Pick<AppError, "title" | "message"> => {
  if (operation === "folder") {
    return {
      title: "Couldn’t use that folder",
      message: "Pick a different folder, or choose one with fewer files in it.",
    };
  }

  if (operation === "read" || operation === "load") {
    return {
      title: "Couldn’t open this drawing",
      message: "The file may be unavailable, invalid, or too large to open.",
    };
  }

  if (operation === "save" || operation === "recover") {
    return {
      title:
        operation === "recover" ? "Couldn’t recover this drawing" : "Couldn’t save this drawing",
      message:
        "Your latest edits are still open in xcalidraw. Check that the drawings folder is available and try again.",
    };
  }

  if (operation === "rename") {
    return {
      title: "Couldn’t rename this drawing",
      message: "Check that the folder is available and try again.",
    };
  }

  if (operation === "create") {
    return {
      title: "Couldn’t create this drawing",
      message: "Check that the drawings folder is available and try again.",
    };
  }

  if (operation === "delete") {
    return {
      title: "Couldn’t delete this drawing",
      message: "Try again after checking folder access.",
    };
  }

  if (operation === "settings") {
    return { title: "Couldn’t update settings", message: "Your change was not saved. Try again." };
  }

  return {
    title: "Something went wrong",
    message: "Try again. If this keeps happening, copy the details for support.",
  };
};

export const saveErrorToastId = (fileId: string) => `save:${fileId}`;
export const libraryErrorToastId = "library:save";

const displayDetailsFor = (error: unknown): ErrorDetails => {
  if (isRendererSafeError(error) || isSerializedAppError(error)) return error.details;
  if (isRecord(error) && isErrorDetails(error["details"])) return error["details"];
  return { code: "UNKNOWN", reason: "io" };
};

export const detailFor = (details: ErrorDetails): string => {
  if (details.code === "NOT_FOUND") {
    if (details.reason === "missing-file") return "The file no longer exists on disk.";
    if (details.reason === "missing-parent") return "The parent folder no longer exists on disk.";
    if (details.reason === "missing-root")
      return "The drawings folder is unavailable. Choose the folder again.";
    return "The thumbnail could not be loaded because the file is missing.";
  }
  if (details.code === "TOO_LARGE") {
    if (details.reason === "too-many-entries")
      return "The drawings folder has too many files to list safely. Choose a smaller folder.";
    if (details.reason === "too-many-ids")
      return "Too many drawings were requested at once. Try again with fewer selected.";
    if (details.reason === "library-too-large")
      return "The library is too large to store. Remove unused items and try again.";
    if (details.reason === "thumbnail-too-large") return "The thumbnail is too large to store.";
    return "The drawing exceeds the 10 MB size limit.";
  }
  if (details.code === "INVALID") {
    if (details.reason === "exists") return "A file or folder with that name already exists.";
    if (details.reason === "bad-name" || details.reason === "bad-path")
      return "That name cannot be used. Use letters and numbers without leading dots or slashes.";
    if (details.reason === "bad-extension")
      return "That name cannot be used because folders cannot end with .excalidraw.";
    if (details.reason === "symlink" || details.reason === "outside-root")
      return "This item cannot be used because it links outside the drawings folder.";
    if (details.reason === "hardlink")
      return "This item cannot be used because linked files are not allowed in the drawings folder.";
    if (details.reason === "invalid-json" || details.reason === "invalid-record")
      return "This file is not a valid drawing and cannot be opened.";
    if (details.reason === "is-directory")
      return "This item is a folder and cannot be opened as a drawing.";
    if (details.reason === "directory-not-empty") return "This folder is not empty.";
    return "Your change was not saved because it was invalid. Try again.";
  }
  if (details.code === "UNKNOWN") {
    if (details.reason === "busy" || details.reason === "lock-conflict")
      return "xcalidraw is busy with file changes. Wait a moment and try again.";
    if (details.reason === "trash-unavailable")
      return "The system trash is unavailable. Check permissions and try again.";
    if (details.reason === "permission-denied")
      return "The drawings folder or file is not writable.";
    if (details.reason === "disk-full") return "The disk is full. Free up space and try again.";
    if (details.reason === "port-in-use")
      return "Another app is using the agent port. Close it and try again.";
    if (details.reason === "watcher-failed")
      return "Changes on disk may not appear. Try reopening the folder.";
    return "Something went wrong with file access. Try again.";
  }
  if (details.code === "CANCELLED") return "The operation was cancelled.";
  return assertNever(details);
};

export const toAppError = (
  error: unknown,
  operation: ErrorOperation = "unexpected",
  opts?: { resourceId?: string },
): AppError => {
  const details = displayDetailsFor(error);
  const detail = detailFor(details);
  return {
    id: opts?.resourceId
      ? `${operation}:${opts.resourceId}`
      : `${operation}:${details.code}:${details.reason}`,
    operation,
    retryable: isRetryableDetails(details),
    detail,
    ...messageFor(operation),
    ...(details.code === "INVALID" ? { message: detail } : {}),
    code: details.code,
    reason: details.reason,
    details,
  };
};
