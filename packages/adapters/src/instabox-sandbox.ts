import { randomUUID } from "node:crypto";
import type {
  AdapterContext,
  CommandRequest,
  ComputerActionRequest,
  ComputerFileEntry,
  ComputerInput,
  ComputerObservation,
  ComputerRef,
  ControlLeaseRef,
  PortableFile,
  ProcessEvent,
  SandboxProvider,
  ScreenRequest,
  ScreenSession,
  SnapshotRef,
} from "@rakazo/adapter-kit";
import { boundedSandboxCommandTimeoutMs } from "@rakazo/core";
import { sandboxIdleMs } from "./computer-idle.js";
import {
  normalizeWorkspacePath,
  shellQuote,
  workspaceCwd,
  workspacePath,
} from "./computer-support.js";
import { PortableFileBatcher } from "./computer-workspace.js";
import { sandboxCommandArgv } from "./sandbox-command-environment.js";
import { shouldSkipPortableWorkspaceFile } from "./workspace-save-policy.js";

const HOME = "/data/home";
const WORKSPACE = `${HOME}/rakazo-home`;
const DEFAULT_TEMPLATE = "agent-browser";
const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** Server-side cap on one running period; the provider pauses the machine when it is reached. */
const DEFAULT_MAX_RUN_MINUTES = 240;

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

interface EntryInfo {
  name: string;
  path: string;
  type: "file" | "dir";
}

/**
 * The Instabox SDK calls this provider makes, shaped like the SDK so an offline fake can stand in
 * for it and the SDK itself loads only when an Instabox computer is configured.
 */
export interface InstaboxClient {
  create(options: {
    name: string;
    template: string;
    metadata: Record<string, string>;
    autoSuspendMs: number;
  }): Promise<InstaboxMachine>;
  /** Attach without resuming when `resume` is false. */
  connect(id: string, options: { resume: boolean }): Promise<InstaboxMachine>;
  /** Current state, without starting or resuming the machine. */
  inspect(id: string): Promise<{ state: string }>;
  pause(id: string): Promise<void>;
  kill(id: string): Promise<boolean>;
  keepAlive(id: string, idleMs: number): Promise<void>;
  /** Caps one running period on the provider's side, independent of Rakazo's idle checks. */
  setMaxRun(id: string, minutes: number): Promise<void>;
}

export interface InstaboxMachine {
  readonly sandboxId: string;
  commands: {
    run(
      command: string,
      options: {
        cwd?: string;
        envs?: Record<string, string>;
        timeoutMs?: number;
        signal?: AbortSignal;
      },
    ): Promise<CommandResult>;
  };
  files: {
    list(path: string): Promise<EntryInfo[]>;
    read(path: string, options: { format: "bytes" }): Promise<Uint8Array>;
    write(path: string, data: Uint8Array, options?: { signal?: AbortSignal }): Promise<unknown>;
  };
  getInfo(): Promise<{ state: string }>;
  setAutoSuspend(idleMs: number): Promise<void>;
  pause(): Promise<void>;
  kill(): Promise<boolean>;
}

