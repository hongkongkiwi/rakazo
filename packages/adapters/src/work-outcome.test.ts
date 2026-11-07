import type { ArtifactStore } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { buildOutcomeBlock } from "./work-outcome.js";

type EffectRow = {
  kind: string;
  status: string;
  request: unknown;
  result?: unknown;
  runId?: string;
  spaceId?: string;
};

type Fixture = {
  effects?: EffectRow[];
  artifacts?: Array<{ id: string; name: string; storageKey: string; runId?: string }>;
  messages?: Array<{ blocks: unknown; runId?: string }>;
  pages?: Record<string, { id: string }>;
  versions?: Record<string, { id: string }>;
  has?: (id: string) => boolean | null | Promise<boolean | null>;
};

const scope = { runId: "run-1", spaceId: "space-1", botId: "bot-1", userId: "user-1" };

function fixture(rows: Fixture = {}) {
  const has = vi.fn(rows.has ?? (() => true));
  const prisma = {
    externalEffect: {
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: { runId: string; spaceId?: string; status: { in: string[] } };
        }) =>
          (rows.effects ?? []).filter(
            (row) =>
              (row.runId ?? scope.runId) === where.runId &&
              (row.spaceId ?? scope.spaceId) === (where.spaceId ?? scope.spaceId) &&
              where.status.in.includes(row.status),
          ),
      ),
    },
    artifact: {
      findMany: vi.fn(async ({ where }: { where: { runId: string } }) =>
        (rows.artifacts ?? []).filter((row) => (row.runId ?? scope.runId) === where.runId),
      ),
    },
    message: {
      findMany: vi.fn(async ({ where }: { where: { runId: string } }) =>
        (rows.messages ?? []).filter((row) => (row.runId ?? scope.runId) === where.runId),
      ),
    },
    page: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; spaceId: string } }) =>
        rows.pages?.[where.id] && where.spaceId === scope.spaceId ? rows.pages[where.id] : null,
      ),
    },
    pageVersion: {
      findUnique: vi.fn(
        async ({ where }: { where: { pageId_version: { pageId: string; version: number } } }) =>
          rows.versions?.[`${where.pageId_version.pageId}:${where.pageId_version.version}`] ?? null,
      ),
    },
  };
  const deps = {
    prisma,
    artifacts: rows.has === undefined ? undefined : ({ has } as unknown as ArtifactStore),
  } as unknown as Parameters<typeof buildOutcomeBlock>[0];
  return { deps, has, prisma };
}

function pageBlock(pageId: string, version: number, title: string) {
  return { blocks: [{ kind: "page", pageId, version, title }] };
}

describe("buildOutcomeBlock", () => {
  it("reports an outside action without its query string and marks an uncertain one unchecked", async () => {
    const { deps, prisma } = fixture({
      effects: [
        {
          kind: "COMPOSIO_SEND_EMAIL",
          status: "completed",
          request: {
            to: "anna@example.com",
            subject: "Hi",
            url: "https://example.com/inbox?token=1",
          },
        },
        { kind: "COMPOSIO_UPDATE_RECORD", status: "uncertain", request: {} },
      ],
    });
    const block = await buildOutcomeBlock(deps, scope);
    expect(block).toEqual({
      kind: "outcome",
      entries: [
        { kind: "action", label: "Update record", status: "unchecked" },
        {
          kind: "action",
          label: "Send email",
          detail: "https://example.com/inbox",
          url: "https://example.com/inbox",
          status: "reported",
        },
      ],
    });
    expect(JSON.stringify(block)).not.toContain("token=1");
    expect(prisma.externalEffect.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ runId: "run-1", status: { in: expect.any(Array) } }),
      }),
    );
  });

  it("leaves computer-internal builtin work out and groups repeated actions", async () => {
    const { deps } = fixture({
      effects: [
        { kind: "shell", status: "completed", request: { command: "npm test" } },
        { kind: "COMPOSIO_SEND_EMAIL", status: "completed", request: { to: "a@example.com" } },
        { kind: "COMPOSIO_SEND_EMAIL", status: "completed", request: { to: "a@example.com" } },
      ],
    });
    const block = await buildOutcomeBlock(deps, scope);
    expect(block?.entries).toEqual([
      {
        kind: "action",
        label: "Send email",
        detail: "a@example.com",
        status: "reported",
        count: 2,
      },
    ]);
  });

  it("reports only the saved files an artifact store says are missing", async () => {
    const { deps, has, prisma } = fixture({
      artifacts: [
        { id: "a1", name: "kept.csv", storageKey: "key-1" },
        { id: "a2", name: "gone.csv", storageKey: "key-2" },
      ],
      has: (id) => id !== "key-2",
    });
    const block = await buildOutcomeBlock(deps, scope);
    expect(has).toHaveBeenCalledTimes(2);
    expect(prisma.artifact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { runId: "run-1" } }),
    );
    expect(block?.entries).toEqual([
      {
        kind: "file",
        label: "gone.csv",
        status: "failed",
        artifactId: "a2",
        detail: "The saved file could not be found.",
      },
    ]);
  });

  it.each([
    ["cannot tell", () => null],
    [
      "fails",
      () => {
        throw new Error("storage unavailable");
      },
    ],
  ])("stays silent when the artifact store %s", async (_label, has) => {
    const { deps } = fixture({
      artifacts: [{ id: "a1", name: "report.csv", storageKey: "key-1" }],
      has,
    });
    await expect(buildOutcomeBlock(deps, scope)).resolves.toBeNull();
  });

  it("truncates an artifact name to the contract's label bound", async () => {
    const name = "x".repeat(300);
    const { deps } = fixture({
      artifacts: [{ id: "a1", name, storageKey: "key-1" }],
      has: () => false,
    });
    const block = await buildOutcomeBlock(deps, scope);
    expect(block?.entries[0]?.label).toHaveLength(255);
  });

  it("reports a page whose saved version cannot be found", async () => {
    const { deps, prisma } = fixture({
      messages: [pageBlock("page-1", 2, "Launch plan")],
      pages: { "page-1": { id: "page-1" } },
    });
    const block = await buildOutcomeBlock(deps, scope);
    expect(prisma.page.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "page-1", spaceId: "space-1" } }),
    );
    expect(block?.entries).toEqual([
      {
        kind: "page",
        label: "Launch plan",
        status: "failed",
        pageId: "page-1",
        version: 2,
        detail: "The saved page could not be found.",
      },
    ]);
  });

  it("says nothing when the turn changed nothing outside the chat", async () => {
    const { deps } = fixture({ effects: [{ kind: "shell", status: "completed", request: {} }] });
    await expect(buildOutcomeBlock(deps, scope)).resolves.toBeNull();
  });
});
