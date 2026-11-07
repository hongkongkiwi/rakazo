import type {
  AdapterContext,
  BrowserActRequest,
  BrowserActResult,
  BrowserPurchaseCheckResult,
  BrowserSnapshotNode,
  BrowserSnapshotResult,
  ComputerRef,
} from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { browserActFromTool, browserNavigateFromTool } from "./browser-tools.js";
import { FakeBrowserProvider } from "./fake-browser.js";
import { pageBrowserTool } from "./run-tools-computer.js";

const computer: ComputerRef = { id: "c1", botId: "b1", kind: "fake", providerRef: "c1" };
const url = "https://example.test/guide";
const goal = "Open the installation guide";

// The fork's public decision shape, kept local so the baseline imports only existing modules.
type Decision = {
  candidates: Array<{ ref: string; kind: "click" | "fill" | "type"; confidence: number }>;
  goalMet: number;
  stuck: number;
  blocked: number;
};
type DecisionRequest = {
  goal: string;
  elements: BrowserSnapshotNode[];
  excerpt: string;
  url: string;
  title: string;
  history: Array<{ ref: string; kind: string; changed: boolean }>;
  screenshot?: unknown;
};
const empty: Decision = { candidates: [], goalMet: 0, stuck: 0, blocked: 0 };
const pick = (
  ref: string,
  confidence = 1,
  kind: "click" | "fill" | "type" = "click",
): Decision => ({
  ...empty,
  candidates: [{ ref, kind, confidence }],
});
function page(ref: string, name: string, pageUrl = url): BrowserSnapshotResult {
  return {
    url: pageUrl,
    title: "Guide",
    tree: `- link ${JSON.stringify(name)} [${ref}]`,
    elements: [{ ref, role: "link", name, tag: "a" }],
  };
}

function fixture(
  pages = [page("e1", "Documentation"), page("e2", "Installation"), page("e3", "Done")],
) {
  const context: AdapterContext = {
    operationId: "op",
    traceId: "trace",
    spaceId: "space",
    userId: "user",
    signal: new AbortController().signal,
  };
  let index = 0;
  const current = () => pages[Math.min(index, pages.length - 1)]!;
  const events: string[] = [];
  const browser = Object.assign(new FakeBrowserProvider(), {
    navigate: vi.fn(async () => {
      events.push("navigate");
      return current();
    }),
    snapshot: vi.fn(async () => current()),
    act: vi.fn(
      async (_computer: ComputerRef, request: BrowserActRequest): Promise<BrowserActResult> => {
        events.push(`act:${request.actions.map((action) => action.ref).join(",")}`);
        index++;
        return { ok: true, completed: request.actions.length, ...current() };
      },
    ),
  });
  const purchaseCheck = vi.fn(
    async (): Promise<BrowserPurchaseCheckResult> => ({ purchase: null, verified: true }),
  );
  const screenshot = vi.fn(async () => ({ data: "fake-private-pixels", scale: 1 }));
  Object.assign(browser, { purchaseCheck, screenshot });
  const decide = vi.fn(
    async (_computer: ComputerRef, request: DecisionRequest): Promise<Decision> => {
      events.push("decide");
      return index >= pages.length - 1 ? { ...empty, goalMet: 1 } : pick(request.elements[0]!.ref);
    },
  );
  const decider = {
    describe: () => ({
      id: "fake",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { vision: false },
    }),
    decide,
  };
  const secrets: string[] = [];
  const options = { desktopTools: false, decider, redactions: () => secrets };
  const navigate = (args: Record<string, unknown> = { url, goal }, enabled = true) =>
    browserNavigateFromTool(browser, computer, context, args, enabled ? options : {});
  return {
    browser,
    context,
    decider,
    decide,
    purchaseCheck,
    screenshot,
    secrets,
    options,
    navigate,
    events,
  };
}

