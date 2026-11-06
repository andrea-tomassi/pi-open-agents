/**
 * Tests for primary-agent static tool filtering across all sources (#18).
 *
 * The static filter used to cover builtin tools only: non-builtin tools
 * (extensions, MCP) were always kept via an explicit
 * `sourceInfo?.source !== "builtin"` carve-out, so a restricted profile
 * could block extension tools at the runtime gate but never hide them from
 * the model. Filtering now applies to every registered source; the gate
 * remains the backstop for argument-pattern rules and tools that arrive
 * after the agent started.
 *
 * These tests drive `applyAgentConfig` / `refreshAgentTools` with a fake
 * ExtensionAPI whose tool list mixes builtin and `npm:`-sourced tools —
 * the exact shapes observed on a live pi 1.5.0 host. Peer-dependency
 * handling mirrors the other suites (skip in publish CI).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { AgentDefinition } from "../src/types.ts";

type PrimaryModule = typeof import("../src/primary/executor.ts");

let primary: PrimaryModule | undefined;
try {
  primary = await import("../src/primary/executor.ts");
} catch {
  primary = undefined;
}

const run = primary ? test : test.skip;

interface FakeTool {
  name: string;
  sourceInfo: { source: string };
}

const mixedTools: FakeTool[] = [
  { name: "read", sourceInfo: { source: "builtin" } },
  { name: "bash", sourceInfo: { source: "builtin" } },
  { name: "edit", sourceInfo: { source: "builtin" } },
  { name: "mcp", sourceInfo: { source: "npm:pi-mcp-adapter" } },
  { name: "system_one", sourceInfo: { source: "npm:pi-system-one" } },
  { name: "subagent", sourceInfo: { source: "npm:pi-open-agents" } },
];

const baseAgent: AgentDefinition = {
  name: "generic",
  mode: "primary",
  hidden: false,
  disable: false,
  thinking: "off",
  systemPrompt: "replace",
  maxDepth: 1,
  prompt: "You are a generic agent.",
  source: "project",
  filePath: "/tmp/generic.agent.md",
};

function makePi(tools: FakeTool[] = mixedTools) {
  let active: string[] = tools.map((t) => t.name);
  const notifications: Array<{ message: string; level?: string }> = [];
  const pi = {
    getAllTools: () => tools,
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => {
      active = names;
    },
    getThinkingLevel: () => "off",
    setThinkingLevel: () => {},
  };
  const ctx = {
    cwd: process.cwd(),
    ui: {
      notify: (message: string, level?: string) => {
        notifications.push({ message, level });
      },
    },
    modelRegistry: {
      find: () => undefined,
      getAvailable: () => [],
    },
  };
  return { pi, ctx, notifications, getActive: () => active };
}

// ─── Criterion 1: permission deny hides extension tools ─────────────────────

run("#18: blanket deny on an extension tool removes it from the active set", async () => {
  const { pi, ctx, getActive } = makePi();
  const agent: AgentDefinition = {
    ...baseAgent,
    permission: { mcp: "deny" } as never,
  };
  await primary!.applyAgentConfig(agent, pi as never, ctx as never);
  assert.ok(!getActive().includes("mcp"), "mcp must be hidden");
  assert.ok(getActive().includes("read"), "unrelated builtin stays");
  assert.ok(getActive().includes("system_one"), "unrelated extension stays");
});

run("#18: wildcard allow + specific deny hides only the denied extension tool", async () => {
  const { pi, ctx, getActive } = makePi();
  const agent: AgentDefinition = {
    ...baseAgent,
    permission: { "*": "allow", bash: "deny" } as never,
  };
  await primary!.applyAgentConfig(agent, pi as never, ctx as never);
  assert.ok(!getActive().includes("bash"));
  assert.ok(getActive().includes("mcp"), "extension tool survives wildcard allow");
});

// ─── Criterion 2: tools allowlist covers all sources ────────────────────────

run("#18: allowlist without extension tools hides them (the reporter's dev/generic split)", async () => {
  const { pi, ctx, getActive } = makePi();
  const agent: AgentDefinition = { ...baseAgent, tools: ["read", "edit"] };
  await primary!.applyAgentConfig(agent, pi as never, ctx as never);
  assert.deepEqual(getActive(), ["read", "edit"]);
});

run("#18: allowlist naming an extension tool keeps it", async () => {
  const { pi, ctx, getActive } = makePi();
  const agent: AgentDefinition = { ...baseAgent, tools: ["read", "mcp"] };
  await primary!.applyAgentConfig(agent, pi as never, ctx as never);
  assert.deepEqual(getActive(), ["read", "mcp"]);
});

// ─── Criterion 3: default preserved ─────────────────────────────────────────

run("#18 non-regression: no restrictions keeps every source active", async () => {
  const { pi, ctx, getActive } = makePi();
  await primary!.applyAgentConfig(baseAgent, pi as never, ctx as never);
  assert.deepEqual(getActive(), ["read", "bash", "edit", "mcp", "system_one", "subagent"]);
});

// ─── Criterion 4: hiding subagent warns ─────────────────────────────────────

run("#18: allowlist dropping subagent warns once, names the fix", async () => {
  const { pi, ctx, notifications } = makePi();
  const agent: AgentDefinition = { ...baseAgent, tools: ["read", "edit"] };
  await primary!.applyAgentConfig(agent, pi as never, ctx as never);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0]!.message, /subagent/);
  assert.equal(notifications[0]!.level, "warning");
});

run("#18: allowlist keeping subagent stays silent", async () => {
  const { pi, ctx, notifications } = makePi();
  const agent: AgentDefinition = { ...baseAgent, tools: ["read", "subagent"] };
  await primary!.applyAgentConfig(agent, pi as never, ctx as never);
  assert.equal(notifications.length, 0);
});

run("#18: unrestricted agent never warns even though subagent is present", async () => {
  const { pi, ctx, notifications } = makePi();
  await primary!.applyAgentConfig(baseAgent, pi as never, ctx as never);
  assert.equal(notifications.length, 0);
});

// ─── Criterion 5: refresh covers tools registered after session start ───────

run("#18: refreshAgentTools filters tools that arrived after the first apply", async () => {
  const { pi, ctx } = makePi([
    { name: "read", sourceInfo: { source: "builtin" } },
    { name: "bash", sourceInfo: { source: "builtin" } },
  ]);
  const agent: AgentDefinition = { ...baseAgent, tools: ["read"] };
  await primary!.applyAgentConfig(agent, pi as never, ctx as never);

  // An MCP server connects late and contributes a new tool mid-session.
  const lateTools: FakeTool[] = [
    { name: "read", sourceInfo: { source: "builtin" } },
    { name: "bash", sourceInfo: { source: "builtin" } },
    { name: "lsp_hover", sourceInfo: { source: "npm:some-lsp" } },
  ];
  (pi as { getAllTools: () => FakeTool[] }).getAllTools = () => lateTools;
  primary!.refreshAgentTools(agent, pi as never);
  assert.deepEqual((pi as { getActiveTools: () => string[] }).getActiveTools(), ["read"]);
});

// ─── Non-regression: builtin-only behavior unchanged ────────────────────────

run("#18 non-regression: builtin blanket deny still hides builtin tools", async () => {
  const { pi, ctx, getActive } = makePi();
  const agent: AgentDefinition = {
    ...baseAgent,
    permission: { bash: "deny" } as never,
  };
  await primary!.applyAgentConfig(agent, pi as never, ctx as never);
  assert.ok(!getActive().includes("bash"));
  assert.ok(getActive().includes("read"));
});
