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

// ─── set_agent Guard Simulation ───────────────────────────────────────────────

test("set_agent: subagent process cannot switch agent", () => {
  const manager = new AgentManager();
  manager.setAgents([PRIMARY]);

  const env = { PI_OPEN_AGENTS_DEPTH: "1" };
  assert.throws(() => {
    if (isSubagentProcess(env)) {
      throw new Error("set_agent is only available to the primary agent, not subagents.");
    }
    const agent = manager.getAgent("main");
    if (agent?.mode === "subagent") {
      throw new Error(`Agent "main" is a subagent and cannot be set as the primary agent.`);
    }
  }, /set_agent is only available to the primary agent/);
});

test("set_agent: all-mode agent spawned as subagent cannot call set_agent", () => {
  // A "full" agent (mode: all) can be spawned as a subagent. The isSubagentProcess
  // guard blocks set_agent regardless of the agent's mode.
  const manager = new AgentManager();
  manager.setAgents([ALL_MODE]);

  const env = { PI_OPEN_AGENTS_DEPTH: "1" };
  assert.throws(() => {
    if (isSubagentProcess(env)) {
      throw new Error("set_agent is only available to the primary agent, not subagents.");
    }
    const agent = manager.getAgent("dual");
    if (agent?.mode === "subagent") {
      throw new Error(`Agent "dual" is a subagent and cannot be set as the primary agent.`);
    }
  }, /set_agent is only available to the primary agent/);
});

test("set_agent: primary agent cannot switch to subagent target", () => {
  const manager = new AgentManager();
  manager.setAgents([PRIMARY, SUBAGENT]);

  const env = {};
  assert.throws(() => {
    if (isSubagentProcess(env)) {
      throw new Error("set_agent is only available to the primary agent, not subagents.");
    }
    const agent = manager.getAgent("sub-helper");
    if (agent?.mode === "subagent") {
      throw new Error(`Agent "sub-helper" is a subagent and cannot be set as the primary agent.`);
    }
  }, /is a subagent and cannot be set as the primary agent/);
});



