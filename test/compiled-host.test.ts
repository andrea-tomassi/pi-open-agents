/**
 * Tests for compiled single-file host support (issue #28).
 *
 * Inside a `bun build --compile` pi binary, `process.argv[1]` is a virtual
 * `/$bunfs/...` path that does not exist on disk, so the old
 * `realpathSync(process.argv[1])` fallback threw ENOENT and every `subagent`
 * call failed. The fix detects the virtual path, resolves the real executable
 * (`/proc/self/exe` → `execPath` → absolute `argv[0]`), returns an empty
 * entry point, and omits it from the child args (the binary IS the CLI).
 *
 * The peer dependency is optional (absent in publish CI), so like the other
 * executor suites these tests load the module dynamically and skip when it
 * is unavailable.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { AgentDefinition } from "../src/types.ts";
import type {
  ExecutorFs,
  PiResolution,
  ProcessRunner,
} from "../src/subagent/executor.ts";

type ExecutorModule = typeof import("../src/subagent/executor.ts");

let executor: ExecutorModule | undefined;
try {
  executor = await import("../src/subagent/executor.ts");
} catch {
  executor = undefined;
}

// Run the suite when the optional peer dependency is present; skip in CI.
const run = executor ? test : test.skip;

// ─── Criterion 1: pure detection ─────────────────────────────────────────────

run("isVirtualBunPath: detects the issue's and the locally reproduced paths", () => {
  const { isVirtualBunPath } = executor!;
  assert.equal(isVirtualBunPath("/$bunfs/root/pi"), true);
  assert.equal(isVirtualBunPath("/$bunfs/root/tbin"), true);
});

run("isVirtualBunPath: detects the defensive Windows markers", () => {
  const { isVirtualBunPath } = executor!;
  assert.equal(isVirtualBunPath("C:\\Temp\\~BUN1234\\pi.exe"), true);
  assert.equal(isVirtualBunPath("C:\\Temp\\%7EBUN1234\\pi.exe"), true);
});

run("isVirtualBunPath: real paths and missing values are not virtual", () => {
  const { isVirtualBunPath } = executor!;
  assert.equal(isVirtualBunPath("/pkg/dist/cli.js"), false);
  assert.equal(isVirtualBunPath("/usr/bin/bun"), false);
  assert.equal(isVirtualBunPath("/opt/pi/pi"), false);
  assert.equal(isVirtualBunPath(""), false);
  assert.equal(isVirtualBunPath(undefined), false);
  assert.equal(isVirtualBunPath(null), false);
});

// ─── Criterion 2: never hand a $bunfs path to spawn ──────────────────────────

run("resolvePiEntryPoint: virtual argv[1] resolves to the real binary, empty entry", () => {
  const { resolvePiEntryPoint } = executor!;
  const resolution = resolvePiEntryPoint(
    () => {
      throw new Error("unreachable on a compiled host");
    },
    {
      execPath: "/tmp/bunprobe/tbin",
      argv0: "bun",
      argv1: "/$bunfs/root/tbin",
      readProcSelfExe: () => "/tmp/bunprobe/tbin",
    },
  );
  assert.equal(resolution.command, "/tmp/bunprobe/tbin");
  assert.equal(resolution.entryPoint, "");
  assert.ok(!resolution.command.includes("$bunfs"), "no virtual path in command");
});

run("resolvePiEntryPoint: virtual execPath also triggers the compiled path", () => {
  const { resolvePiEntryPoint } = executor!;
  const resolution = resolvePiEntryPoint(
    () => `file:///fake/pkg/dist/index.js`,
    {
      execPath: "/$bunfs/root/pi",
      argv0: "bun",
      argv1: "/$bunfs/root/pi",
      readProcSelfExe: () => "/opt/pi/pi",
    },
  );
  assert.equal(resolution.command, "/opt/pi/pi");
  assert.equal(resolution.entryPoint, "");
});

// ─── Criterion 4: fallback priority — argv[0] "bun" must never win ───────────

run("resolveCompiledCommand: prefers /proc/self/exe over execPath over argv[0]", () => {
  const { resolveCompiledCommand } = executor!;
  assert.equal(
    resolveCompiledCommand({ execPath: "/opt/pi/pi", argv0: "bun", procSelfExe: "/real/pi" }),
    "/real/pi",
  );
  assert.equal(
    resolveCompiledCommand({ execPath: "/opt/pi/pi", argv0: "bun", procSelfExe: undefined }),
    "/opt/pi/pi",
  );
});

run("resolvePiEntryPoint: compiled argv[1] with the default /proc branch → no ENOENT", () => {
  const { resolvePiEntryPoint } = executor!;
  // No readProcSelfExe injected: exercises the production /proc/self/exe
  // read (Linux) with graceful fallback to the real execPath elsewhere.
  const resolution = resolvePiEntryPoint(
    () => {
      throw new Error("no self-resolution");
    },
    { execPath: process.execPath, argv0: process.argv[0], argv1: "/$bunfs/root/pi" },
  );
  assert.equal(resolution.entryPoint, "");
  assert.ok(!resolution.command.includes("$bunfs"), "command must be a real path");
});

run("resolvePiEntryPoint: without /proc, execPath wins over bare argv[0] 'bun'", () => {
  const { resolvePiEntryPoint } = executor!;
  const resolution = resolvePiEntryPoint(
    () => {
      throw new Error("unreachable");
    },
    {
      execPath: "/opt/pi/pi",
      argv0: "bun",
      argv1: "/$bunfs/root/pi",
      readProcSelfExe: () => {
        throw new Error("no /proc on this platform");
      },
    },
  );
  assert.equal(resolution.command, "/opt/pi/pi", "must not resolve to the bare word 'bun'");
  assert.equal(resolution.entryPoint, "");
});

run("resolvePiEntryPoint: absolute argv[0] is the last resort before throwing", () => {
  const { resolvePiEntryPoint } = executor!;
  const resolution = resolvePiEntryPoint(
    () => {
      throw new Error("unreachable");
    },
    {
      execPath: "/$bunfs/root/pi",
      argv0: "/opt/pi/pi",
      argv1: "/$bunfs/root/pi",
      readProcSelfExe: () => {
        throw new Error("no /proc");
      },
    },
  );
  assert.equal(resolution.command, "/opt/pi/pi");
});

run("resolvePiEntryPoint: only virtual paths available → descriptive error, not ENOENT", () => {
  const { resolvePiEntryPoint } = executor!;
  assert.throws(
    () =>
      resolvePiEntryPoint(
        () => {
          throw new Error("unreachable");
        },
        {
          execPath: "/$bunfs/root/pi",
          argv0: "bun",
          argv1: "/$bunfs/root/pi",
          readProcSelfExe: () => {
            throw new Error("no /proc");
          },
        },
      ),
    /compiled single-file/,
  );
});

// ─── Criterion 3: child arg shape ────────────────────────────────────────────

const baseAgent: AgentDefinition = {
  name: "worker",
  mode: "subagent",
  hidden: true,
  disable: false,
  thinking: "off",
  systemPrompt: "replace",
  maxDepth: 1,
  prompt: "You are a worker subagent.",
  source: "project",
  filePath: "/tmp/worker.agent.md",
};

const fakeFs: ExecutorFs = {
  makeTempDir: async () => "/tmp/fake-subagent",
  writeFile: async () => {},
  removeDir: async () => {},
};

const fakeResolvePi = async (): Promise<PiResolution> => ({
  command: "node",
  entryPoint: "/fake/cli.js",
});

async function captureArgs(pi: PiResolution): Promise<string[]> {
  let args: string[] = [];
  const captureRunner: ProcessRunner = (invocation) => {
    args = invocation.args;
    return Promise.resolve({ exitCode: 0 });
  };
  await executor!.runSubagent({
    agent: baseAgent,
    task: "t",
    cwd: process.cwd(),
    runner: captureRunner,
    fs: fakeFs,
    resolvePi: async () => pi,
  });
  return args;
}

run("#28 args: empty entryPoint is omitted — child receives only real flags", async () => {
  const args = await captureArgs({ command: "/opt/pi/pi", entryPoint: "" });
  assert.equal(args[0], "--mode", "first arg must be a flag, not an entry point");
  assert.ok(!args.includes(""), "no empty-string argument");
  assert.ok(!args.some((a) => a.includes("$bunfs")), "no virtual path in args");
});

run("#28 args: non-compiled shape unchanged — entryPoint first", async () => {
  const args = await captureArgs({ command: "node", entryPoint: "/fake/cli.js" });
  assert.equal(args[0], "/fake/cli.js");
  assert.deepEqual(args.slice(1, 4), ["--mode", "json", "-p"]);
});

// ─── Non-compiled behavior byte-for-byte ─────────────────────────────────────

run("#28 non-regression: self-resolution success path ignores the host probe", () => {
  const { resolvePiEntryPoint } = executor!;
  const fakeEntry = "/fake/pkg/dist/index.js";
  const resolution = resolvePiEntryPoint(
    () => `file://${fakeEntry}`,
    { execPath: "/usr/bin/node", argv0: "/usr/bin/node", argv1: "/usr/bin/node" },
  );
  assert.equal(resolution.command, "/usr/bin/node");
  assert.equal(resolution.entryPoint, "/fake/pkg/dist/cli.js");
});
