/**
 * Tests for subagent tool restriction via --tools CLI flag.
 *
 * Covers Issues #1 and #2 from GitHub:
 * - #1: OpenCode tools map (converted to permission) must restrict the
 *   subagent child toolset via --tools
 * - #2: Explicit permission allow-list must also restrict the child toolset
 *
 * These tests drive `runSubagent` with an injected fake runner that captures
 * the CLI args, so no real child pi process is spawned.
 * `executor.ts` imports the optional peer dependency
 * `@earendil-works/pi-coding-agent` at module load; we skip gracefully when it
 * is absent (publish CI) and run wherever it is present (local dev).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { AgentDefinition } from "../src/types.ts";
import type { ProcessRunner, ExecutorFs, PiResolution } from "../src/subagent/executor.ts";

type RunSubagent = typeof import("../src/subagent/executor.ts").runSubagent;

let runSubagent: RunSubagent | undefined;
try {
  ({ runSubagent } = await import("../src/subagent/executor.ts"));
} catch {
  runSubagent = undefined;
}

const run = runSubagent ? test : test.skip;

// ─── Fixtures ────────────────────────────────────────────────────────────────

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

/**
 * Run a subagent and capture the CLI args passed to the child process.
 */
async function runAndCaptureArgs(agent: AgentDefinition): Promise<string[]> {
  let capturedArgs: string[] = [];

  const captureRunner: ProcessRunner = async (invocation) => {
    capturedArgs = invocation.args;
    // Minimal event stream so runSubagent completes cleanly
    return { exitCode: 0 };
  };

  await runSubagent!({
    agent,
    task: "do something",
    cwd: process.cwd(),
    runner: captureRunner,
    fs: fakeFs,
    resolvePi: fakeResolvePi,
  });

  return capturedArgs;
}

/** Extract the --tools value from args, or undefined if not present. */
function getToolsArg(args: string[]): string | undefined {
  const idx = args.indexOf("--tools");
  return idx !== -1 ? args[idx + 1] : undefined;
}

// ─── Issue #1: Tools map → subagent toolset ──────────────────────────────────

run("subagent #1: OC tools map restricts child toolset via --tools", async () => {
  // Simulates parseAgentDefinition output for:
  //   tools:
  //     read: true
  //     edit: true
  //     write: false
  //     bash: false
  // After parsing: permission is set, tools is undefined
  const agent: AgentDefinition = {
    ...baseAgent,
    permission: { read: "allow", edit: "allow", write: "deny", bash: "deny" },
    tools: undefined,
  };

  const args = await runAndCaptureArgs(agent);
  const toolsValue = getToolsArg(args);

  assert.ok(toolsValue, "--tools must be passed to child");
  assert.ok(toolsValue!.includes("read"), "read must be whitelisted");
  assert.ok(toolsValue!.includes("edit"), "edit must be whitelisted");
  assert.ok(!toolsValue!.includes("bash"), "bash must be excluded");
  assert.ok(!toolsValue!.includes("write"), "write must be excluded");
});

run("subagent #1: explicit tools array still works (pi-style CSV)", async () => {
  const agent: AgentDefinition = {
    ...baseAgent,
    tools: ["read", "edit"],
    permission: undefined,
  };

  const args = await runAndCaptureArgs(agent);
  const toolsValue = getToolsArg(args);

  assert.ok(toolsValue, "--tools must be passed");
  assert.ok(toolsValue!.includes("read"));
  assert.ok(toolsValue!.includes("edit"));
});

// ─── Issue #2: Permission block → subagent toolset ───────────────────────────

run("subagent #2: explicit permission allow-list restricts child toolset", async () => {
  const agent: AgentDefinition = {
    ...baseAgent,
    permission: { read: "allow", edit: "allow", bash: "deny", grep: "deny" },
    tools: undefined,
  };

  const args = await runAndCaptureArgs(agent);
  const toolsValue = getToolsArg(args);

  assert.ok(toolsValue, "--tools must be passed to child");
  assert.ok(toolsValue!.includes("read"));
  assert.ok(toolsValue!.includes("edit"));
  assert.ok(!toolsValue!.includes("bash"), "bash must be excluded");
});

run("subagent #2: wildcard permission cannot restrict child (known limitation)", async () => {
  // { "*": allow, bash: deny } — can't derive a finite whitelist from this
  // The --tools flag is a whitelist (include only), not a deny-list.
  // Child gets all tools. This is an inherent limitation of the CLI flag.
  const agent: AgentDefinition = {
    ...baseAgent,
    permission: { "*": "allow", bash: "deny" },
    tools: undefined,
  };

  const args = await runAndCaptureArgs(agent);
  const toolsValue = getToolsArg(args);

  assert.equal(toolsValue, undefined, "wildcard permission must not produce a whitelist");
});

run("subagent #2: no permission or tools → no --tools flag (all tools)", async () => {
  const agent: AgentDefinition = {
    ...baseAgent,
    permission: undefined,
    tools: undefined,
  };

  const args = await runAndCaptureArgs(agent);
  const toolsValue = getToolsArg(args);

  assert.equal(toolsValue, undefined, "no restrictions → no --tools flag");
});
