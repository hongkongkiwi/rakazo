/**
 * Managed installs for npm-published stdio MCP servers.
 *
 * `npx -y <package>` downloads the package on every cold start, inside the MCP startup
 * timeout. A slow registry turns that into a timeout that kills npx mid-download, and the
 * interrupted install leaves a half-populated `~/.npm/_npx` entry without the bin, so every
 * later launch fails with "Connection closed". Instead the connector installs the package
 * once into its own directory, with its own (longer) timeout, publishes it atomically, and
 * launches the installed bin directly.
 */

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mcpOAuthEnvReferences } from "@rakazo/contracts";

export const DEFAULT_MCP_INSTALL_TIMEOUT_MS = 180_000;
const READY_MARKER = ".ready";
const LOCK_POLL_MS = 250;
/** How long past the holder's install timeout a lock is still honoured. */
const LOCK_GRACE_MS = 30_000;
const OUTPUT_TAIL_CHARS = 2_000;

/** A package launcher reduced to the package it runs and the bin's own arguments. */
export type LaunchSpec = {
  /** Registry or PyPI spec, for example `name@1.2.3` or `name==1.2.3`. */
  spec: string;
  /** Bin named with `-p <spec> <bin>` or `uvx --from <spec> <bin>`. */
  binName?: string;
  binArgs: string[];
};

/** An `npx` or `pnpx` launch. */
export type NpmLaunch = LaunchSpec;

/**
 * A bin installed by {@link ensureMcpPackage}. Only values this module issued are accepted
 * as a stdio launch target, so a path that came from configuration cannot bypass the
 * command allowlist.
 */
export type InstalledMcpBin = { readonly binPath: string };

const issued = new WeakSet<InstalledMcpBin>();

/** True for a bin issued by {@link ensureMcpPackage} in this process. */
export function isInstalledMcpBin(value: unknown): value is InstalledMcpBin {
  return typeof value === "object" && value !== null && issued.has(value as InstalledMcpBin);
}

const NAME_PART = "[A-Za-z0-9][A-Za-z0-9._~-]*";
const PACKAGE_NAME = new RegExp(`^(?:@${NAME_PART}/)?${NAME_PART}$`);
// Versions, dist-tags and ranges without spaces. Paths, URLs, git and alias specs all need
// a character outside this set (`/`, `:`, `#`).
const VERSION_SELECTOR = /^[A-Za-z0-9.^~<>=*|+_-]+$/;
const TARBALL_NAME = /\.(?:tgz|tar|tar\.gz)$/i;
const BIN_NAME = /^[A-Za-z0-9._-]+$/;

/** Split a registry spec into its package name, or undefined when it is not one. */
export function registryPackageName(spec: string): string | undefined {
  const at = spec.indexOf("@", spec.startsWith("@") ? 1 : 0);
  const name = at === -1 ? spec : spec.slice(0, at);
  const selector = at === -1 ? undefined : spec.slice(at + 1);
  if (!PACKAGE_NAME.test(name) || TARBALL_NAME.test(name) || name.length > 214) return undefined;
  if (selector !== undefined && !VERSION_SELECTOR.test(selector)) return undefined;
  return name;
}

/** The command's file name without a directory or a Windows launcher suffix. */
export function launcherBasename(command: string): string {
  return basename(command.trim().replaceAll("\\", "/")).replace(/\.(?:cmd|exe|ps1)$/i, "");
}

export function isNpmRunnerCommand(command: string): boolean {
  return /^(?:npx|pnpx)(?:\.cmd|\.exe)?$/i.test(launcherBasename(command));
}

export function isUvxCommand(command: string): boolean {
  return /^uvx(?:\.cmd|\.exe)?$/i.test(launcherBasename(command));
}