/** The SDK loads only when an Instabox computer is used, never in the default runtime. */
export function nativeInstaboxClient(apiKey: string, apiUrl?: string): InstaboxClient {
  type SdkSandbox = import("@insforge/instabox-sdk").Sandbox;
  let sdk: Promise<typeof import("@insforge/instabox-sdk")> | undefined;
  const load = () => (sdk ??= import("@insforge/instabox-sdk"));
  const connection = async () => ({
    apiKey,
    ...(apiUrl ? { apiUrl } : {}),
  });
  return {
    async create(options) {
      const { Sandbox } = await load();
      // `vault: false` keeps the account's Vault out of bot machines. Organization Secret
      // selection is a separate grant requested per machine and is never set here, so a new
      // machine holds neither store's credentials.
      return (await Sandbox.create(options.template, {
        ...(await connection()),
        name: options.name,
        metadata: options.metadata,
        autoSuspendMs: options.autoSuspendMs,
        vault: false,
      })) as unknown as SdkSandbox & InstaboxMachine;
    },
    async connect(id, options) {
      const { Sandbox } = await load();
      return (await Sandbox.connect(id, {
        ...(await connection()),
        resume: options.resume,
      })) as unknown as SdkSandbox & InstaboxMachine;
    },
    async inspect(id) {
      const { Sandbox } = await load();
      const machine = await Sandbox.connect(id, { ...(await connection()), resume: false });
      return machine.getInfo();
    },
    async pause(id) {
      const { Sandbox } = await load();
      await (await Sandbox.connect(id, { ...(await connection()), resume: false })).pause();
    },
    async kill(id) {
      const { Sandbox } = await load();
      return Sandbox.kill(id, await connection());
    },
    async keepAlive(id, idleMs) {
      const { Sandbox } = await load();
      const machine = await Sandbox.connect(id, { ...(await connection()), resume: false });
      await machine.setAutoSuspend(idleMs);
    },
    async setMaxRun(id, minutes) {
      // The SDK has no runtime-cap call, so this uses the documented machine PATCH route.
      const response = await fetch(
        `${apiUrl ?? "https://api.instabox.sh"}/v1/machines/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          headers: {
            "X-API-Key": apiKey,
            "content-type": "application/json",
            "Idempotency-Key": `rakazo-max-run-${randomUUID()}`,
          },
          body: JSON.stringify({ maxRunMinutes: minutes }),
        },
      );
      if (!response.ok) {
        throw new Error(`could not cap the Instabox computer's runtime (HTTP ${response.status})`);
      }
    },
  };
}

export interface InstaboxSandboxOptions {
  apiKey: string;
  apiUrl?: string;
  template?: string;
  maxRunMinutes?: number;
}

/** Instabox owns the VM; Rakazo runs commands and files there and has no graphical screen yet. */
export class InstaboxSandboxProvider implements SandboxProvider {
  billsWhileRunning(): boolean {
    return true;
  }

  private readonly client: InstaboxClient;
  private readonly template: string;
  private readonly maxRunMinutes: number;

  constructor(options: InstaboxSandboxOptions, client?: InstaboxClient) {
    this.client = client ?? nativeInstaboxClient(options.apiKey, options.apiUrl);
    this.template = options.template?.trim() || DEFAULT_TEMPLATE;
    this.maxRunMinutes = options.maxRunMinutes ?? DEFAULT_MAX_RUN_MINUTES;
  }

