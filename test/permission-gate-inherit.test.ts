/**
 * Tests for permission inheritance parent → child (issue #8).
 *
 * Design (from @Silentpartnercoding's proposal, adopted):
 * - snapshot pi.getActiveTools() at delegation → parent ceiling
 * - blanket deny/ask in the parent's rules REMOVES the tool from the ceiling
 *   (ask is not authority)
 * - child effective tools = own whitelist ∩ ceiling; empty → --no-tools
 *   (omitting --tools would fail open to ALL tools)
 * - arg-pattern deny/ask rules travel to the child's gate via
 *   PI_OPEN_AGENTS_PARENT_RULES (enforced in-child, last-match-wins)
 * - transitively: the child's own getActiveTools() already reflects the CLI
 *   ceiling, so a grandchild cannot regain a tool removed upstream
 *
 * Pinned: the five regression cases from the issue thread.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { AgentDefinition } from "../src/types.ts";
import type { ProcessRunner, ExecutorFs, PiResolution } from "../src/subagent/executor.ts";
import { parentInheritedRules } from "../src/subagent/env.ts";

type RunSubagent = typeof import("../src/subagent/executor.ts").runSubagent;
type ToolModule = typeof import("../src/subagent/tool.ts");

let runSubagent: RunSubagent | undefined;
let toolMod: ToolModule | undefined;
try {
  ({ runSubagent } = await import("../src/subagent/executor.ts"));
  toolMod = await import("../src/subagent/tool.ts");
} catch {
  runSubagent = undefined;
}

const run = runSubagent && toolMod ? test : test.skip;

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

/** Run with injected ceiling/rules, capture child CLI args and env. */
async function capture(agent: AgentDefinition, extra: Record<string, unknown> = {}) {
  let args: string[] = [];
  let env: NodeJS.ProcessEnv = {};
  const captureRunner: ProcessRunner = (invocation) => {
    args = invocation.args;
    env = invocation.env;
    return Promise.resolve({ exitCode: 0 });
  };
  await runSubagent!({
    agent,
    task: "t",
    cwd: process.cwd(),
    runner: captureRunner,
    fs: fakeFs,
    resolvePi: fakeResolvePi,
    ...extra,
  });
  const toolsIdx = args.indexOf("--tools");
  return {
    tools: toolsIdx !== -1 ? args[toolsIdx + 1]!.split(",") : undefined,
    noTools: args.includes("--no-tools"),
    parentRulesEnv: env.PI_OPEN_AGENTS_PARENT_RULES,
  };
}

// ─── Regression 1: read-only parent cannot spawn a child with edit/bash ─────

run("#8 r1: child whitelist ∩ ceiling drops tools the parent lacks", async () => {
  const agent: AgentDefinition = { ...baseAgent, tools: ["read", "edit", "bash"] };
  const r = await capture(agent, { parentCeiling: ["read", "ls"] });
  assert.deepEqual(r.tools, ["read"]);
});

run("#8 r1b: unrestricted child under read-only ceiling gets exactly the ceiling", async () => {
  const r = await capture(baseAgent, { parentCeiling: ["read", "grep"] });
  assert.deepEqual(r.tools, ["read", "grep"]);
});

// ─── Regression 2: ask without approval bridge yields no child authority ────

run("#8 r2: blanket ask removes the tool from the ceiling", () => {
  const ceiling = toolMod!.computeDelegationCeiling(
    ["read", "bash", "edit"],
    [{ permission: "bash", pattern: "*", action: "ask" }],
  );
  assert.deepEqual(ceiling, ["read", "edit"]);
});

// ─── Regression 3: `*: allow` + `bash: deny` excludes bash ───────────────────

run("#8 r3: blanket deny removes the tool from the ceiling", () => {
  const ceiling = toolMod!.computeDelegationCeiling(
    ["read", "bash"],
    [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "*", action: "deny" },
    ],
  );
  assert.deepEqual(ceiling, ["read"]);
});

run("#8 r3b: write is its own category — denying edit keeps write in the ceiling", () => {
  const ceiling = toolMod!.computeDelegationCeiling(
    ["read", "edit", "write"],
    [{ permission: "edit", pattern: "*", action: "deny" }],
  );
  assert.deepEqual(ceiling, ["read", "write"]);
});

// ─── Regression 4: empty intersection launches with NO tools ─────────────────