// Package managers and runners that fetch and run packages Rakazo can't vet. Whole commands,
// not subcommands: global flags (`pnpm -C dir dlx`) and auto-installs (`bun run`, `uv run
// --with`) make subcommand checks easy to slip past.
const PACKAGE_RUNNER =
  /^(?:npm|pnpm|yarn|yarnpkg|corepack|bun|bunx|deno|uv|pipx)(?:\.cmd|\.exe|\.ps1)?$/i;

/** Package runners that cannot use a managed install. */
export function isPackageRunnerCommand(command: string): boolean {
  return PACKAGE_RUNNER.test(launcherBasename(command));
}

/**
 * Recognise `npx`/`pnpx [-y|--yes] <spec> [args...]` and `[-y] -p|--package <spec> <bin>
 * [args...]` (with optional `--` separators). Anything else, including unknown runner flags
 * and specs that are not plain registry packages (paths, git or tarball URLs, aliases),
 * returns undefined and must not be launched.
 */
export function parseNpmLaunch(command: string, args: readonly string[]): NpmLaunch | undefined {
  if (!isNpmRunnerCommand(command)) return undefined;
  let spec: string | undefined;
  let index = 0;
  for (; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "-y" || arg === "--yes") continue;
    if (arg === "--") {
      index += 1;
      break;
    }
    if (arg === "-p" || arg === "--package" || arg.startsWith("--package=")) {
      // Several packages make the bin choice ambiguous; leave that to npx.
      if (spec !== undefined) return undefined;
      spec = arg.startsWith("--package=") ? arg.slice("--package=".length) : args[++index];
      if (!spec) return undefined;
      continue;
    }
    if (arg.startsWith("-")) return undefined;
    break;
  }
  const rest = args.slice(index);
  if (spec !== undefined) {
    const [binName, ...binArgs] = rest;
    if (!binName || !BIN_NAME.test(binName) || !registryPackageName(spec)) return undefined;
    return { spec, binName, binArgs };
  }
  const [first, ...binArgs] = rest;
  if (!first || !registryPackageName(first)) return undefined;
  return { spec: first, binArgs };
}

const PYTHON_NAME = "[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?";
const PYTHON_VERSION = "[A-Za-z0-9.*+!_-]+";
const PYTHON_SPECIFIER = `(?:===|==|!=|<=|>=|<|>|~=)[ \\t]*${PYTHON_VERSION}`;
const REQUIREMENT = new RegExp(
  `^(${PYTHON_NAME})(?:\\[${PYTHON_NAME}(?:,${PYTHON_NAME})*\\])?(?:[ \\t]*${PYTHON_SPECIFIER}(?:[ \\t]*,[ \\t]*${PYTHON_SPECIFIER})*)?$`,
);

function distributionName(spec: string): string | undefined {
  return REQUIREMENT.exec(spec)?.[1]
    ?.toLowerCase()
    .replace(/[-_.]+/g, "-");
}

export function parseUvxLaunch(command: string, args: readonly string[]): LaunchSpec | undefined {
  if (!isUvxCommand(command)) return undefined;
  let index = 0;
  let from: string | undefined;
  const first = args[index];
  if (first === "--from") from = args[++index];
  else if (first?.startsWith("--from=")) from = first.slice("--from=".length);
  if (from !== undefined) {
    index += 1;
    if (args[index] === "--") index += 1;
    const binName = args[index++];
    if (!distributionName(from) || !binName || !BIN_NAME.test(binName)) return undefined;
    return { spec: from, binName, binArgs: args.slice(index) };
  }
  if (args[index] === "--") index += 1;
  const spec = args[index++];
  if (!spec || !distributionName(spec)) return undefined;
  return { spec, binArgs: args.slice(index) };
}

export type PackageLaunch = LaunchSpec & { runner: "npm" | "uv" };

export function parsePackageLaunch(
  command: string,
  args: readonly string[],
): PackageLaunch | undefined {
  const npm = parseNpmLaunch(command, args);
  if (npm) return { runner: "npm", ...npm };
  const uv = parseUvxLaunch(command, args);
  return uv ? { runner: "uv", ...uv } : undefined;
}

