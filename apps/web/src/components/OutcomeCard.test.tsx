// @vitest-environment jsdom

import type { MessageBlock } from "@rakazo/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: unknown }) => children,
}));

import { OutcomeCard } from "./OutcomeCard";

const visibleText = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function render(block: Extract<MessageBlock, { kind: "outcome" }>) {
  return visibleText(renderToStaticMarkup(<OutcomeCard block={block} />));
}

describe("OutcomeCard", () => {
  it("lists an outside action with its target and how it was established", () => {
    const text = render({
      kind: "outcome",
      entries: [
        {
          kind: "action",
          label: "Send email",
          detail: "anna@example.com",
          status: "reported",
        },
      ],
    });
    expect(text).toContain("What changed");
    expect(text).toContain("Send email");
    expect(text).toContain("anna@example.com");
    expect(text).toContain("Reported");
  });

  it("groups repeats and puts a failed check in the destructive tone", () => {
    const html = renderToStaticMarkup(
      <OutcomeCard
        block={{
          kind: "outcome",
          entries: [
            { kind: "action", label: "Send email", status: "reported", count: 3 },
            {
              kind: "file",
              label: "report.csv",
              status: "failed",
              artifactId: "a1",
              detail: "The saved file could not be found.",
            },
          ],
        }}
      />,
    );
    expect(html).toContain("×3");
    expect(html).toContain("Couldn&#x27;t confirm");
    expect(html).toContain("text-destructive");
  });
});
