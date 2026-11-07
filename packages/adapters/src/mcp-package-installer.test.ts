import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultMcpPackagesRoot,
  ensureMcpPackage,
  isInstalledMcpBin,
  isNpmRunnerCommand,
  isUvxCommand,
  mcpPackageDir,
  parseNpmLaunch,
  parsePackageLaunch,
  parseUvxLaunch,
  registryPackageName,
  uvSettings,
} from "./mcp-package-installer.js";

vi.mock("node:fs/promises", { spy: true });

describe("parseNpmLaunch", () => {
  it("reads the plain and -y forms for npx and pnpx", () => {
    for (const command of ["npx", "pnpx"]) {
      expect(parseNpmLaunch(command, ["-y", "@klodr/gmail-mcp@2.0.2"])).toEqual({
        spec: "@klodr/gmail-mcp@2.0.2",
        binArgs: [],
      });
      expect(parseNpmLaunch(command, ["--yes", "server-pkg", "--port", "1", "-y"])).toEqual({
        spec: "server-pkg",
        binArgs: ["--port", "1", "-y"],
      });
      expect(parseNpmLaunch(command, ["-y", "--", "pkg@^1.2.0", "a"])).toEqual({
        spec: "pkg@^1.2.0",
        binArgs: ["a"],
      });
    }
  });

  it("recognises the launcher by basename regardless of path, extension, and case", () => {
    expect(parseNpmLaunch("/usr/local/bin/npx", ["pkg@latest"])).toEqual({
      spec: "pkg@latest",
      binArgs: [],
    });
    expect(parseNpmLaunch("C:\\node\\pnpx.cmd", ["pkg"])).toEqual({ spec: "pkg", binArgs: [] });
    expect(parseNpmLaunch("Npx", ["pkg"])).toEqual({ spec: "pkg", binArgs: [] });
    expect(parseNpmLaunch("PNPX.exe", ["pkg"])).toEqual({ spec: "pkg", binArgs: [] });
  });

  it("reads -p/--package with the bin named next", () => {
    expect(parseNpmLaunch("npx", ["-y", "-p", "@scope/tools@1.0.0", "tool-a", "x"])).toEqual({
      spec: "@scope/tools@1.0.0",
      binName: "tool-a",
      binArgs: ["x"],
    });
    expect(parseNpmLaunch("pnpx", ["--package=tools", "--", "tool-b"])).toEqual({
      spec: "tools",
      binName: "tool-b",
      binArgs: [],
    });
    expect(parseNpmLaunch("npx", ["--package", "tools", "tool-c"])).toMatchObject({
      binName: "tool-c",
    });
  });

  it("leaves everything else to a plain launch", () => {
    for (const [command, args] of [
      ["node", ["server.js"]],
      ["npx", []],
      ["pnpx", []],
      ["npx", ["-y"]],
      ["pnpx", ["-y"]],
      ["npx", ["--registry", "https://registry.example.test", "pkg"]],
      ["pnpx", ["--registry", "https://registry.example.test", "pkg"]],
      ["npx", ["-c", "echo hi"]],
      ["pnpx", ["-c", "echo hi"]],
      ["npx", ["-p", "a", "-p", "b", "bin"]],
      ["pnpx", ["-p", "a", "-p", "b", "bin"]],
      ["npx", ["-p", "pkg"]],
      ["npx", ["-p", "pkg", "../bin"]],
      ["npx", ["./local-server"]],
      ["pnpx", ["./local-server"]],
      ["npx", ["/abs/server"]],
      ["npx", ["github:owner/repo"]],
      ["pnpx", ["github:owner/repo"]],
      ["npx", ["owner/repo"]],
      ["npx", ["git+https://example.test/repo.git"]],
      ["npx", ["https://example.test/pkg.tgz"]],
      ["pnpx", ["https://example.test/pkg.tgz"]],
      ["npx", ["pkg.tgz"]],
      ["npx", ["alias@npm:pkg@1"]],
      ["npx", ["file:../pkg"]],
      ["npx", ["pkg@1.0.0 || evil"]],
    ] as const) {
      expect(parseNpmLaunch(command, [...args]), `${command} ${args.join(" ")}`).toBeUndefined();
    }
  });

  it("splits scoped and unscoped specs", () => {
    expect(registryPackageName("@a/b@1")).toBe("@a/b");
    expect(registryPackageName("@a/b")).toBe("@a/b");
    expect(registryPackageName("b@next")).toBe("b");
    expect(registryPackageName("b@")).toBeUndefined();
    expect(registryPackageName("@a")).toBeUndefined();
  });
});