/**
 * Where managed packages live: `MCP_PACKAGES_DIR`, else `<DATA_DIR or /data>/mcp-packages`
 * when that volume is writable (the API and worker share it, so one install serves both),
 * else a directory under the OS temp dir.
 */
export function defaultMcpPackagesRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MCP_PACKAGES_DIR?.trim()) return resolve(env.MCP_PACKAGES_DIR.trim());
  const dataDir = resolve(env.DATA_DIR?.trim() || "/data");
  try {
    accessSync(dataDir, constants.W_OK);
    return join(dataDir, "mcp-packages");
  } catch {
    return join(tmpdir(), "rakazo-mcp-packages");
  }
}

export type EnsureMcpPackageOptions = {
  /** Packages directory; defaults to {@link defaultMcpPackagesRoot}. */
  root?: string;
  /** Bin to launch (from `npx -p <spec> <bin>`). */
  binName?: string;
  timeoutMs?: number;
  /** Stops this caller waiting. A started install keeps going, so the next launch finds it. */
  signal?: AbortSignal;
  /** Extra environment for the installer, such as the server's `NPM_CONFIG_*` settings. */
  env?: Record<string, string>;
  /** Called once when the package is not installed yet and this call has to wait for it. */
  onInstall?: () => void;
  onSettled?: () => Promise<void>;
  /** npm executable. Tests point this at a stub. */
  npmCommand?: string;
  /** Which installer runs; `uv` installs a PyPI requirement into its own venv. */
  runner?: "npm" | "uv";
  /** uv executable. Tests point this at a stub. */
  uvCommand?: string;
  /** What the installer installs instead of `spec` (tests install a local tarball). */
  installTarget?: string;
};

const inFlight = new Map<string, Promise<void>>();

/**
 * The install directory for `spec` under `root`. Native addons are built per Node ABI, so
 * the npm key includes the Node major version; a uv venv is self-contained.
 */
export function mcpPackageDir(
  spec: string,
  root: string,
  env: Record<string, string> = {},
  runner: "npm" | "uv" = "npm",
): string {
  if (runner === "uv") {
    const key = createHash("sha256")
      .update(
        `uv\0${spec}\0${JSON.stringify(Object.entries(uvSettings(env)).sort(([a], [b]) => a.localeCompare(b)))}`,
      )
      .digest("hex")
      .slice(0, 32);
    return join(resolve(root), key);
  }
  const nodeMajor = process.versions.node.split(".")[0];
  const key = createHash("sha256")
    .update(
      `${spec}\0node${nodeMajor}\0${JSON.stringify(Object.entries(npmSettings(env)).sort(([a], [b]) => a.localeCompare(b)))}`,
    )
    .digest("hex")
    .slice(0, 32);
  return join(resolve(root), key);
}

/**
 * Install `spec` once under `root/<hash of spec and Node major>` and return its bin. A
 * directory only becomes visible at its final path, complete and marked ready, through one
 * atomic rename; concurrent callers share one install in-process and one lock across
 * processes on the same volume.
 */
