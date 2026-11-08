import { MAX_DRAWING_CONTENT_BYTES, validateDrawingRecord } from "@shared/ipc";

export const MAX_DROP_FILES = 50;

const SCENE_EXTENSION = ".excalidraw";
const JSON_EXTENSION_PATTERN = /\.json$/i;

export type DroppedFile = {
  name: string;
  text: () => Promise<string>;
};

export type SceneDraft = {
  name: string;
  content: string;
};

export type DropRejection = {
  name: string;
  reason: string;
};

export type DropParseResult = {
  drafts: SceneDraft[];
  rejected: DropRejection[];
};

export const isSceneFile = (name: string) => /\.excalidraw$/i.test(name.trim());

const isSceneCandidate = (name: string) => {
  const trimmed = name.trim();
  return isSceneFile(trimmed) || JSON_EXTENSION_PATTERN.test(trimmed);
};

export const sceneFileName = (name: string) => {
  const stem = name
    .trim()
    .replace(/\.excalidraw$/i, "")
    .replace(JSON_EXTENSION_PATTERN, "")
    .trim();
  return `${stem || "Untitled"}${SCENE_EXTENSION}`;
};

export const uniqueImportName = (taken: readonly string[], name: string) => {
  const siblings = new Set(taken);
  if (!siblings.has(name)) return name;

  const stem = name.replace(/\.excalidraw$/i, "");
  for (let index = 1; ; index += 1) {
    const candidate = `${stem} copy${index === 1 ? "" : ` ${index}`}${SCENE_EXTENSION}`;
    if (!siblings.has(candidate)) return candidate;
  }
};

const isSceneRecord = (value: unknown) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as { type?: unknown; elements?: unknown };
  return record.type === "excalidraw" || Array.isArray(record.elements);
};

export const readSceneDraft = (name: string, text: string): SceneDraft | DropRejection => {
  if (new TextEncoder().encode(text).length > MAX_DRAWING_CONTENT_BYTES) {
    return { name, reason: "Drawing is too large to import" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { name, reason: "Not a valid drawing file" };
  }

  try {
    validateDrawingRecord(parsed);
  } catch (error) {
    return {
      name,
      reason: error instanceof Error ? error.message : "Not a valid drawing file",
    };
  }

  if (!isSceneRecord(parsed)) return { name, reason: "Not a valid drawing file" };

  return { name: sceneFileName(name), content: text };
};

export const isDropRejection = (value: SceneDraft | DropRejection): value is DropRejection =>
  "reason" in value;

export const readDroppedScenes = async (
  files: readonly DroppedFile[],
): Promise<DropParseResult> => {
  const drafts: SceneDraft[] = [];
  const rejected: DropRejection[] = [];
  const accepted = files.slice(0, MAX_DROP_FILES);

  for (const file of files.slice(MAX_DROP_FILES)) {
    rejected.push({
      name: file.name,
      reason: `Only the first ${MAX_DROP_FILES} files are imported`,
    });
  }

  for (const file of accepted) {
    if (!isSceneCandidate(file.name)) {
      rejected.push({ name: file.name, reason: "Only .excalidraw files can be imported" });
      continue;
    }

    let text: string;
    try {
      text = await file.text();
    } catch {
      rejected.push({ name: file.name, reason: "Couldn’t read the file" });
      continue;
    }

    const result = readSceneDraft(file.name, text);
    if (isDropRejection(result)) {
      rejected.push(result);
      continue;
    }
    drafts.push(result);
  }

  return { drafts, rejected };
};
