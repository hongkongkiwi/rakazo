import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { AvailabilityKind, SpaceAvailability } from "@rakazo/contracts";
import {
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { useSpaceQueries } from "../../lib/query";
import { rpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";

/** The user's spaces; choosing where something is available only matters with two or more. */
export function useOwnSpaces(): Array<{ id: string; name: string }> {
  const queries = useSpaceQueries();
  const spaces = useQuery(queries.spaces.list.queryOptions());
  return spaces.data?.spaces ?? [];
}

/** True when removing an item takes it from more than this one space. */
export function reachesOtherSpaces(
  availability: SpaceAvailability | undefined,
  spaceCount: number,
): boolean {
  return (
    spaceCount > 1 && Boolean(availability?.allSpaces || (availability?.spaceIds.length ?? 0) > 1)
  );
}

/** A muted note for list rows on items that are not available everywhere. */
export function AvailabilityLabel({ availability }: { availability?: SpaceAvailability }) {
  const spaces = useOwnSpaces();
  if (spaces.length < 2 || !availability || availability.allSpaces) return null;
  const only =
    availability.spaceIds.length === 1
      ? spaces.find((s) => s.id === availability.spaceIds[0])
      : null;
  return (
    <span className="shrink-0 text-body-sm text-muted-foreground">
      {only ? (
        only.name
      ) : availability.spaceIds.length === 0 ? (
        <Trans>No spaces</Trans>
      ) : (
        <Plural value={availability.spaceIds.length} one="# space" other="# spaces" />
      )}
    </span>
  );
}

/** "Available in" for one of the user's items, shown only to someone with several spaces. */
export function AvailabilityControl({
  kind,
  id,
  availability,
  onChanged,
}: {
  kind: AvailabilityKind;
  id: string;
  availability?: SpaceAvailability;
  onChanged: () => Promise<unknown> | unknown;
}) {
  const { t } = useLingui();
  const spaces = useOwnSpaces();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parked = !availability?.allSpaces && availability?.spaceIds.length === 0;
  // A server can be kept out of every space, so its control is useful even with one space.
  if (!availability || (spaces.length < 2 && !parked && kind !== "mcpServer")) return null;

  async function save(next: SpaceAvailability) {
    setSaving(true);
    setError(null);
    try {
      await rpc.availability.set({ kind, id, ...next });
      await onChanged();
    } catch (err) {
      setError(errorText(err, t`Could not change where this is available`));
    } finally {
      setSaving(false);
    }
  }

  const chosen = availability.allSpaces ? spaces.map((space) => space.id) : availability.spaceIds;
  const summary = availability.allSpaces ? (
    <Trans>All spaces</Trans>
  ) : chosen.length === 0 ? (
    <Trans>No spaces</Trans>
  ) : chosen.length === 1 ? (
    (spaces.find((space) => space.id === chosen[0])?.name ?? <Trans>1 space</Trans>)
  ) : (
    <Plural value={chosen.length} one="# space" other="# spaces" />
  );
  const toggle = (spaceId: string) => {
    const next = chosen.includes(spaceId)
      ? chosen.filter((other) => other !== spaceId)
      : [...chosen, spaceId];
    // Only a server can be kept out of every space; other items have a removal action.
    if (!next.length && kind !== "mcpServer") return;
    void save({ allSpaces: false, spaceIds: next });
  };

  return (
    <div data-testid="availability" className="flex flex-wrap items-center gap-1 text-label">
      <span className="text-muted-foreground">
        <Trans>Available in</Trans>
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              disabled={saving}
              className="h-6 gap-1 px-1.5 text-label font-normal text-foreground"
            />
          }
        >
          {summary}
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuCheckboxItem
            checked={availability.allSpaces}
            onCheckedChange={(checked) =>
              void save(
                checked
                  ? { allSpaces: true, spaceIds: availability.spaceIds }
                  : { allSpaces: false, spaceIds: availability.spaceIds },
              )
            }
          >
            <Trans>All spaces</Trans>
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          {spaces.map((space) => (
            <DropdownMenuCheckboxItem
              key={space.id}
              checked={chosen.includes(space.id)}
              onCheckedChange={() => toggle(space.id)}
            >
              {space.name}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {error ? (
        <span role="alert" className="text-body-sm text-destructive">
          {error}
        </span>
      ) : null}
    </div>
  );
}
