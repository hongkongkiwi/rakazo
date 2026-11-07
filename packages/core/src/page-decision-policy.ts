export type PageActionKind = "click" | "fill" | "type";

export interface PageDecisionPolicyInput {
  decision: {
    candidates: readonly { target: string; kind: PageActionKind; confidence: number }[];
    goalMet: number;
    stuck: number;
    blocked: number;
    error?: string;
  };
  budget: { steps: number; elapsedMs: number };
  history: readonly { target: string; kind: PageActionKind; changed: boolean }[];
  knownTargets: readonly string[];
}

// Provisional opt-in bounds, not calibrated claims about model accuracy.
export const DEFAULT_PAGE_DECISION_THRESHOLDS = {
  goalMet: 0.85,
  stuck: 0.85,
  blocked: 0.85,
  confidence: 0.7,
  maxSteps: 24,
  maxElapsedMs: 180_000,
};

export type PageDecisionOutcome =
  | { action: "act"; target: string; kind: "click" }
  | { action: "done" }
  | { action: "stop" };

function score(value: number): number {
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0;
}

export function decidePageAction(input: PageDecisionPolicyInput): PageDecisionOutcome {
  const { decision, budget, history, knownTargets } = input;
  const limits = DEFAULT_PAGE_DECISION_THRESHOLDS;
  if (
    budget.steps >= limits.maxSteps ||
    budget.elapsedMs >= limits.maxElapsedMs ||
    decision.error ||
    score(decision.blocked) >= limits.blocked ||
    score(decision.stuck) >= limits.stuck
  )
    return { action: "stop" };
  if (score(decision.goalMet) >= limits.goalMet) return { action: "done" };
  const candidates = decision.candidates.filter(
    (candidate) =>
      candidate.kind === "click" &&
      knownTargets.includes(candidate.target) &&
      !history.some(
        (attempt) =>
          attempt.target === candidate.target && attempt.kind === "click" && !attempt.changed,
      ),
  );
  const best = candidates.reduce<(typeof candidates)[number] | undefined>(
    (a, b) => (!a || score(b.confidence) > score(a.confidence) ? b : a),
    undefined,
  );
  return best && score(best.confidence) >= limits.confidence
    ? { action: "act", target: best.target, kind: "click" }
    : { action: "stop" };
}
