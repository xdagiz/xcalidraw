import type { UpdateStatus } from "@shared/ipc";

export type UpdateCheckTrigger = "boot" | "interval" | "manual";

export type CompletedUpdateCheckInput = {
  readonly stagedVersion: string | null;
  readonly declinedVersion: string | null;
  readonly trigger: UpdateCheckTrigger;
  readonly updateAvailable: boolean;
  readonly availableVersion: string | null;
};

export type DownloadedUpdateInput = {
  readonly stagedVersion: string | null;
  readonly declinedVersion: string | null;
  readonly incomingVersion: string;
  readonly trigger: UpdateCheckTrigger;
};

export type DownloadedUpdatePlan = {
  readonly stagedVersion: string;
  readonly declinedVersion: string | null;
  readonly status: UpdateStatus;
  readonly promptVersion: string | null;
};

const parseCoreParts = (core: string) => {
  if (!core) return null;
  const raw = core.split(".");
  const parts: number[] = [];

  for (const item of raw) {
    if (!/^\d+$/.test(item)) return null;
    const value = Number.parseInt(item, 10);
    if (!Number.isSafeInteger(value) || value < 0) return null;
    parts.push(value);
  }

  return parts;
};

const parsePrerelease = (pre: string | null) => {
  if (pre === null) return null;
  if (!pre) return undefined;

  const ids = pre.split(".");
  const out: (string | number)[] = [];
  for (const id of ids) {
    if (!id || !/^[0-9A-Za-z-]+$/.test(id)) return undefined;
    out.push(/^\d+$/.test(id) ? Number.parseInt(id, 10) : id);
  }

  return out;
};

const parseVersion = (version: string) => {
  const trimmed = version.trim();
  if (!trimmed) return null;

  const withoutV = /^v(?=\d)/i.test(trimmed) ? trimmed.slice(1) : trimmed;
  const withoutBuild = withoutV.split("+", 1)[0] ?? "";
  if (!withoutBuild) return null;

  const dash = withoutBuild.indexOf("-");
  const coreStr = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash);
  const preStr = dash === -1 ? null : withoutBuild.slice(dash + 1);
  const parts = parseCoreParts(coreStr);
  if (!parts) return null;

  const pre = parsePrerelease(preStr);
  if (pre === undefined) return null;
  return { parts, pre };
};

const comparePrerelease = (
  left: readonly (string | number)[],
  right: readonly (string | number)[],
) => {
  const length = Math.max(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    const l = left[index];
    const r = right[index];

    if (l === undefined) return -1;
    if (r === undefined) return 1;

    if (typeof l === "number" && typeof r === "number") {
      if (l !== r) return l > r ? 1 : -1;
      continue;
    }

    if (typeof l === "string" && typeof r === "string") {
      if (l !== r) return l > r ? 1 : -1;
      continue;
    }

    return typeof l === "number" ? -1 : 1;
  }

  return 0;
};

export const compareUpdateVersions = (left: string, right: string) => {
  const l = parseVersion(left);
  const r = parseVersion(right);
  if (!l || !r) return null;

  const length = Math.max(l.parts.length, r.parts.length);
  for (let index = 0; index < length; index += 1) {
    const a = l.parts[index] ?? 0;
    const b = r.parts[index] ?? 0;
    if (a !== b) return a > b ? 1 : -1;
  }

  if (l.pre === null && r.pre === null) return 0;
  if (l.pre === null) return 1;
  if (r.pre === null) return -1;

  return comparePrerelease(l.pre, r.pre);
};

export const isSameUpdateVersion = (left: string, right: string) => {
  const comparison = compareUpdateVersions(left, right);
  return comparison === null ? left === right : comparison === 0;
};

export const planAvailableUpdate = (stagedVersion: string | null, availableVersion: string) => {
  if (stagedVersion) {
    const comparison = compareUpdateVersions(availableVersion, stagedVersion);
    if (comparison !== null && comparison <= 0) {
      return { state: "downloaded", version: stagedVersion } as const;
    }
    if (comparison === null && availableVersion === stagedVersion) {
      return { state: "downloaded", version: stagedVersion } as const;
    }
  }

  return { state: "available", version: availableVersion } as const;
};

const isNewerUpdateVersion = (incomingVersion: string, declinedVersion: string) => {
  const comparison = compareUpdateVersions(incomingVersion, declinedVersion);
  return comparison === null ? incomingVersion !== declinedVersion : comparison > 0;
};

export const planCompletedUpdateCheck = (input: CompletedUpdateCheckInput) => {
  if (input.trigger !== "manual" || !input.stagedVersion) return { promptVersion: null };
  if (input.declinedVersion && isSameUpdateVersion(input.stagedVersion, input.declinedVersion)) {
    return { promptVersion: null };
  }

  if (!input.updateAvailable) return { promptVersion: input.stagedVersion };
  if (!input.availableVersion) return { promptVersion: null };

  const comparison = compareUpdateVersions(input.availableVersion, input.stagedVersion);
  if (comparison === null) {
    return {
      promptVersion: isSameUpdateVersion(input.availableVersion, input.stagedVersion)
        ? input.stagedVersion
        : null,
    };
  }

  return { promptVersion: comparison <= 0 ? input.stagedVersion : null };
};

export const planDownloadedUpdate = (input: DownloadedUpdateInput): DownloadedUpdatePlan => {
  if (input.stagedVersion && !isSameUpdateVersion(input.incomingVersion, input.stagedVersion)) {
    const stagedComparison = compareUpdateVersions(input.incomingVersion, input.stagedVersion);
    if (stagedComparison !== null && stagedComparison < 0) {
      return {
        stagedVersion: input.stagedVersion,
        declinedVersion: input.declinedVersion,
        status: { state: "downloaded", version: input.stagedVersion },
        promptVersion: null,
      };
    }

    if (stagedComparison === null && input.incomingVersion !== input.stagedVersion) {
      return {
        stagedVersion: input.stagedVersion,
        declinedVersion: input.declinedVersion,
        status: { state: "downloaded", version: input.stagedVersion },
        promptVersion: null,
      };
    }
  }

  const prompt =
    input.trigger === "manual" ||
    !input.declinedVersion ||
    isNewerUpdateVersion(input.incomingVersion, input.declinedVersion);

  return {
    stagedVersion: input.incomingVersion,
    declinedVersion: input.declinedVersion,
    status: { state: "downloaded", version: input.incomingVersion },
    promptVersion: prompt ? input.incomingVersion : null,
  };
};

export const statusAfterUpdateError = (status: UpdateStatus, message: string): UpdateStatus => {
  if (status.state === "idle") return status;
  if (status.state === "downloaded") return status;
  if (status.state === "installing") return { state: "downloaded", version: status.version };
  if (status.state === "error" && status.message === message) return status;
  return { state: "error", version: status.version, message };
};
