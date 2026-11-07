import type { PageDecider } from "@rakazo/adapter-kit";
import { recordUsage } from "@rakazo/db";
import type { ExecutorDeps } from "./executor-deps.js";
import { ModelPageDecider } from "./model-page-decider.js";
import { resolveConnectedRunModel } from "./run-model.js";

/**
 * A bot's opt-in page decider, resolved for one run. Absent settings mean the feature is
 * off and the browser tools behave exactly as before. A choice that no longer resolves
 * throws, and the caller falls back to the original tool result.
 */
export async function createConfiguredPageDecider(options: {
  deps: ExecutorDeps;
  run: { id: string; userId: string; spaceId: string };
  bot: { id: string; pageDeciderProvider: string | null; pageDeciderModelId: string | null };
  threadId: string;
  registerSecrets: (values: string[]) => void;
}): Promise<PageDecider | undefined> {
  const provider = options.bot.pageDeciderProvider?.trim();
  const modelId = options.bot.pageDeciderModelId?.trim();
  if (!provider || !modelId) return undefined;
  const model = await resolveConnectedRunModel(
    options.deps,
    { userId: options.run.userId, spaceId: options.run.spaceId },
    provider,
    modelId,
    options.registerSecrets,
  );
  return new ModelPageDecider({
    runtime: options.deps.runtime,
    model,
    run: { runId: options.run.id, botId: options.bot.id, threadId: options.threadId },
    onUsage: (event) =>
      recordUsage(options.deps.prisma, event, {
        spaceId: options.run.spaceId,
        userId: options.run.userId,
        botId: options.bot.id,
        runId: options.run.id,
        parentRunId: options.run.id,
        operationId: `page-decider:${options.run.id}`,
        operationKind: "setup",
      }),
  });
}
