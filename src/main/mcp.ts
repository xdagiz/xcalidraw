import { createServer, type Server } from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { app } from "electron";
import { z } from "zod";

import { listEntries, readDrawingFile } from "./files";
import { log } from "./logger";

export const MCP_PORT = 29180;

// Only local agents: browsers always send Origin, and a foreign Host means DNS rebinding.
export const isAllowedRequest = (host: string | undefined, origin: string | undefined) =>
  origin === undefined && (host === `127.0.0.1:${MCP_PORT}` || host === `localhost:${MCP_PORT}`);

const text = (value: unknown) => ({
  content: [
    { type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) },
  ],
});

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
