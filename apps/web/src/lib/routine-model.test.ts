import { describe, expect, it } from "vitest";
import { isRoutineModelMissing, shouldWarnRoutineModelMissing } from "./routine-model";

const connected = [{ key: "anthropic:claude-sonnet-5" }, { key: "openai:gpt-6.1" }];

describe("isRoutineModelMissing", () => {
  it("lets a routine follow the bot's model", () => {
    expect(isRoutineModelMissing("", connected)).toBe(false);
  });

  it("accepts a model whose connection still exists", () => {
    expect(isRoutineModelMissing("openai:gpt-6.1", connected)).toBe(false);
  });

  it("flags a pinned model that is no longer connected", () => {
    expect(isRoutineModelMissing("openai:retired-model", connected)).toBe(true);
  });

  it("stays quiet until the model list has loaded successfully", () => {
    expect(shouldWarnRoutineModelMissing("loading", "openai:retired-model", [])).toBe(false);
    expect(shouldWarnRoutineModelMissing("failed", "openai:retired-model", [])).toBe(false);
    expect(shouldWarnRoutineModelMissing("ready", "openai:retired-model", connected)).toBe(true);
  });
});