export async function ensureMcpPackage(
  spec: string,
  options: EnsureMcpPackageOptions = {},
): Promise<InstalledMcpBin> {
  const runner = options.runner ?? "npm";
  const name = runner === "uv" ? distributionName(spec) : registryPackageName(spec);
  if (!name)
    throw new Error(
      `Not an ${runner === "uv" ? "PyPI requirement" : "npm registry package"}: ${spec}`,
    );
  const root = resolve(options.root ?? defaultMcpPackagesRoot());
  const dir = mcpPackageDir(spec, root, options.env, runner);
  const key = basename(dir);
  if (!(await isReady(dir))) {
    options.onInstall?.();
    let pending = inFlight.get(dir);
    if (!pending) {
      pending = installLocked({
        root,
        key,
        dir,
        name,
        target: options.installTarget ?? spec,
        timeoutMs: options.timeoutMs ?? DEFAULT_MCP_INSTALL_TIMEOUT_MS,
        env: options.env ?? {},
        npmCommand: options.npmCommand ?? "npm",
        runner,
        uvCommand: options.uvCommand ?? "uv",
      }).finally(() => inFlight.delete(dir));
      inFlight.set(dir, pending);
    }
    void pending
      .then(
        () => options.onSettled?.(),
        () => options.onSettled?.(),
      )
      .catch(() => undefined);
    await abortable(pending, options.signal);
  }
  const bin: InstalledMcpBin = Object.freeze({
    binPath: await resolveBin(dir, name, options.binName, runner),
  });
  issued.add(bin);
  return bin;
}