describe("isNpmRunnerCommand", () => {
  it("accepts npx and pnpx by basename", () => {
    for (const command of [
      "npx",
      "pnpx",
      "/opt/npm/bin/npx",
      "C:\\node\\pnpx.cmd",
      "Npx",
      "PNPX.exe",
    ]) {
      expect(isNpmRunnerCommand(command), command).toBe(true);
    }
  });

  it("rejects other commands", () => {
    for (const command of ["npm", "node", "uvx", "uv", "npxx", "pnpx.js", ""]) {
      expect(isNpmRunnerCommand(command), command).toBe(false);
    }
  });
});

describe("parseUvxLaunch", () => {
  it("reads requirements and the --from forms", () => {
    expect(parseUvxLaunch("uvx", ["mail-mcp"])).toEqual({ spec: "mail-mcp", binArgs: [] });
    expect(parseUvxLaunch("uvx", ["mail-mcp==1.2.3"])).toEqual({
      spec: "mail-mcp==1.2.3",
      binArgs: [],
    });
    expect(parseUvxLaunch("uvx", ["mail-mcp[extra]>=1"])).toEqual({
      spec: "mail-mcp[extra]>=1",
      binArgs: [],
    });
    expect(parseUvxLaunch("uvx", ["mail-mcp>=1.0,<2.0"])).toEqual({
      spec: "mail-mcp>=1.0,<2.0",
      binArgs: [],
    });
    expect(parseUvxLaunch("uvx", ["mail-mcp >= 1.0 , != 1.5", "--x"])).toEqual({
      spec: "mail-mcp >= 1.0 , != 1.5",
      binArgs: ["--x"],
    });
    expect(parseUvxLaunch("uvx", ["--from", "mail-mcp", "mcp", "x"])).toEqual({
      spec: "mail-mcp",
      binName: "mcp",
      binArgs: ["x"],
    });
    expect(parseUvxLaunch("uvx", ["--from=mail-mcp", "mcp"])).toEqual({
      spec: "mail-mcp",
      binName: "mcp",
      binArgs: [],
    });
    expect(parseUvxLaunch("uvx", ["--", "mail-mcp", "a", "b"])).toEqual({
      spec: "mail-mcp",
      binArgs: ["a", "b"],
    });
    expect(parseUvxLaunch("uvx", ["--from", "mail-mcp", "--", "mcp", "a", "b"])).toEqual({
      spec: "mail-mcp",
      binName: "mcp",
      binArgs: ["a", "b"],
    });
    expect(parseUvxLaunch("uvx", ["mail-mcp", "a", "b"])).toEqual({
      spec: "mail-mcp",
      binArgs: ["a", "b"],
    });
    expect(parseUvxLaunch("/usr/local/bin/uvx", ["mail-mcp"])).toEqual({
      spec: "mail-mcp",
      binArgs: [],
    });
    expect(parseUvxLaunch("UVX", ["mail-mcp"])).toEqual({ spec: "mail-mcp", binArgs: [] });
    expect(parseUvxLaunch("uvx.cmd", ["mail-mcp"])).toEqual({ spec: "mail-mcp", binArgs: [] });
  });

  it("rejects flags, paths, URLs, direct references, markers, and bad bins", () => {
    for (const args of [
      [],
      ["-q", "mail-mcp"],
      ["--python", "3.12", "mail-mcp"],
      ["--with", "extra-pkg", "mail-mcp"],
      ["--index-url", "https://mirror.example.test", "mail-mcp"],
      ["./local-server"],
      ["/abs/server"],
      ["https://example.test/pkg"],
      ["git+https://example.test/repo.git"],
      ["mail-mcp @ https://example.test/mail-mcp"],
      ["mail-mcp; python_version >= '3.8'"],
      ["--from", "mail-mcp", "bad/bin"],
      ["--from", "mail-mcp", ""],
      ["--from=mail-mcp"],
    ]) {
      expect(parseUvxLaunch("uvx", [...args]), JSON.stringify(args)).toBeUndefined();
    }
  });
});

