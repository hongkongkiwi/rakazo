import { describe, expect, it } from "vitest";
import { McpSourcePresetSchema } from "./mcp.js";

describe("MCP source preset schema", () => {
  it("defaults a preset without auth to bearer", () => {
    expect(
      McpSourcePresetSchema.parse({ id: "treg", name: "Treg", url: "https://treg.to/mcp/" }),
    ).toMatchObject({ id: "treg", auth: "bearer" });
  });

  it("accepts the provider-neutral auth values", () => {
    for (const auth of ["none", "bearer", "oauth"]) {
      expect(McpSourcePresetSchema.parse({ id: "x", name: "X", auth })).toMatchObject({ auth });
    }
  });

  it("rejects an unknown auth value", () => {
    expect(() => McpSourcePresetSchema.parse({ id: "x", name: "X", auth: "api-key" })).toThrow();
  });
});
