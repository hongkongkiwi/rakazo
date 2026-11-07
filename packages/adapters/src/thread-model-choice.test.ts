import { describe, expect, it } from "vitest";
import { runModelChoice } from "./model-selection.js";

const bot = { modelProvider: "provider-a", modelId: "model-a", thinkingLevel: "high" };

describe("thread model choice", () => {
  const run = { modelProvider: "provider-b", modelId: "model-b", thinkingLevel: "medium" };
  const thread = { modelProvider: "provider-c", modelId: "model-c", thinkingLevel: "low" };

  it.each([false, undefined])("uses the thread's model when the run's pin is %s", (modelPinned) => {
    expect(runModelChoice({ ...run, modelPinned }, bot, thread)).toEqual(thread);
  });

  it.each([null, undefined])("follows the bot when the thread override is %s", (override) => {
    expect(runModelChoice(run, bot, override)).toEqual(bot);
  });

  it("keeps a pinned run on its model when the thread has an override", () => {
    expect(runModelChoice({ ...run, modelPinned: true }, bot, thread)).toEqual(run);
  });

  it.each([
    { modelProvider: "provider-c", modelId: null, thinkingLevel: "low" },
    { modelProvider: "provider-c", modelId: "", thinkingLevel: "low" },
    { modelProvider: null, modelId: "model-c", thinkingLevel: "low" },
  ])("ignores an incomplete thread override %j", (override) => {
    expect(runModelChoice(run, bot, override)).toEqual(bot);
  });

  it("keeps the thread's null thinking level instead of inheriting the bot's", () => {
    expect(runModelChoice(run, bot, { ...thread, thinkingLevel: null })).toEqual({
      ...thread,
      thinkingLevel: null,
    });
  });
});
