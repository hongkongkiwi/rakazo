import type { ChatModelChoice } from "@rakazo/core";
import { chatModelChoices, connectedModelChoices, modelOptionKey } from "@rakazo/core";
import type { MobileBot, MobileMe, MobileModel, MobileModelCredential } from "./mobile-types";

/** What a chat's model picker lists, with the space default named after its model. */
export function chatModelPickerChoices(
  me: MobileMe | null,
  catalog: MobileModel[],
  credentials: MobileModelCredential[],
  selectedKey: string,
  t: (message: string) => string,
): ChatModelChoice[] {
  const defaultEntry = me?.defaultModel
    ? catalogEntry(catalog, me.defaultProvider, me.defaultModel)
    : undefined;
  const spaceDefaultLabel = me?.defaultModel
    ? `${t("Space default")} (${defaultEntry?.label ?? me.defaultModel})`
    : t("Space default");
  const choices = chatModelChoices(
    connectedModelChoices(credentials, catalog),
    selectedKey,
    spaceDefaultLabel,
    defaultEntry?.images,
  );
  choices[0] = {
    ...choices[0]!,
    title: t("Space default"),
    detail: me?.defaultModel ? (defaultEntry?.label ?? me.defaultModel) : undefined,
  };
  return choices;
}

function catalogEntry(
  catalog: MobileModel[],
  provider: string | null | undefined,
  modelId: string,
) {
  if (!provider) return undefined;
  return catalog.find((entry) => entry.provider === provider && entry.id === modelId);
}

/** A conversation's own model key, or "" while it follows the bot. */
export function threadModelKey(
  model:
    | {
        modelProvider: string | null;
        modelId: string | null;
      }
    | null
    | undefined,
): string {
  return model?.modelProvider && model.modelId
    ? modelOptionKey(model.modelProvider, model.modelId)
    : "";
}

/**
 * What a conversation's model picker lists. The first row clears its own choice, so
 * it names the model the conversation falls back to: the bot's, or the space default.
 */
export function threadModelPickerChoices(
  bot: MobileBot | null,
  me: MobileMe | null,
  catalog: MobileModel[],
  credentials: MobileModelCredential[],
  selectedKey: string,
  t: (message: string) => string,
): ChatModelChoice[] {
  const botEntry =
    bot?.modelProvider && bot.modelId
      ? catalogEntry(catalog, bot.modelProvider, bot.modelId)
      : undefined;
  const defaultEntry = me?.defaultModel
    ? catalogEntry(catalog, me.defaultProvider, me.defaultModel)
    : undefined;
  const followsBot = Boolean(bot?.modelProvider && bot.modelId);
  const followModel = followsBot
    ? (botEntry?.label ?? bot?.modelId)
    : (defaultEntry?.label ?? me?.defaultModel);
  const followLabel = `${followsBot ? t("Follow the bot") : t("Space default")}${
    followModel ? ` (${followModel})` : ""
  }`;
  const choices = chatModelChoices(
    connectedModelChoices(credentials, catalog),
    selectedKey,
    followLabel,
    followsBot ? botEntry?.images : defaultEntry?.images,
  );
  choices[0] = {
    ...choices[0]!,
    title: followsBot ? t("Follow the bot") : t("Space default"),
    detail: followModel ?? undefined,
  };
  return choices;
}