run("#8 r4: empty intersection → --no-tools, not an omitted --tools", async () => {
  const agent: AgentDefinition = { ...baseAgent, tools: ["edit"] };
  const r = await capture(agent, { parentCeiling: ["read"] });
  assert.equal(r.tools, undefined, "--tools must not carry an empty list");
  assert.equal(r.noTools, true, "--no-tools must be passed");
});

run("#8 r4b: empty ceiling (parent has nothing) → --no-tools", async () => {
  const r = await capture(baseAgent, { parentCeiling: [] });
  assert.equal(r.noTools, true);
  assert.equal(r.tools, undefined);
});

run("#8 r4c: no ceiling at all → legacy behavior (own whitelist only)", async () => {
  const agent: AgentDefinition = { ...baseAgent, tools: ["read", "edit"] };
  const r = await capture(agent);
  assert.deepEqual(r.tools, ["read", "edit"]);
  assert.equal(r.noTools, false);
});

// ─── Regression 5: transitive ceiling (grandchild cannot regain) ─────────────

run("#8 r5: two-hop composition is monotonic — edit is not regained downstream", async () => {
  const hop1 = await capture({ ...baseAgent, name: "child" }, { parentCeiling: ["read", "bash"] });
  assert.deepEqual(hop1.tools, ["read", "bash"]);
  // The child's --tools IS its pi.getActiveTools() at runtime; delegating on
  // uses that snapshot as the next ceiling.
  const hop2 = await capture(
    { ...baseAgent, name: "grandchild", tools: ["read", "bash", "edit"] },
    { parentCeiling: hop1.tools },
  );
  assert.deepEqual(hop2.tools, ["read", "bash"], "edit must not be regained at the second hop");
});

// ─── Arg-pattern rules travel to the child's gate via env ────────────────────

run("#8 rules: parent restrictive rules serialize to PI_OPEN_AGENTS_PARENT_RULES", async () => {
  const rules = [{ permission: "edit", pattern: "*.env", action: "deny" as const }];
  const r = await capture(baseAgent, { parentRules: rules });
  assert.equal(r.parentRulesEnv, JSON.stringify(rules));
});

run("#8 rules: empty rule list → no env var", async () => {
  const r = await capture(baseAgent, { parentRules: [] });
  assert.equal(r.parentRulesEnv, undefined);
});

test("#8 rules: parentInheritedRules — roundtrip, filtering, malformed", () => {
  const rules = [{ permission: "edit", pattern: "*.env", action: "deny" }];
  assert.deepEqual(parentInheritedRules({ PI_OPEN_AGENTS_PARENT_RULES: JSON.stringify(rules) }), rules);
  assert.deepEqual(parentInheritedRules({}), []);
  assert.deepEqual(parentInheritedRules({ PI_OPEN_AGENTS_PARENT_RULES: "{oops" }), []);
  assert.deepEqual(parentInheritedRules({ PI_OPEN_AGENTS_PARENT_RULES: '{"not":"an-array"}' }), []);
  assert.deepEqual(parentInheritedRules({ PI_OPEN_AGENTS_PARENT_RULES: '[{"action":"allow"}]' }), []);
});

// ─── composeInheritedRules: env-up + own, deduped, restrictive only ──────────

run("#8 rules: composed chain rules keep restrictive only, deduped", () => {
  const composed = toolMod!.composeInheritedRules(
    [
      { permission: "edit", pattern: "*.env", action: "deny" },
      { permission: "read", pattern: "*", action: "allow" },
    ],
    [
      { permission: "edit", pattern: "*.env", action: "deny" },
      { permission: "bash", pattern: "rm *", action: "deny" },
    ],
  );
  assert.deepEqual(composed, [
    { permission: "edit", pattern: "*.env", action: "deny" },
    { permission: "bash", pattern: "rm *", action: "deny" },
  ]);
});

// ─── Child gate enforces inherited arg-patterns over own allows ──────────────

run("#8 gate: inherited deny beats child's own allow (last-match composition)", async () => {
  const { decideToolCall } = await import("../src/permission/gate.ts");
  const { parsePermissionRules } = await import("../src/permission/parser.ts");
  const childOwn = parsePermissionRules({ edit: "allow" });
  const inherited = parentInheritedRules({
    PI_OPEN_AGENTS_PARENT_RULES: JSON.stringify([{ permission: "edit", pattern: "*.env", action: "deny" }]),
  });
  const merged = [...childOwn, ...inherited];
  const blocked = decideToolCall("edit", { file_path: "prod.env" }, merged);
  assert.equal(blocked.action, "deny");
  const fine = decideToolCall("edit", { file_path: "app.ts" }, merged);
  assert.equal(fine.action, "allow");
});
