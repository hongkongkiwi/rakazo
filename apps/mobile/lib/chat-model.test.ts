import type { ModelCatalogEntry } from "@rakazo/contracts";
import type { ChatModelChoice } from "@rakazo/core";
import { expect, it } from "vitest";
import { threadModelKey, threadModelPickerChoices } from "./chat-model";
import type { MobileBot, MobileMe } from "./mobile-types";

const catalog = [
  { provider: "provider-a", id: "model-a", label: "Model A" },
  { provider: "provider-a", id: "model-b", label: "Model B" },
] as ModelCatalogEntry[];
const t = (value: string) => value;

function bot(modelId: string | null): MobileBot {
  return {
    id: "bot-1",
    name: "Ada",
    modelProvider: modelId ? "provider-a" : null,
    modelId,
  } as MobileBot;
}

const me = {
  defaultProvider: "provider-a",
  defaultModel: "model-b",
} as MobileMe;

it("names the first row after the bot's own model, so following it is explicit", () => {
  const choices = threadModelPickerChoices(
    bot("model-a"),
    me,
    catalog,
    [],
    "provider-a::model-a",
    t,
  );

  expect(choices[0]).toMatchObject({ key: "", title: "Follow the bot", detail: "Model A" });
});

it("names the first row after the space default when the bot has no model of its own", () => {
  const choices = threadModelPickerChoices(bot(null), me, catalog, [], "", t);

  expect(choices[0]).toMatchObject({ key: "", title: "Space default", detail: "Model B" });
});

it("keeps a conversation's model listed when no connection offers it any more", () => {
  const choices: ChatModelChoice[] = threadModelPickerChoices(
    bot("model-a"),
    me,
    catalog,
    [],
    "other::retired-model",
    t,
  );

  expect(choices.some((choice) => choice.key === "other::retired-model")).toBe(true);
});

it("reads a conversation's model key, and nothing while it follows the bot", () => {
  expect(threadModelKey({ modelProvider: "provider-a", modelId: "model-a" })).toBe(
    "provider-a::model-a",
  );
  expect(threadModelKey({ modelProvider: null, modelId: null })).toBe("");
  expect(threadModelKey(undefined)).toBe("");
});
