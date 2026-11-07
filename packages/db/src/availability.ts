/**
 * Skills, MCP servers and plugin or tool-source installs belong to the account that added them.
 * Each is available in the space it was added in (`spaceId`), in every space of its owner
 * (`allSpaces`, which includes spaces created later), or also in chosen further spaces
 * (`availableIn`). Nobody but the owner ever sees them.
 */
export function availableInSpace(scope: { spaceId: string; userId: string }) {
  return {
    userId: scope.userId,
    OR: [
      { spaceId: scope.spaceId },
      { allSpaces: true },
      { availableIn: { some: { spaceId: scope.spaceId } } },
    ],
  };
}

/**
 * An MCP server bots can use here: available in this space and not kept out of every space.
 * A server with no spaces stays in its home space's settings but no run sees it.
 */
export function mcpServerAvailableInSpace(scope: { spaceId: string; userId: string }) {
  return { ...availableInSpace(scope), availableNowhere: false };
}

/** An item's secret is this space's or, once the item reaches further spaces, the account's. */
export function itemSecretIn(scope: { spaceId: string; userId: string }) {
  return { userId: scope.userId, OR: [{ spaceId: scope.spaceId }, { spaceId: null }] };
}

/** Select alongside a row so `spaceAvailability` can describe it. */
export const AVAILABILITY_SELECT = { select: { spaceId: true } } as const;

export type SpaceAvailability = { allSpaces: boolean; spaceIds: string[] };

/** The spaces an item is available in, starting with the one it was added in. */
export function spaceAvailability(row: {
  spaceId: string;
  allSpaces: boolean;
  /** MCP servers only: true keeps the server out of every space. */
  availableNowhere?: boolean;
  availableIn?: Array<{ spaceId: string }>;
}): SpaceAvailability {
  if (row.availableNowhere) return { allSpaces: false, spaceIds: [] };
  return {
    allSpaces: row.allSpaces,
    spaceIds: [
      row.spaceId,
      ...(row.availableIn ?? []).map((entry) => entry.spaceId).filter((id) => id !== row.spaceId),
    ],
  };
}
