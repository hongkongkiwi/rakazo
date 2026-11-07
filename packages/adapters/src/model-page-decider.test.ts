import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
  ComputerRef,
  PageDecisionRequest,
} from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { ModelPageDecider } from "./model-page-decider.js";

const computer: ComputerRef = { id: "c1", botId: "b1", kind: "fake", providerRef: "c1" };
const context: AdapterContext = {
  operationId: "op",
  traceId: "trace",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};
const run = { runId: "run-1", botId: "b1", threadId: "t1" };
const model = { provider: "fake", id: "text-only" };

function request(overrides: Partial<PageDecisionRequest> = {}): PageDecisionRequest {
  return {
    goal: "Open the guide",
    elements: [{ ref: "e1", role: "link", name: "Guide", tag: "a" }],
    excerpt: '- link "Guide" [e1]',
    url: "https://example.test/private/path?token=fake",
    title: "Guide",
    history: [],
    ...overrides,
  };
}

function runtimeFor(events: AgentRuntimeEvent[] | (() => AgentRuntimeEvent[])) {
  const requests: AgentRunRequest[] = [];
  const runtime: AgentRuntime = {
    describe: () => ({
      id: "fake",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { streaming: false, compaction: false, tools: false, scripted: true },
    }),
    run(input) {
      requests.push(input);
      const resolved = typeof events === "function" ? events() : events;
      return (async function* () {
        yield* resolved;
      })();
    },
    async abort() {},
  };
  return { runtime, requests };
}

const answer = (value: unknown) => [{ type: "done" as const, text: JSON.stringify(value) }];

describe("ModelPageDecider", () => {
  it("sends text only, keeps the origin and returns only offered click candidates", async () => {
    const { runtime, requests } = runtimeFor(
      answer({
        candidates: [
          { ref: "e1", kind: "click", confidence: 0.9 },
          { ref: "missing", kind: "click", confidence: 1 },
          { ref: "e1", kind: "fill", confidence: 1 },
        ],
        goalMet: 0.1,
        stuck: 0,
        blocked: 0,
      }),
    );
    const decider = new ModelPageDecider({ runtime, model, run });

    const decision = await decider.decide(computer, request(), context);

    // The model may name any offered control; only click candidates can ever act, per policy.
    expect(decision.candidates).toEqual([
      { ref: "e1", kind: "click", confidence: 0.9 },
      { ref: "e1", kind: "fill", confidence: 1 },
    ]);
    expect(decision.candidates.some((candidate) => candidate.ref === "missing")).toBe(false);
    expect(decision.error).toBeUndefined();
    const sent = requests[0]!;
    expect(sent.model).toBe(model);
    expect(sent.tools).toEqual([]);
    expect(sent.history).toEqual([]);
    expect(sent.usageOperationKind).toBe("setup");
    const prompt = JSON.parse(sent.prompt) as Record<string, unknown>;
    expect(prompt.origin).toBe("https://example.test");
    expect(JSON.stringify(prompt)).not.toContain("/private/path");
    expect(JSON.stringify(sent)).not.toContain("screenshot");
    expect(sent.instructions).toContain("untrusted data");
    expect(sent.instructions).toContain("Never invent a ref");
  });

  it("returns an error decision for a reply that is not the agreed JSON", async () => {
    const { runtime } = runtimeFor([{ type: "done", text: "I would click the first link" }]);
    const decider = new ModelPageDecider({ runtime, model, run });

    const decision = await decider.decide(computer, request(), context);

    expect(decision).toMatchObject({
      candidates: [],
      goalMet: 0,
      stuck: 0,
      blocked: 0,
      error: expect.any(String),
    });
  });

  it("refuses a non-http page without calling the model", async () => {
    const { runtime, requests } = runtimeFor(answer({ candidates: [] }));
    const decider = new ModelPageDecider({ runtime, model, run });

    const decision = await decider.decide(
      computer,
      request({ url: "file:///private/page.html" }),
      context,
    );

    expect(requests).toEqual([]);
    expect(decision).toMatchObject({ candidates: [] });
  });

  it("forwards unaccounted usage once", async () => {
    const usage = {
      type: "usage" as const,
      provider: "fake",
      model: "text-only",
      inputTokens: 10,
      outputTokens: 2,
    };
    const { runtime } = runtimeFor([
      usage,
      {
        type: "usage",
        provider: "fake",
        model: "text-only",
        inputTokens: 0,
        outputTokens: 0,
        accounted: true,
      },
      { type: "done", text: JSON.stringify({ candidates: [], goalMet: 1, stuck: 0, blocked: 0 }) },
    ]);
    const onUsage = vi.fn(
      async (_event: Extract<AgentRuntimeEvent, { type: "usage" }>) => undefined,
    );
    const decider = new ModelPageDecider({ runtime, model, run, onUsage });

    await decider.decide(computer, request(), context);

    expect(onUsage).toHaveBeenCalledOnce();
    expect(onUsage.mock.calls[0]![0]).toMatchObject({ inputTokens: 10 });
  });

  it("describes itself as text only", () => {
    const { runtime } = runtimeFor([]);
    expect(new ModelPageDecider({ runtime, model, run }).describe().capabilities).toEqual({
      vision: false,
    });
  });
});
