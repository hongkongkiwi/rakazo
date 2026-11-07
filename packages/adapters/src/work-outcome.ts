import type { AdapterContext, ArtifactStore } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { MessageBlock as MessageBlockSchema } from "@rakazo/contracts";
import { humanizeToolName, redactSecrets } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { builtinAgentTools } from "./builtin-tools.js";

export type OutcomeScope = {
  runId: string;
  spaceId: string;
  botId: string;
  userId: string;
  /** Every value this run must never show, as collected while it ran. */
  secrets?: readonly string[];
};

type OutcomeBlock = Extract<MessageBlock, { kind: "outcome" }>;
type OutcomeEntry = OutcomeBlock["entries"][number];

/**
 * Builtin effects whose result lands somewhere the user can see outside this chat.
 * Computer, file, page and media tools are left out: their own cards are the record,
 * and a missing file or page is reported separately below.
 */
const REPORTED_BUILTIN_TOOLS = new Set([
  "send_email",
  "delete_email",
  "message_user",
  "message_bot",
  "message_agent",
  "handoff_to_bot",
  "connect_agent",
  "connect_app",
  "add_mcp_server",
  "create_group",
  "create_space",
  "archive_bot",
  "organize_bot",
  "spawn_bot",
  "ticket_create",
  "ticket_update",
  "ticket_comment",
  "board_tickets",
  "create_child_routine",
  "schedule_create",
  "schedule_update",
  "schedule_cancel",
  "cloud_agent_launch",
  "cloud_agent_reply",
  "cloud_agent_cancel",
  "skill_create",
  "skill_update",
  "skill_delete",
  "claim_email_address",
  "respond_agent_connection",
  "set_child_bot_model",
  "set_child_instructions",
  "update_bot",
  "update_group",
  "update_preferences",
  "forget_secret",
]);

const BUILTIN_NAMES = new Set(builtinAgentTools.map((tool) => tool.name));
const EFFECT_STATUSES = ["completed", "uncertain", "executing", "intended"] as const;
const TARGET_TEXT_KEYS = ["subject", "title", "name", "to", "recipient", "channel", "space", "bot"];
const MAX_ENTRIES = 20;
const MAX_DETAIL = 80;
/** The contract's label bound; artifact names can be this long. */
const MAX_LABEL = 255;

/** One line of page text, with control characters flattened. */
function oneLine(value: string): string {
  let text = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    text += code < 0x20 || code === 0x7f ? " " : character;
  }
  return text.replace(/\s+/g, " ").trim();
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const text = oneLine(value);
    return text ? text.slice(0, 200) : undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = stringValue(item);
      if (text) return text;
    }
  }
  return undefined;
}

/** An http(s) address without its query or fragment, which may carry private data. */
function safeUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return `${url.origin}${url.pathname}`.slice(0, 2048);
  } catch {
    return undefined;
  }
}

function targetOf(request: unknown): { detail?: string; url?: string } {
  if (!request || typeof request !== "object" || Array.isArray(request)) return {};
  const record = request as Record<string, unknown>;
  const url = stringValue(record.url) ?? stringValue(record.link);
  const safe = url ? safeUrl(url) : undefined;
  if (safe) return { url: safe, detail: safe.slice(0, MAX_DETAIL) };
  for (const key of TARGET_TEXT_KEYS) {
    const value = stringValue(record[key]);
    if (value) return { detail: value.slice(0, MAX_DETAIL) };
  }
  return {};
}

function actionLabel(tool: string): string {
  // Connector names carry a namespace: `mcp__server__tool`, or an uppercase provider
  // prefix such as `COMPOSIO_SEND_EMAIL`. It says nothing about the action.
  const scoped = tool.includes("__")
    ? tool.slice(tool.lastIndexOf("__") + 2)
    : tool.replace(/^[A-Z0-9]+_/, "");
  return humanizeToolName(scoped).slice(0, 200) || tool.slice(0, 200);
}

function reportedStatus(status: string, result: unknown): OutcomeEntry["status"] {
  if (status !== "completed") return "unchecked";
  if (result && typeof result === "object" && "ok" in result) {
    if ((result as { ok?: unknown }).ok === false) return "failed";
  }
  return "reported";
}

function shouldReport(tool: string): boolean {
  // Work inside a computer is not a change to the user's own destinations.
  if (tool.startsWith("user_computer_")) return false;
  return !BUILTIN_NAMES.has(tool) || REPORTED_BUILTIN_TOOLS.has(tool);
}

function groupKey(entry: OutcomeEntry): string {
  return [
    entry.kind,
    entry.label,
    entry.detail ?? "",
    entry.status,
    entry.url ?? "",
    // Two versions of one file share a name but are different results.
    entry.artifactId ?? entry.pageId ?? "",
  ].join("\u001f");
}

