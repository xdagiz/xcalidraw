import { isRecord } from "@shared/errors";
import { net } from "electron";

import { store } from "./store";

const LIBRARIES_ORIGIN = "https://libraries.excalidraw.com";
const INDEX_TTL_MS = 10 * 60_000;
const MAX_LIBRARY_BYTES = 10 * 1024 * 1024;
const MAX_CACHED_LIBRARIES = 20;
export const MAX_ITEM_ELEMENTS = 2000;
export const MY_LIBRARY_ID = "mine";

export type LibraryInfo = {
  id: string;
  name: string;
  description: string;
  authors: string[];
  source: string;
};

export type RawLibraryItem = { name?: string; elements: unknown[] };

// .excalidrawlib v2 has named items; v1 is a bare list of element groups.
export const itemsOf = (data: unknown): RawLibraryItem[] => {
  if (!isRecord(data)) return [];
  if (Array.isArray(data.libraryItems)) {
    return data.libraryItems.filter(isRecord).map((item) => ({
      name: typeof item.name === "string" && item.name.trim() ? item.name : undefined,
      elements: Array.isArray(item.elements) ? item.elements : [],
    }));
  }
  if (Array.isArray(data.library)) {
    return data.library.filter(Array.isArray).map((elements) => ({ elements }));
  }
  return [];
};

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

// v1 items have no names, so their text is the best hint of what they are.
export const summarizeItem = (item: RawLibraryItem, index: number) => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const labels: string[] = [];
  for (const element of item.elements) {
    if (!isRecord(element) || element.isDeleted === true) continue;
    const x = num(element.x);
    const y = num(element.y);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + num(element.width));
    maxY = Math.max(maxY, y + num(element.height));
    if (element.type === "text" && typeof element.text === "string" && labels.length < 5) {
      labels.push(element.text.slice(0, 40));
    }
  }
  return {
    index,
    ...(item.name && { name: item.name }),
    ...(labels.length > 0 && { labels }),
    width: Number.isFinite(maxX) ? Math.round(maxX - minX) : 0,
    height: Number.isFinite(maxY) ? Math.round(maxY - minY) : 0,
    elementCount: item.elements.length,
  };
};

export const parseIndex = (data: unknown): LibraryInfo[] =>
  (Array.isArray(data) ? data : []).filter(isRecord).flatMap((entry) =>
    typeof entry.id === "string" &&
    typeof entry.name === "string" &&
    typeof entry.source === "string"
      ? [
          {
            id: entry.id,
            name: entry.name,
            description: typeof entry.description === "string" ? entry.description : "",
            authors: (Array.isArray(entry.authors) ? entry.authors : []).flatMap((author) =>
              isRecord(author) && typeof author.name === "string" ? [author.name] : [],
            ),
            source: entry.source,
          },
        ]
      : [],
  );

export const searchIndex = (libraries: LibraryInfo[], query: string, limit = 20) => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return libraries.slice(0, limit);
  return libraries
    .map((library) => {
      const name = library.name.toLowerCase();
      const rest = `${library.description} ${library.authors.join(" ")}`.toLowerCase();
      const score = words.reduce(
        (sum, word) => sum + (name.includes(word) ? 3 : 0) + (rest.includes(word) ? 1 : 0),
        0,
      );
      return { library, score };
    })
    .filter(({ score }) => score > 0)
    .toSorted((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ library }) => library);
};

const fetchJson = async (path: string) => {
  const url = new URL(path, `${LIBRARIES_ORIGIN}/`);
  if (url.origin !== LIBRARIES_ORIGIN) throw new Error("Libraries only load from excalidraw.com.");
  const response = await net.fetch(url.toString());
  if (!response.ok) throw new Error(`Couldn't load ${url.pathname} (${response.status}).`);
  const body = await response.text();
  if (body.length > MAX_LIBRARY_BYTES) throw new Error("That library is too large to load.");
  return JSON.parse(body) as unknown;
};

let indexCache: { at: number; libraries: LibraryInfo[] } | null = null;
const libraryCache = new Map<string, RawLibraryItem[]>();

export const getLibraryIndex = async () => {
  if (indexCache && Date.now() - indexCache.at < INDEX_TTL_MS) return indexCache.libraries;
  const libraries = parseIndex(await fetchJson("libraries.json"));
  indexCache = { at: Date.now(), libraries };
  return libraries;
};

const myLibraryItems = (): RawLibraryItem[] => {
  const raw = store.get("libraryItems");
  if (typeof raw !== "string") return [];
  try {
    return itemsOf({ libraryItems: JSON.parse(raw) as unknown });
  } catch {
    return [];
  }
};

export const getLibraryItems = async (id: string) => {
  if (id === MY_LIBRARY_ID) return { name: "My library", items: myLibraryItems() };

  const info = (await getLibraryIndex()).find((library) => library.id === id);
  if (!info) throw new Error(`No library with id ${JSON.stringify(id)}. Use search_libraries.`);

  let items = libraryCache.get(id);
  if (!items) {
    items = itemsOf(await fetchJson(`libraries/${info.source}`));
    libraryCache.set(id, items);
    // ponytail: insertion-order eviction, a real LRU if agents hop between many libraries.
    if (libraryCache.size > MAX_CACHED_LIBRARIES) {
      const oldest = libraryCache.keys().next().value;
      if (oldest !== undefined) libraryCache.delete(oldest);
    }
  }
  return { name: info.name, items };
};
