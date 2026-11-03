import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";

import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import { McpServer, createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";
import { MCP_REQUEST, MCP_RESPONSE } from "@shared/channels";
import { codedError } from "@shared/errors";
import { MCP_PORT, type McpResponse } from "@shared/ipc";
import { app, ipcMain } from "electron";
import { z } from "zod";

import { listEntries, readDrawingFile } from "./files";
import {
  MAX_ITEM_ELEMENTS,
  MY_LIBRARY_ID,
  getLibraryIndex,
  getLibraryItems,
  searchIndex,
  summarizeItem,
} from "./library";
import { log } from "./logger";
import { getMainWindow } from "./window";

const EDITOR_TIMEOUT_MS = 15_000;

type Pending = { senderId: number; settle: (response: McpResponse) => void };
const pending = new Map<string, Pending>();

ipcMain.on(MCP_RESPONSE, (event, response: McpResponse) => {
  const entry = pending.get(response?.id);
  if (!entry || entry.senderId !== event.sender.id) return;
  pending.delete(response.id);
  entry.settle(response);
});

const askEditor = (name: string, args: Record<string, unknown> = {}) =>
  new Promise<unknown>((resolve, reject) => {
    const win = getMainWindow();
    if (!win || win.isDestroyed() || win.webContents.isCrashed()) {
      reject(new Error("The xcalidraw window isn't open."));
      return;
    }

    const id = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`xcalidraw didn't answer ${name} in time.`));
    }, EDITOR_TIMEOUT_MS);

    pending.set(id, {
      senderId: win.webContents.id,
      settle: (response) => {
        clearTimeout(timer);
        if ("error" in response) reject(new Error(response.error));
        else resolve(response.result);
      },
    });
    win.webContents.send(MCP_REQUEST, { id, name, args });
  });

const text = (value: unknown) => ({
  content: [
    { type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) },
  ],
});

const GUIDE = `# Drawing in xcalidraw

Edits appear live in the user's open drawing and autosave. The user can undo them with Ctrl+Z.

Workflow: get_open_drawing (or open_drawing / create_drawing) -> add_elements -> get_open_drawing to check.

## Element skeletons for add_elements
Give every element an "id" you choose so you can update, delete or connect it later.

- Shapes: {"id":"api","type":"rectangle","x":0,"y":0,"width":180,"height":80}
  type is "rectangle", "ellipse" or "diamond".
  Put text inside a shape with "label": {"text":"API server"}. Don't add separate text for it.
- Text: {"id":"title","type":"text","x":0,"y":-60,"text":"Auth flow","fontSize":28}
- Arrows: {"id":"a1","type":"arrow","x":180,"y":40,"width":120,"height":0,
  "start":{"id":"api"},"end":{"id":"db"},"label":{"text":"query"}}
  start/end can name shapes in the same call or shapes already in the drawing.
- Lines: {"type":"line","x":0,"y":0,"points":[[0,0],[200,0]]}

## Libraries (icons, logos, architecture and diagram kits)
search_libraries -> get_library -> insert_library_item. Library id "${MY_LIBRARY_ID}" is the user's own library.
Inserted items arrive grouped, with new ids; insert_library_item returns them so you can connect arrows.

## Style
Optional on any element: strokeColor, backgroundColor, fillStyle ("solid" | "hachure"),
strokeWidth (1, 2, 4), strokeStyle ("solid" | "dashed"), roughness (0 clean, 1 sketchy), opacity (0-100),
roundness ({"type":3} rounded corners, {"type":2} proportional; omit for sharp corners).
Good fills: #a5d8ff blue, #b2f2bb green, #ffd8a8 orange, #d0bfff purple, #ffc9c9 red, #fff3bf yellow.
Use fillStyle "solid" with a fill so it reads clearly.

## Layout
Choose spacing from the content, not a fixed gap. When text sits between or around two things,
estimate how much room it needs (about 10px per character) and leave that plus padding, so text
never touches a shape or an arrow. When there is no text, use even spacing that matches the whole
drawing: tight inside a group, wider between groups. Lay flows left-to-right or top-to-bottom.
Size shapes to fit their label: about 10px per character wide plus padding, and 60-80px tall.
Arrows: when the two connected shapes line up in the same row or column, use a straight arrow
between them; use diagonals only for shapes that don't line up.
`;

