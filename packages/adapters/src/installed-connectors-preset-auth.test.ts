import type { McpSourcePreset } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  applyMcpSourcePreset,
  MCP_SOURCE_PRESETS,
  verifyMcpInstall,
} from "./installed-connectors.js";

const preset = (id: string) => MCP_SOURCE_PRESETS.find((entry) => entry.id === id);

describe("install-time preset auth", () => {
  it("pins the Quackr, DigitalOcean, and Instabox bearer endpoints", () => {
    const expected: Record<string, string> = {
      quackr: "https://mcp.quackr.io/",
      digitalocean: "https://mcp.digitalocean.com/mcp",
      instabox: "https://api.instabox.sh/mcp",
    };
    for (const [id, url] of Object.entries(expected)) {
      expect(preset(id), id).toMatchObject({ url, auth: "bearer" });
    }
  });

  it("normalizes a preset reply without auth to bearer", () => {
    const legacy = {
      id: "legacy-source",
      name: "Legacy source",
      url: "https://legacy.example/mcp",
    } as McpSourcePreset;
    MCP_SOURCE_PRESETS.push(legacy);
    try {
      expect(applyMcpSourcePreset("https://elsewhere.example/mcp", { preset: legacy.id })).toEqual({
        source: "https://legacy.example/mcp",
        config: { preset: legacy.id, auth: { type: "bearer" } },
      });
    } finally {
      MCP_SOURCE_PRESETS.pop();
    }
  });

  it("rejects a credential for a no-auth install before any request", async () => {
    const fetch = vi.fn();
    await expect(
      verifyMcpInstall({
        source: "https://mcp.deepwiki.com/mcp",
        config: { preset: "deepwiki", auth: { type: "none" } },
        credential: "fake-no-auth-credential",
        remote: { fetch: fetch as unknown as typeof globalThis.fetch },
      }),
    ).rejects.toThrow("This connector does not accept a credential");
    expect(fetch).not.toHaveBeenCalled();
  });
});
