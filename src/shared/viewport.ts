import { isRecord } from "./errors";

export type Viewport = {
  scrollX: number;
  scrollY: number;
  zoom: number;
};

export type PersistedViewport = {
  rootPath: string;
  fileId: string;
  viewport: Viewport;
  updatedAt: number;
};

export type ViewportStore = {
  version: 1;
  entries: PersistedViewport[];
};

export const MAX_VIEWPORT_ENTRIES = 200;
export const MAX_VIEWPORT_STORE_BYTES = 1024 * 1024;
export const MIN_VIEWPORT_ZOOM = 0.1;
export const MAX_VIEWPORT_ZOOM = 30;
const MAX_VIEWPORT_SCROLL = Number.MAX_SAFE_INTEGER;

export const viewportKey = (rootPath: string | null, fileId: string) =>
  JSON.stringify([rootPath, fileId]);

export const isValidViewport = (value: unknown): value is Viewport => {
  if (!isRecord(value)) return false;
  const { scrollX, scrollY, zoom } = value;
  return (
    typeof scrollX === "number" &&
    Number.isFinite(scrollX) &&
    Math.abs(scrollX) <= MAX_VIEWPORT_SCROLL &&
    typeof scrollY === "number" &&
    Number.isFinite(scrollY) &&
    Math.abs(scrollY) <= MAX_VIEWPORT_SCROLL &&
    typeof zoom === "number" &&
    Number.isFinite(zoom) &&
    zoom >= MIN_VIEWPORT_ZOOM &&
    zoom <= MAX_VIEWPORT_ZOOM
  );
};

export const viewportStoreFrom = (value: unknown): ViewportStore | null => {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.entries)) return null;

  const candidates: readonly unknown[] = parsed.entries;
  if (candidates.length > MAX_VIEWPORT_ENTRIES) return null;

  const entries: PersistedViewport[] = [];
  const keys = new Set<string>();
  for (const candidate of candidates) {
    if (!isRecord(candidate)) return null;
    const { rootPath, fileId, viewport, updatedAt } = candidate;
    if (
      typeof rootPath !== "string" ||
      rootPath.length === 0 ||
      typeof fileId !== "string" ||
      fileId.length === 0 ||
      !isValidViewport(viewport) ||
      typeof updatedAt !== "number" ||
      !Number.isFinite(updatedAt) ||
      updatedAt < 0
    ) {
      return null;
    }

    const key = viewportKey(rootPath, fileId);
    if (keys.has(key)) return null;
    keys.add(key);
    entries.push({ rootPath, fileId, viewport: { ...viewport }, updatedAt });
  }

  return { version: 1, entries };
};
