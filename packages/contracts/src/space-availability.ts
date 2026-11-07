import * as z from "zod";
import { Id } from "./ids.js";

/**
 * Where an account-owned item is available: every space, or these (starting with the one it was
 * added in). An MCP server only may have none, which keeps it out of every space.
 */
export const SpaceAvailabilitySchema = z.object({
  allSpaces: z.boolean(),
  spaceIds: z.array(Id),
});
export type SpaceAvailability = z.infer<typeof SpaceAvailabilitySchema>;
