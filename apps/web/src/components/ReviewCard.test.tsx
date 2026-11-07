// @vitest-environment jsdom

import type { MessageBlock } from "@rakazo/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: unknown }) => children,
}));

import { ReviewCard } from "./ReviewCard";

function render(block: Extract<MessageBlock, { kind: "review" }>) {
  return renderToStaticMarkup(<ReviewCard block={block} />);
}

describe("ReviewCard", () => {
  it("shows the verdict, summary, and findings", () => {
    const html = render({
      kind: "review",
      verdict: "concerns",
      summary: "The reply claims an email that was not sent.",
      findings: ["No send effect was recorded."],
      model: "test/review-model",
      reviewedModel: "test/worker-model",
      rubric: "result-review/v1",
    });
    expect(html).toContain("Concerns");
    expect(html).toContain("The reply claims an email that was not sent.");
    expect(html).toContain("No send effect was recorded.");
  });

  it("shows a pass without findings", () => {
    const html = render({
      kind: "review",
      verdict: "pass",
      summary: "The result holds up.",
      findings: [],
      model: "test/review-model",
      rubric: "result-review/v1",
    });
    expect(html).toContain("Pass");
    expect(html).toContain("The result holds up.");
    expect(html).not.toContain("<ul");
  });

  it("shows an unclear review, the fallback for a failed or malformed pass", () => {
    const html = render({
      kind: "review",
      verdict: "unclear",
      summary: "The review model returned no usable assessment.",
      findings: ["Try again later."],
      model: "test/review-model",
      rubric: "result-review/v1",
    });
    expect(html).toContain("Unclear");
    expect(html).toContain("The review model returned no usable assessment.");
    expect(html).toContain("Try again later.");
  });
});
