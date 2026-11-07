import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { buildRunChanges } from "./run-changes.js";

function fixture(payloads: unknown[]) {
  const prisma = {
    event: { findMany: vi.fn(async () => payloads.map((payload) => ({ payload }))) },
  } as unknown as Pick<PrismaClient, "event">;
  return { prisma };
}

const write = (path: string, extra: Record<string, unknown> = {}) => ({
  executionId: `write:${path}`,
  kind: "write_file",
  command: path,
  cwd: ".",
  status: "done",
  exitCode: 0,
  output: "",
  bytes: 10,
  ...extra,
});

describe("buildRunChanges", () => {
  it("keeps the last write per path and ignores shell or unfinished work", async () => {
    const { prisma } = fixture([
      write("notes/a.md", { change: "created", bytes: 10 }),
      write("notes/a.md", { change: "modified", bytes: 20 }),
      write("notes/b.md"),
      {
        executionId: "shell:1",
        kind: "shell",
        command: "sed -i s/a/b/ notes/a.md",
        cwd: ".",
        status: "done",
        exitCode: 0,
        output: "",
      },
      { ...write("notes/c.md"), status: "running" },
      { nope: true },
    ]);
    const block = await buildRunChanges(prisma, "run-1");
    expect(block).toEqual({
      kind: "changes",
      files: [
        { path: "notes/a.md", change: "modified", bytes: 20 },
        { path: "notes/b.md", bytes: 10 },
      ],
    });
  });

  it("says nothing when the turn wrote no files", async () => {
    const { prisma } = fixture([]);
    await expect(buildRunChanges(prisma, "run-1")).resolves.toBeNull();
  });

  it("caps a very busy turn at thirty files", async () => {
    const { prisma } = fixture(
      Array.from({ length: 40 }, (_, index) => write(`file-${index}.txt`)),
    );
    const block = await buildRunChanges(prisma, "run-1");
    expect(block?.files).toHaveLength(30);
  });
});
