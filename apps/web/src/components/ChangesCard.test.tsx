// @vitest-environment jsdom

import type { MessageBlock } from "@rakazo/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: unknown }) => children,
}));

import { ChangesCard } from "./ChangesCard";

describe("ChangesCard", () => {
  it("shows each written file with its status and size", () => {
    const block: Extract<MessageBlock, { kind: "changes" }> = {
      kind: "changes",
      files: [
        { path: "notes/a.md", change: "created", bytes: 12 },
        { path: "notes/b.md", change: "modified", bytes: 2048 },
      ],
    };
    const html = renderToStaticMarkup(<ChangesCard block={block} />);
    expect(html).toContain("Files written");
    expect(html).toContain("notes/a.md");
    expect(html).toContain("New file");
    expect(html).toContain("notes/b.md");
    expect(html).toContain("Changed file");
    expect(html).toContain("2 KB");
  });
});
