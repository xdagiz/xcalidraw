import { request as httpRequest } from "node:http";
import { connect, type AddressInfo } from "node:net";

import type { McpHttpHandler } from "@modelcontextprotocol/server";
import { MCP_PORT } from "@shared/ipc";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createHandler, createMcpHttpServer } from "./mcp";

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
const LEGACY_PROTOCOL_VERSION = "2025-11-25";
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
const servers: Array<ReturnType<typeof createMcpHttpServer>> = [];

const handler = () => {
  const created = createHandler();
  handlers.push(created);
  return created;
};

type RequestOptions = {
  name?: string;
  legacy?: boolean;
};

const makeRequest = (
  method: string,
  params: Record<string, unknown> = {},
  { name, legacy = false }: RequestOptions = {},
) =>
  new Request(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(legacy
        ? {}
        : {
            "mcp-protocol-version": PROTOCOL_VERSION,
            "mcp-method": method,
            ...(name ? { "mcp-name": name } : {}),
          }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: legacy
        ? params
        : {
            ...params,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
    }),
  });

const request = (method: string, params?: Record<string, unknown>, name?: string) =>
  makeRequest(method, params, { name });

const legacyRequest = (method: string, params?: Record<string, unknown>) =>
  makeRequest(method, params, { legacy: true });

// The modern handler replies with JSON, the legacy stateless fallback with SSE.
const parse = async (response: Response): Promise<Rpc> => {
  const text = await response.text();
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const data = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .join("\n");
    return JSON.parse(data) as Rpc;
  }
  return JSON.parse(text) as Rpc;
};

const listen = async () => {
  const created = createMcpHttpServer();
  servers.push(created);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    created.server.once("error", onError);
    created.server.listen(0, "127.0.0.1", () => {
      created.server.off("error", onError);
      resolve();
    });
  });
  const address = created.server.address() as AddressInfo;
  return address.port;
};

type SendOptions = {
  host?: string;
  origin?: string;
};

const send = (port: number, built: Request, { host, origin }: SendOptions = {}) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const headers: Record<string, string> = {};
    built.headers.forEach((value, key) => {
      headers[key] = value;
    });
    if (host !== undefined) headers.host = host;
    if (origin !== undefined) headers.origin = origin;

    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        setHost: false,
        headers,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    void built.text().then((body) => req.end(body));
  });

// HTTP/1.1 requires a Host header, so a truly missing one needs a raw HTTP/1.0 request.
const sendWithoutHost = (port: number, built: Request) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    void built.text().then((body) => {
      const headers: string[] = [];
      built.headers.forEach((value, key) => headers.push(`${key}: ${value}`));
      const payload = [
        "POST /mcp HTTP/1.0",
        ...headers,
        `content-length: ${Buffer.byteLength(body)}`,
        "",
        body,
      ].join("\r\n");

      const socket = connect({ host: "127.0.0.1", port }, () => socket.write(payload));
      let data = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        data += chunk;
      });
      socket.on("error", reject);
      socket.on("end", () => {
        const [head, ...rest] = data.split("\r\n\r\n");
        resolve({ status: Number(head.split(" ")[1]), body: rest.join("\r\n\r\n") });
      });
    });
  });

afterEach(async () => {
  await Promise.all(handlers.splice(0).map((created) => created.close()));
  await Promise.all(
    servers.splice(0).map(async ({ server, mcp }) => {
      await mcp.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }),
  );
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

  it("serves the legacy initialize, tools/list, and tools/call flow", async () => {
    const legacy = handler();

    const initialized = await parse(
      await legacy.fetch(
        legacyRequest("initialize", {
          protocolVersion: LEGACY_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "legacy client", version: "1.0.0" },
        }),
      ),
    );

    expect(initialized.result?.protocolVersion).toBe(LEGACY_PROTOCOL_VERSION);
    expect(initialized.result?.serverInfo).toMatchObject({ name: "xcalidraw" });

    const listed = await parse(await legacy.fetch(legacyRequest("tools/list")));
    const tools = listed.result?.tools;

    expect(Array.isArray(tools)).toBe(true);
    expect((tools as Array<{ name: string }>).map((tool) => tool.name)).toEqual(TOOL_NAMES);

    const called = await parse(
      await legacy.fetch(legacyRequest("tools/call", { name: "read_me", arguments: {} })),
    );

    expect(called.result?.isError).toBeUndefined();
    expect(JSON.stringify(called.result?.content)).toContain("Drawing in xcalidraw");
  });
});

describe("MCP HTTP listener", () => {
  it("rejects requests without a Host header", async () => {
    const port = await listen();
    const response = await sendWithoutHost(port, request("server/discover"));

    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toMatchObject({ error: { message: "Missing Host header" } });
  });

  it("rejects a rebound Host header", async () => {
    const port = await listen();
    const response = await send(port, request("server/discover"), { host: "evil.example" });

    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toMatchObject({
      error: { message: "Invalid Host: evil.example" },
    });
  });

  it("rejects an untrusted Origin", async () => {
    const port = await listen();
    const response = await send(port, request("server/discover"), {
      host: `127.0.0.1:${port}`,
      origin: "https://evil.example",
    });

    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toMatchObject({
      error: { message: "Invalid Origin: evil.example" },
    });
  });

  it("allows a local request", async () => {
    const port = await listen();
    const response = await send(port, request("server/discover"), {
      host: `127.0.0.1:${port}`,
    });

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).result.supportedVersions).toEqual([PROTOCOL_VERSION]);
  });
});
