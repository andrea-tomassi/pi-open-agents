/**
 * Tests for AgentManager and tool-layer agent filtering.
 *
 * Verifies that the AgentManager stores all agents regardless of mode,
 * and that mode filtering is correctly applied at the tool/TUI layer.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentManager } from "../src/primary/manager.ts";
import { isSubagentProcess } from "../src/subagent/env.ts";
import { registerAgentTools } from "../src/tui/tools.ts";
import type { AgentDefinition } from "../src/types.ts";

// ─── Sample Agents ────────────────────────────────────────────────────────────

const SUBAGENT: AgentDefinition = {
  name: "sub-helper",
  mode: "subagent",
  hidden: false,
  disable: false,
  thinking: "off",
  systemPrompt: "append",
  maxDepth: 10,
  prompt: "",
  source: "global",
  filePath: "/sub.md",
};

const PRIMARY: AgentDefinition = {
  name: "main",
  mode: "primary",
  hidden: false,
  disable: false,
  thinking: "off",
  systemPrompt: "append",
  maxDepth: 10,
  prompt: "",
  source: "global",
  filePath: "/main.md",
};

const OTHER_PRIMARY: AgentDefinition = {
  name: "reviewer",
  mode: "primary",
  hidden: false,
  disable: false,
  thinking: "off",
  systemPrompt: "append",
  maxDepth: 10,
  prompt: "",
  source: "global",
  filePath: "/reviewer.md",
};

const ALL_MODE: AgentDefinition = {
  name: "dual",
  mode: "all",
  hidden: false,
  disable: false,
  thinking: "off",
  systemPrompt: "append",
  maxDepth: 10,
  prompt: "",
  source: "global",
  filePath: "/dual.md",
};

const HIDDEN_PRIMARY: AgentDefinition = {
  name: "hidden-admin",
  mode: "primary",
  hidden: true,
  disable: false,
  thinking: "off",
  systemPrompt: "append",
  maxDepth: 10,
  prompt: "",
  source: "global",
  filePath: "/hidden.md",
};

// ─── Agent Registration ───────────────────────────────────────────────────────

test("AgentManager: setAgents stores all agents including subagents", () => {
  const manager = new AgentManager();
  manager.setAgents([PRIMARY, SUBAGENT, ALL_MODE]);

  assert.equal(manager.getAgents().length, 3);
});

test("AgentManager: getAgent returns subagent by name", () => {
  const manager = new AgentManager();
  manager.setAgents([PRIMARY, SUBAGENT]);

  const agent = manager.getAgent("sub-helper");
  assert.ok(agent);
  assert.equal(agent.name, "sub-helper");
  assert.equal(agent.mode, "subagent");
});

test("AgentManager: getAgent returns primary agent by name", () => {
  const manager = new AgentManager();
  manager.setAgents([PRIMARY]);

  const agent = manager.getAgent("main");
  assert.ok(agent);
  assert.equal(agent.mode, "primary");
});

test("AgentManager: getAgent returns undefined for unknown name", () => {
  const manager = new AgentManager();
  manager.setAgents([PRIMARY]);

  assert.equal(manager.getAgent("nonexistent"), undefined);
});

test("AgentManager: getAgents returns all agents unfiltered", () => {
  const manager = new AgentManager();
  manager.setAgents([PRIMARY, SUBAGENT, ALL_MODE, HIDDEN_PRIMARY]);

  const all = manager.getAgents();
  const names = all.map((a) => a.name);
  assert.ok(names.includes("main"));
  assert.ok(names.includes("sub-helper"));
  assert.ok(names.includes("dual"));
  assert.ok(names.includes("hidden-admin"));
});

// ─── Active Agent ─────────────────────────────────────────────────────────────

test("AgentManager: getActive returns undefined initially", () => {
  const manager = new AgentManager();

  assert.equal(manager.getActive(), undefined);
  assert.equal(manager.getActiveName(), undefined);
});

test("AgentManager: getActiveName returns undefined initially", () => {
  const manager = new AgentManager();

  assert.equal(manager.getActiveName(), undefined);
});

test("AgentManager: isActive returns false when no agent active", () => {
  const manager = new AgentManager();
  manager.setAgents([PRIMARY]);

  assert.equal(manager.isActive("main"), false);
});

test("AgentManager: isActive returns true for active agent", () => {
  const manager = new AgentManager();
  manager.setAgents([PRIMARY]);
  manager.restoreFromSession("main");

  assert.equal(manager.isActive("main"), true);
  assert.equal(manager.isActive("sub-helper"), false);
});

// ─── Mode Filtering Contract ──────────────────────────────────────────────────

test("AgentManager: getAgent does NOT filter by mode (tool layer must check)", () => {
  // The manager returns subagents via getAgent() — it is the tool
  // layer's responsibility to reject subagents when used as primary.
  const manager = new AgentManager();
  manager.setAgents([PRIMARY, SUBAGENT, ALL_MODE]);

  // Subagents are retrievable — the set_agent tool must check mode === "subagent"
  const sub = manager.getAgent("sub-helper");
  assert.ok(sub);
  assert.equal(sub.mode, "subagent");

  // Primary and all-mode agents are also retrievable
  assert.ok(manager.getAgent("main"));
  assert.ok(manager.getAgent("dual"));
});

test("AgentManager: getAgent returns hidden agents (hidden filter is TUI-level)", () => {
  const manager = new AgentManager();
  manager.setAgents([HIDDEN_PRIMARY, PRIMARY]);

  assert.ok(manager.getAgent("hidden-admin"));
  assert.ok(manager.getAgent("main"));
});

// ─── Session Restore ──────────────────────────────────────────────────────────

test("AgentManager: restoreFromSession sets active state", () => {
  const manager = new AgentManager();
  manager.setAgents([PRIMARY]);

  manager.restoreFromSession("main");

  assert.equal(manager.getActive()?.name, "main");
  assert.equal(manager.getActiveName(), "main");
  assert.equal(manager.isActive("main"), true);
});

test("AgentManager: restoreFromSession ignores unknown names", () => {
  const manager = new AgentManager();
  manager.setAgents([PRIMARY]);

  manager.restoreFromSession("no-such-agent");

  assert.equal(manager.getActive(), undefined);
  assert.equal(manager.getActiveName(), undefined);
});

// ─── Subagent Process Detection ───────────────────────────────────────────────

test("isSubagentProcess: returns false when depth is 0 or unset", () => {
  assert.equal(isSubagentProcess({}), false);
  assert.equal(isSubagentProcess({ PI_OPEN_AGENTS_DEPTH: "0" }), false);
});

test("isSubagentProcess: returns true when depth > 0", () => {
  assert.equal(isSubagentProcess({ PI_OPEN_AGENTS_DEPTH: "1" }), true);
  assert.equal(isSubagentProcess({ PI_OPEN_AGENTS_DEPTH: "3" }), true);
});

// ─── set_agent Tool ────────────────────────────────────────────────────────────

interface RegisteredTool {
  name: string;
  execute: (...args: unknown[]) => Promise<unknown>;
}

function getSetAgentTool(
  manager: AgentManager,
  pi: { registerTool(tool: RegisteredTool): void } = { registerTool: () => {} },
): RegisteredTool {
  const tools: RegisteredTool[] = [];
  const registerTool = pi.registerTool;
  pi.registerTool = (tool) => {
    tools.push(tool);
    registerTool.call(pi, tool);
  };

  registerAgentTools(manager, pi as never);

  const tool = tools.find((candidate) => candidate.name === "set_agent");
  assert.ok(tool, "set_agent should be registered");
  return tool;
}

function makeApplyHost(): {
  pi: {
    registerTool(tool: RegisteredTool): void;
    getThinkingLevel(): string;
    getAllTools(): Array<{ name: string; sourceInfo: { source: string } }>;
    setThinkingLevel(level: string): void;
    setActiveTools(names: string[]): void;
  };
  ctx: {
    model: undefined;
    ui: {
      notify(message: string, level: string): void;
      theme: {
        bold(value: string): string;
        fg(color: string, value: string): string;
      };
      setWidget(name: string, content: string[] | undefined): void;
    };
  };
  notifications: string[];
} {
  const notifications: string[] = [];
  const pi = {
    registerTool: (_tool: RegisteredTool): void => {},
    getThinkingLevel: (): string => "off",
    getAllTools: (): Array<{ name: string; sourceInfo: { source: string } }> => [
      { name: "read", sourceInfo: { source: "builtin" } },
    ],
    setThinkingLevel: (_level: string): void => {},
    setActiveTools: (_names: string[]): void => {},
  };
  const ctx = {
    model: undefined,
    ui: {
      notify: (message: string, _level: string): void => {
        notifications.push(message);
      },
      theme: {
        bold: (value: string): string => value,
        fg: (_color: string, value: string): string => value,
      },
      setWidget: (_name: string, _content: string[] | undefined): void => {},
    },
  };

  return { pi, ctx, notifications };
}

test("set_agent implementation blocks subagent processes", async () => {
  const manager = new AgentManager();
  manager.setAgents([PRIMARY]);
  const tool = getSetAgentTool(manager);

  const previousDepth = process.env.PI_OPEN_AGENTS_DEPTH;
  process.env.PI_OPEN_AGENTS_DEPTH = "1";
  try {
    assert.equal(isSubagentProcess(process.env), true, "test must run as a subagent process");
    await assert.rejects(
      () => tool.execute("test-call", { agent: "main" }, undefined, undefined, undefined),
      /set_agent is only available to the primary agent, not subagents/,
    );
  } finally {
    if (previousDepth === undefined) delete process.env.PI_OPEN_AGENTS_DEPTH;
    else process.env.PI_OPEN_AGENTS_DEPTH = previousDepth;
  }
});

test("set_agent implementation blocks all-mode agents running as subagents", async () => {
  const manager = new AgentManager();
  manager.setAgents([ALL_MODE]);
  const tool = getSetAgentTool(manager);

  const previousDepth = process.env.PI_OPEN_AGENTS_DEPTH;
  process.env.PI_OPEN_AGENTS_DEPTH = "1";
  try {
    assert.equal(isSubagentProcess(process.env), true, "test must run as a subagent process");
    await assert.rejects(
      () => tool.execute("test-call", { agent: "dual" }, undefined, undefined, undefined),
      /set_agent is only available to the primary agent, not subagents/,
    );
  } finally {
    if (previousDepth === undefined) delete process.env.PI_OPEN_AGENTS_DEPTH;
    else process.env.PI_OPEN_AGENTS_DEPTH = previousDepth;
  }
});

test("set_agent implementation rejects a subagent-only target", async () => {
  const manager = new AgentManager();
  manager.setAgents([PRIMARY, SUBAGENT]);
  const tool = getSetAgentTool(manager);

  const previousDepth = process.env.PI_OPEN_AGENTS_DEPTH;
  delete process.env.PI_OPEN_AGENTS_DEPTH;
  try {
    assert.equal(isSubagentProcess(process.env), false, "test must run as the primary process");
    await assert.rejects(
      () => tool.execute("test-call", { agent: "sub-helper" }, undefined, undefined, undefined),
      /Agent "sub-helper" is a subagent and cannot be set as the primary agent/,
    );
  } finally {
    if (previousDepth === undefined) delete process.env.PI_OPEN_AGENTS_DEPTH;
    else process.env.PI_OPEN_AGENTS_DEPTH = previousDepth;
  }
});

test("set_agent implementation switches to another primary agent", async () => {
  const manager = new AgentManager();
  manager.setAgents([PRIMARY, OTHER_PRIMARY]);
  const host = makeApplyHost();
  const tool = getSetAgentTool(manager, host.pi);

  const previousDepth = process.env.PI_OPEN_AGENTS_DEPTH;
  delete process.env.PI_OPEN_AGENTS_DEPTH;
  try {
    assert.equal(isSubagentProcess(process.env), false, "test must run as the primary process");
    const result = await tool.execute(
      "test-call",
      { agent: "reviewer", reason: "Review the implementation" },
      undefined,
      undefined,
      host.ctx,
    );

    assert.equal(manager.getActiveName(), "reviewer");
    assert.deepEqual(result, {
      content: [{ type: "text", text: 'Switched to agent "reviewer". Reason: Review the implementation' }],
      details: { agent: "reviewer", reason: "Review the implementation" },
    });
    assert.deepEqual(host.notifications, ['Switched to agent "reviewer". Reason: Review the implementation']);
  } finally {
    if (previousDepth === undefined) delete process.env.PI_OPEN_AGENTS_DEPTH;
    else process.env.PI_OPEN_AGENTS_DEPTH = previousDepth;
  }
});

test("set_agent implementation switches to an all-mode agent", async () => {
  const manager = new AgentManager();
  manager.setAgents([PRIMARY, ALL_MODE]);
  const host = makeApplyHost();
  const tool = getSetAgentTool(manager, host.pi);

  const previousDepth = process.env.PI_OPEN_AGENTS_DEPTH;
  delete process.env.PI_OPEN_AGENTS_DEPTH;
  try {
    assert.equal(isSubagentProcess(process.env), false, "test must run as the primary process");
    const result = await tool.execute("test-call", { agent: "dual" }, undefined, undefined, host.ctx);

    assert.equal(manager.getActiveName(), "dual");
    assert.deepEqual(result, {
      content: [{ type: "text", text: 'Switched to agent "dual"' }],
      details: { agent: "dual", reason: undefined },
    });
    assert.deepEqual(host.notifications, ['Switched to agent "dual"']);
  } finally {
    if (previousDepth === undefined) delete process.env.PI_OPEN_AGENTS_DEPTH;
    else process.env.PI_OPEN_AGENTS_DEPTH = previousDepth;
  }
});
