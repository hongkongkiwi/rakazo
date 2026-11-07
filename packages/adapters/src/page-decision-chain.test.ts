import type {
  AdapterContext,
  BrowserActRequest,
  BrowserActResult,
  BrowserPurchaseCheckResult,
  BrowserSnapshotNode,
  BrowserSnapshotResult,
  ComputerRef,
  PageDecision,
  PageDecisionRequest,
} from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { FakeBrowserProvider } from "./fake-browser.js";
import { runPageDecisionChain } from "./page-decision-chain.js";

const computer: ComputerRef = { id: "c1", botId: "b1", kind: "fake", providerRef: "c1" };
const url = "https://example.test/guide";
const goal = "Open the installation guide";

const context: AdapterContext = {
  operationId: "op",
  traceId: "trace",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};

const page = (ref: string, name: string, pageUrl = url): BrowserSnapshotResult => ({
  url: pageUrl,
  title: "Guide",
  tree: `- link ${JSON.stringify(name)} [${ref}]`,
  elements: [{ ref, role: "link", name, tag: "a" }],
});

function decideWith(decisions: Array<Partial<PageDecision> | Error>) {
  const requests: PageDecisionRequest[] = [];
  const decide = vi.fn(async (_computer: ComputerRef, request: PageDecisionRequest) => {
    requests.push(request);
    const next = decisions[Math.min(requests.length - 1, decisions.length - 1)];
    if (next instanceof Error) throw next;
    return {
      candidates: [],
      goalMet: 0,
      stuck: 0,
      blocked: 0,
      ...next,
    } satisfies PageDecision;
  });
  return { decide, requests, decider: { describe: () => descriptor, decide } };
}

const descriptor = {
  id: "fake",
  contractVersion: "1",
  adapterVersion: "0.1.0",
  capabilities: { vision: false },
};

function chainBrowser(purchase: () => BrowserPurchaseCheckResult) {
  const clicked: string[] = [];
  const browser = Object.assign(new FakeBrowserProvider(), {
    act: vi.fn(
      async (_computer: ComputerRef, request: BrowserActRequest): Promise<BrowserActResult> => {
        clicked.push(...request.actions.flatMap((action) => (action.ref ? [action.ref] : [])));
        return { ok: true, completed: request.actions.length, ...page("e2", "Installation") };
      },
    ),
    purchaseCheck: vi.fn(async () => purchase()),
  });
  return { browser, clicked };
}

const pick = (ref: string, confidence = 1): Partial<PageDecision> => ({
  candidates: [{ ref, kind: "click", confidence }],
});

describe("page decision chain purchase gate", () => {
  it("clicks the chosen control only when the purchase check verified no purchase", async () => {
    const { browser, clicked } = chainBrowser(() => ({ purchase: null, verified: true }));
    const { decider, decide } = decideWith([pick("e1"), { goalMet: 1 }]);

    const result = await runPageDecisionChain({
      browser,
      computer,
      context,
      decider,
      goal,
      result: page("e1", "Documentation"),
    });

    expect(clicked).toEqual(["e1"]);
    expect(decide).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ url, elements: [{ ref: "e2", name: "Installation" }] });
    expect(browser.purchaseCheck).toHaveBeenCalledOnce();
  });

  it("does not click when the check ran but reported no verified answer", async () => {
    const { browser, clicked } = chainBrowser(() => ({ purchase: null }));
    const { decider } = decideWith([pick("e1")]);

    const result = await runPageDecisionChain({
      browser,
      computer,
      context,
      decider,
      goal,
      result: page("e1", "Documentation"),
    });

    expect(clicked).toEqual([]);
    expect(result).toMatchObject({ url, tree: '- link "Documentation" [e1]' });
  });

  it("asks the site rule before each implicit click and stops when it refuses", async () => {
    const { browser, clicked } = chainBrowser(() => ({ purchase: null, verified: true }));
    const { decider } = decideWith([pick("e1")]);
    const allowStep = vi.fn(async () => false);

    const result = await runPageDecisionChain({
      browser,
      computer,
      context,
      decider,
      goal,
      result: page("e1", "Documentation"),
      allowStep,
    });

    expect(allowStep).toHaveBeenCalledWith(url);
    expect(clicked).toEqual([]);
    expect(result).toMatchObject({ url });
  });

  it("hands a purchase candidate back even when verified", async () => {
    const { browser, clicked } = chainBrowser(() => ({
      purchase: { site: "example.test", label: "Pay", amount: "$5", steps: [0] },
      verified: true,
    }));
    const { decider } = decideWith([pick("e1")]);

    const result = await runPageDecisionChain({
      browser,
      computer,
      context,
      decider,
      goal,
      result: page("e1", "Pay"),
    });

    expect(clicked).toEqual([]);
    expect(result).toMatchObject({ url });
  });
});