async function isReady(dir: string): Promise<boolean> {
  try {
    await access(join(dir, READY_MARKER));
    return true;
  } catch {
    return false;
  }
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  void promise.catch(() => undefined);
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolvePromise, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolvePromise(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

type InstallPlan = {
  root: string;
  key: string;
  dir: string;
  name: string;
  target: string;
  timeoutMs: number;
  env: Record<string, string>;
  npmCommand: string;
  runner: "npm" | "uv";
  uvCommand: string;
};

async function installLocked(plan: InstallPlan): Promise<void> {
  await mkdir(plan.root, { recursive: true });
  const lock = `${plan.dir}.lock`;
  let token: string | undefined;
  while (!token) {
    if (await isReady(plan.dir)) return;
    token = await tryLock(lock, plan.timeoutMs);
    if (!token) {
      await breakStaleLock(lock, plan.timeoutMs);
      await new Promise((done) => setTimeout(done, LOCK_POLL_MS));
    }
  }
  try {
    if (await isReady(plan.dir)) return;
    // Holding the lock, anything left for this key is debris from an interrupted install.
    await rm(plan.dir, { recursive: true, force: true });
    for (const entry of await readdir(plan.root)) {
      if (entry.startsWith(`.tmp-${plan.key}-`))
        await rm(join(plan.root, entry), { recursive: true, force: true });
    }
    const staging = await mkdtemp(join(plan.root, `.tmp-${plan.key}-`));
    try {
      if (plan.runner === "uv") {
        const venv = join(staging, ".venv");
        const env = {
          ...installEnvironment(plan.env, "uv"),
          UV_CACHE_DIR: join(plan.root, "uv", "cache"),
          UV_PYTHON_INSTALL_DIR: join(plan.root, "uv", "python"),
          UV_LINK_MODE: "copy",
          UV_NO_PROGRESS: "1",
          UV_NO_CONFIG: "1",
        };
        const started = Date.now();
        await runInstall(plan, plan.uvCommand, ["venv", venv], env);
        await runInstall(
          { ...plan, timeoutMs: Math.max(1, plan.timeoutMs - (Date.now() - started)) },
          plan.uvCommand,
          [
            "pip",
            "install",
            "--python",
            join(venv, "bin", "python"),
            // An sdist build runs the package's own code; install wheels only.
            "--only-binary",
            ":all:",
            plan.target,
          ],
          env,
        );
        const { bins } = await declaredUvBins(staging, plan.name);
        if (bins.length === 0)
          throw new Error(`${plan.name} does not declare a single bin to run (available: none)`);
        const python = join(plan.dir, ".venv", "bin", "python");
        for (const [, path] of bins) {
          // Console scripts are entry points: their shebang names this venv's interpreter, and
          // publishing moves the venv (a staging path may differ), so rewrite the line itself.
          const script = await readFile(path, "utf8");
          const end = script.indexOf("\n");
          const first = end === -1 ? script : script.slice(0, end);
          const cr = first.endsWith("\r") ? "\r" : "";
          if (first.replace(/\r$/, "").startsWith("#!")) {
            const rest = end === -1 ? "" : script.slice(end);
            await writeFile(path, `#!${python}${cr}${rest}`);
          }
          await chmod(path, 0o755);
        }
      } else {
        // Anchor npm at the staging dir so it never walks up to an unrelated project.
        await writeFile(join(staging, "package.json"), '{"private":true}\n');
        await runNpmInstall(plan, staging);
        await makeBinsExecutable(staging, plan.name);
      }
      await writeFile(join(staging, READY_MARKER), `${JSON.stringify({ target: plan.target })}\n`);
      await rename(staging, plan.dir);
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      // A holder whose lock expired mid-install may still have published the same package.
      if (await isReady(plan.dir)) return;
      throw error;
    }
  } finally {
    await releaseLock(lock, token);
  }
}

type LockOwner = { token: string; pid: number; host: string; expiresAt: number };

/** Atomic `mkdir` lock; the owner file says when a crashed holder's lock may be taken. */
async function tryLock(lock: string, timeoutMs: number): Promise<string | undefined> {
  try {
    await mkdir(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw error;
  }
  const owner: LockOwner = {
    token: randomUUID(),
    pid: process.pid,
    host: hostname(),
    expiresAt: Date.now() + timeoutMs + LOCK_GRACE_MS,
  };
  await writeFile(join(lock, "owner"), JSON.stringify(owner));
  return owner.token;
}

async function readOwner(lock: string): Promise<LockOwner | undefined> {
  try {
    return JSON.parse(await readFile(join(lock, "owner"), "utf8")) as LockOwner;
  } catch {
    return undefined;
  }
}

async function breakStaleLock(lock: string, timeoutMs: number): Promise<void> {
  const inspected = await stat(lock).catch(() => undefined);
  if (!inspected) return;
  const owner = await readOwner(lock);
  let stale: boolean;
  if (owner) {
    stale =
      Date.now() > owner.expiresAt ||
      (owner.host === hostname() && owner.pid !== process.pid && !processAlive(owner.pid));
  } else {
    // The holder died between mkdir and writing its owner file (or the lock just vanished).
    const created = await stat(lock).then(
      (info) => info.mtimeMs,
      () => undefined,
    );
    stale = created !== undefined && Date.now() > created + timeoutMs + LOCK_GRACE_MS;
  }
  if (!stale) return;
  // Quarantine atomically, then verify that we moved the lock we inspected.
  const aside = `${lock}.stale-${randomUUID()}`;
  try {
    await rename(lock, aside);
  } catch {
    return;
  }
  const movedOwner = await readOwner(aside);
  const moved = await stat(aside);
  if (
    moved.ino !== inspected.ino ||
    moved.dev !== inspected.dev ||
    movedOwner?.token !== owner?.token
  ) {
    // A different waiter already replaced the expired owner. Never delete its lock.
    // If another owner has acquired the path meanwhile, keep the quarantine intact.
    await rename(aside, lock).catch(() => undefined);
    return;
  }
  await rm(aside, { recursive: true, force: true });
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function releaseLock(lock: string, token: string): Promise<void> {
  // A lock taken over after this install overran its timeout belongs to someone else now.
  if ((await readOwner(lock))?.token !== token) return;
  await rm(lock, { recursive: true, force: true });
}

/** npm and proxy settings from the host, the server's own env on top. */
export function npmSettings(extra: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(extra).filter(([key]) =>
      /^(?:npm_config_|https?_proxy$|no_proxy$|node_extra_ca_certs$)/i.test(key),
    ),
  );
}

/** uv, pip and proxy settings from the host, the server's own env on top. */
export function uvSettings(extra: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(extra).filter(
      ([key]) =>
        /^(?:uv_|pip_|https?_proxy$|no_proxy$|ssl_cert_file$|requests_ca_bundle$)/i.test(key) &&
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(key),
    ),
  );
}

function installEnvironment(
  extra: Record<string, string>,
  runner: "npm" | "uv" = "npm",
): Record<string, string> {
  const env: Record<string, string> = { ...getDefaultEnvironment() };
  const settings = runner === "uv" ? uvSettings : npmSettings;
  const host = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  for (const [key, value] of Object.entries({ ...settings(host), ...settings(extra) })) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) env[key] = value;
  }
  // The connector already drops these; keep both runners safe on their own.
  for (const [key, value] of Object.entries(env)) {
    if (mcpOAuthEnvReferences(value).fields.length > 0) delete env[key];
  }
  return env;
}

