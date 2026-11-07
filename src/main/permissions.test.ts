import { describe, expect, it } from "vite-plus/test";

import {
  APP_ALLOWED_PERMISSIONS,
  ORIGIN_SCOPED_PERMISSIONS,
  UNATTRIBUTED_PERMISSIONS,
  isOriginScopedPermission,
  isUnattributedAccessGranted,
  isUnattributedPermission,
} from "./permissions";

const trustedOrigin = "app://renderer";
const isTrustedOrigin = (origin: string) => origin === trustedOrigin;

describe("permission groups", () => {
  it("allows the permissions the editor relies on", () => {
    expect(isOriginScopedPermission("fullscreen")).toBe(true);
    expect(isOriginScopedPermission("clipboard-read")).toBe(true);
    expect(isOriginScopedPermission("clipboard-sanitized-write")).toBe(true);
  });

  it("treats fileSystem as unattributed, not origin scoped", () => {
    expect(isUnattributedPermission("fileSystem")).toBe(true);
    expect(isOriginScopedPermission("fileSystem")).toBe(false);
  });

  it("grants fileSystem writes only for a trusted origin", () => {
    expect(
      isUnattributedAccessGranted(
        "fileSystem",
        { fileAccessType: "writable", requestingOrigin: trustedOrigin },
        isTrustedOrigin,
      ),
    ).toBe(true);

    expect(
      isUnattributedAccessGranted(
        "fileSystem",
        { fileAccessType: "writable", requestingOrigin: "https://evil.example" },
        isTrustedOrigin,
      ),
    ).toBe(false);

    expect(
      isUnattributedAccessGranted(
        "fileSystem",
        { fileAccessType: "writable", requestingOrigin: "" },
        isTrustedOrigin,
      ),
    ).toBe(false);

    expect(
      isUnattributedAccessGranted("fileSystem", { fileAccessType: "writable" }, isTrustedOrigin),
    ).toBe(false);
  });

  it("grants fileSystem writes but keeps reads denied", () => {
    expect(
      isUnattributedAccessGranted(
        "fileSystem",
        { fileAccessType: "writable", requestingOrigin: trustedOrigin },
        isTrustedOrigin,
      ),
    ).toBe(true);
    expect(
      isUnattributedAccessGranted(
        "fileSystem",
        { fileAccessType: "readable", requestingOrigin: trustedOrigin },
        isTrustedOrigin,
      ),
    ).toBe(false);
    expect(
      isUnattributedAccessGranted(
        "fileSystem",
        { fileAccessType: "readwrite", requestingOrigin: trustedOrigin },
        isTrustedOrigin,
      ),
    ).toBe(false);
    expect(
      isUnattributedAccessGranted(
        "fileSystem",
        { requestingOrigin: trustedOrigin },
        isTrustedOrigin,
      ),
    ).toBe(false);
    expect(
      isUnattributedAccessGranted(
        "media",
        { fileAccessType: "writable", requestingOrigin: trustedOrigin },
        isTrustedOrigin,
      ),
    ).toBe(false);
  });

  it("denies everything else", () => {
    for (const permission of [
      "geolocation",
      "media",
      "notifications",
      "openExternal",
      "serial",
      "usb",
      "hid",
      "midi",
      "display-capture",
      "idle-detection",
      "window-management",
      "",
    ]) {
      expect(isOriginScopedPermission(permission)).toBe(false);
      expect(isUnattributedPermission(permission)).toBe(false);
      expect(APP_ALLOWED_PERMISSIONS.has(permission)).toBe(false);
    }
  });

  it("keeps the allow-list small and explicit", () => {
    expect([...APP_ALLOWED_PERMISSIONS].toSorted()).toEqual([
      "clipboard-read",
      "clipboard-sanitized-write",
      "fileSystem",
      "fullscreen",
    ]);
    expect([...ORIGIN_SCOPED_PERMISSIONS].toSorted()).toEqual([
      "clipboard-read",
      "clipboard-sanitized-write",
      "fullscreen",
    ]);
    expect([...UNATTRIBUTED_PERMISSIONS].toSorted()).toEqual(["fileSystem"]);
  });
});
