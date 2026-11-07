import { describe, expect, it } from "vitest";
import { DEFAULT_PAGE_DECISION_THRESHOLDS, decidePageAction } from "./page-decision-policy.js";

const target = "e1";

function input(
  overrides: {
    decision?: Partial<Parameters<typeof decidePageAction>[0]["decision"]>;
    budget?: Partial<Parameters<typeof decidePageAction>[0]["budget"]>;
    history?: Parameters<typeof decidePageAction>[0]["history"];
    knownTargets?: string[];
  } = {},
) {
  return {
    decision: {
      candidates: [{ target, kind: "click" as const, confidence: 0.9 }],
      goalMet: 0,
      stuck: 0,
      blocked: 0,
      ...overrides.decision,
    },
    budget: { steps: 0, elapsedMs: 0, ...overrides.budget },
    history: overrides.history ?? [],
    knownTargets: overrides.knownTargets ?? [target],
  };
}

describe("decidePageAction", () => {
  it("acts on the most confident offered click", () => {
    expect(
      decidePageAction(
        input({
          decision: {
            candidates: [
              { target: "e2", kind: "click", confidence: 0.75 },
              { target: "e1", kind: "click", confidence: 0.95 },
            ],
          },
          knownTargets: ["e1", "e2"],
        }),
      ),
    ).toEqual({ action: "act", target: "e1", kind: "click" });
  });

  it("reports done when the model says the goal is met", () => {
    expect(decidePageAction(input({ decision: { goalMet: 0.9 } }))).toEqual({ action: "done" });
  });

  it.each([
    ["a model error", { error: "bad reply" }],
    ["blocked", { blocked: 0.9 }],
    ["stuck", { stuck: 0.9 }],
  ])("stops on %s", (_name, decision) => {
    expect(decidePageAction(input({ decision }))).toEqual({ action: "stop" });
  });

  it("stops at the step and time budgets", () => {
    expect(
      decidePageAction(input({ budget: { steps: DEFAULT_PAGE_DECISION_THRESHOLDS.maxSteps } })),
    ).toEqual({ action: "stop" });
    expect(
      decidePageAction(
        input({ budget: { elapsedMs: DEFAULT_PAGE_DECISION_THRESHOLDS.maxElapsedMs } }),
      ),
    ).toEqual({ action: "stop" });
  });

  it("never acts on fill or type, an unknown ref, or low confidence", () => {
    for (const current of [
      input({ decision: { candidates: [{ target, kind: "fill", confidence: 1 }] } }),
      input({ decision: { candidates: [{ target, kind: "type", confidence: 1 }] } }),
      input({ decision: { candidates: [{ target: "other", kind: "click", confidence: 1 }] } }),
      input({ decision: { candidates: [{ target, kind: "click", confidence: 0.5 }] } }),
    ]) {
      expect(decidePageAction(current)).toEqual({ action: "stop" });
    }
  });

  it("does not retry a click that changed nothing", () => {
    expect(
      decidePageAction(input({ history: [{ target, kind: "click", changed: false }] })),
    ).toEqual({ action: "stop" });
  });

  it("retries a click that changed the page", () => {
    expect(
      decidePageAction(input({ history: [{ target, kind: "click", changed: true }] })),
    ).toEqual({ action: "act", target, kind: "click" });
  });

  it("treats scores outside the probability range as zero", () => {
    expect(
      decidePageAction(
        input({
          decision: {
            candidates: [{ target, kind: "click", confidence: Number.NaN }],
            blocked: 2,
          },
        }),
      ),
    ).toEqual({ action: "stop" });
  });
});