describe("isUvxCommand", () => {
  it("accepts uvx by basename", () => {
    for (const command of ["uvx", "/usr/local/bin/uvx", "uvx.exe", "UVX"]) {
      expect(isUvxCommand(command), command).toBe(true);
    }
  });

  it("rejects other commands", () => {
    for (const command of ["uv", "npx", "uvxx", "uvx.js", ""]) {
      expect(isUvxCommand(command), command).toBe(false);
    }
  });
});

describe("parsePackageLaunch", () => {
  it("dispatches to the npm and uv parsers", () => {
    expect(parsePackageLaunch("npx", ["pkg"])).toEqual({ runner: "npm", spec: "pkg", binArgs: [] });
    expect(parsePackageLaunch("pnpx", ["pkg"])).toEqual({
      runner: "npm",
      spec: "pkg",
      binArgs: [],
    });
    expect(parsePackageLaunch("uvx", ["pkg"])).toEqual({ runner: "uv", spec: "pkg", binArgs: [] });
    expect(parsePackageLaunch("uvx", ["--from", "pkg", "bin"])).toEqual({
      runner: "uv",
      spec: "pkg",
      binName: "bin",
      binArgs: [],
    });
    expect(parsePackageLaunch("node", ["pkg"])).toBeUndefined();
    expect(parsePackageLaunch("uvx", ["--with", "x", "pkg"])).toBeUndefined();
  });
});

describe("uvSettings", () => {
  it("passes through uv/pip/proxy/cert settings case-insensitively", () => {
    expect(
      uvSettings({
        UV_INDEX_URL: "a",
        pip_index_url: "b",
        HTTPS_PROXY: "c",
        http_proxy: "d",
        no_proxy: "e",
        ssl_cert_file: "f",
        requests_ca_bundle: "g",
        NPM_CONFIG_REGISTRY: "h",
        API_KEY: "i",
      }),
    ).toEqual({
      UV_INDEX_URL: "a",
      pip_index_url: "b",
      HTTPS_PROXY: "c",
      http_proxy: "d",
      no_proxy: "e",
      ssl_cert_file: "f",
      requests_ca_bundle: "g",
    });
  });
});

describe("defaultMcpPackagesRoot", () => {
  it("prefers MCP_PACKAGES_DIR, then a writable DATA_DIR, then the temp dir", async () => {
    const data = await mkdtemp(join(tmpdir(), "rakazo-data-"));
    try {
      expect(defaultMcpPackagesRoot({ MCP_PACKAGES_DIR: "/srv/pkgs", DATA_DIR: data })).toBe(
        "/srv/pkgs",
      );
      expect(defaultMcpPackagesRoot({ DATA_DIR: data })).toBe(join(data, "mcp-packages"));
      expect(defaultMcpPackagesRoot({ DATA_DIR: join(data, "missing") })).toBe(
        join(tmpdir(), "rakazo-mcp-packages"),
      );
    } finally {
      await rm(data, { recursive: true, force: true });
    }
  });
});

describe("mcpPackageDir", () => {
  it("keeps the npm key stable and separates it from the uv key", () => {
    const root = "/srv/packages";
    const npmDir = mcpPackageDir("demo@1.0.0", root);
    expect(mcpPackageDir("demo@1.0.0", root)).toBe(npmDir);
    expect(mcpPackageDir("demo@1.0.0", root, {}, "npm")).toBe(npmDir);
    const uvDir = mcpPackageDir("demo@1.0.0", root, {}, "uv");
    expect(uvDir).not.toBe(npmDir);
    expect(mcpPackageDir("other@1.0.0", root)).not.toBe(npmDir);
  });
});

/**
 * A stand-in for npm: installs `<name>` from the last argument into `--prefix`, logging each
 * run, and refuses an install that would run package scripts. NPM_CONFIG_FAKE_MODE=hang
 * writes half a package and never exits; fail exits 1 with output.
 */
