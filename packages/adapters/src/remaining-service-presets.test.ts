import { describe, expect, it } from "vitest";
import { applyMcpSourcePreset, MCP_SOURCE_PRESETS } from "./installed-connectors.js";

describe("remaining remote service presets", () => {
  it("pins Hugging Face to its documented bearer endpoint", () => {
    expect(MCP_SOURCE_PRESETS.find((preset) => preset.id === "huggingface")).toMatchObject({
      name: "Hugging Face",
      url: "https://huggingface.co/mcp",
      auth: "bearer",
    });
    expect(
      applyMcpSourcePreset("https://elsewhere.example/mcp", {
        preset: "huggingface",
        auth: { type: "none" },
      }),
    ).toEqual({
      source: "https://huggingface.co/mcp",
      config: { preset: "huggingface", auth: { type: "bearer" } },
    });
  });

  it("offers Mobbin and Infobip through their documented OAuth flows", () => {
    for (const [id, name, url] of [
      ["mobbin", "Mobbin", "https://api.mobbin.com/mcp"],
      ["infobip", "Infobip", "https://mcp.infobip.com/search"],
    ]) {
      expect(MCP_SOURCE_PRESETS.find((preset) => preset.id === id)).toMatchObject({
        name,
        url,
        auth: "oauth",
      });
      expect(() => applyMcpSourcePreset("https://elsewhere.example/mcp", { preset: id })).toThrow(
        /OAuth/,
      );
    }
  });
});
