/**
 * Tests for the runtime permission gate (issue #20).
 *
 * Two levels:
 * - decideToolCall / extractToolArg: pure verdict logic (gated scoping,
 *   argument-aware patterns, last-match-wins)
 * - registerPermissionGate: the tool_call handler with a fake pi + fake UI
 *   (allow once / always-session / deny / cancel / headless fail-closed)
 *
 * gate.ts imports the pi host package as TYPES ONLY, so these tests run
 * everywhere (including publish CI where the peer dependency is absent).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { AgentDefinition, PermissionRule } from "../src/types.ts";
import { decideToolCall, extractToolArg, registerPermissionGate } from "../src/permission/gate.ts";
import { parsePermissionRules } from "../src/permission/parser.ts";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const baseAgent: AgentDefinition = {
  name: "worker",
  mode: "subagent",
  hidden: true,
  disable: false,
  thinking: "off",
  systemPrompt: "replace",
  maxDepth: 1,
  prompt: "You are a worker.",
  source: "project",
  filePath: "/tmp/worker.agent.md",
};

function agentWith(permission: NonNullable<AgentDefinition["permission"]>): AgentDefinition {
  return { ...baseAgent, permission };
}

type Handler = (event: { toolName: string; input?: Record<string, unknown> }, ctx: unknown) => Promise<unknown>;

function captureHandler(resolveAgent: () => AgentDefinition | undefined): {
  handler: Handler;
  alwaysAllow: Map<string, boolean>;
} {
  let handler: Handler | undefined;
  const pi = {
    on: (event: string, h: Handler) => {
      if (event === "tool_call") handler = h;
      return () => {};
    },
  };
  const alwaysAllow = new Map<string, boolean>();
  registerPermissionGate(pi as never, { resolveAgent, alwaysAllow });
  assert.ok(handler, "tool_call handler must be registered");
  return { handler, alwaysAllow };
}

function fakeCtx(hasUI: boolean, selectResult?: string | undefined) {
  const calls: Array<{ title: string; options: string[] }> = [];
  const ctx = {
    hasUI,
    ui: {
      select: async (title: string, options: string[]) => {
        calls.push({ title, options });
        return selectResult;
      },
    },
  };
  return { ctx, calls };
}

// ─── extractToolArg ──────────────────────────────────────────────────────────

test("gate: extractToolArg maps tools to their pattern-matching argument", () => {
  assert.equal(extractToolArg("bash", { command: "git status" }), "git status");
  assert.equal(extractToolArg("edit", { file_path: "src/a.ts" }), "src/a.ts");
  assert.equal(extractToolArg("read", { path: "src/a.ts" }), "src/a.ts");
  assert.equal(extractToolArg("grep", { pattern: "todo", path: "src" }), "src");
  assert.equal(extractToolArg("grep", { pattern: "todo" }), "todo");
  assert.equal(extractToolArg("unknown_tool", {}), undefined);
});

// ─── decideToolCall ──────────────────────────────────────────────────────────

function decide(agent: AgentDefinition, toolName: string, input: Record<string, unknown>) {
  return decideToolCall(toolName, input, parsePermissionRules(agent.permission ?? {}));
}

test("gate: ungated category is not gated (no rules for the category)", () => {
  const agent = agentWith({ bash: "ask" });
  assert.deepEqual(decide(agent, "edit", { file_path: "a.ts" }), {
    action: "allow",
    category: "edit",
    gated: false,
  });
});

test("gate: simple ask rule gates the whole category", () => {
  const agent = agentWith({ bash: "ask" });
  const d = decide(agent, "bash", { command: "ls" });
  assert.equal(d.gated, true);
  assert.equal(d.action, "ask");
});

test("gate: argument-aware deny matches file paths", () => {
  const agent = agentWith({ edit: { "*.env": "deny" } });
  assert.equal(decide(agent, "edit", { file_path: "secrets.env" }).action, "deny");
  // star does not cross "/" — nested files need **
  assert.equal(decide(agent, "edit", { file_path: "config/secrets.env" }).action, "allow");
  const nested = agentWith({ edit: { "**/*.env": "deny" } });
  assert.equal(decide(nested, "edit", { file_path: "config/secrets.env" }).action, "deny");
});

test("gate: unmatched call within a gated category proceeds", () => {
  const agent = agentWith({ edit: { "*.env": "deny" } });
  const d = decide(agent, "edit", { file_path: "README.md" });
  assert.equal(d.gated, true);
  assert.equal(d.action, "allow");
});

