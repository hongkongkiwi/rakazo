import type {
  AdapterContext,
  BrowserActResult,
  BrowserNavigateResult,
  BrowserProvider,
  BrowserSnapshotNode,
  BrowserSnapshotResult,
  ComputerRef,
  PageDecider,
  PageDecisionRequest,
} from "@rakazo/adapter-kit";
import { PAGE_DECISION_MAX_ELEMENTS, PAGE_DECISION_MAX_EXCERPT_CHARS } from "@rakazo/adapter-kit";
import { decidePageAction } from "@rakazo/core";
import { redactConnectorPayload } from "./connector-safety.js";

export function normalizeGoal(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function originOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

function identityOf(element: BrowserSnapshotNode): string {
  return JSON.stringify([element.role, element.name, element.tag ?? ""]);
}

function treeWithout(snapshot: BrowserSnapshotResult, keepValues: boolean): string {
  let tree = snapshot.tree;
  for (const element of snapshot.elements) {
    const value = element.value ? ` value=${JSON.stringify(element.value)}` : "";
    tree = tree.split(`[${element.ref}]${value}`).join(keepValues ? value : "");
  }
  return tree;
}

function requestPage(snapshot: BrowserSnapshotResult, goal: string, secrets: string[]) {
  const values = snapshot.elements.flatMap((element) => [
    ...(element.value ? [element.value] : []),
    ...(element.options?.map((option) => option.value).filter(Boolean) ?? []),
  ]);
  const forms = [...secrets, ...values]
    .filter(Boolean)
    .flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]);
  const safe = redactConnectorPayload(
    {
      goal,
      elements: snapshot.elements.map(({ ref, role, name, tag }) => ({ ref, role, name, tag })),
      excerpt: treeWithout(snapshot, false),
      url: originOf(snapshot.url) ?? "",
      title: snapshot.title,
    },
    forms,
  ) as Pick<PageDecisionRequest, "goal" | "elements" | "excerpt" | "url" | "title">;
  return {
    ...safe,
    goal: safe.goal.slice(0, 400),
    elements: safe.elements.slice(0, PAGE_DECISION_MAX_ELEMENTS),
    excerpt: safe.excerpt.slice(0, PAGE_DECISION_MAX_EXCERPT_CHARS),
  };
}

export async function runPageDecisionChain(input: {
  browser: BrowserProvider;
  computer: ComputerRef;
  context: AdapterContext;
  decider?: PageDecider;
  goal: unknown;
  result: BrowserSnapshotResult | BrowserActResult | BrowserNavigateResult;
  redactions?: () => string[];
  downloads?: string;
  /** Asked before each implicit click, with the page URL, so site-scoped rules still apply. */
  allowStep?: (url: string) => Promise<boolean>;
}): Promise<BrowserSnapshotResult | BrowserActResult | BrowserNavigateResult> {
  const { browser, computer, context, decider } = input;
  const goal = normalizeGoal(input.goal);
  let result = input.result;
  if (!goal || !decider) return result;
  const origin = originOf(result.url);
  if (!origin) return result;
  const started = Date.now();
  const history: Array<{ identity: string; kind: "click"; changed: boolean }> = [];
  let steps = 0;
  try {
    for (;;) {
      context.signal.throwIfAborted();
      if (
        result.error ||
        result.fallback ||
        result.dialog ||
        result.loading ||
        ("ok" in result && (!result.ok || result.uncertain)) ||
        originOf(result.url) !== origin
      )
        return result;
      if (typeof result.tree !== "string" || !result.elements) {
        const next = await browser.snapshot(computer, { signal: context.signal }, context);
        if (
          next.error ||
          next.fallback ||
          next.dialog ||
          next.loading ||
          originOf(next.url) !== origin
        )
          return next;
        result = { ...result, ...next };
      }
      const snapshot = result as BrowserSnapshotResult;
      // Site rules are checked before any page text reaches the model, then again per click.
      if (input.allowStep && !(await input.allowStep(result.url))) return result;
      const attempts = history.flatMap((attempt) =>
        snapshot.elements
          .filter((element) => identityOf(element) === attempt.identity)
          .map((element) => ({ ref: element.ref, kind: attempt.kind, changed: attempt.changed })),
      );
      const page = requestPage(snapshot, goal, input.redactions?.() ?? []);
      const decision = await decider.decide(
        computer,
        {
          ...page,
          history: attempts,
          signal: context.signal,
        },
        context,
      );
      const outcome = decidePageAction({
        decision: {
          ...decision,
          candidates: decision.candidates.map((candidate) => ({
            target: candidate.ref,
            kind: candidate.kind,
            confidence: candidate.confidence,
          })),
        },
        budget: { steps, elapsedMs: Date.now() - started },
        history: attempts.map((attempt) => ({ ...attempt, target: attempt.ref })),
        knownTargets: page.elements.map((element) => element.ref),
      });
      if (outcome.action !== "act") return result;
      const target = snapshot.elements.find((element) => element.ref === outcome.target);
      if (!target || !browser.purchaseCheck) return result;
      const actions = [{ kind: "click" as const, ref: target.ref }];
      // Each implicit click is checked anew, never carrying the explicit call's purchase approval.
      const check = await browser.purchaseCheck(
        computer,
        { actions, signal: context.signal },
        context,
      );
      if (check.purchase !== null || check.verified !== true) return result;
      if (input.allowStep && !(await input.allowStep(result.url))) return result;
      context.signal.throwIfAborted();
      let next: BrowserActResult;
      try {
        next = await browser.act(
          computer,
          { actions, downloads: input.downloads, signal: context.signal },
          context,
        );
      } catch {
        context.signal.throwIfAborted();
        return {
          ok: false,
          completed: 0,
          uncertain: true,
          url: snapshot.url,
          title: snapshot.title,
        };
      }
      result = next;
      steps++;
      if (
        !next.ok ||
        next.uncertain ||
        next.error ||
        next.fallback ||
        next.completed !== 1 ||
        originOf(next.url) !== origin
      )
        return result;
      if (typeof next.tree !== "string" || !next.elements) {
        const observed = await browser.snapshot(computer, { signal: context.signal }, context);
        result = { ...next, ...observed };
      }
      if (typeof result.tree !== "string" || !result.elements) return result;
      history.push({
        identity: identityOf(target),
        kind: "click",
        changed:
          snapshot.url + treeWithout(snapshot, true) !==
          result.url + treeWithout(result as BrowserSnapshotResult, true),
      });
    }
  } catch {
    context.signal.throwIfAborted();
    return result;
  }
}