const buildServer = () => {
  const server = new McpServer({ name: "xcalidraw", version: app.getVersion() });

  server.registerTool(
    "list_drawings",
    { description: "List the .excalidraw drawings in the user's drawings folder." },
    async () =>
      text(
        (await listEntries())
          .filter((entry) => entry.kind === "file")
          .map(({ id, name, modifiedAt }) => ({ id, name, modifiedAt })),
      ),
  );

  server.registerTool(
    "read_drawing",
    {
      description: "Read a drawing's raw .excalidraw JSON by its id from list_drawings.",
      inputSchema: z.object({ id: z.string() }),
    },
    async ({ id }) => text(await readDrawingFile(id)),
  );

  server.registerTool(
    "read_me",
    { description: "How to draw in xcalidraw. Call once before add_elements." },
    async () => text(GUIDE),
  );

  server.registerTool(
    "get_open_drawing",
    { description: "The drawing open in xcalidraw and a compact list of its elements." },
    async () => text(await askEditor("get_open_drawing")),
  );

  server.registerTool(
    "open_drawing",
    {
      description: "Open a drawing in xcalidraw by its id from list_drawings.",
      inputSchema: z.object({ id: z.string() }),
    },
    async (args) => text(await askEditor("open_drawing", args)),
  );

  server.registerTool(
    "create_drawing",
    {
      description: "Create a new drawing in the folder root and open it.",
      inputSchema: z.object({ name: z.string().optional() }),
    },
    async (args) => text(await askEditor("create_drawing", args)),
  );

  server.registerTool(
    "add_elements",
    {
      description:
        "Add elements to the open drawing, shown live. Takes Excalidraw element skeletons; see read_me.",
      inputSchema: z.object({
        elements: z
          .array(z.looseObject({ type: z.string() }))
          .min(1)
          .max(500),
      }),
    },
    async (args) => text(await askEditor("add_elements", args)),
  );

  server.registerTool(
    "update_elements",
    {
      description:
        "Change existing elements by id, e.g. {id, x, y, strokeColor, backgroundColor, text}.",
      inputSchema: z.object({
        elements: z
          .array(z.looseObject({ id: z.string() }))
          .min(1)
          .max(500),
      }),
    },
    async (args) => text(await askEditor("update_elements", args)),
  );

  server.registerTool(
    "delete_elements",
    {
      description: "Delete elements from the open drawing by id. Their labels go with them.",
      inputSchema: z.object({ ids: z.array(z.string()).min(1).max(500) }),
    },
    async (args) => text(await askEditor("delete_elements", args)),
  );

  server.registerTool(
    "search_libraries",
    {
      description:
        "Search the public Excalidraw libraries (icons, logos, cloud, system design kits...).",
      inputSchema: z.object({ query: z.string().max(200) }),
    },
    async ({ query }) =>
      text(
        searchIndex(await getLibraryIndex(), query).map(({ id, name, description }) => ({
          id,
          name,
          description,
        })),
      ),
  );

  server.registerTool(
    "get_library",
    {
      description: `List the items in a library. Use id "${MY_LIBRARY_ID}" for the user's own library.`,
      inputSchema: z.object({ id: z.string().max(200) }),
    },
    async ({ id }) => {
      const { name, items } = await getLibraryItems(id);
      return text({ id, name, items: items.map(summarizeItem) });
    },
  );

  server.registerTool(
    "insert_library_item",
    {
      description:
        "Place a library item on the open drawing. x/y is its top-left; omit to place it beside the drawing.",
      inputSchema: z.object({
        library: z.string().max(200),
        item: z.number().int().min(0),
        x: z.number().finite().optional(),
        y: z.number().finite().optional(),
      }),
    },
    async ({ library, item, x, y }) => {
      // Pin the drawing before the download so a switch meanwhile can't redirect the item.
      const { id: drawingId } = z
        .object({ id: z.string() })
        .parse(await askEditor("open_drawing_id"));
      const { items } = await getLibraryItems(library);
      const picked = items[item];
      if (!picked)
        throw new Error(`That library has ${items.length} items (0-${items.length - 1}).`);
      if (picked.elements.length > MAX_ITEM_ELEMENTS) throw new Error("That item is too large.");
      return text(
        await askEditor("insert_elements", { drawingId, elements: picked.elements, x, y }),
      );
    },
  );

  return server;
};

export const createHandler = (): McpHttpHandler =>
  createMcpHandler(buildServer, {
    legacy: "stateless",
    onerror: (error) => log.error("[mcp] request failed", error),
  });

let http: Server | null = null;
let handler: McpHttpHandler | null = null;

const startMcpServer = async () => {
  if (http) return;

  const mcp = createHandler();
  const handle = toNodeHandler(mcp, {
    onerror: (error) => log.error("[mcp] transport failed", error),
  });
  const allowedHost = localhostHostValidation();
  const allowedOrigin = localhostOriginValidation();

  const server = createServer((req, res) => {
    if (req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    if (!allowedHost(req, res)) return;
    if (!allowedOrigin(req, res)) return;
    void handle(req, res).catch((error: unknown) => {
      log.error("[mcp] request failed", error);
      if (!res.headersSent) res.writeHead(500).end();
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(MCP_PORT, "127.0.0.1", () => {
        server.off("error", onError);
        resolve();
      });
    });
  } catch (error) {
    await mcp.close();
    log.error("[mcp] server error", error);
    throw codedError(
      `Couldn't start the MCP server on port ${MCP_PORT}`,
      { code: "UNKNOWN", reason: "port-in-use" },
      { cause: error },
    );
  }

  server.on("error", (error) => log.error("[mcp] server error", error));
  log.info(`[mcp] listening on 127.0.0.1:${MCP_PORT}`);

  http = server;
  handler = mcp;
};

const stopMcpServer = async () => {
  const server = http;
  const mcp = handler;
  http = null;
  handler = null;
  if (!server) return;

  try {
    await mcp?.close();
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
  }
};

let lifecycle: Promise<void> = Promise.resolve();

export const applyMcpSetting = (enabled: boolean) => {
  const run = lifecycle.then(() => (enabled ? startMcpServer() : stopMcpServer()));
  lifecycle = run.catch(() => undefined);
  return run;
};