describe("page decision chain site rule", () => {
  it("stops before the page reaches the model when the site rule refuses", async () => {
    const { browser, clicked } = chainBrowser(() => ({ purchase: null, verified: true }));
    const { decider, decide } = decideWith([pick("e1")]);
    const allowStep = vi.fn(async () => false);

    const result = await runPageDecisionChain({
      browser,
      computer,
      context,
      decider,
      goal,
      result: page("e1", "Documentation"),
      allowStep,
    });

    expect(allowStep).toHaveBeenCalledWith(url);
    expect(decide).not.toHaveBeenCalled();
    expect(clicked).toEqual([]);
    expect(result).toMatchObject({ url, tree: '- link "Documentation" [e1]' });
  });

  it("continues when the site rule allows, checking again before the click", async () => {
    const { browser, clicked } = chainBrowser(() => ({ purchase: null, verified: true }));
    const { decider, decide } = decideWith([pick("e1"), { goalMet: 1 }]);
    const allowStep = vi.fn(async () => true);

    const result = await runPageDecisionChain({
      browser,
      computer,
      context,
      decider,
      goal,
      result: page("e1", "Documentation"),
      allowStep,
    });

    expect(allowStep).toHaveBeenCalledWith(url);
    expect(allowStep.mock.calls.length).toBeGreaterThan(1);
    expect(decide).toHaveBeenCalledTimes(2);
    expect(clicked).toEqual(["e1"]);
    expect(result).toMatchObject({ url, elements: [{ ref: "e2", name: "Installation" }] });
  });
});

describe("page decision chain origin boundary", () => {
  it("returns the reached page and stops before sending another site's page to the decider", async () => {
    const elsewhere = "https://other.example.test/private";
    const { browser, clicked } = chainBrowser(() => ({ purchase: null, verified: true }));
    const browserWithAct = Object.assign(browser, {
      act: vi.fn(
        async (_computer: ComputerRef, request: BrowserActRequest): Promise<BrowserActResult> => {
          clicked.push(...request.actions.flatMap((action) => (action.ref ? [action.ref] : [])));
          return {
            ok: true,
            completed: request.actions.length,
            ...page("x1", "Other site", elsewhere),
          };
        },
      ),
    });
    const { decider, requests } = decideWith([pick("e1")]);

    const result = await runPageDecisionChain({
      browser: browserWithAct,
      computer,
      context,
      decider,
      goal,
      result: page("e1", "Documentation"),
    });

    expect(clicked).toEqual(["e1"]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://example.test");
    expect(result).toMatchObject({ url: elsewhere });
  });

  it("never starts on a non-http page", async () => {
    const { browser } = chainBrowser(() => ({ purchase: null, verified: true }));
    const { decider, decide } = decideWith([pick("e1")]);

    const result = await runPageDecisionChain({
      browser,
      computer,
      context,
      decider,
      goal,
      result: page("e1", "Local", "file:///private/page.html"),
    });

    expect(decide).not.toHaveBeenCalled();
    expect(result).toMatchObject({ url: "file:///private/page.html" });
  });

  it("leaves the result untouched when there is no goal or no decider", async () => {
    const { browser, clicked } = chainBrowser(() => ({ purchase: null, verified: true }));
    const { decider, decide } = decideWith([pick("e1")]);
    const original: BrowserSnapshotResult = page("e1", "Documentation");

    expect(
      await runPageDecisionChain({
        browser,
        computer,
        context,
        goal: "",
        decider,
        result: original,
      }),
    ).toBe(original);
    expect(
      await runPageDecisionChain({
        browser,
        computer,
        context,
        goal: "  ",
        result: page("e1", "Documentation"),
      }),
    ).toMatchObject({ url });
    expect(decide).not.toHaveBeenCalled();
    expect(clicked).toEqual([]);
  });
});

// The chain only offers visible controls; a value a page echoes stays out of the request.
function visibleOnly(elements: BrowserSnapshotNode[]) {
  return elements.every((element) => !("value" in element) && !("options" in element));
}

describe("page decision chain request shape", () => {
  it("sends visible controls without their values and stops at a failed decider", async () => {
    const { browser } = chainBrowser(() => ({ purchase: null, verified: true }));
    const { decider, requests } = decideWith([new Error("fake failure")]);
    const snapshot = page("e1", "Documentation");
    snapshot.elements = [{ ...snapshot.elements[0]!, value: "fake-secret-value" }];

    const result = await runPageDecisionChain({
      browser,
      computer,
      context,
      decider,
      goal,
      result: snapshot,
    });

    expect(result).toMatchObject({ url });
    expect(visibleOnly(requests[0]!.elements)).toBe(true);
    expect(JSON.stringify(requests[0])).not.toContain("fake-secret-value");
  });
});
