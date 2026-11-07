import { describe, expect, it } from "vitest";
import { applyMcpSourcePreset, MCP_SOURCE_PRESETS } from "./installed-connectors.js";

const preset = (id: string) => MCP_SOURCE_PRESETS.find((entry) => entry.id === id);

describe("service auth preset catalog", () => {
  it("offers the verified service presets", () => {
    const ids = MCP_SOURCE_PRESETS.map((entry) => entry.id);
    for (const required of ["agentmail", "slack", "planetscale", "elevenlabs", "aiven"]) {
      expect(ids, required).toContain(required);
    }
  });

  it("pins AgentMail to its header-auth endpoint and header name", () => {
    expect(preset("agentmail")).toMatchObject({
      url: "https://mcp.agentmail.to/mcp",
      auth: "header",
      authHeader: "x-api-key",
    });
  });

  it("pins each OAuth service to its verified endpoint", () => {
    const expected: Record<string, string> = {
      slack: "https://mcp.slack.com/mcp",
      planetscale: "https://mcp.pscale.dev/mcp/planetscale",
      elevenlabs: "https://api.elevenlabs.io/v1/mcp",
      aiven: "https://mcp.aiven.live/mcp",
    };
    for (const [id, url] of Object.entries(expected)) {
      expect(preset(id), id).toMatchObject({ url, auth: "oauth" });
    }
  });

  it("carries only preset metadata, never credential values", () => {
    const allowed = new Set(["id", "name", "url", "urlPlaceholder", "auth", "authHeader"]);
    for (const entry of MCP_SOURCE_PRESETS) {
      expect(
        Object.keys(entry).every((key) => allowed.has(key)),
        entry.id,
      ).toBe(true);
    }
  });
});

describe("applyMcpSourcePreset service auth", () => {
  it("installs AgentMail with header auth, discarding the caller's auth and headers", () => {
    expect(
      applyMcpSourcePreset("https://elsewhere.example/mcp", {
        preset: "agentmail",
        auth: { type: "bearer" },
        headers: { "x-caller": "ignored" },
      }),
    ).toEqual({
      source: "https://mcp.agentmail.to/mcp",
      config: { preset: "agentmail", auth: { type: "header", name: "x-api-key" } },
    });
  });

  it("rejects a generic capabilities install of an OAuth service preset", () => {
    for (const id of ["slack", "planetscale", "elevenlabs", "aiven"]) {
      expect(
        () => applyMcpSourcePreset("https://mine.example/mcp", { preset: id }),
        id,
      ).toThrow(/OAuth/i);
    }
  });
});
