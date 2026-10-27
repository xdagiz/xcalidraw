import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { MCP_REQUEST, MCP_RESPONSE } from "@shared/channels";
import type { McpResponse } from "@shared/ipc";
import { app, ipcMain } from "electron";
import { z } from "zod";

import { listEntries, readDrawingFile } from "./files";
import { log } from "./logger";
import { getMainWindow } from "./window";

export const MCP_PORT = 29180;
const EDITOR_TIMEOUT_MS = 15_000;

// Only local agents: browsers always send Origin, and a foreign Host means DNS rebinding.
export const isAllowedRequest = (host: string | undefined, origin: string | undefined) =>
  origin === undefined && (host === `127.0.0.1:${MCP_PORT}` || host === `localhost:${MCP_PORT}`);

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
  start/end must name shapes added in the same add_elements call.
  To connect to existing shapes, add the arrow together with new shapes or point x/y/width/height at them.
- Lines: {"type":"line","x":0,"y":0,"points":[[0,0],[200,0]]}

## Style
Optional on any element: strokeColor, backgroundColor, fillStyle ("solid" | "hachure"),
strokeWidth (1, 2, 4), strokeStyle ("solid" | "dashed"), roughness (0 clean, 1 sketchy), opacity (0-100).
Good fills: #a5d8ff blue, #b2f2bb green, #ffd8a8 orange, #d0bfff purple, #ffc9c9 red, #fff3bf yellow.
Use fillStyle "solid" with a fill so it reads clearly.

## Layout
Leave ~80px between shapes. Lay flows left-to-right or top-to-bottom.
Size shapes to fit their label: about 10px per character wide, 60-80px tall.
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
      inputSchema: { id: z.string() },
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
      inputSchema: { id: z.string() },
    },
    async (args) => text(await askEditor("open_drawing", args)),
  );

  server.registerTool(
    "create_drawing",
    {
      description: "Create a new drawing in the folder root and open it.",
      inputSchema: { name: z.string().optional() },
    },
    async (args) => text(await askEditor("create_drawing", args)),
  );

  server.registerTool(
    "add_elements",
    {
      description:
        "Add elements to the open drawing, shown live. Takes Excalidraw element skeletons; see read_me.",
      inputSchema: {
        elements: z
          .array(z.looseObject({ type: z.string() }))
          .min(1)
          .max(500),
      },
    },
    async (args) => text(await askEditor("add_elements", args)),
  );

  server.registerTool(
    "update_elements",
    {
      description:
        "Change existing elements by id, e.g. {id, x, y, strokeColor, backgroundColor, text}.",
      inputSchema: {
        elements: z
          .array(z.looseObject({ id: z.string() }))
          .min(1)
          .max(500),
      },
    },
    async (args) => text(await askEditor("update_elements", args)),
  );

  server.registerTool(
    "delete_elements",
    {
      description: "Delete elements from the open drawing by id. Their labels go with them.",
      inputSchema: { ids: z.array(z.string()).min(1).max(500) },
    },
    async (args) => text(await askEditor("delete_elements", args)),
  );

  return server;
};

let http: Server | null = null;

export const startMcpServer = () => {
  if (http) return;

  http = createServer(async (req, res) => {
    if (req.url !== "/mcp" || !isAllowedRequest(req.headers.host, req.headers.origin)) {
      res.writeHead(403).end();
      return;
    }

    // Stateless: a fresh server per request, nothing to clean up between agents.
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => void server.close());

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      log.error("[mcp] request failed", error);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });

  http.on("error", (error) => {
    log.error("[mcp] server error", error);
    http = null;
  });
  http.listen(MCP_PORT, "127.0.0.1", () => log.info(`[mcp] listening on 127.0.0.1:${MCP_PORT}`));
};