function addEntry(entries: OutcomeEntry[], entry: OutcomeEntry, secrets: readonly string[]) {
  const bounded: OutcomeEntry = {
    ...entry,
    // A tool argument or saved name can repeat a value the run must not show.
    label: redactSecrets(entry.label, secrets).slice(0, MAX_LABEL),
    ...(entry.detail ? { detail: redactSecrets(entry.detail, secrets).slice(0, 300) } : {}),
    ...(entry.url ? { url: redactSecrets(entry.url, secrets).slice(0, 2048) } : {}),
  };
  const key = groupKey(bounded);
  const existing = entries.find((candidate) => groupKey(candidate) === key);
  if (existing) {
    existing.count = (existing.count ?? 1) + 1;
    return;
  }
  entries.push(bounded);
}

async function failedPages(prisma: PrismaClient, scope: OutcomeScope): Promise<OutcomeEntry[]> {
  const messages = await prisma.message.findMany({
    where: { runId: scope.runId, role: "bot" },
    select: { blocks: true },
  });
  const pages = new Map<string, Extract<MessageBlock, { kind: "page" }>>();
  for (const message of messages) {
    const parsed = MessageBlockSchema.array().safeParse(message.blocks);
    if (!parsed.success) continue;
    for (const block of parsed.data) {
      if (block.kind === "page") pages.set(`${block.pageId}:${block.version}`, block);
    }
  }
  const failures: OutcomeEntry[] = [];
  for (const page of pages.values()) {
    const stored = await prisma.page.findFirst({
      where: { id: page.pageId, spaceId: scope.spaceId },
      select: { id: true },
    });
    const version = stored
      ? await prisma.pageVersion.findUnique({
          where: { pageId_version: { pageId: page.pageId, version: page.version } },
          select: { id: true },
        })
      : null;
    if (!version)
      failures.push({
        kind: "page",
        label: page.title,
        status: "failed",
        pageId: page.pageId,
        version: page.version,
        detail: "The saved page could not be found.",
      });
  }
  return failures;
}

async function missingFiles(
  deps: { prisma: PrismaClient; artifacts?: ArtifactStore },
  scope: OutcomeScope,
): Promise<OutcomeEntry[]> {
  const { artifacts } = deps;
  if (!artifacts?.has) return [];
  const stored = await deps.prisma.artifact.findMany({
    where: { runId: scope.runId },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, storageKey: true },
  });
  if (stored.length === 0) return [];
  const context: AdapterContext = {
    operationId: `outcome:${scope.runId}`,
    traceId: `outcome:${scope.runId}`,
    spaceId: scope.spaceId,
    userId: scope.userId,
    botId: scope.botId,
    signal: new AbortController().signal,
  };
  const failures: OutcomeEntry[] = [];
  for (const artifact of stored) {
    let present: boolean | null;
    try {
      present = await artifacts.has(artifact.storageKey, context);
    } catch (error) {
      getLogger().warn("artifact outcome check failed", {
        "artifact.id": artifact.id,
        "error.message": error instanceof Error ? error.message : String(error),
      });
      // The store could not answer; that is not the same as a missing file.
      present = null;
    }
    if (present === false)
      failures.push({
        kind: "file",
        label: artifact.name,
        status: "failed",
        artifactId: artifact.id,
        detail: "The saved file could not be found.",
      });
  }
  return failures;
}

/**
 * A compact record of what a finished turn changed outside the chat, with the checks
 * that failed afterwards. Ordinary successes stay out of sight: the bot's reply and
 * the destination's own card are the record. Never throws into the run.
 */
export async function buildOutcomeBlock(
  deps: { prisma: PrismaClient; artifacts?: ArtifactStore },
  scope: OutcomeScope,
): Promise<OutcomeBlock | null> {
  const entries: OutcomeEntry[] = [];
  const effects = await deps.prisma.externalEffect.findMany({
    where: { runId: scope.runId, status: { in: [...EFFECT_STATUSES] } },
    orderBy: { createdAt: "asc" },
    select: { kind: true, status: true, request: true, result: true },
  });
  for (const effect of effects) {
    if (!shouldReport(effect.kind)) continue;
    addEntry(
      entries,
      {
        kind: "action",
        label: actionLabel(effect.kind),
        status: reportedStatus(effect.status, effect.result),
        ...targetOf(effect.request),
      },
      scope.secrets ?? [],
    );
  }
  for (const failure of await missingFiles(deps, scope))
    addEntry(entries, failure, scope.secrets ?? []);
  for (const failure of await failedPages(deps.prisma, scope))
    addEntry(entries, failure, scope.secrets ?? []);
  if (entries.length === 0) return null;
  const order = { failed: 0, unchecked: 1, reported: 2 } as const;
  entries.sort((a, b) => order[a.status] - order[b.status]);
  return { kind: "outcome", entries: entries.slice(0, MAX_ENTRIES) };
}
