import type { ChatModelChoice } from "@rakazo/core";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ModelPickerList } from "../components/model-picker-list";
import { rpc } from "../lib/api";
import { threadModelKey, threadModelPickerChoices } from "../lib/chat-model";
import { useI18n } from "../lib/i18n";
import { errorText } from "../lib/user-error";

/** This conversation's model: a pick lasts until it is changed again. */
export default function ThreadModelScreen() {
  const { t } = useI18n();
  const router = useRouter();
  const { botId = "" } = useLocalSearchParams<{ botId: string }>();
  const [choices, setChoices] = useState<ChatModelChoice[] | null>(null);
  const [botKey, setBotKey] = useState("");
  const [selectedKey, setSelectedKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const picking = useRef(false);

  useEffect(() => {
    void Promise.all([
      rpc("bots/get", { botId }),
      rpc("me"),
      rpc("models/list"),
      rpc("models/credentials"),
      rpc("threads/get", { botId }),
    ])
      .then(([bot, me, catalog, credentials, snapshot]) => {
        const key = threadModelKey(snapshot.model);
        setBotKey(threadModelKey(bot));
        setSelectedKey(key);
        setChoices(threadModelPickerChoices(bot, me, catalog, credentials, key, t));
      })
      .catch((err) => setError(errorText(err, t("Could not load models"))));
  }, [botId, t]);

  async function pick(choice: ChatModelChoice) {
    // One write at a time: a second tap before the first lands must not pop this screen twice.
    if (picking.current) return;
    picking.current = true;
    // Picking the bot's own model clears the conversation's choice, so the bot's thinking applies.
    const followsBot = !choice.key || choice.key === botKey;
    try {
      await rpc("threads/setModel", {
        botId,
        modelProvider: followsBot ? null : (choice.provider ?? null),
        modelId: followsBot ? null : (choice.modelId ?? null),
        thinkingLevel: null,
      });
      router.back();
    } catch (err) {
      picking.current = false;
      setError(errorText(err, t("Could not switch the model")));
    }
  }

  return (
    <ModelPickerList
      choices={choices}
      selectedKey={selectedKey}
      error={error}
      onSelect={(choice) => void pick(choice)}
    />
  );
}
