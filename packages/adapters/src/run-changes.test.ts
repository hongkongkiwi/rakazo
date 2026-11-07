import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { buildRunChanges } from "./run-changes.js";

function fixture(payloads: unknown[]) {
  const findMany = vi.fn(async () => payloads.map((payload) => ({ payload })));
  const prisma = { event: { findMany } } as unknown as Pick<PrismaClient, "event">;
  return { prisma, findMany };
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
    const { prisma, findMany } = fixture([
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
    expect(findMany).toHaveBeenCalledWith({
      where: { runId: "run-1", type: "computer.command" },
      orderBy: { seq: "asc" },
      select: { payload: true },
    });
    expect(block).toEqual({
      kind: "changes",
      files: [
        { path: "notes/a.md", change: "modified", bytes: 20 },
        { path: "notes/b.md", bytes: 10 },
      ],
    });
  });

  it("ignores a failed write even though it is recorded as done", async () => {
    const { prisma } = fixture([write("notes/failed.md", { exitCode: 1 })]);
    await expect(buildRunChanges(prisma, "run-1")).resolves.toBeNull();
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
