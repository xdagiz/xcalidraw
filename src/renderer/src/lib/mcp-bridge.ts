import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import type { ElementUpdate } from "@excalidraw/excalidraw/element/mutateElement";
import type {
  ExcalidrawElement,
  OrderedExcalidrawElement,
} from "@excalidraw/excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { isRecord } from "@shared/errors";
import type { FileEntry } from "@shared/ipc";

export type McpCanvas = {
  api: ExcalidrawImperativeAPI;
  fileId: string | null;
  isReady: () => boolean;
};

export type McpHandlerDeps = {
  getCanvas: () => McpCanvas | null;
  getOpenFileId: () => string | null;
  getEntries: () => FileEntry[];
  openFile: (id: string) => Promise<boolean>;
  createFile: (name?: string) => Promise<string | null>;
  sleep?: (ms: number) => Promise<void>;
};

const READY_TIMEOUT_MS = 8000;
const POLL_MS = 50;
const EXTENSION = ".excalidraw";

const round = (n: number) => Math.round(n);

const isSkeleton = (value: unknown): value is ExcalidrawElementSkeleton =>
  isRecord(value) && typeof value.type === "string";

const UPDATABLE = new Set([
  "x",
  "y",
  "width",
  "height",
  "angle",
  "text",
  "originalText",
  "fontSize",
  "strokeColor",
  "backgroundColor",
  "fillStyle",
  "strokeWidth",
  "strokeStyle",
  "roughness",
  "opacity",
]);

// Style and geometry only; ids, types and bindings stay owned by Excalidraw.
const isElementUpdate = (
  value: Record<string, unknown>,
): value is ElementUpdate<OrderedExcalidrawElement> =>
  Object.entries(value).every(
    ([key, field]) =>
      UPDATABLE.has(key) && (typeof field === "number" || typeof field === "string"),
  );

// Loaded on demand so the app shell doesn't pull the editor bundle in at startup.
const loadExcalidraw = () => import("@excalidraw/excalidraw");

// Compact view for agents: enough to reference, move and connect elements.
export const summarizeElements = (elements: readonly ExcalidrawElement[]) =>
  elements
    .filter((element) => !element.isDeleted)
    .map((element) => {
      const summary: Record<string, unknown> = {
        id: element.id,
        type: element.type,
        x: round(element.x),
        y: round(element.y),
        width: round(element.width),
        height: round(element.height),
        strokeColor: element.strokeColor,
      };
      if (element.backgroundColor !== "transparent") {
        summary.backgroundColor = element.backgroundColor;
      }
      if (element.type === "text") {
        summary.text = element.text;
        if (element.containerId) summary.containerId = element.containerId;
      }
      if (element.type === "arrow") {
        summary.start = element.startBinding?.elementId;
        summary.end = element.endBinding?.elementId;
      }
      return summary;
    });