  describe() {
    return {
      id: "instabox" as const,
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        graphical: false,
        pty: false,
        snapshots: false,
        takeover: false,
        persistentHome: true,
        multiScreen: false,
      },
    };
  }

  async provision(
    request: {
      botId: string;
      homePath: string;
      providerRef?: string;
      providerKind?: ComputerRef["kind"];
    },
    context: AdapterContext,
  ): Promise<ComputerRef> {
    context.signal.throwIfAborted();
    if (request.providerRef && request.providerKind === "instabox") {
      try {
        const machine = await this.client.connect(request.providerRef, { resume: true });
        return this.ref(machine.sandboxId, request.botId, false);
      } catch (error) {
        if (!isGone(error)) throw error;
      }
    }
    const name = `rakazo-${randomUUID().replaceAll("-", "").slice(0, 20)}`;
    const machine = await this.client.create({
      name,
      template: this.template,
      metadata: { botId: request.botId, rakazo: "computer" },
      autoSuspendMs: sandboxIdleMs(),
    });
    if (context.signal.aborted) {
      await this.client.kill(machine.sandboxId).catch(() => undefined);
      context.signal.throwIfAborted();
    }
    // A machine without the provider-side cap could outlive any Rakazo bug, so fail closed.
    try {
      await this.client.setMaxRun(machine.sandboxId, this.maxRunMinutes);
    } catch (error) {
      await this.client.kill(machine.sandboxId).catch(() => undefined);
      throw error;
    }
    return this.ref(machine.sandboxId, request.botId, true);
  }

  async isRunning(computer: ComputerRef, context: AdapterContext): Promise<boolean> {
    context.signal.throwIfAborted();
    try {
      return (await this.client.inspect(this.id(computer))).state === "running";
    } catch (error) {
      if (isGone(error)) return false;
      throw error;
    }
  }

  async isStopped(computer: ComputerRef, context: AdapterContext): Promise<boolean> {
    context.signal.throwIfAborted();
    try {
      const state = (await this.client.inspect(this.id(computer))).state;
      return state === "suspended" || state === "stopped";
    } catch (error) {
      if (isGone(error)) return true;
      throw error;
    }
  }

  async prepare(computer: ComputerRef, context: AdapterContext): Promise<void> {
    const result = await this.run(
      computer,
      `mkdir -p -- ${shellQuote(WORKSPACE)} && test -d ${shellQuote(WORKSPACE)}`,
      { timeoutMs: 60_000, signal: context.signal },
    );
    if (result.exitCode !== 0)
      throw new Error(result.stderr || "could not prepare the Instabox computer");
  }

  async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    const command = sandboxCommandArgv(request).map(shellQuote).join(" ");
    const result = await this.run(computer, command, {
      cwd: workspaceCwd(WORKSPACE, request.cwd, [HOME]),
      envs: request.env,
      signal: context.signal,
      timeoutMs: boundedSandboxCommandTimeoutMs(request.timeoutMs),
    });
    if (result.stdout) yield { type: "stdout", data: result.stdout };
    if (result.stderr) yield { type: "stderr", data: result.stderr };
    yield { type: "exit", code: result.exitCode };
  }

  async connectScreen(
    _computer: ComputerRef,
    _request: ScreenRequest,
    _context: AdapterContext,
  ): Promise<ScreenSession> {
    throw new Error("Instabox computers have no Rakazo desktop");
  }

  async sendInput(
    _computer: ComputerRef,
    _input: ComputerInput,
    _lease: ControlLeaseRef,
    _context: AdapterContext,
  ): Promise<void> {
    throw new Error("Instabox computers have no Rakazo desktop");
  }

  async observe(_computer: ComputerRef, _context: AdapterContext): Promise<ComputerObservation> {
    throw new Error("Instabox computers have no Rakazo desktop");
  }

  async act(
    _computer: ComputerRef,
    _request: ComputerActionRequest,
    _context: AdapterContext,
  ): Promise<never> {
    throw new Error("Instabox computers have no Rakazo desktop");
  }

  async listFiles(
    computer: ComputerRef,
    directory: string,
    context: AdapterContext,
  ): Promise<ComputerFileEntry[]> {
    const relative = normalizeWorkspacePath(directory);
    const machine = await this.connect(computer);
    const entries = await machine.files.list(workspacePath(WORKSPACE, relative));
    context.signal.throwIfAborted();
    return entries.flatMap((entry) => {
      if (entry.type !== "file" && entry.type !== "dir") return [];
      return [
        {
          path: normalizeWorkspacePath(relative ? `${relative}/${entry.name}` : entry.name),
          kind: entry.type,
          // The SDK's listing carries no size or mode.
          size: 0,
        },
      ];
    });
  }

  async readFile(
    computer: ComputerRef,
    filePath: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ): Promise<Uint8Array> {
    const machine = await this.connect(computer);
    const content = await machine.files.read(workspacePath(WORKSPACE, filePath), {
      format: "bytes",
    });
    context.signal.throwIfAborted();
    const limit = options?.maxBytes ?? MAX_FILE_BYTES;
    if (content.byteLength > limit) throw new Error(`computer file exceeds ${limit} bytes`);
    return content;
  }

  async writeFile(
    computer: ComputerRef,
    file: PortableFile,
    context: AdapterContext,
  ): Promise<void> {
    await this.write(computer, [file], context);
  }

  async *exportWorkspace(
    computer: ComputerRef,
    context: AdapterContext,
  ): AsyncIterable<PortableFile> {
    const machine = await this.connect(computer);
    yield* walk(machine, "", context.signal);
  }

  async importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ): Promise<void> {
    const machine = await this.connect(computer);
    const batcher = new PortableFileBatcher<PortableFile>(32, (file) => file.content.byteLength);
    const flush = async (batch: PortableFile[]) => {
      if (batch.length) await this.writeWith(machine, batch, context);
    };
    for await (const file of files) {
      if (shouldSkipPortableWorkspaceFile(file.path)) continue;
      const full = batcher.add(file);
      if (full) await flush(full);
    }
    await flush(batcher.take());
  }

  async snapshot(_computer: ComputerRef, _context: AdapterContext): Promise<SnapshotRef> {
    throw new Error("Instabox computers have no Rakazo screen to snapshot");
  }

  async keepAlive(computer: ComputerRef): Promise<void> {
    await this.client.keepAlive(this.id(computer), sandboxIdleMs());
  }

  async stop(computer: ComputerRef, _context: AdapterContext): Promise<void> {
    await this.client.pause(this.id(computer));
  }

  async destroy(computer: ComputerRef, _context: AdapterContext): Promise<void> {
    await this.client.kill(this.id(computer));
  }

  private id(computer: ComputerRef): string {
    return computer.providerRef || computer.id;
  }

  private ref(id: string, botId: string, fresh: boolean): ComputerRef {
    return { id, botId, kind: "instabox", providerRef: id, fresh };
  }

  private async connect(computer: ComputerRef): Promise<InstaboxMachine> {
    try {
      return await this.client.connect(this.id(computer), { resume: true });
    } catch (error) {
      if (isGone(error)) throw new Error(`Instabox computer ${this.id(computer)} is gone`);
      throw error;
    }
  }

  private async write(
    computer: ComputerRef,
    files: readonly PortableFile[],
    context: AdapterContext,
  ): Promise<void> {
    await this.writeWith(await this.connect(computer), files, context);
  }

  private async writeWith(
    machine: InstaboxMachine,
    files: readonly PortableFile[],
    context: AdapterContext,
  ): Promise<void> {
    for (const file of files) {
      context.signal.throwIfAborted();
      await machine.files.write(workspacePath(WORKSPACE, file.path), file.content, {
        signal: context.signal,
      });
    }
    const executable = files
      .filter((file) => file.executable)
      .map((file) => shellQuote(workspacePath(WORKSPACE, file.path)));
    if (executable.length) {
      const result = await machine.commands.run(`chmod 700 -- ${executable.join(" ")}`, {
        signal: context.signal,
      });
      if (result.exitCode !== 0)
        throw new Error(result.stderr || "could not mark files executable");
    }
  }

  private async run(
    computer: ComputerRef,
    command: string,
    options: {
      cwd?: string;
      envs?: Record<string, string>;
      signal?: AbortSignal;
      timeoutMs: number;
    },
  ): Promise<CommandResult> {
    const machine = await this.connect(computer);
    options.signal?.throwIfAborted();
    try {
      return await machine.commands.run(command, options);
    } catch (error) {
      options.signal?.throwIfAborted();
      const result = error as Partial<CommandResult>;
      if (typeof result.exitCode === "number" && typeof result.stdout === "string") {
        return {
          stdout: result.stdout,
          stderr: typeof result.stderr === "string" ? result.stderr : "",
          exitCode: result.exitCode,
          timedOut: result.timedOut === true,
        };
      }
      throw error;
    }
  }
}

async function* walk(
  machine: InstaboxMachine,
  directory: string,
  signal: AbortSignal,
): AsyncIterable<PortableFile> {
  signal.throwIfAborted();
  const entries = await machine.files.list(workspacePath(WORKSPACE, directory));
  const files: Array<{ relative: string }> = [];
  const directories: string[] = [];
  for (const entry of entries) {
    const relative = normalizeWorkspacePath(directory ? `${directory}/${entry.name}` : entry.name);
    if (shouldSkipPortableWorkspaceFile(relative, entry.type === "dir")) continue;
    if (entry.type === "dir") directories.push(relative);
    else if (entry.type === "file") files.push({ relative });
  }
  for (let index = 0; index < files.length; index += 8) {
    const batch = await Promise.all(
      files.slice(index, index + 8).map(async ({ relative }) => {
        signal.throwIfAborted();
        return {
          path: relative,
          content: await machine.files.read(workspacePath(WORKSPACE, relative), {
            format: "bytes" as const,
          }),
        };
      }),
    );
    for (const file of batch) yield file;
  }
  for (const relative of directories) yield* walk(machine, relative, signal);
}

function isGone(error: unknown): boolean {
  return error instanceof Error && (error as { code?: unknown }).code === "not_found";
}
