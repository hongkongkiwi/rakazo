import type { MessageBlock } from "@rakazo/contracts";
import { ComputerCommandSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";

type ChangesBlock = Extract<MessageBlock, { kind: "changes" }>;
type ChangeFile = ChangesBlock["files"][number];

const MAX_FILES = 30;

/**
 * The files a turn wrote on its computer, from the write events it recorded.
 * Only explicit writes are attributed; edits made through a shell are not.
 */
export async function buildRunChanges(
  prisma: Pick<PrismaClient, "event">,
  runId: string,
): Promise<ChangesBlock | null> {
  const events = await prisma.event.findMany({
    where: { runId, type: "computer.command" },
    orderBy: { seq: "asc" },
    select: { payload: true },
  });
  const files = new Map<string, ChangeFile>();
  for (const event of events) {
    const command = ComputerCommandSchema.safeParse(event.payload);
    if (!command.success) continue;
    const { kind, status, exitCode, command: path, bytes, change } = command.data;
    // A failed write is recorded as done with a non-zero exit code.
    if (kind !== "write_file" || status !== "done" || exitCode !== 0 || !path) continue;
    files.set(path, {
      path,
      ...(change ? { change } : {}),
      ...(bytes === undefined ? {} : { bytes }),
    });
  }
  if (files.size === 0) return null;
  return { kind: "changes", files: [...files.values()].slice(0, MAX_FILES) };
}
