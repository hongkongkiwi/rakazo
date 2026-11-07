import { describe, expect, it } from "vitest";
import { McpSourcePresetSchema } from "./mcp.js";

describe("MCP source preset auth modes", () => {
  it("accepts the header auth mode with its header name", () => {
    expect(
      McpSourcePresetSchema.parse({
        id: "agentmail",
        name: "AgentMail",
        auth: "header",
        authHeader: "x-api-key",
      }),
    ).toMatchObject({ auth: "header", authHeader: "x-api-key" });
  });

  it("still rejects the retired api-key auth value", () => {
    expect(() => McpSourcePresetSchema.parse({ id: "x", name: "X", auth: "api-key" })).toThrow();
  });

  it("requires an authHeader for header mode", () => {
    expect(() => McpSourcePresetSchema.parse({ id: "x", name: "X", auth: "header" })).toThrow();
  });

  it("rejects an authHeader on every non-header auth mode", () => {
    for (const auth of ["none", "bearer", "oauth"]) {
      expect(() =>
        McpSourcePresetSchema.parse({ id: "x", name: "X", auth, authHeader: "x-api-key" }),
      ).toThrow();
    }
  });

  it("rejects an authHeader that is not an HTTP field name", () => {
    for (const authHeader of ["x api key", "x-api-key:", "x-api-key\ninjected"]) {
      expect(() =>
        McpSourcePresetSchema.parse({ id: "x", name: "X", auth: "header", authHeader }),
      ).toThrow();
    }
  });

  it("rejects a transport-level header as authHeader", () => {
    for (const authHeader of ["host", "content-length", "connection", "transfer-encoding"]) {
      expect(() =>
        McpSourcePresetSchema.parse({ id: "x", name: "X", auth: "header", authHeader }),
      ).toThrow();
    }
  });
});
