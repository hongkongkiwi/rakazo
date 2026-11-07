import { describe, expect, it } from "vitest";
import { BotSchema, UpdateBotInput } from "./domain.js";

describe("page decider settings", () => {
  it("defaults an older bot payload to off", () => {
    expect(BotSchema.shape.pageDeciderProvider.parse(undefined)).toBeNull();
    expect(BotSchema.shape.pageDeciderModelId.parse(undefined)).toBeNull();
  });

  it("accepts both settings together and clearing them together", () => {
    for (const input of [
      { botId: "bot-1", pageDeciderProvider: "openai", pageDeciderModelId: "gpt-4.1" },
      { botId: "bot-1", pageDeciderProvider: null, pageDeciderModelId: null },
    ]) {
      expect(UpdateBotInput.safeParse(input).success).toBe(true);
    }
  });

  it.each([
    ["provider alone", { pageDeciderProvider: "openai" }],
    ["model alone", { pageDeciderModelId: "gpt-4.1" }],
    ["a half-cleared pair", { pageDeciderProvider: null, pageDeciderModelId: "gpt-4.1" }],
    ["an empty provider", { pageDeciderProvider: "", pageDeciderModelId: "gpt-4.1" }],
  ])("rejects %s", (_name, extra) => {
    expect(UpdateBotInput.safeParse({ botId: "bot-1", ...extra }).success).toBe(false);
  });

  it("leaves the run model's own pair rule alone", () => {
    expect(
      UpdateBotInput.safeParse({ botId: "bot-1", modelProvider: "openai", modelId: "gpt-4.1" })
        .success,
    ).toBe(true);
    expect(UpdateBotInput.safeParse({ botId: "bot-1", modelProvider: "openai" }).success).toBe(
      false,
    );
  });
});
