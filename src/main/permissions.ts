export type FileAccessType = "readable" | "writable" | "readwrite";

export const ORIGIN_SCOPED_PERMISSIONS: ReadonlySet<string> = new Set([
  "fullscreen",
  "clipboard-read",
  "clipboard-sanitized-write",
]);

export const UNATTRIBUTED_PERMISSIONS: ReadonlySet<string> = new Set(["fileSystem"]);

export const isOriginScopedPermission = (permission: string): boolean =>
  ORIGIN_SCOPED_PERMISSIONS.has(permission);

export const isUnattributedPermission = (permission: string): boolean =>
  UNATTRIBUTED_PERMISSIONS.has(permission);

export const isUnattributedAccessGranted = (
  permission: string,
  access: { fileAccessType?: FileAccessType; requestingOrigin?: string },
  isTrustedOrigin: (origin: string) => boolean,
): boolean =>
  isUnattributedPermission(permission) &&
  access.fileAccessType === "writable" &&
  typeof access.requestingOrigin === "string" &&
  access.requestingOrigin !== "" &&
  isTrustedOrigin(access.requestingOrigin);

export const APP_ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set([
  ...ORIGIN_SCOPED_PERMISSIONS,
  ...UNATTRIBUTED_PERMISSIONS,
]);