describe("optional page decider at the browser tool boundary", () => {
  it("continues confident clicks and returns the reached page within one navigate call", async () => {
    const f = fixture();
    const result = await f.navigate();
    expect(f.events).toEqual(["navigate", "decide", "act:e1", "decide", "act:e2", "decide"]);
    expect(result).toMatchObject({ url, title: "Guide", tree: '- link "Done" [e3]' });
    expect(f.browser.act).toHaveBeenCalledTimes(2);
  });

  it("continues after a successful explicit action and returns fresh actionable refs", async () => {
    const f = fixture();
    const result = await browserActFromTool(
      f.browser,
      computer,
      f.context,
      { actions: [{ kind: "click", ref: "e1" }], goal },
      f.options,
    );
    expect(f.events).toEqual(["act:e1", "decide", "act:e2", "decide"]);
    expect(result).toMatchObject({ elements: [{ ref: "e3", name: "Done" }] });
  });

  it.each(["off", "no goal", "blank goal"])(
    "preserves the original result with %s",
    async (mode) => {
      const f = fixture();
      const result = await f.navigate(
        { url, ...(mode === "off" ? { goal } : mode === "blank goal" ? { goal: "  " } : {}) },
        mode !== "off",
      );
      expect(result).toEqual(page("e1", "Documentation"));
      expect(f.decide).not.toHaveBeenCalled();
      expect(f.browser.snapshot).not.toHaveBeenCalled();
      expect(f.browser.act).not.toHaveBeenCalled();
      expect(f.screenshot).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["uncertain", pick("e1", 0.1)],
    ["unknown ref", pick("missing")],
    ["text entry", pick("e1", 1, "fill")],
    ["blocked", { ...empty, blocked: 1 }],
    ["stuck", { ...empty, stuck: 1 }],
  ])("hands %s decisions back without clicks", async (_name, decision) => {
    const f = fixture();
    f.decide.mockResolvedValue(decision);
    const result = await f.navigate();
    expect(f.decide).toHaveBeenCalledOnce();
    expect(f.browser.act).not.toHaveBeenCalled();
    expect(result).toMatchObject({ url, title: "Guide" });
  });

  it("a failed decider leaves the original browser result usable", async () => {
    const f = fixture();
    f.decide.mockRejectedValue(new Error("fake decision failure"));
    expect(await f.navigate()).toMatchObject({ url, title: "Guide" });
    expect(f.decide).toHaveBeenCalledOnce();
    expect(f.browser.act).not.toHaveBeenCalled();
  });

  it("does not continue on top of an uncertain explicit action", async () => {
    const f = fixture();
    f.browser.act.mockResolvedValue({
      ok: false,
      completed: 0,
      uncertain: true,
      url,
      title: "Guide",
    });
    const result = await browserActFromTool(
      f.browser,
      computer,
      f.context,
      { actions: [{ kind: "click", ref: "e1" }], goal },
      f.options,
    );
    expect(result).toMatchObject({ ok: false, uncertain: true });
    expect(f.browser.act).toHaveBeenCalledOnce();
    expect(f.decide).not.toHaveBeenCalled();
  });

  it("stops after an observed origin change without sending the other site's page to the decider", async () => {
    const elsewhere = "https://other.example.test/private";
    const f = fixture([page("e1", "Documentation"), page("x1", "Other site", elsewhere)]);
    expect(await f.navigate()).toMatchObject({ url: elsewhere });
    expect(f.browser.act).toHaveBeenCalledOnce();
    expect(f.decide).toHaveBeenCalledOnce();
    expect(f.decide.mock.calls[0]![1].url).toBe(new URL(url).origin);
  });

  it("does not retry a no-op click when snapshot refs change", async () => {
    const f = fixture([page("e1", "Documentation"), page("e9", "Documentation")]);
    f.decide.mockImplementation(async (_computer, request) => pick(request.elements[0]!.ref));
    await f.navigate();
    expect(f.browser.act).toHaveBeenCalledOnce();
    expect(f.decide).toHaveBeenCalledTimes(2);
    expect(f.decide.mock.calls[1]![1].history).toContainEqual({
      ref: "e9",
      kind: "click",
      changed: false,
    });
  });

  it("does not replay a chain click whose response is uncertain", async () => {
    const f = fixture();
    f.browser.act.mockResolvedValue({
      ok: false,
      completed: 0,
      uncertain: true,
      url,
      title: "Guide",
    });
    expect(await f.navigate()).toMatchObject({ uncertain: true });
    expect(f.browser.act).toHaveBeenCalledOnce();
    expect(f.decide).toHaveBeenCalledOnce();
  });

  it("hands a purchase candidate back before clicking, even when its score is confident", async () => {
    const f = fixture([page("e1", "Pay $5"), page("e2", "Receipt")]);
    f.purchaseCheck.mockResolvedValue({
      purchase: {
        site: "example.test",
        label: "Pay $5",
        amount: "$5",
        steps: [0],
      },
    });
    const result = await f.navigate();
    expect(f.decide).toHaveBeenCalledOnce();
    expect(f.browser.act).not.toHaveBeenCalled();
    expect(result).toMatchObject({ url, tree: '- link "Pay $5" [e1]' });
  });

  it.each([undefined, false])(
    "does not click when a no-purchase result has verified=%s",
    async (verified) => {
      const f = fixture();
      f.purchaseCheck.mockResolvedValue({
        purchase: null,
        ...(verified === undefined ? {} : { verified }),
      });
      const result = await f.navigate();
      expect(f.decide).toHaveBeenCalledOnce();
      expect(f.purchaseCheck).toHaveBeenCalledOnce();
      expect(f.browser.act).not.toHaveBeenCalled();
      expect(result).toMatchObject({ url, tree: '- link "Documentation" [e1]' });
    },
  );

  it("scrubs run secrets before excerpt truncation and removes arbitrary element values", async () => {
    const secret = "FAKE-SECRET-CROSSES-CUTOFF";
    const value = "fake-unregistered-input-value";
    const snapshot = page("e1", `Documentation ${secret}`);
    snapshot.title = `Guide ${secret}`;
    snapshot.elements.push({ ref: "e2", role: "textbox", name: "Field", value });
    snapshot.tree = `${"x".repeat(3995)}${secret}\n- textbox "Field" [e2] value=${JSON.stringify(value)}`;
    const f = fixture([snapshot]);
    f.secrets.push(secret);
    await f.navigate();
    expect(f.decide).toHaveBeenCalledOnce();
    const request = f.decide.mock.calls[0]![1];
    expect(JSON.stringify(request)).not.toContain(secret);
    expect(JSON.stringify(request)).not.toContain(value);
    expect(request.excerpt).not.toContain("FAKE-");
    expect(request.excerpt.length).toBeLessThanOrEqual(4000);
    expect(request.elements[1]).not.toHaveProperty("value");
    expect(request.title).toContain("[redacted]");
    expect(request.goal).toBe(goal);
  });

  it("does not capture private pixels merely because a decider requests vision", async () => {
    const f = fixture();
    f.decider.describe = () => ({
      id: "fake",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { vision: true },
    });
    f.decide.mockResolvedValue(empty);
    await f.navigate();
    expect(f.screenshot).not.toHaveBeenCalled();
    for (const [, request] of f.decide.mock.calls) expect(request.screenshot).toBeUndefined();
    expect(f.browser.act).not.toHaveBeenCalled();
  });
});

