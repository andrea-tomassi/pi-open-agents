/**
 * Tests for the skills-on-primary warning (issue #19).
 *
 * `skills:` is honored only for subagent children. A primary (or an `all`
 * agent applied as primary) that declares skills gets a warning instead of
 * silent ignorance — the fallback resolution the reporter proposed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { AgentManager, warnAgentSkillsPrimary } from "../src/primary/manager.ts";
import type { AgentDefinition } from "../src/types.ts";

const base: AgentDefinition = {
  name: "worker",
  mode: "primary",
  hidden: false,
  disable: false,
  thinking: "off",
  systemPrompt: "append",
  maxDepth: 1,
  prompt: "body",
  source: "global",
  filePath: "/global/worker.md",
};

function makeHost() {
  const notifications: Array<{ message: string; level: string }> = [];
  const pi = {
    getAllTools: () => [{ name: "read", sourceInfo: { source: "builtin" } }],
    setActiveTools: () => {},
    setThinkingLevel: () => {},
    getThinkingLevel: () => "off",
    appendEntry: () => {},
  } as never;
  const ui = {
    notify: (message: string, level = "info") => notifications.push({ message, level }),
  };
  const ctx = { model: undefined, ui } as never;
  return { pi, ctx, ui, notifications };
}

test("skills warning: primary with skills → warning on apply", async () => {
  const { pi, ctx, notifications } = makeHost();
  const manager = new AgentManager();
  manager.setAgents([{ ...base, skills: ["websearch", "pdf"] }]);

  await manager.apply("worker", pi, ctx);

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, "warning");
  assert.match(notifications[0].message, /skills: \(websearch, pdf\)/);
  assert.match(notifications[0].message, /subagent delegation only/);
});

test("skills warning: all-mode agent with skills → warning (it acts as primary here)", async () => {
  const { pi, ctx, notifications } = makeHost();
  const manager = new AgentManager();
  manager.setAgents([{ ...base, mode: "all" as const, skills: ["x"] }]);

  await manager.apply("worker", pi, ctx);
  assert.equal(notifications.length, 1);
});

test("skills warning: subagent-mode with skills → NO warning (skills apply there)", async () => {
  const { pi, ctx, ui, notifications } = makeHost();
  const manager = new AgentManager();
  // apply() is the primary path; assert on the helper directly for subagents
  warnAgentSkillsPrimary({ ...base, mode: "subagent", skills: ["audit"] } as AgentDefinition, ui as never);
  assert.equal(notifications.length, 0);
});

test("skills warning: no skills / empty skills → no warning", async () => {
  const { pi, ctx, notifications } = makeHost();
  const manager = new AgentManager();
  manager.setAgents([{ ...base, skills: undefined }]);
  await manager.apply("worker", pi, ctx);

  const manager2 = new AgentManager();
  manager2.setAgents([{ ...base, skills: [] }]);
  const host2 = makeHost();
  await manager2.apply("worker", host2.pi, host2.ctx);

  assert.equal(notifications.length, 0);
  assert.equal(host2.notifications.length, 0);
});
