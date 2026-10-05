export type ErrorOperation =
  | "folder"
  | "load"
  | "read"
  | "save"
  | "recover"
  | "rename"
  | "create"
  | "delete"
  | "move"
  | "copy"
  | "settings"
  | "unexpected";

export type ErrorCode = "NOT_FOUND" | "TOO_LARGE" | "INVALID" | "CANCELLED" | "UNKNOWN";

export type ErrorDetails =
  | {
      code: "NOT_FOUND";
      reason: "missing-file" | "missing-parent" | "missing-root" | "missing-thumbnail";
    }
  | {
      code: "TOO_LARGE";
      reason:
        | "too-many-entries"
        | "too-many-ids"
        | "content-too-large"
        | "file-too-large"
        | "library-too-large"
        | "thumbnail-too-large";
      limit?: number;
    }
  | {
      code: "INVALID";
      reason:
        | "exists"
        | "bad-name"
        | "bad-extension"
        | "bad-path"
        | "symlink"
        | "hardlink"
        | "outside-root"
        | "invalid-json"
        | "invalid-record"
        | "invalid-arg"
        | "into-self"
        | "is-directory"
        | "directory-not-empty"
        | "invalid-payload";
      field?: string;
    }
  | {
      code: "UNKNOWN";
      reason:
        | "busy"
        | "lock-conflict"
        | "trash-unavailable"
        | "permission-denied"
        | "disk-full"
        | "io"
        | "watcher-failed"
        | "port-in-use";
    }
  | { code: "CANCELLED"; reason: "user-cancelled" | "suppressed" };

export type CodedError = Error & {
  code: ErrorCode;
  details: ErrorDetails;
  operation?: ErrorOperation;
};

export interface SerializedAppError {
  readonly $isAppError: true;
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly code: ErrorCode;
  readonly operation: ErrorOperation;
  readonly retryable: boolean;
  readonly details: ErrorDetails;
  readonly cause?: SerializedAppError;
}

export type RendererSafeError = Pick<
  SerializedAppError,
  "$isAppError" | "name" | "message" | "code" | "operation" | "retryable" | "details"
>;

const IPC_PREFIX_PATTERN = /^Error invoking remote method ("[^"]+"|'[^']+'): (Error: )?/;

const ERROR_CODES: ReadonlySet<string> = new Set([
  "NOT_FOUND",
  "TOO_LARGE",
  "INVALID",
  "CANCELLED",
  "UNKNOWN",
]);

const ERROR_OPERATIONS: ReadonlySet<string> = new Set([
  "folder",
  "load",
  "read",
  "save",
  "recover",
  "rename",
  "create",
  "delete",
  "move",
  "copy",
  "settings",
  "unexpected",
]);

const INVALID_REASONS: ReadonlySet<string> = new Set([
  "exists",
  "bad-name",
  "bad-extension",
  "bad-path",
  "symlink",
  "hardlink",
  "outside-root",
  "invalid-json",
  "invalid-record",
  "invalid-arg",
  "into-self",
  "is-directory",
  "directory-not-empty",
  "invalid-payload",
]);

const NOT_FOUND_REASONS: ReadonlySet<string> = new Set([
  "missing-file",
  "missing-parent",
  "missing-root",
  "missing-thumbnail",
]);

const TOO_LARGE_REASONS: ReadonlySet<string> = new Set([
  "too-many-entries",
  "too-many-ids",
  "content-too-large",
  "file-too-large",
  "library-too-large",
  "thumbnail-too-large",
]);

const UNKNOWN_REASONS: ReadonlySet<string> = new Set([
  "busy",
  "lock-conflict",
  "trash-unavailable",
  "permission-denied",
  "disk-full",
  "io",
  "watcher-failed",
  "port-in-use",
]);

