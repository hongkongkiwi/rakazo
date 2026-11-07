import { randomUUID } from "node:crypto";
import { createRouterClient } from "@orpc/server";
import { EncryptedSecretStore, withSecretPersistence } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { createDb, runAsSystem, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled).sequential("MCP server agents (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let actor: Actor;
  const suffix = randomUUID();
  const organizationId = `mcp-agents-org-${suffix}`;
  const secrets = new EncryptedSecretStore("fake-mcp-agents-test-encryption-key");
  const botIds = { chief: `mcp-agents-chief-${suffix}`, writer: `mcp-agents-writer-${suffix}` };
  const client = () =>
    createRouterClient(
      createRouter({
        prisma,
        secrets,
        remoteConnectors: {
          resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
        },
        events: { notify: vi.fn() },
        env: { webOrigin: "http://localhost:5173", defaultProvider: "fake", defaultModel: "fake" },
        dataDir: "/tmp/mcp-agents-db-test",
      } as unknown as RouterDeps),
      { context: { actor } },
    );
  const asActor = (fn: () => Promise<void>) => () => runAsTenant(actor, fn);

  beforeAll(() =>
    runAsSystem("mcp agents fixture", async () => {
      db = createDb(process.env.DATABASE_URL!);
      prisma = withSecretPersistence(db.prisma, secrets);
      const userId = `mcp-agents-user-${suffix}`;
      const spaceId = `mcp-agents-space-${suffix}`;
      await prisma.user.create({
        data: { id: userId, name: "MCP Agents", email: `${userId}@example.test` },
      });
      await prisma.organization.create({
        data: {
          id: organizationId,
          name: "MCP Agents",
          slug: organizationId,
          createdAt: new Date(),
        },
      });
      await prisma.member.create({
        data: {
          id: `${userId}-member`,
          organizationId,
          userId,
          role: "owner",
          createdAt: new Date(),
        },
      });
      await prisma.space.create({
        data: {
          id: spaceId,
          organizationId,
          name: "General",
          isDefault: true,
          createdByUserId: userId,
        },
      });
      await prisma.spaceMember.create({
        data: {
          id: `${userId}-${spaceId}`,
          organizationId,
          spaceId,
          userId,
          createdAt: new Date(),
        },
      });
      for (const [name, id] of Object.entries(botIds))
        await prisma.bot.create({ data: { id, spaceId, userId, name, color: "blue" } });
      actor = { spaceId, userId, email: `${userId}@example.test`, isDeploymentOwner: false };
    }),
  );
  afterAll(() =>
    runAsSystem("mcp agents fixture", async () => {
      if (prisma) {
        await prisma.organization.deleteMany({ where: { id: organizationId } });
        await prisma.user.deleteMany({ where: { id: actor?.userId } });
        await prisma.$disconnect();
        await db.pool.end();
      }
      await secrets.close();
    }),
  );

  it(
    "shares a server the user adds with every agent, and narrows it to chosen agents",
    asActor(async () => {
      const created = await client().mcp.servers.create({
        transport: "streamable_http",
        slug: "search-console",
        name: "Search Console",
        endpoint: "https://mcp.search-console.test/mcp",
        headers: {},
        enabled: true,
      });
      expect(created.allBots).toBe(true);

      const narrowed = await client().mcp.servers.agents({
        id: created.id,
        allBots: false,
        botIds: [botIds.writer],
      });
      expect(narrowed.server.allBots).toBe(false);
      expect(narrowed.assignments.map((row) => row.botId)).toEqual([botIds.writer]);

      const switched = await client().mcp.servers.agents({
        id: created.id,
        allBots: false,
        botIds: [botIds.chief],
      });
      expect(switched.assignments.map((row) => row.botId)).toEqual([botIds.chief]);

      // Sharing again keeps the choice, so narrowing later starts from it.
      const shared = await client().mcp.servers.agents({ id: created.id, allBots: true });
      expect(shared.server.allBots).toBe(true);
      expect(shared.assignments.map((row) => row.botId)).toEqual([botIds.chief]);
    }),
  );

  it(
    "switches a server off and on without changing its configuration",
    asActor(async () => {
      const created = await client().mcp.servers.create({
        transport: "streamable_http",
        slug: "toggle-server",
        name: "Toggle",
        endpoint: "https://mcp.search-console.test/mcp",
        headers: {},
        enabled: true,
      });
      const off = await client().mcp.servers.setEnabled({ id: created.id, enabled: false });
      expect(off.enabled).toBe(false);
      expect(off.revision).toBeGreaterThan(created.revision);
      expect(off.endpoint).toBe(created.endpoint);

      const listed = (await client().mcp.servers.list()).find((row) => row.id === created.id);
      expect(listed?.enabled).toBe(false);

      // A config edit that leaves the switch out keeps it off.
      const edited = await client().mcp.servers.update({
        id: created.id,
        config: {
          transport: "streamable_http",
          slug: "toggle-server",
          name: "Toggle renamed",
          endpoint: "https://mcp.search-console.test/mcp",
          headers: {},
        },
      });
      expect(edited.enabled).toBe(false);
      expect(edited.name).toBe("Toggle renamed");

      const on = await client().mcp.servers.setEnabled({ id: created.id, enabled: true });
      expect(on.enabled).toBe(true);
      // Repeating the current state changes nothing.
      expect(
        (await client().mcp.servers.setEnabled({ id: created.id, enabled: true })).revision,
      ).toBe(on.revision);

      // Two identical requests race: one transition and one revision bump.
      const [first, second] = await Promise.all([
        client().mcp.servers.setEnabled({ id: created.id, enabled: false }),
        client().mcp.servers.setEnabled({ id: created.id, enabled: false }),
      ]);
      expect(first.revision).toBe(on.revision + 1);
      expect(second.revision).toBe(first.revision);
    }),
  );

  it(
    "keeps a server available in no space while its settings still list it",
    asActor(async () => {
      const created = await client().mcp.servers.create({
        transport: "streamable_http",
        slug: "parked-server",
        name: "Parked",
        endpoint: "https://mcp.search-console.test/mcp",
        headers: {},
        enabled: true,
      });
      expect(
        await client().availability.set({
          kind: "mcpServer",
          id: created.id,
          allSpaces: false,
          spaceIds: [],
        }),
      ).toEqual({ allSpaces: false, spaceIds: [] });

      const listed = (await client().mcp.servers.list()).find((row) => row.id === created.id);
      expect(listed?.availability).toEqual({ allSpaces: false, spaceIds: [] });

      // The parked server still holds its name in the space that keeps it.
      await client().mcp.servers.create({
        transport: "streamable_http",
        slug: "taken-server",
        name: "Taken",
        endpoint: "https://mcp.search-console.test/mcp",
        headers: {},
      });
      await expect(
        client().mcp.servers.update({
          id: created.id,
          config: {
            transport: "streamable_http",
            slug: "taken-server",
            name: "Parked",
            endpoint: "https://mcp.search-console.test/mcp",
            headers: {},
            enabled: false,
          },
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });

      await client().availability.set({
        kind: "mcpServer",
        id: created.id,
        allSpaces: false,
        spaceIds: [actor.spaceId],
      });
    }),
  );

  it(
    "refuses agents and servers the user does not own",
    asActor(async () => {
      const server = (await client().mcp.servers.list()).find(
        (row) => row.slug === "search-console",
      );
      await expect(
        client().mcp.servers.agents({ id: server!.id, allBots: false, botIds: ["other-bot"] }),
      ).rejects.toThrow();
      await expect(
        client().mcp.servers.agents({ id: "other-server", allBots: true }),
      ).rejects.toThrow();
      expect(server?.allBots).toBe(true);
    }),
  );
});