test("gate: bash command patterns (catch-all first, specific rules last)", () => {
  const agent = agentWith({ bash: { "*": "ask", "git *": "allow" } });
  assert.equal(decide(agent, "bash", { command: "git status" }).action, "allow");
  assert.equal(decide(agent, "bash", { command: "rm -rf /" }).action, "ask");
});

test("gate: last-match-wins across wildcard categories", () => {
  const agent = agentWith({ "*": "ask", edit: "allow" });
  assert.equal(decide(agent, "edit", { file_path: "a.ts" }).action, "allow");
  assert.equal(decide(agent, "bash", { command: "ls" }).action, "ask");
});

test("gate: write is its own category (separate from edit)", () => {
  const editDeny = agentWith({ edit: "deny" });
  assert.equal(decide(editDeny, "write", { file_path: "a.ts" }).gated, false);
  assert.equal(decide(editDeny, "edit", { file_path: "a.ts" }).action, "deny");

  const writeDeny = agentWith({ write: "deny" });
  const d = decide(writeDeny, "write", { file_path: "a.ts" });
  assert.equal(d.action, "deny");
  assert.equal(d.category, "write");
});

// ─── Handler behavior ────────────────────────────────────────────────────────

const RULES = { bash: "ask" } as const;
type PermissionConfigLike = NonNullable<AgentDefinition["permission"]>;
const askAgent = agentWith(RULES as PermissionConfigLike);

test("gate handler: no permission config → not blocked, no dialog", async () => {
  const { handler } = captureHandler(() => baseAgent);
  const { ctx, calls } = fakeCtx(true, "Allow once");
  const result = await handler({ toolName: "bash", input: { command: "rm -rf /" } }, ctx);
  assert.equal(result, undefined);
  assert.equal(calls.length, 0);
});

test("gate handler: deny rule blocks with model-visible reason", async () => {
  const agent = agentWith({ edit: { "*.env": "deny" } } as PermissionConfigLike);
  const { handler } = captureHandler(() => agent);
  const { ctx } = fakeCtx(true, "Allow once");
  const result = (await handler({ toolName: "edit", input: { file_path: "secrets.env" } }, ctx)) as {
    block: boolean;
    reason: string;
  };
  assert.equal(result.block, true);
  assert.match(result.reason, /Permission denied/);
  assert.match(result.reason, /secrets\.env/);
});

test("gate handler: ask + allow once → proceeds, dialog shown once", async () => {
  const { handler } = captureHandler(() => askAgent);
  const { ctx, calls } = fakeCtx(true, "Allow once");
  const result = await handler({ toolName: "bash", input: { command: "ls" } }, ctx);
  assert.equal(result, undefined);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options, ["Allow once", "Allow always (this session)", "Deny"]);
});

test("gate handler: ask + allow always → memoized for the session", async () => {
  const { handler, alwaysAllow } = captureHandler(() => askAgent);
  const { ctx, calls } = fakeCtx(true, "Allow always (this session)");
  assert.equal(await handler({ toolName: "bash", input: { command: "ls" } }, ctx), undefined);
  assert.equal(await handler({ toolName: "bash", input: { command: "pwd" } }, ctx), undefined);
  assert.equal(calls.length, 1, "second call must not re-open the dialog");
  assert.equal(alwaysAllow.get("bash"), true);
});

test("gate handler: ask + deny → blocked", async () => {
  const { handler } = captureHandler(() => askAgent);
  const { ctx } = fakeCtx(true, "Deny");
  const result = (await handler({ toolName: "bash", input: { command: "ls" } }, ctx)) as {
    block: boolean;
    reason: string;
  };
  assert.equal(result.block, true);
  assert.match(result.reason, /denied/);
});

test("gate handler: ask + dialog cancelled → fail-closed block", async () => {
  const { handler } = captureHandler(() => askAgent);
  const { ctx } = fakeCtx(true, undefined);
  const result = (await handler({ toolName: "bash", input: { command: "ls" } }, ctx)) as { block: boolean };
  assert.equal(result.block, true);
});

test("gate handler: ask without UI (headless subagent) → fail-closed, no dialog", async () => {
  const { handler } = captureHandler(() => askAgent);
  const { ctx, calls } = fakeCtx(false, "Allow once");
  const result = (await handler({ toolName: "bash", input: { command: "ls" } }, ctx)) as {
    block: boolean;
    reason: string;
  };
  assert.equal(result.block, true);
  assert.match(result.reason, /non-interactive/);
  assert.equal(calls.length, 0, "no dialog may be attempted without UI");
});
