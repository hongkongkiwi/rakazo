import type { AgentRuntime, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createResultReviewer } from "./result-review.js";

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "owner@example.test",
  isDeploymentOwner: false,
};

function fixture(
  options: { reply?: string; fail?: boolean; noModel?: boolean; activeRun?: boolean } = {},
) {
  const run = vi.fn(async function* (_request?: unknown, _context?: unknown) {
    if (options.fail) throw new Error("provider down");
    yield { type: "done", text: options.reply ?? "{}" } as AgentRuntimeEvent;
  });
  const prisma = {
    message: {
      findFirst: vi.fn(async (args: { where: { id: string } }) =>
        args.where.id === "message-1"
          ? {
              id: "message-1",
              blocks: [{ kind: "text", text: "I sent the report." }],
              runId: "run-1",
              seq: 10,
            }
          : null,
      ),
    },
    run: {
      findFirst: vi.fn(async () => ({
        status: options.activeRun ? "running" : "completed",
        modelProvider: "test",
        modelId: "worker-model",
        task: { prompt: "Send the weekly report" },
      })),
    },
    externalEffect: {
      findMany: vi.fn(async () => [{ kind: "send_email", status: "completed" }]),
    },
  };
  const reviewer = createResultReviewer({
    prisma: prisma as unknown as PrismaClient,
    runtime: { run, abort: vi.fn() } as unknown as AgentRuntime,
    resolveModel: async () => {
      if (options.noModel) throw new Error("no model");
      return { provider: "test", id: "review-model" } as never;
    },
  } as unknown as Parameters<typeof createResultReviewer>[0]);
  return { reviewer, run, prisma };
}

const input = { botId: "bot-1", threadId: "thread-1", messageId: "message-1" };

describe("result review", () => {
  it("parses a verdict and gives the model the request, reply, and effects", async () => {
    const { reviewer, run } = fixture({
      reply: '{"verdict":"pass","summary":"The reply matches the recorded send.","findings":[]}',
    });
    const review = await reviewer(actor, input);
    expect(review).toMatchObject({
      verdict: "pass",
      summary: "The reply matches the recorded send.",
      model: "test/review-model",
      reviewedModel: "test/worker-model",
      rubric: "result-review/v1",
    });
    const request = run.mock.calls[0]?.[0] as { prompt?: string; tools?: unknown[] };
    expect(request.prompt).toContain("Send the weekly report");
    expect(request.prompt).toContain("I sent the report.");
    expect(request.prompt).toContain("Send email: completed");
    expect(request.tools).toEqual([]);
  });

  it("treats an unusable answer as unclear, not a pass", async () => {
    const { reviewer } = fixture({ reply: "Looks fine to me." });
    const review = await reviewer(actor, input);
    expect(review.verdict).toBe("unclear");
    expect(review.summary).toContain("no usable assessment");
  });

  it("treats a failed model call as unclear", async () => {
    const { reviewer } = fixture({ fail: true });
    const review = await reviewer(actor, input);
    expect(review.verdict).toBe("unclear");
    expect(review.summary).toContain("could not be completed");
  });

  it("treats a missing model as unclear", async () => {
    const { reviewer } = fixture({ noModel: true });
    const review = await reviewer(actor, input);
    expect(review.verdict).toBe("unclear");
    expect(review.summary).toContain("No review model");
  });

  it("does not review a message whose run is still working", async () => {
    const { reviewer } = fixture({ activeRun: true });
    await expect(reviewer(actor, input)).rejects.toThrow("still working");
  });

  it("refuses a message outside the bot thread", async () => {
    const { reviewer } = fixture();
    await expect(reviewer(actor, { ...input, messageId: "other-message" })).rejects.toThrow();
  });
});
