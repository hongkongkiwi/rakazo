import type { McpSourcePreset } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { applyMcpSourcePreset, MCP_SOURCE_PRESETS } from "./installed-connectors.js";

const preset = (id: string) => MCP_SOURCE_PRESETS.find((entry) => entry.id === id);

describe("MCP source preset catalog", () => {
  it("offers every required verified vendor and no unsupported one", () => {
    const ids = MCP_SOURCE_PRESETS.map((entry) => entry.id);
    for (const required of [
      "context7",
      "deepwiki",
      "executor",
      "github",
      "linear",
      "perplexity",
      "treg",
    ]) {
      expect(ids, required).toContain(required);
    }
    // Vendors with no verified preset must never appear, even as a guess.
    for (const unsupported of ["asana", "figma", "jira", "notion", "slack"]) {
      expect(ids, unsupported).not.toContain(unsupported);
    }
  });

  it("pins each new vendor's verified endpoint and auth", () => {
    const expected: Record<string, { url: string; auth: McpSourcePreset["auth"] }> = {
      deepwiki: { url: "https://mcp.deepwiki.com/mcp", auth: "none" },
      linear: { url: "https://mcp.linear.app/mcp", auth: "bearer" },
      github: { url: "https://api.githubcopilot.com/mcp/", auth: "bearer" },
      context7: { url: "https://mcp.context7.com/mcp", auth: "bearer" },
      perplexity: { url: "https://api.perplexity.ai/mcp", auth: "bearer" },
    };
    for (const [id, want] of Object.entries(expected)) {
      expect(preset(id)?.url, id).toBe(want.url);
      expect(preset(id)?.auth, id).toBe(want.auth);
    }
  });

  it("keeps legacy presets unchanged and defaults their auth to bearer", () => {
    expect(preset("executor")).toMatchObject({ name: "Executor", auth: "bearer" });
    expect(preset("executor")?.url).toBeUndefined();
    expect(preset("treg")).toMatchObject({
      url: "https://treg.to/mcp/",
      auth: "bearer",
    });
  });

  it("carries only preset fields, never credential values", () => {
    const allowed = new Set(["id", "name", "url", "urlPlaceholder", "auth"]);
    for (const entry of MCP_SOURCE_PRESETS) {
      expect(
        Object.keys(entry).every((key) => allowed.has(key)),
        entry.id,
      ).toBe(true);
    }
  });
});

describe("applyMcpSourcePreset", () => {
  it("stores the legacy open-URL preset as a custom bearer source", () => {
    expect(applyMcpSourcePreset("https://mine.example/mcp", { preset: "executor" })).toEqual({
      source: "https://mine.example/mcp",
      config: { preset: "custom", auth: { type: "bearer" } },
    });
  });

  it("keeps the legacy fixed-URL preset pinned with bearer auth", () => {
    expect(
      applyMcpSourcePreset("https://elsewhere.example/mcp", {
        preset: "treg",
        auth: { type: "none" },
      }),
    ).toEqual({
      source: "https://treg.to/mcp/",
      config: { preset: "treg", auth: { type: "bearer" } },
    });
  });

  it("stores an unknown preset id as custom, untouched", () => {
    expect(applyMcpSourcePreset("https://mine.example/mcp", { preset: "not-offered" })).toEqual({
      source: "https://mine.example/mcp",
      config: { preset: "custom" },
    });
  });

  it("leaves custom sources untouched", () => {
    const config = { preset: "custom", auth: { type: "header", name: "x-api-key" } };
    expect(applyMcpSourcePreset("https://mine.example/mcp", config)).toEqual({
      source: "https://mine.example/mcp",
      config,
    });
  });

  it("overrides the caller's auth with a bearer preset's auth", () => {
    expect(
      applyMcpSourcePreset("https://elsewhere.example/mcp", {
        preset: "linear",
        auth: { type: "header", name: "x-api-key" },
      }),
    ).toEqual({
      source: "https://mcp.linear.app/mcp",
      config: { preset: "linear", auth: { type: "bearer" } },
    });
  });

  it("strips credential-in-header config from a none preset", () => {
    expect(
      applyMcpSourcePreset("https://elsewhere.example/mcp", {
        preset: "deepwiki",
        auth: { type: "header", name: "x-api-key" },
      }),
    ).toEqual({
      source: "https://mcp.deepwiki.com/mcp",
      config: { preset: "deepwiki", auth: { type: "none" } },
    });
  });

  it("never converts an oauth preset to bearer auth", () => {
    // Fixture preset: no oauth vendor ships in the catalog, so the fixture
    // exercises the normalization rule and is removed before the test ends.
    const fixture: McpSourcePreset = {
      id: "oauth-fixture",
      name: "OAuth Fixture",
      url: "https://oauth.example/mcp",
      auth: "oauth",
    };
    MCP_SOURCE_PRESETS.push(fixture);
    try {
      let result: ReturnType<typeof applyMcpSourcePreset> | undefined;
      let thrown: unknown;
      try {
        result = applyMcpSourcePreset("https://mine.example/mcp", { preset: fixture.id });
      } catch (error) {
        thrown = error;
      }
      if (result) {
        expect(thrown).toBeUndefined();
        expect(result.config).not.toEqual({
          preset: fixture.id,
          auth: { type: "bearer" },
        });
        expect(JSON.stringify(result.config)).not.toContain('"type":"bearer"');
      } else {
        // Rejecting with an error is equally correct: the generic bearer install
        // must not accept an oauth preset.
        expect(thrown).toBeInstanceOf(Error);
      }
    } finally {
      MCP_SOURCE_PRESETS.pop();
    }
  });
});
