import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { ComputerBrowserProvider } from "./computer-browser.js";

const baseContext: AdapterContext = {
  operationId: "1",
  traceId: "1",
  spaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};

const computer: ComputerRef = {
  id: "team-1",
  botId: "bot-1",
  kind: "docker",
  providerRef: "team-1",
};

describe("purchase check verification", () => {
  it("leaves a missing purchase field unverified and says no purchase", async () => {
    const provider = new ComputerBrowserProvider({
      liveDriver: async () => ({ ok: true, url: "https://shop.test/pay", title: "Pay" }),
    });
    expect(await provider.purchaseCheck(computer, { actions: [] }, baseContext)).toEqual({
      purchase: null,
    });
  });

  it("marks an explicit no-purchase answer as verified", async () => {
    const provider = new ComputerBrowserProvider({
      liveDriver: async () => ({
        ok: true,
        url: "https://shop.test/pay",
        title: "Pay",
        purchase: null,
      }),
    });
    expect(await provider.purchaseCheck(computer, { actions: [] }, baseContext)).toEqual({
      purchase: null,
      verified: true,
    });
  });

  it("returns a found purchase without claiming the page verified no purchase", async () => {
    const provider = new ComputerBrowserProvider({
      liveDriver: async () => ({
        ok: true,
        url: "https://shop.test/pay",
        title: "Pay",
        site: "shop.test",
        purchase: { steps: [], label: "Pay", amount: "$5", amountFrom: "button" },
      }),
    });
    const result = await provider.purchaseCheck(computer, { actions: [] }, baseContext);
    expect(result.purchase).toMatchObject({ label: "Pay", amount: "$5" });
    expect(result.verified).toBeUndefined();
  });
});