function runFixture(trigger = "message", rules: unknown[] = [], disabled = false) {
  const f = fixture();
  const pageDecider = vi.fn(async () => f.decider);
  const ctx = {
    deps: { prisma: { taughtSkill: { findFirst: async () => null } } },
    run: { id: "run", spaceId: "space", botId: "b1", trigger },
    bot: { id: "b1" },
    context: f.context,
    computer: {
      heldForTakeover: false,
      graphicalToolsAllowed: false,
      mode: "private",
      checkpoint: { markDirty: () => {} },
      get: async () => computer,
    },
    tools: { disabled: new Set(disabled ? ["browser_act"] : []) },
    providers: { browser: f.browser },
    pageDecider,
    trust: { loadApprovalRules: async () => rules },
    secrets: new Set<string>(),
    state: { walletHosts: new Set<string>(), screen: { unchangedVisualStreak: { count: 0 } } },
  };
  const run = () =>
    pageBrowserTool(
      ctx as never,
      {
        name: "browser_navigate",
        args: { url, goal },
        executionId: "call",
        finish: async (result: unknown) => result,
      } as never,
    );
  return { ...f, pageDecider, run };
}

describe("page decider respects the calling run's authority", () => {
  it("wires an enabled decider into an ordinary unasked browser call", async () => {
    const f = runFixture();
    await f.run();
    expect(f.pageDecider).toHaveBeenCalledOnce();
    expect(f.browser.act).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      "explicit approval rule",
      "message",
      [{ effect: "require_approval", matchKind: "tool", matchValue: "browser_act" }],
      false,
    ],
    [
      "webhook even with always allow",
      "webhook",
      [{ effect: "always_allow", matchKind: "tool", matchValue: "browser_act" }],
      false,
    ],
    ["disabled browser_act", "message", [], true],
  ])("leaves %s to the original gate", async (_name, trigger, rules, disabled) => {
    const f = runFixture(trigger, rules, disabled);
    await f.run();
    expect(f.browser.navigate).toHaveBeenCalledOnce();
    expect(f.pageDecider).not.toHaveBeenCalled();
    expect(f.decide).not.toHaveBeenCalled();
    expect(f.browser.act).not.toHaveBeenCalled();
  });
});