function runNpmInstall(plan: InstallPlan, prefix: string): Promise<void> {
  const args = [
    "install",
    "--ignore-scripts",
    "--prefix",
    prefix,
    "--no-save",
    "--no-audit",
    "--no-fund",
    "--no-package-lock",
    "--loglevel=warn",
    plan.target,
  ];
  return runInstall(plan, plan.npmCommand, args, installEnvironment(plan.env));
}

function runInstall(
  plan: InstallPlan,
  command: string,
  args: string[],
  env: Record<string, string>,
): Promise<void> {
  return new Promise<void>((resolvePromise, reject) => {
    let output = "";
    const append = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-OUTPUT_TAIL_CHARS * 2);
    };
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        // Own process group, so a timeout also stops everything npm started.
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, plan.timeoutMs);
    timer.unref?.();
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Could not run ${installerName(plan, args)} to install ${plan.target}: ${error.message}`,
        ),
      );
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (!timedOut && code === 0) {
        resolvePromise();
        return;
      }
      const tail = output.trim().slice(-OUTPUT_TAIL_CHARS);
      const reason = timedOut
        ? `timed out after ${Math.round(plan.timeoutMs / 1000)}s`
        : `failed (${code === null ? `signal ${signal}` : `exit ${code}`})`;
      reject(
        new Error(
          `${installerName(plan, args)} ${plan.target} ${reason}${tail ? `: ${tail}` : ""}`,
        ),
      );
    });
  });
}

function installerName(plan: InstallPlan, args: readonly string[]): string {
  if (plan.runner !== "uv") return "npm install";
  return args[0] === "venv" ? "uv venv" : "uv pip install";
}

function killTree(child: ChildProcess): void {
  try {
    if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

type DeclaredBins = { packageDir: string; unscoped: string; bins: Array<[string, string]> };

/** PEP 503 normalisation, which both distribution names and console-script names use. */
function normalizeDistribution(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

/** The installed distribution's `Name:` header, which is authoritative for matching. */
async function metadataName(distInfo: string): Promise<string | undefined> {
  try {
    const handle = await open(join(distInfo, "METADATA"), "r");
    try {
      // Headers come first; a long description later in the file is not worth reading.
      const buffer = Buffer.alloc(4_096);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const name = /^Name:[ \t]*(.+?)\r?$/im.exec(buffer.toString("utf8", 0, bytesRead))?.[1];
      return name ? normalizeDistribution(name.trim()) : undefined;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

/** The bins an installed uv package declares, as executable paths inside its venv. */
async function declaredUvBins(
  dir: string,
  name: string,
): Promise<Pick<DeclaredBins, "unscoped" | "bins">> {
  const venv = join(dir, ".venv");
  const entryPoints = await findUvEntryPoints(venv, normalizeDistribution(name));
  const bins: Array<[string, string]> = [];
  const actualVenv = await realpath(venv).catch(() => undefined);
  const actualRoot = await realpath(dir).catch(() => undefined);
  if (!entryPoints || !actualVenv || !actualRoot) return { unscoped: name, bins };
  let section = "";
  for (const line of (await readFile(entryPoints, "utf8")).split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      section = trimmed;
      continue;
    }
    if (section !== "[console_scripts]") continue;
    const [script, target, ...rest] = trimmed.split("=");
    if (!script || !target || rest.length > 0) continue;
    const bin = script.trim();
    if (!BIN_NAME.test(bin)) continue;
    const path = await realpath(join(venv, "bin", bin)).catch(() => undefined);
    // A console script must stay inside this venv and this install directory.
    if (path?.startsWith(actualVenv + sep) && path.startsWith(actualRoot + sep))
      bins.push([bin, path]);
  }
  return { unscoped: name, bins };
}

async function findUvEntryPoints(venv: string, name: string): Promise<string | undefined> {
  const library = join(venv, "lib");
  for (const entry of await readdir(library).catch(() => [] as string[])) {
    if (!entry.startsWith("python")) continue;
    const site = join(library, entry, "site-packages");
    for (const distInfo of await readdir(site).catch(() => [] as string[])) {
      if (!distInfo.endsWith(".dist-info")) continue;
      const dir = join(site, distInfo);
      if ((await metadataName(dir)) !== name) continue;
      const path = join(dir, "entry_points.txt");
      try {
        await access(path);
        return path;
      } catch {
        // Metadata without entry points declares no console scripts.
      }
    }
  }
  return undefined;
}

/** The bins an installed npm package declares, as paths inside the package. */
async function declaredBins(dir: string, name: string): Promise<DeclaredBins> {
  const packageDir = join(dir, "node_modules", ...name.split("/"));
  let manifest: { name?: string; bin?: unknown };
  try {
    manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
  } catch {
    throw new Error(`npm did not install ${name}`);
  }
  const unscoped = (manifest.name ?? name).replace(/^@[^/]+\//, "");
  const raw =
    typeof manifest.bin === "string"
      ? { [unscoped]: manifest.bin }
      : manifest.bin && typeof manifest.bin === "object"
        ? (manifest.bin as Record<string, unknown>)
        : {};
  const bins: Array<[string, string]> = [];
  for (const [bin, path] of Object.entries(raw)) {
    if (typeof path !== "string") continue;
    const binPath = resolve(packageDir, path);
    // A bin must stay inside its package; anything else is not launched.
    if (binPath.startsWith(packageDir + sep)) {
      const actual = await realpath(binPath).catch(() => undefined);
      const actualPackage = await realpath(packageDir);
      const actualRoot = await realpath(dir);
      if (actualPackage.startsWith(actualRoot + sep) && actual?.startsWith(actualPackage + sep))
        bins.push([bin, actual]);
    }
  }
  return { packageDir, unscoped, bins };
}

/** npm leaves bins executable only through its links; the launch uses the target directly. */
async function makeBinsExecutable(dir: string, name: string): Promise<void> {
  const { bins } = await declaredBins(dir, name);
  if (bins.length === 0) throw new Error(`${name} does not declare a bin to run`);
  await Promise.all(bins.map(([, path]) => chmod(path, 0o755).catch(() => undefined)));
}

/** npx's choice: the named bin, else the only bin, else the one named after the package. */
async function resolveBin(
  dir: string,
  name: string,
  binName?: string,
  runner: "npm" | "uv" = "npm",
): Promise<string> {
  const { unscoped, bins } =
    runner === "uv" ? await declaredUvBins(dir, name) : await declaredBins(dir, name);
  const byName = new Map(bins);
  // Like npx: names that all run the same file (aliases) are one choice.
  const targets = new Set(bins.map(([, path]) => path));
  const chosen = binName
    ? byName.get(binName)
    : targets.size === 1
      ? bins[0]?.[1]
      : byName.get(unscoped);
  if (!chosen) {
    const available = bins.map(([bin]) => bin).join(", ") || "none";
    throw new Error(
      binName
        ? `${name} has no bin named ${binName} (available: ${available})`
        : `${name} does not declare a single bin to run (available: ${available})`,
    );
  }
  return chosen;
}