const CANCELLED_REASONS: ReadonlySet<string> = new Set(["user-cancelled", "suppressed"]);

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const errorCodeOf = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null) return undefined;
  if (!("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
};

const normalizeMessage = (value: string) => {
  const cleaned = value.replace(IPC_PREFIX_PATTERN, "");
  return cleaned.trim();
};

export const cleanErrorMessage = (error: unknown) => {
  if (isSerializedAppError(error)) {
    const cleaned = normalizeMessage(error.message);
    return cleaned ? cleaned : "Unknown error";
  }

  let message = "";
  if (error instanceof Error) {
    message = error.message;
  } else if (typeof error === "string") {
    message = error;
  } else if (isRecord(error) && typeof error.message === "string") {
    message = error.message;
  }

  const cleaned = normalizeMessage(message);
  return cleaned ? cleaned : "Unknown error";
};

export const isErrorDetails = (value: unknown): value is ErrorDetails => {
  if (!isRecord(value)) return false;
  if (typeof value.code !== "string" || typeof value.reason !== "string") return false;
  if (value.code === "NOT_FOUND") return NOT_FOUND_REASONS.has(value.reason);
  if (value.code === "TOO_LARGE") return TOO_LARGE_REASONS.has(value.reason);
  if (value.code === "INVALID") return INVALID_REASONS.has(value.reason);
  if (value.code === "UNKNOWN") return UNKNOWN_REASONS.has(value.reason);
  if (value.code === "CANCELLED") return CANCELLED_REASONS.has(value.reason);
  return false;
};

export const isSerializedAppError = (value: unknown): value is SerializedAppError => {
  if (!isRecord(value)) return false;
  if (value.$isAppError !== true) return false;
  if (typeof value.message !== "string") return false;
  if (typeof value.name !== "string") return false;
  if (typeof value.code !== "string" || !ERROR_CODES.has(value.code)) return false;
  if (typeof value.retryable !== "boolean") return false;
  if (typeof value.operation !== "string" || !ERROR_OPERATIONS.has(value.operation)) return false;
  if (!isErrorDetails(value.details)) return false;
  return true;
};

export const isRendererSafeError = (value: unknown): value is RendererSafeError => {
  if (!isSerializedAppError(value)) return false;
  return !("stack" in value) && !("cause" in value);
};

const systemDetailsFor = (code: string): ErrorDetails | null => {
  const upper = code.toUpperCase();
  if (upper === "ENOENT") return { code: "NOT_FOUND", reason: "missing-file" };
  if (upper === "EFBIG") return { code: "TOO_LARGE", reason: "file-too-large" };
  if (upper === "EINVAL") return { code: "INVALID", reason: "invalid-arg" };
  if (upper === "ECANCELED" || upper === "ECANCELLED")
    return { code: "CANCELLED", reason: "user-cancelled" };
  if (upper === "EACCES" || upper === "EPERM")
    return { code: "UNKNOWN", reason: "permission-denied" };
  if (upper === "ENOSPC") return { code: "UNKNOWN", reason: "disk-full" };
  if (upper === "ELOOP" || upper === "ENOTDIR") return { code: "INVALID", reason: "outside-root" };
  if (upper === "EISDIR") return { code: "INVALID", reason: "is-directory" };
  if (upper === "EEXIST") return { code: "INVALID", reason: "exists" };
  if (upper === "ENOTEMPTY") return { code: "INVALID", reason: "directory-not-empty" };
  return null;
};

export const normalizeSystemError = (error: unknown): ErrorDetails | null => {
  if (!isRecord(error) || typeof error.code !== "string") return null;
  return systemDetailsFor(error.code);
};

export const isRetryableDetails = (details: ErrorDetails): boolean => {
  return details.code === "UNKNOWN";
};

export const isNotFoundError = (error: unknown): boolean => {
  if (isSerializedAppError(error) || isRendererSafeError(error)) {
    return error.details.code === "NOT_FOUND";
  }
  if (isRecord(error) && isErrorDetails(error.details)) {
    return error.details.code === "NOT_FOUND";
  }
  return false;
};

export const codedError = (
  message: string,
  details: ErrorDetails,
  opts?: { operation?: ErrorOperation; cause?: unknown },
): CodedError => {
  return Object.assign(new Error(message), {
    code: details.code,
    details,
    ...(opts?.operation === undefined ? {} : { operation: opts.operation }),
    ...(opts?.cause === undefined ? {} : { cause: opts.cause }),
  });
};

const getDetails = (error: unknown): ErrorDetails => {
  if (isRecord(error) && isErrorDetails(error.details)) return error.details;
  const system = normalizeSystemError(error);
  if (system) return system;
  return { code: "UNKNOWN", reason: "io" };
};

const getStack = (error: unknown) => {
  if (isRecord(error) && typeof error.stack === "string" && error.stack.length > 0) {
    return error.stack;
  }

  return undefined;
};

const getCause = (error: unknown) => {
  if (isRecord(error) && "cause" in error) return error.cause;
  return undefined;
};

export const toRendererSafe = (error: SerializedAppError): RendererSafeError => ({
  $isAppError: true,
  name: error.name,
  message: error.message,
  code: error.code,
  operation: error.operation,
  retryable: error.retryable,
  details: error.details,
});

export const toSerialized = (error: unknown, operation: ErrorOperation): SerializedAppError => {
  if (isSerializedAppError(error)) {
    return {
      $isAppError: true,
      name: error.name,
      message: error.message,
      stack: error.stack,
      code: error.code,
      operation,
      retryable: isRetryableDetails(error.details),
      details: error.details,
      cause: error.cause,
    };
  }

  const message = cleanErrorMessage(error);
  const stack = getStack(error);
  const details = getDetails(error);
  const causeRaw = getCause(error);
  let name = "Error";

  if (isRecord(error) && typeof error.name === "string" && error.name.length > 0) name = error.name;
  let cause: SerializedAppError | undefined;
  if (causeRaw instanceof Error || isSerializedAppError(causeRaw) || typeof causeRaw === "string") {
    if (causeRaw instanceof Error || typeof causeRaw === "string") {
      cause = toSerialized(causeRaw, operation);
    } else {
      cause = { ...causeRaw, operation, retryable: isRetryableDetails(causeRaw.details) };
    }
  }

  return {
    $isAppError: true,
    name,
    message,
    stack,
    code: details.code,
    operation,
    retryable: isRetryableDetails(details),
    details,
    cause,
  };
};

export const assertNever = (value: never): never => {
  throw new Error(`Unhandled value: ${JSON.stringify(value)}`);
};
