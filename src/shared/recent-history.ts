export const RECENT_FILE_LIMIT = 12;

export type RecentFileHistory = {
  rootPath: string;
  ids: string[];
};

export const parseRecentFileHistory = (value: unknown): RecentFileHistory | null => {
  if (typeof value !== "string") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  if (!("rootPath" in parsed) || !("ids" in parsed)) return null;

  const rootPath = parsed.rootPath;
  const rawIds = parsed.ids;
  if (typeof rootPath !== "string" || rootPath.length === 0) return null;
  if (!Array.isArray(rawIds)) return null;

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const id of rawIds) {
    if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length === RECENT_FILE_LIMIT) break;
  }

  return { rootPath, ids };
};

export const serializeRecentFileHistory = (rootPath: string | null, ids: string[]) => {
  if (!rootPath) return null;

  const seen = new Set<string>();
  const recentIds: string[] = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    recentIds.push(id);
    if (recentIds.length === RECENT_FILE_LIMIT) break;
  }

  return JSON.stringify({ rootPath, ids: recentIds });
};

export const recentFileIdsForRoot = (value: unknown, rootPath: string | null) => {
  if (!rootPath) return [];
  const history = parseRecentFileHistory(value);
  return history?.rootPath === rootPath ? history.ids : [];
};
