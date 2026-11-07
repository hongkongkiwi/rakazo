import { useLingui } from "@lingui/react/macro";
import type { ModelCatalogEntry, ThreadModel } from "@rakazo/contracts";
import {
  chatModelChoices,
  connectedModelChoices,
  groupModelChoices,
  modelChoiceSearchText,
  modelOptionKey,
  parseModelOptionKey,
} from "@rakazo/core";
import { Button, Popover, PopoverContent, PopoverTrigger, toast } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { ChevronDownIcon } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { useSpaceQueries } from "../../lib/query";
import { useSpaceRpc } from "../../lib/space-rpc";
import { useListSearch } from "../../lib/use-list-search";
import { errorText } from "../../lib/user-error";
import { ModelChoiceCommand } from "./chat-model-picker";

const NO_CREDENTIALS: never[] = [];
const NO_CATALOG: never[] = [];

/**
 * The model this conversation runs on, beside its name. A pick here lasts for the
 * conversation; saving it for the bot is a separate, explicit step.
 */
export function ThreadModelChip({
  botId,
  botProvider,
  botModelId,
  threadModel,
  onChanged,
}: {
  botId: string;
  botProvider: string | null;
  botModelId: string | null;
  threadModel: ThreadModel | undefined;
  onChanged: () => Promise<void> | void;
}) {
  const { t } = useLingui();
  const rpc = useSpaceRpc();
  const queries = useSpaceQueries();
  const credentials = useQuery(queries.models.credentials.queryOptions()).data ?? NO_CREDENTIALS;
  const catalog = useQuery(queries.models.list.queryOptions()).data ?? NO_CATALOG;
  const me = useQuery(queries.me.queryOptions()).data ?? null;
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const imagesHintId = useId();

  const botKey = botProvider && botModelId ? modelOptionKey(botProvider, botModelId) : "";
  const threadKey =
    threadModel?.modelProvider && threadModel.modelId
      ? modelOptionKey(threadModel.modelProvider, threadModel.modelId)
      : "";
  // The first row clears the conversation's choice, so it names the model that follows.
  const followLabel = botKey ? labelFor(catalog, botKey, t`Bot default`) : t`Space default`;
  const choices = useMemo(
    () =>
      chatModelChoices(
        connectedModelChoices(credentials, catalog),
        threadKey,
        threadKey ? t`Follow the bot` : followLabel,
      ),
    [catalog, credentials, followLabel, t, threadKey],
  );
  const { query, setQuery, visible } = useListSearch(choices, { text: modelChoiceSearchText });
  const sections = useMemo(() => groupModelChoices(visible, ""), [visible]);
  const effectiveKey = threadKey || botKey;
  const effectiveLabel = effectiveKey
    ? labelFor(catalog, effectiveKey, t`Model`)
    : (labelForQuery(catalog, me?.defaultProvider, me?.defaultModel) ?? t`Space default`);

  /** A pick applies to this conversation; picking the bot's own model clears the choice. */
  async function choose(key: string) {
    setOpen(false);
    setQuery("");
    setPending(true);
    try {
      const parsed = key ? parseModelOptionKey(key) : null;
      const sameAsBot =
        (parsed?.provider ?? null) === botProvider && (parsed?.modelId ?? null) === botModelId;
      await rpc.threads.setModel({
        botId,
        modelProvider: sameAsBot ? null : (parsed?.provider ?? null),
        modelId: sameAsBot ? null : (parsed?.modelId ?? null),
        thinkingLevel: null,
      });
      await onChanged();
    } catch (error) {
      toast.error(errorText(error, t`Could not switch the model`));
    } finally {
      setPending(false);
    }
  }

  /** Make the conversation's model the bot's, then let the conversation follow it. */
  async function saveForBot() {
    const parsed = parseModelOptionKey(effectiveKey);
    if (!parsed) return;
    setOpen(false);
    setPending(true);
    try {
      await rpc.bots.update({
        botId,
        modelProvider: parsed.provider,
        modelId: parsed.modelId,
        thinkingLevel: threadModel?.thinkingLevel ?? null,
      });
      await rpc.threads.setModel({
        botId,
        modelProvider: null,
        modelId: null,
        thinkingLevel: null,
      });
      await onChanged();
    } catch (error) {
      toast.error(errorText(error, t`Could not save the model`));
    } finally {
      setPending(false);
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger
        render={
          <Button
            variant="floating"
            disabled={pending}
            className="app-no-drag h-8 gap-1.5 rounded-full px-3 text-body-sm"
          />
        }
        aria-label={t`Model: ${effectiveLabel}`}
      >
        <span className="max-w-40 truncate">{effectiveLabel}</span>
        <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      </PopoverTrigger>
      {open ? (
        <PopoverContent
          align="end"
          side="bottom"
          collisionAvoidance={{ side: "flip", align: "shift", fallbackAxisSide: "none" }}
          className="w-72 gap-0 overflow-hidden bg-popover p-0 opacity-100 animate-none! backdrop-filter-none"
        >
          <ModelChoiceCommand
            query={query}
            setQuery={setQuery}
            sections={sections}
            value={threadKey}
            imagesHintId={imagesHintId}
            onSelect={(key) => void choose(key)}
          />
          {threadKey && threadKey !== botKey ? (
            <div className="border-t border-border p-1">
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start"
                disabled={pending}
                onClick={() => void saveForBot()}
              >
                {t`Set as bot default`}
              </Button>
            </div>
          ) : null}
        </PopoverContent>
      ) : null}
    </Popover>
  );
}

/** The label a saved model key wears in the catalog, or its bare id. */
function labelFor(catalog: readonly ModelCatalogEntry[], key: string, fallback: string): string {
  const parsed = parseModelOptionKey(key);
  if (!parsed) return fallback;
  return labelForQuery(catalog, parsed.provider, parsed.modelId) ?? parsed.modelId ?? fallback;
}

function labelForQuery(
  catalog: readonly ModelCatalogEntry[],
  provider: string | null | undefined,
  modelId: string | null | undefined,
): string | undefined {
  if (!provider || !modelId) return undefined;
  return catalog.find((entry) => entry.provider === provider && entry.id === modelId)?.label;
}
