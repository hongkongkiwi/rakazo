import { Trans } from "@lingui/react/macro";
import type { MessageBlock } from "@rakazo/contracts";
import { BuiCard } from "./ai/primitives";

type OutcomeEntry = Extract<MessageBlock, { kind: "outcome" }>["entries"][number];

function StatusLabel({ status }: { status: OutcomeEntry["status"] }) {
  if (status === "failed") return <Trans>Couldn't confirm</Trans>;
  if (status === "unchecked") return <Trans>Not checked</Trans>;
  return <Trans>Reported</Trans>;
}

export function OutcomeCard({ block }: { block: Extract<MessageBlock, { kind: "outcome" }> }) {
  return (
    <BuiCard className="w-fit max-w-full border px-4 py-3" data-testid="outcome-card">
      <div className="mb-1.5 text-body-sm text-muted-foreground">
        <Trans>What changed</Trans>
      </div>
      <ul className="flex flex-col gap-1">
        {block.entries.map((entry, index) => (
          <li
            key={`${entry.kind}-${entry.label}-${index}`}
            className="flex flex-wrap items-baseline gap-x-1.5 text-body"
          >
            <span className={entry.status === "failed" ? "text-destructive" : "font-medium"}>
              {entry.label}
            </span>
            {entry.count && entry.count > 1 ? (
              <span className="text-muted-foreground">×{entry.count}</span>
            ) : null}
            {entry.detail ? (
              <span className="min-w-0 wrap-anywhere text-muted-foreground">{entry.detail}</span>
            ) : null}
            <span
              className={
                entry.status === "failed"
                  ? "text-body-sm text-destructive"
                  : "text-body-sm text-muted-foreground"
              }
            >
              · <StatusLabel status={entry.status} />
            </span>
          </li>
        ))}
      </ul>
    </BuiCard>
  );
}
