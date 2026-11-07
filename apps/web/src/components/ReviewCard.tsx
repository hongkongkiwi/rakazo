import { Trans } from "@lingui/react/macro";
import type { MessageBlock } from "@rakazo/contracts";
import { AlertTriangle, CheckCircle2, HelpCircle } from "lucide-react";
import { BuiCard } from "./ai/primitives";

type ReviewBlock = Extract<MessageBlock, { kind: "review" }>;

function Verdict({ verdict }: { verdict: ReviewBlock["verdict"] }) {
  if (verdict === "pass")
    return (
      <span className="flex items-center gap-1 text-success">
        <CheckCircle2 size={14} strokeWidth={1.8} />
        <Trans>Pass</Trans>
      </span>
    );
  if (verdict === "concerns")
    return (
      <span className="flex items-center gap-1 text-warning">
        <AlertTriangle size={14} strokeWidth={1.8} />
        <Trans>Concerns</Trans>
      </span>
    );
  return (
    <span className="flex items-center gap-1 text-muted-foreground">
      <HelpCircle size={14} strokeWidth={1.8} />
      <Trans>Unclear</Trans>
    </span>
  );
}

export function ReviewCard({ block }: { block: ReviewBlock }) {
  return (
    <BuiCard className="w-fit max-w-full border px-4 py-3" data-testid="review-card">
      <div className="flex items-center gap-2 text-body-sm text-muted-foreground">
        <Trans>Advisory review</Trans>
        <span aria-hidden>·</span>
        <Verdict verdict={block.verdict} />
      </div>
      <p className="mt-1 break-words text-body" dir="auto">
        {block.summary}
      </p>
      {block.findings.length > 0 ? (
        <ul className="mt-2 flex list-disc flex-col gap-1 ps-5 text-body text-muted-foreground">
          {block.findings.map((finding, index) => (
            <li key={`${index}-${finding}`} className="break-words" dir="auto">
              {finding}
            </li>
          ))}
        </ul>
      ) : null}
    </BuiCard>
  );
}
