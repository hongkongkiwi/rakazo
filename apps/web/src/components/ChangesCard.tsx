import { Trans } from "@lingui/react/macro";
import type { MessageBlock } from "@rakazo/contracts";
import { formatFileSize } from "@rakazo/core";
import { BuiCard } from "./ai/primitives";

type ChangesBlock = Extract<MessageBlock, { kind: "changes" }>;

export function ChangesCard({ block }: { block: ChangesBlock }) {
  return (
    <BuiCard className="w-fit max-w-full border px-4 py-3" data-testid="changes-card">
      <div className="mb-1.5 text-body-sm text-muted-foreground">
        <Trans>Files written</Trans>
      </div>
      <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto">
        {block.files.map((file) => (
          <li key={file.path} className="flex items-baseline gap-2 text-body">
            <span className="min-w-0 wrap-anywhere" dir="auto">
              {file.path}
            </span>
            <span className="shrink-0 text-body-sm text-muted-foreground">
              {file.change === "created" ? (
                <Trans>New file</Trans>
              ) : file.change === "modified" ? (
                <Trans>Changed file</Trans>
              ) : null}
              {file.bytes === undefined ? null : (
                <>
                  {file.change === undefined ? "" : " · "}
                  {formatFileSize(file.bytes)}
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
    </BuiCard>
  );
}