const FAKE_NPM = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
if (process.env.API_KEY) throw new Error("server secret leaked to npm");
const args = process.argv.slice(2);
if (!args.includes("--ignore-scripts")) { console.error("npm install would run package scripts"); process.exit(1); }
const prefix = args[args.indexOf("--prefix") + 1];
const target = args.at(-1);
const name = target.startsWith("@") ? "@" + target.slice(1).split("@")[0] : target.split("@")[0];
if (process.env.NPM_CONFIG_FAKE_LOG) fs.appendFileSync(process.env.NPM_CONFIG_FAKE_LOG, target + "\\n");
const dir = path.join(prefix, "node_modules", ...name.split("/"));
fs.mkdirSync(dir, { recursive: true });
const mode = process.env.NPM_CONFIG_FAKE_MODE || "ok";
const bin = JSON.parse(process.env.NPM_CONFIG_FAKE_BIN || '{"server":"bin/server.js"}');
fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", bin }));
if (mode === "hang") { setInterval(() => {}, 1000); return; }
if (mode === "fail") { console.error("npm ERR! 404 Not Found - " + name); process.exit(1); }
const delay = Number(process.env.NPM_CONFIG_FAKE_DELAY_MS || 0);
setTimeout(() => {
  for (const file of new Set(typeof bin === "string" ? [bin] : Object.values(bin))) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), "#!/usr/bin/env node\\nconsole.log('ran " + name + "');\\n");
  }
  }, delay);
`;

/**
 * A stand-in for uv: `venv <dir>` creates the venv bin and site-packages dirs,
 * and `pip install --python <venv>/bin/python --only-binary :all: <spec>` writes
 * a fake venv with a `<normalized>-<version>.dist-info` (METADATA plus
 * entry_points.txt) and one executable console script per key in UV_FAKE_SCRIPTS
 * (JSON object of script name to entry). Console scripts start with a
 * `#!<venv>/bin/python` line so the install can relocate it. UV_FAKE_MODE=hang
 * never exits; fail exits 1 on pip install with output.
 */
