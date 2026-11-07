import type { AdapterContext, ComputerRef, ProcessEvent } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import type { InstaboxClient, InstaboxMachine } from "./instabox-sandbox.js";
import { InstaboxSandboxProvider } from "./instabox-sandbox.js";

const ctx: AdapterContext = {
  operationId: "op",
  traceId: "trace",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};

const encoder = new TextEncoder();
const WORKSPACE = "/data/home/rakazo-home";

class FakeMachine implements InstaboxMachine {
  readonly sandboxId: string;
  readonly store = new Map<string, Uint8Array>();
  readonly ran: string[] = [];
  state = "running";
  readonly commands = {
    run: async (command: string) => {
      this.ran.push(command);
      if (command.includes("exit 3"))
        return { stdout: "out", stderr: "err", exitCode: 3, timedOut: false };
      return { stdout: "ok", stderr: "", exitCode: 0, timedOut: false };
    },
  };
  readonly files = {
    list: async (directory: string) => {
      const entries: Array<{ name: string; path: string; type: "file" }> = [];
      for (const path of this.store.keys()) {
        if (!path.startsWith(`${directory}/`)) continue;
        entries.push({ name: path.slice(directory.length + 1), path, type: "file" });
      }
      return entries;
    },
    read: async (path: string) => {
      const content = this.store.get(path);
      if (!content) throw Object.assign(new Error("not found"), { code: "not_found" });
      return content;
    },
    write: async (path: string, data: Uint8Array) => {
      this.store.set(path, data);
      return { path };
    },
  };

  constructor(id: string) {
    this.sandboxId = id;
  }

  readonly setAutoSuspend = async () => undefined;
  readonly pause = async () => {
    this.state = "suspended";
  };
  readonly kill = async () => true;
  readonly getInfo = async () => ({ state: this.state });
}

class FakeInstabox implements InstaboxClient {
  readonly machines = new Map<string, FakeMachine>();
  readonly created: Array<Parameters<InstaboxClient["create"]>[0]> = [];
  async create(options: Parameters<InstaboxClient["create"]>[0]) {
    this.created.push(options);
    const machine = new FakeMachine(`m_${this.machines.size + 1}`);
    this.machines.set(machine.sandboxId, machine);
    return machine;
  }
  async connect(id: string) {
    const machine = this.machines.get(id);
    if (!machine) throw Object.assign(new Error("not found"), { code: "not_found" });
    return machine;
  }
  async inspect(id: string) {
    return { state: (await this.connect(id)).state };
  }
  async pause(id: string) {
    await (await this.connect(id)).pause();
  }
  async kill(id: string) {
    return this.machines.delete(id);
  }
  async keepAlive() {
    return undefined;
  }
}

async function events(
  provider: InstaboxSandboxProvider,
  computer: ComputerRef,
  argv: string[] = ["echo", "hi"],
) {
  const seen: ProcessEvent[] = [];
  for await (const event of provider.execute(computer, { argv }, ctx)) {
    seen.push(event);
  }
  return seen;
}

describe("instabox computers", () => {
  it("creates an isolated machine in the bot's name without the account Vault", async () => {
    const box = new FakeInstabox();
    const provider = new InstaboxSandboxProvider({ apiKey: "ibk_test" }, box);

    const computer = await provider.provision({ botId: "bot", homePath: "/unused" }, ctx);

    expect(computer).toMatchObject({ kind: "instabox", fresh: true, providerRef: "m_1" });
    expect(box.created).toEqual([
      expect.objectContaining({
        template: "agent-browser",
        metadata: { botId: "bot", rakazo: "computer" },
      }),
    ]);
  });

  it("reconnects a saved reference instead of creating another machine", async () => {
    const box = new FakeInstabox();
    const first = await new InstaboxSandboxProvider({ apiKey: "k" }, box).provision(
      { botId: "bot", homePath: "/unused" },
      ctx,
    );
    const second = await new InstaboxSandboxProvider({ apiKey: "k" }, box).provision(
      {
        botId: "bot",
        homePath: "/unused",
        providerRef: first.providerRef,
        providerKind: "instabox",
      },
      ctx,
    );

    expect(second).toMatchObject({ providerRef: first.providerRef, fresh: false });
    expect(box.created).toHaveLength(1);
  });

  it("writes, lists, reads and exports the bot workspace", async () => {
    const box = new FakeInstabox();
    const provider = new InstaboxSandboxProvider({ apiKey: "k" }, box);
    const computer = await provider.provision({ botId: "bot", homePath: "/unused" }, ctx);

    await provider.writeFile(
      computer,
      { path: "notes/result.txt", content: encoder.encode("portable") },
      ctx,
    );
    expect(await provider.listFiles(computer, "notes", ctx)).toEqual([
      { path: "notes/result.txt", kind: "file", size: 0 },
    ]);
    expect(
      new TextDecoder().decode(await provider.readFile(computer, "notes/result.txt", ctx)),
    ).toBe("portable");

    const exported = [];
    for await (const file of provider.exportWorkspace(computer, ctx)) exported.push(file);
    expect(exported.map((file) => file.path)).toEqual(["notes/result.txt"]);
    expect(box.machines.get("m_1")!.store.has(`${WORKSPACE}/notes/result.txt`)).toBe(true);
  });

  it("returns a non-zero exit as a result instead of throwing", async () => {
    const box = new FakeInstabox();
    const provider = new InstaboxSandboxProvider({ apiKey: "k" }, box);
    const computer = await provider.provision({ botId: "bot", homePath: "/unused" }, ctx);
    box.machines.get("m_1")!.commands.run = async (command: string) =>
      command.includes("exit 3")
        ? { stdout: "out", stderr: "err", exitCode: 3, timedOut: false }
        : { stdout: "ok", stderr: "", exitCode: 0, timedOut: false };

    expect(await events(provider, computer, ["bash", "-c", "exit 3"])).toEqual([
      { type: "stdout", data: "out" },
      { type: "stderr", data: "err" },
      { type: "exit", code: 3 },
    ]);
  });

  it("pauses on stop and deletes on destroy", async () => {
    const box = new FakeInstabox();
    const provider = new InstaboxSandboxProvider({ apiKey: "k" }, box);
    const computer = await provider.provision({ botId: "bot", homePath: "/unused" }, ctx);

    await provider.stop(computer, ctx);
    expect(await provider.isStopped(computer, ctx)).toBe(true);
    expect(await provider.isRunning(computer, ctx)).toBe(false);

    await provider.destroy(computer, ctx);
    expect(box.machines.size).toBe(0);
  });

  it("refuses to read more bytes than asked for", async () => {
    const box = new FakeInstabox();
    const provider = new InstaboxSandboxProvider({ apiKey: "k" }, box);
    const computer = await provider.provision({ botId: "bot", homePath: "/unused" }, ctx);

    await provider.writeFile(
      computer,
      { path: "hello.txt", content: encoder.encode("hello") },
      ctx,
    );
    await expect(provider.readFile(computer, "hello.txt", ctx, { maxBytes: 2 })).rejects.toThrow(
      "exceeds 2 bytes",
    );
    expect(await provider.readFile(computer, "hello.txt", ctx)).toEqual(encoder.encode("hello"));
  });
});
