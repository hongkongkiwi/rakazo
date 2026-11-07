import type { Message, ToolCall } from "@earendil-works/pi-ai";
import type { AgentRunModel } from "@rakazo/adapter-kit";
import { withoutThinkingFrom } from "./thinking-signatures.js";

export interface ComputerModeSelection {
  provider: string;
  id: string;
  connectionId?: string;
  auth: "oauth" | "api-key";
  thinkingLevel?: AgentRunModel["thinkingLevel"];
}

export interface ComputerModeCheckpoint {
  version: 1;
  mode: "main" | "computer";
  main: ComputerModeSelection;
  computer: ComputerModeSelection;
}

/** Internal, versioned transcript; never a client event payload. */
export interface TurnCheckpoint {
  version: 1;
  /** Credential-free role state; absent on legacy checkpoints. */
  computerMode?: ComputerModeCheckpoint;
  provider: string;
  model: string;
  systemPrompt: string;
  pendingToolCallId: string;
  messages: Message[];
  historyMessageIds?: string[];
  /** The instructions the saved system prompt was built from; own writes resume guarding on it. */
  ownInstructionsBaseline?: string;
  /** Executor-assigned occurrences include canonical arguments and the paused call. */
  effectOccurrences?: Array<{ executionId: string; fingerprint: string; occurrence: number }>;
  /** Only explicit sequential checkpoints guarantee an unstarted tail. */
  executionMode?: "parallel" | "sequential";
}

export function serializeTurnCheckpoint(checkpoint: TurnCheckpoint): string {
  return JSON.stringify(checkpoint);
}

/** The provider and model a saved turn last ran on, when the blob names them. */
export function checkpointProviderModel(
  blob: string,
): { provider: string; model: string } | undefined {
  try {
    const checkpoint = JSON.parse(blob) as { provider?: unknown; model?: unknown };
    return typeof checkpoint.provider === "string" && typeof checkpoint.model === "string"
      ? { provider: checkpoint.provider, model: checkpoint.model }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Added to a resumed checkpoint's system prompt when the model changed mid-task. */
export const MODEL_SWITCH_INSTRUCTION =
  "This run continues after a model change. The transcript is the same task, not new instructions. Before repeating a tool call whose outcome is uncertain, verify the destination first.";

/** The runtime resumes from the checkpoint's own prompt, so the reminder travels inside it. */
export function withModelSwitchInstruction(blob: string): string {
  try {
    const checkpoint = JSON.parse(blob) as { systemPrompt?: unknown };
    if (
      typeof checkpoint.systemPrompt !== "string" ||
      checkpoint.systemPrompt.includes(MODEL_SWITCH_INSTRUCTION)
    )
      return blob;
    return JSON.stringify({
      ...checkpoint,
      systemPrompt: `${checkpoint.systemPrompt}\n\n${MODEL_SWITCH_INSTRUCTION}`,
    });
  } catch {
    return blob;
  }
}

export function restoreTurnCheckpoint(
  blob: string,
  model: Pick<AgentRunModel, "provider" | "id">,
): TurnCheckpoint {
  const checkpoint = JSON.parse(blob) as TurnCheckpoint;
  if (
    checkpoint.version !== 1 ||
    typeof checkpoint.systemPrompt !== "string" ||
    typeof checkpoint.provider !== "string" ||
    typeof checkpoint.model !== "string" ||
    typeof checkpoint.pendingToolCallId !== "string" ||
    !Array.isArray(checkpoint.messages)
  ) {
    throw new Error("Unsupported turn checkpoint");
  }
  const messages = [...checkpoint.messages];
  while (messages.at(-1)?.role === "assistant") {
    const tail = messages.at(-1)!;
    if (tail.role !== "assistant" || (tail.stopReason !== "aborted" && tail.stopReason !== "error"))
      break;
    messages.pop();
  }
  return {
    ...checkpoint,
    messages:
      checkpoint.provider === model.provider && checkpoint.model === model.id
        ? messages
        : withoutThinkingFrom(messages, 0),
  };
}

/** Match results in transcript order: wire IDs may repeat in later responses. */
export function unresolvedTurnCheckpointCalls(messages: Message[]): ToolCall[] {
  const pending = new Map<string, ToolCall>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of message.content) if (call.type === "toolCall") pending.set(call.id, call);
    } else if (message.role === "toolResult") {
      pending.delete(message.toolCallId);
    }
  }
  return [...pending.values()];
}
