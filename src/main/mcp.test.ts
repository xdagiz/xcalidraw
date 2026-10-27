import { MCP_PORT } from "@shared/ipc";
import { describe, expect, it, vi } from "vite-plus/test";

import { isAllowedRequest } from "./mcp";

vi.mock("electron", () => ({ app: {}, ipcMain: { on: () => undefined } }));
vi.mock("./files", () => ({}));
vi.mock("./logger", () => ({ log: {} }));
vi.mock("./window", () => ({}));

describe("isAllowedRequest", () => {
  it("allows local agents", () => {
    expect(isAllowedRequest(`127.0.0.1:${MCP_PORT}`, undefined)).toBe(true);
    expect(isAllowedRequest(`localhost:${MCP_PORT}`, undefined)).toBe(true);
  });

  it("rejects browsers and rebound hosts", () => {
    expect(isAllowedRequest(`127.0.0.1:${MCP_PORT}`, "https://evil.example")).toBe(false);
    expect(isAllowedRequest(`evil.example:${MCP_PORT}`, undefined)).toBe(false);
    expect(isAllowedRequest(undefined, undefined)).toBe(false);
  });
});
