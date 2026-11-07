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

  it("offers Mobbin through its documented OAuth flow", () => {
    expect(MCP_SOURCE_PRESETS.find((preset) => preset.id === "mobbin")).toMatchObject({
      name: "Mobbin",
      url: "https://api.mobbin.com/mcp",
      auth: "oauth",
    });
    expect(() =>
      applyMcpSourcePreset("https://elsewhere.example/mcp", { preset: "mobbin" }),
    ).toThrow(/OAuth/);
  });

  it("connects Infobip's public documentation server without credentials", () => {
    expect(MCP_SOURCE_PRESETS.find((preset) => preset.id === "infobip")).toMatchObject({
      name: "Infobip docs",
      url: "https://mcp.infobip.com/search",
      auth: "none",
    });
    expect(
      applyMcpSourcePreset("https://elsewhere.example/mcp", {
        preset: "infobip",
        auth: { type: "bearer" },
      }),
    ).toEqual({
      source: "https://mcp.infobip.com/search",
      config: { preset: "infobip", auth: { type: "none" } },
    });
  });
});