const FAKE_UV = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
if (process.env.API_KEY) throw new Error("server secret leaked to uv");
const args = process.argv.slice(2);
if (process.env.UV_FAKE_ARGV_LOG) {
  fs.appendFileSync(process.env.UV_FAKE_ARGV_LOG, JSON.stringify({ argv: args }) + "\\n");
}
const mode = process.env.UV_FAKE_MODE || "ok";
if (mode === "hang") { setInterval(() => {}, 1000); return; }
if (args[0] === "venv") {
  const venv = args[1];
  fs.mkdirSync(path.join(venv, "bin"), { recursive: true });
  fs.mkdirSync(path.join(venv, "lib", "python3.12", "site-packages"), { recursive: true });
  return;
}
if (args[0] === "pip" && args[1] === "install") {
  const spec = args.at(-1);
  if (mode === "fail") { console.error("uv: error: no distribution found for " + spec); process.exit(1); }
  if (process.env.UV_FAKE_LOG) fs.appendFileSync(process.env.UV_FAKE_LOG, spec + "\\n");
  const py = args[args.indexOf("--python") + 1];
  const venv = path.dirname(path.dirname(py));
  const name = spec.replace(/[^A-Za-z0-9._-].*/, "");
  const normalized = name.replace(/-/g, "_").toLowerCase();
  let version = "1.0.0";
  const eq = spec.indexOf("==");
  if (eq >= 0) version = spec.slice(eq + 2);
  const dirVersion = version.replace(/-/g, "_");
  const scripts = JSON.parse(process.env.UV_FAKE_SCRIPTS || '{"mail-mcp":"mail_mcp:main"}');
  const site = path.join(venv, "lib", "python3.12", "site-packages");
  const distInfo = path.join(site, normalized + "-" + dirVersion + ".dist-info");
  fs.mkdirSync(distInfo, { recursive: true });
  fs.writeFileSync(
    path.join(distInfo, "METADATA"),
    "Metadata-Version: 2.1\\nName: " + name + "\\nVersion: " + version + "\\n",
  );
  fs.writeFileSync(
    path.join(distInfo, "entry_points.txt"),
    "[console_scripts]\\n" + Object.entries(scripts).map(([script, entry]) => script + " = " + entry).join("\\n") + "\\n",
  );
  fs.mkdirSync(path.join(venv, "bin"), { recursive: true });
  for (const script of Object.keys(scripts)) {
    fs.writeFileSync(
      path.join(venv, "bin", script),
      "#!" + path.join(venv, "bin", "python") + "\\nrakazo-console-script-payload\\n",
    );
    fs.chmodSync(path.join(venv, "bin", script), 0o755);
  }
  return;
}
console.error("unexpected uv invocation: " + args.join(" "));
process.exit(1);
`;

describe("ensureMcpPackage", () => {
  let work: string;
  let root: string;
  let npm: string;
  let log: string;
  let uv: string;
  let uvLog: string;

  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), "rakazo-mcp-installer-"));
    root = join(work, "packages");
    npm = join(work, "fake-npm");
    log = join(work, "npm.log");
    uv = join(work, "fake-uv");
    uvLog = join(work, "uv.log");
    await writeFile(npm, FAKE_NPM);
    await chmod(npm, 0o755);
    await writeFile(uv, FAKE_UV);
    await chmod(uv, 0o755);
  });

  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  // Generous waits: under a loaded parallel run the stub npm install can take seconds.
  const WAIT = { timeout: 15_000, interval: 50 };

  it("preserves a fresh owner replacing the inspected expired lock", async () => {
    const lock = `${mcpPackageDir("race-pkg", root, options().env)}.lock`;
    await mkdir(lock, { recursive: true });
    const expired = { token: "expired", expiresAt: 0, pid: process.pid, host: hostname() };
    const fresh = { ...expired, token: "fresh", expiresAt: Date.now() + 60_000 };
    await writeFile(join(lock, "owner"), JSON.stringify(expired));
    const original = (await vi.importActual<typeof fs>("node:fs/promises")).rename;
    const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (from === lock) {
        await writeFile(join(lock, "owner"), JSON.stringify(fresh));
      }
      return original(from, to);
    });
    const controller = new AbortController();
    const pending = ensureMcpPackage("race-pkg", { ...options(), signal: controller.signal });
    try {
      await vi.waitFor(() => expect(spy).toHaveBeenCalled(), WAIT);
      await vi.waitFor(
        async () => expect(JSON.parse(await readFile(join(lock, "owner"), "utf8"))).toEqual(fresh),
        WAIT,
      );
      controller.abort();
      await expect(pending).rejects.toThrow();
      expect(await runs()).toEqual([]);
    } finally {
      spy.mockImplementation(original);
      await rm(lock, { recursive: true, force: true });
      // Let the shared install finish before deleting its fixture.
      await vi.waitFor(async () => expect(await runs()).toHaveLength(1), WAIT);
      await vi.waitFor(async () => expect(await leftovers()).toEqual([]), WAIT);
    }
  }, 30_000);

  const runs = async () =>
    existsSync(log) ? (await readFile(log, "utf8")).trim().split("\n").filter(Boolean) : [];
  const leftovers = async () =>
    (await readdir(root)).filter((entry) => entry.startsWith(".tmp-") || entry.endsWith(".lock"));
  const options = (env: Record<string, string> = {}) => ({
    root,
    npmCommand: npm,
    env: { NPM_CONFIG_FAKE_LOG: log, ...env },
  });

  const uvRuns = async () =>
    existsSync(uvLog) ? (await readFile(uvLog, "utf8")).trim().split("\n").filter(Boolean) : [];
  const uvOptions = (env: Record<string, string> = {}) => ({
    root,
    runner: "uv" as const,
    uvCommand: uv,
    env: { UV_FAKE_LOG: uvLog, ...env },
  });

  it("isolates registry settings and excludes server credentials from install scripts", async () => {
    const first = await ensureMcpPackage(
      "server@1",
      options({ npm_config_registry: "https://one.example.test", API_KEY: "fake-api-secret" }),
    );
    const second = await ensureMcpPackage(
      "server@1",
      options({ npm_config_registry: "https://two.example.test" }),
    );
    expect(first.binPath).not.toBe(second.binPath);
    expect(await runs()).toHaveLength(2);
    expect(mcpPackageDir("server@1", root, { NPM_CONFIG_A: "a", npm_config_b: "b" })).toBe(
      mcpPackageDir("server@1", root, { npm_config_b: "b", NPM_CONFIG_A: "a" }),
    );
  });

  it("installs once, publishes a ready dir, and returns an executable bin", async () => {
    const onInstall = { calls: 0 };
    const first = await ensureMcpPackage("@demo/server@1.0.0", {
      ...options(),
      onInstall: () => {
        onInstall.calls += 1;
      },
    });
    expect(isInstalledMcpBin(first)).toBe(true);
    expect(first.binPath).toMatch(/node_modules\/@demo\/server\/bin\/server\.js$/);
    expect(execFileSync(first.binPath, { encoding: "utf8" })).toContain("ran @demo/server");

    const second = await ensureMcpPackage("@demo/server@1.0.0", {
      ...options(),
      onInstall: () => {
        onInstall.calls += 1;
      },
    });
    expect(second.binPath).toBe(first.binPath);
    expect(await runs()).toEqual(["@demo/server@1.0.0"]);
    expect(onInstall.calls).toBe(1);
    expect(await leftovers()).toEqual([]);
    // A plain object with the same shape is not an issued bin.
    expect(isInstalledMcpBin({ binPath: first.binPath })).toBe(false);
  });

  it("shares one install between concurrent callers", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        ensureMcpPackage("server@1.0.0", options({ NPM_CONFIG_FAKE_DELAY_MS: "200" })),
      ),
    );
    expect(new Set(results.map((bin) => bin.binPath)).size).toBe(1);
    expect(await runs()).toEqual(["server@1.0.0"]);
  });

  it("never publishes an interrupted install, and the next call recovers", async () => {
    await expect(
      ensureMcpPackage("server@2.0.0", {
        ...options({ NPM_CONFIG_FAKE_MODE: "hang" }),
        timeoutMs: 500,
      }),
    ).rejects.toThrow("npm install server@2.0.0 timed out");
    expect((await readdir(root)).filter((entry) => !entry.startsWith("."))).toEqual([]);
    expect(await leftovers()).toEqual([]);

    const bin = await ensureMcpPackage("server@2.0.0", options());
    expect(execFileSync(bin.binPath, { encoding: "utf8" })).toContain("ran server");
  });

  it("reports npm's output when the install fails and cleans up", async () => {
    await expect(
      ensureMcpPackage("missing@1.0.0", options({ NPM_CONFIG_FAKE_MODE: "fail" })),
    ).rejects.toThrow(/npm install missing@1.0.0 failed \(exit 1\): npm ERR! 404 Not Found/);
    expect(await readdir(root)).toEqual([]);
  });

  it("takes over the lock and debris of a crashed install", async () => {
    const probe = await ensureMcpPackage("server@3.0.0", options());
    const key = basename(mcpPackageDir("server@3.0.0", root, options().env));
    await rm(join(root, key), { recursive: true, force: true });
    // A process on another host died mid-install: its lock expired, its staging dir remains.
    await mkdir(join(root, `${key}.lock`));
    await writeFile(
      join(root, `${key}.lock`, "owner"),
      JSON.stringify({ token: "old", pid: 1, host: "other-host", expiresAt: Date.now() - 1 }),
    );
    await mkdir(join(root, `.tmp-${key}-crashed`, "node_modules"), { recursive: true });

    const bin = await ensureMcpPackage("server@3.0.0", options());
    expect(bin.binPath).toBe(probe.binPath);
    expect(await leftovers()).toEqual([]);
    expect(await runs()).toHaveLength(2);
  });

  it("waits for another process that holds the lock instead of installing twice", async () => {
    const probe = await ensureMcpPackage("server@4.0.0", options());
    const key = basename(mcpPackageDir("server@4.0.0", root, options().env));
    const ready = join(root, key);
    const aside = join(work, "aside");
    await mkdir(aside);
    await rename(ready, join(aside, key));
    // Another live process (same host, this pid) is installing.
    const lock = join(root, `${key}.lock`);
    await mkdir(lock);
    await writeFile(
      join(lock, "owner"),
      JSON.stringify({
        token: "other",
        pid: process.pid,
        host: hostname(),
        expiresAt: Date.now() + 60_000,
      }),
    );

    const waiting = ensureMcpPackage("server@4.0.0", options());
    await new Promise((done) => setTimeout(done, 400));
    // It publishes and releases the lock; the waiter picks the result up.
    await rename(join(aside, key), ready);
    await rm(lock, { recursive: true, force: true });

    expect((await waiting).binPath).toBe(probe.binPath);
    expect(await runs()).toHaveLength(1);
  });

  it("stops waiting on abort while the install finishes for the next caller", async () => {
    const controller = new AbortController();
    const waiting = ensureMcpPackage("server@5.0.0", {
      ...options({ NPM_CONFIG_FAKE_DELAY_MS: "300" }),
      signal: controller.signal,
    });
    controller.abort(new Error("run cancelled"));
    await expect(waiting).rejects.toThrow("run cancelled");
    const bin = await ensureMcpPackage(
      "server@5.0.0",
      options({ NPM_CONFIG_FAKE_DELAY_MS: "300" }),
    );
    expect(execFileSync(bin.binPath, { encoding: "utf8" })).toContain("ran server");
    expect(await runs()).toHaveLength(1);
  });

  it("observes a shared install rejection even when the caller is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled before install"));
    let settled!: () => void;
    const done = new Promise<void>((resolve) => {
      settled = resolve;
    });
    await expect(
      ensureMcpPackage("missing@2", {
        ...options({ NPM_CONFIG_FAKE_MODE: "fail" }),
        signal: controller.signal,
        onSettled: async () => {
          settled();
        },
      }),
    ).rejects.toThrow("cancelled before install");
    await done;
    expect(await leftovers()).toEqual([]);
  });

  it("picks npx's bin: named, single, or the package's own", async () => {
    const bins = JSON.stringify({ alpha: "a.js", multi: "m.js" });
    const named = await ensureMcpPackage("multi@1.0.0", {
      ...options({ NPM_CONFIG_FAKE_BIN: bins }),
      binName: "alpha",
    });
    expect(named.binPath).toMatch(/multi\/a\.js$/);
    const own = await ensureMcpPackage("multi@1.0.0", options({ NPM_CONFIG_FAKE_BIN: bins }));
    expect(own.binPath).toMatch(/multi\/m\.js$/);
    await expect(
      ensureMcpPackage("multi@1.0.0", {
        ...options({ NPM_CONFIG_FAKE_BIN: bins }),
        binName: "nope",
      }),
    ).rejects.toThrow("multi has no bin named nope (available: alpha, multi)");
    const single = await ensureMcpPackage(
      "solo@1.0.0",
      options({ NPM_CONFIG_FAKE_BIN: '"cli.js"' }),
    );
    expect(single.binPath).toMatch(/solo\/cli\.js$/);
    const aliased = await ensureMcpPackage(
      "aliased@1.0.0",
      options({ NPM_CONFIG_FAKE_BIN: JSON.stringify({ "srv-a": "s.js", "srv-b": "s.js" }) }),
    );
    expect(aliased.binPath).toMatch(/aliased\/s\.js$/);
  });

  it("refuses specs that are not registry packages", async () => {
    await expect(ensureMcpPackage("../evil", options())).rejects.toThrow("Not an npm registry");
  });

  it("installs a real package with npm, offline, from a local tarball", async () => {
    const fixture = join(work, "fixture");
    await mkdir(join(fixture, "bin"), { recursive: true });
    await writeFile(
      join(fixture, "package.json"),
      JSON.stringify({ name: "fixture-mcp", version: "1.0.0", bin: { "fixture-mcp": "bin/x.js" } }),
    );
    await writeFile(join(fixture, "bin", "x.js"), "#!/usr/bin/env node\nconsole.log('fixture');\n");
    const tarball = join(
      work,
      execFileSync("npm", ["pack", "--silent", "--pack-destination", work], {
        cwd: fixture,
        encoding: "utf8",
        env: { ...process.env, NPM_CONFIG_CACHE: join(work, "npm-cache") },
      }).trim(),
    );

    const bin = await ensureMcpPackage("fixture-mcp@1.0.0", {
      root,
      installTarget: tarball,
      env: { NPM_CONFIG_OFFLINE: "true", NPM_CONFIG_CACHE: join(work, "npm-cache") },
    });
    expect(execFileSync(bin.binPath, { encoding: "utf8" }).trim()).toBe("fixture");
    expect(
      existsSync(
        join(
          mcpPackageDir("fixture-mcp@1.0.0", root, {
            NPM_CONFIG_OFFLINE: "true",
            NPM_CONFIG_CACHE: join(work, "npm-cache"),
          }),
          ".ready",
        ),
      ),
    ).toBe(true);
  }, 60_000);

  it("installs a uv package once into its own directory", async () => {
    const bin = await ensureMcpPackage("mail-mcp==1.0.0", uvOptions());
    expect(isInstalledMcpBin(bin)).toBe(true);
    expect(bin.binPath).toMatch(/bin\/mail-mcp$/);
    expect(await uvRuns()).toEqual(["mail-mcp==1.0.0"]);

    const again = await ensureMcpPackage("mail-mcp==1.0.0", uvOptions());
    expect(again.binPath).toBe(bin.binPath);
    expect(await uvRuns()).toEqual(["mail-mcp==1.0.0"]);
    expect(await leftovers()).toEqual([]);
  });

  it("picks uv's bin: single, named via --from, or rejects a missing one", async () => {
    const single = await ensureMcpPackage(
      "mail-mcp==1.0.0",
      uvOptions({ UV_FAKE_SCRIPTS: '{"cli":"cli:main"}' }),
    );
    expect(single.binPath).toMatch(/bin\/cli$/);

    const named = await ensureMcpPackage("mail-mcp==1.0.0", {
      ...uvOptions({ UV_FAKE_SCRIPTS: '{"alpha":"a:main","beta":"b:main"}' }),
      binName: "alpha",
    });
    expect(named.binPath).toMatch(/bin\/alpha$/);

    await expect(
      ensureMcpPackage("mail-mcp==1.0.0", {
        ...uvOptions({ UV_FAKE_SCRIPTS: '{"alpha":"a:main","beta":"b:main"}' }),
        binName: "nope",
      }),
    ).rejects.toThrow("has no bin named nope");

    await expect(
      ensureMcpPackage("mail-mcp==1.0.0", uvOptions({ UV_FAKE_SCRIPTS: "{}" })),
    ).rejects.toThrow("does not declare a single bin to run");
  });

  it("reports uv's output when the install fails and leaves nothing published", async () => {
    await expect(
      ensureMcpPackage("mail-mcp==1.0.0", uvOptions({ UV_FAKE_MODE: "fail" })),
    ).rejects.toThrow(/no distribution found/);
    expect((await readdir(root)).filter((entry) => !entry.startsWith("."))).toEqual([]);
    expect(await leftovers()).toEqual([]);
  });

  it("kills a hung uv install at the timeout and leaves no ready dir", async () => {
    await expect(
      ensureMcpPackage("mail-mcp==2.0.0", {
        ...uvOptions({ UV_FAKE_MODE: "hang" }),
        timeoutMs: 300,
      }),
    ).rejects.toThrow(/timed out/);
    expect((await readdir(root)).filter((entry) => !entry.startsWith("."))).toEqual([]);
    expect(await leftovers()).toEqual([]);
  });

  it("relocates a console script's shebang out of the staging directory", async () => {
    const spec = "mail-mcp==1.0.0";
    const bin = await ensureMcpPackage(spec, { root, runner: "uv", uvCommand: uv });
    const published = mcpPackageDir(spec, root, {}, "uv");
    expect(bin.binPath).toBe(await fs.realpath(join(published, ".venv", "bin", "mail-mcp")));

    const content = await readFile(bin.binPath, "utf8");
    expect(content).toBe(
      `#!${join(published, ".venv", "bin", "python")}\nrakazo-console-script-payload\n`,
    );
    expect(content).not.toContain(".tmp-");

    const mode = (await stat(bin.binPath)).mode;
    expect(mode & 0o100).not.toBe(0);
  });

  it("resolves a bin whose dist-info carries a local version label", async () => {
    const spec = "mail-mcp==1.0.0+local-build";
    const argvLog = join(work, "uv-argv.json");
    const bin = await ensureMcpPackage(spec, uvOptions({ UV_FAKE_ARGV_LOG: argvLog }));
    expect(isInstalledMcpBin(bin)).toBe(true);
    expect(bin.binPath).toMatch(/bin\/mail-mcp$/);

    const invocations = (await readFile(argvLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { argv: string[] });
    expect(invocations[1]!.argv).toEqual([
      "pip",
      "install",
      "--python",
      expect.stringMatching(/\.venv\/bin\/python$/),
      "--only-binary",
      ":all:",
      spec,
    ]);
  });
});