export const createMcpHandler = (deps: McpHandlerDeps) => {
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  // Edits made while a scene is loading are dropped, so wait for the editor to settle.
  const waitForCanvas = async (fileId: string) => {
    for (let waited = 0; waited <= READY_TIMEOUT_MS; waited += POLL_MS) {
      const canvas = deps.getCanvas();
      if (canvas?.fileId === fileId && deps.getOpenFileId() === fileId && canvas.isReady()) {
        return canvas;
      }
      await sleep(POLL_MS);
    }
    throw new Error("The drawing didn't finish loading in xcalidraw. Try again.");
  };

  const openCanvas = async () => {
    const fileId = deps.getOpenFileId();
    if (fileId === null) {
      throw new Error(
        "No drawing is open in xcalidraw. Call open_drawing or create_drawing first.",
      );
    }
    return { fileId, canvas: await waitForCanvas(fileId) };
  };

  const nameOf = (id: string) => deps.getEntries().find((entry) => entry.id === id)?.name ?? id;

  const describe = async () => {
    const { fileId, canvas } = await openCanvas();
    return {
      id: fileId,
      name: nameOf(fileId),
      elements: summarizeElements(canvas.api.getSceneElements()),
    };
  };

  const tools: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
    get_open_drawing: describe,

    open_drawing: async ({ id }) => {
      if (
        typeof id !== "string" ||
        !deps.getEntries().some((e) => e.id === id && e.kind === "file")
      ) {
        throw new Error(`No drawing with id ${JSON.stringify(id)}. Use list_drawings.`);
      }
      if (!(await deps.openFile(id))) throw new Error("The user kept the current drawing open.");
      await waitForCanvas(id);
      return describe();
    },

    add_elements: async ({ elements }) => {
      if (!Array.isArray(elements) || !elements.every(isSkeleton)) {
        throw new Error("elements must be a list of element skeletons with a type.");
      }
      const { canvas } = await openCanvas();
      const { CaptureUpdateAction, convertToExcalidrawElements } = await loadExcalidraw();
      const scene = canvas.api.getSceneElementsIncludingDeleted();
      const taken = new Set(scene.map((element) => element.id));
      const clash = elements.find((skeleton) => skeleton.id && taken.has(skeleton.id));
      if (clash) throw new Error(`Element id ${clash.id} already exists. Use update_elements.`);

      // Keep agent ids so later calls can reference what it drew.
      const added = convertToExcalidrawElements(elements, { regenerateIds: false });
      canvas.api.updateScene({
        elements: [...scene, ...added],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      canvas.api.scrollToContent(added, { fitToViewport: true, animate: true });
      return { added: summarizeElements(added) };
    },

    update_elements: async ({ elements }) => {
      if (!Array.isArray(elements) || !elements.every(isRecord)) {
        throw new Error("elements must be a list of {id, ...changes}.");
      }
      const updates = new Map<string, ElementUpdate<OrderedExcalidrawElement>>();
      for (const { id, ...changes } of elements) {
        if (typeof id !== "string") throw new Error("Every update needs an element id.");
        // Excalidraw renders originalText for wrapped text, so keep both in sync.
        const synced =
          typeof changes.text === "string" ? { ...changes, originalText: changes.text } : changes;
        if (!isElementUpdate(synced)) {
          throw new Error(`Only these fields can change: ${[...UPDATABLE].join(", ")}.`);
        }
        updates.set(id, synced);
      }

      const { canvas } = await openCanvas();
      const { CaptureUpdateAction, newElementWith } = await loadExcalidraw();
      const scene = canvas.api.getSceneElementsIncludingDeleted();
      const missing = [...updates.keys()].filter(
        (id) => !scene.some((element) => element.id === id && !element.isDeleted),
      );
      if (missing.length > 0) throw new Error(`Unknown element ids: ${missing.join(", ")}`);

      // ponytail: text edits don't re-measure; resize the element or delete + add for long text.
      const next = scene.map((element) => {
        const changes = updates.get(element.id);
        return changes ? newElementWith(element, changes) : element;
      });
      canvas.api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
      return { updated: summarizeElements(next.filter((element) => updates.has(element.id))) };
    },

    delete_elements: async ({ ids }) => {
      if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) {
        throw new Error("ids must be a list of element ids.");
      }
      const { canvas } = await openCanvas();
      const { CaptureUpdateAction, newElementWith } = await loadExcalidraw();
      const doomed = new Set<string>(ids);
      const scene = canvas.api.getSceneElementsIncludingDeleted();
      const next = scene.map((element) =>
        doomed.has(element.id) ||
        (element.type === "text" && element.containerId && doomed.has(element.containerId))
          ? newElementWith(element, { isDeleted: true })
          : element,
      );
      canvas.api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
      return { deleted: [...doomed] };
    },

    create_drawing: async ({ name }) => {
      const trimmed = typeof name === "string" ? name.trim() : "";
      const fileName =
        trimmed && !trimmed.toLowerCase().endsWith(EXTENSION) ? `${trimmed}${EXTENSION}` : trimmed;
      const id = await deps.createFile(fileName || undefined);
      if (id === null) throw new Error("The drawing couldn't be created.");
      await waitForCanvas(id);
      return { id, name: nameOf(id) };
    },
  };

  return async (name: string, args: Record<string, unknown>) => {
    const tool = tools[name];
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    return tool(args);
  };
};

let canvas: McpCanvas | null = null;

export const setMcpCanvas = (next: McpCanvas | null) => {
  canvas = next;
};

export const getMcpCanvas = () => canvas;
