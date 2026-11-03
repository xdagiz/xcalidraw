import type { McpHttpHandler } from "@modelcontextprotocol/server";
import { MCP_PORT } from "@shared/ipc";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createHandler } from "./mcp";

vi.mock("electron", () => ({
  app: { getVersion: () => "0.0.0" },
  ipcMain: { on: () => undefined },
}));
vi.mock("./files", () => ({ listEntries: vi.fn(), readDrawingFile: vi.fn() }));
vi.mock("./logger", () => ({ log: { info: vi.fn(), error: vi.fn() } }));
vi.mock("./window", () => ({ getMainWindow: () => null }));
vi.mock("./library", () => ({
  MAX_ITEM_ELEMENTS: 100,
  MY_LIBRARY_ID: "mine",
  getLibraryIndex: vi.fn(),
  getLibraryItems: vi.fn(),
  searchIndex: vi.fn(),
  summarizeItem: vi.fn(),
}));

const PROTOCOL_VERSION = "2026-07-28";
const ENDPOINT = `http://127.0.0.1:${MCP_PORT}/mcp`;
const TOOL_NAMES = [
  "list_drawings",
  "read_drawing",
  "read_me",
  "get_open_drawing",
  "open_drawing",
  "create_drawing",
  "add_elements",
  "update_elements",
  "delete_elements",
  "search_libraries",
  "get_library",
  "insert_library_item",
];

type Rpc = {
  result?: Record<string, unknown>;
};

const handlers: McpHttpHandler[] = [];

const handler = () => {
  const created = createHandler();
  handlers.push(created);
  return created;
};

const request = (method: string, params: Record<string, unknown> = {}, name?: string) =>
  new Request(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL_VERSION,
      "mcp-method": method,
      ...(name ? { "mcp-name": name } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });

// The handler replies with JSON.
const parse = async (response: Response): Promise<Rpc> => (await response.json()) as Rpc;

afterEach(async () => {
  await Promise.all(handlers.splice(0).map((created) => created.close()));
});

describe("MCP server", () => {
  it("answers server/discover", async () => {
    const response = await handler().fetch(request("server/discover"));

    expect(response.status).toBe(200);
    expect((await parse(response)).result?.supportedVersions).toEqual([PROTOCOL_VERSION]);
  });

  it("lists every tool", async () => {
    const body = await parse(await handler().fetch(request("tools/list")));
    const tools = body.result?.tools;

    expect(Array.isArray(tools)).toBe(true);
    expect((tools as Array<{ name: string }>).map((tool) => tool.name)).toEqual(TOOL_NAMES);
  });

  it("calls a tool", async () => {
    const response = await handler().fetch(
      request("tools/call", { name: "read_me", arguments: {} }, "read_me"),
    );
    const body = await parse(response);

    expect(body.result?.isError).toBeUndefined();
    expect(JSON.stringify(body.result?.content)).toContain("Drawing in xcalidraw");
  });
});
