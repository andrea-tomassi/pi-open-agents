/**
 * Tests for schema parsing, validation, and normalization.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAgentDefinition, AgentParseError } from "../src/config/schema.ts";
import type { SchemaDefaults } from "../src/config/schema.ts";

const DEFAULTS: SchemaDefaults = { thinking: "xhigh" };

function makeContent(frontmatter: string, body = "Agent body"): string {
  return `---\n${frontmatter}\n---\n${body}`;
}

// ─── Required Fields ─────────────────────────────────────────────────────────

test("schema: missing name throws", () => {
  const content = makeContent("description: no name");
  assert.throws(
    () => parseAgentDefinition(content, "/test.md", "global", DEFAULTS),
    /missing required field: name/,
  );
});

test("schema: name from nameHint when no frontmatter name", () => {
  const content = makeContent("description: has hint");
  const agent = parseAgentDefinition(content, "/test.md", "global", DEFAULTS, "from-path");
  assert.equal(agent.name, "from-path");
});

// ─── Defaults ────────────────────────────────────────────────────────────────

test("schema: default values applied", () => {
  const content = makeContent("name: test");
  const agent = parseAgentDefinition(content, "/test.md", "global", DEFAULTS);

  assert.equal(agent.mode, "all");           // OC default
  assert.equal(agent.hidden, false);         // OC default
  assert.equal(agent.disable, false);        // OC default
  assert.equal(agent.thinking, "xhigh");     // from SchemaDefaults
  assert.equal(agent.systemPrompt, "append"); // pi default
  assert.equal(agent.maxDepth, 10);          // pi default
  assert.equal(agent.prompt, "Agent body");
});

test("schema: thinking falls back to SCHEMA_DEFAULTS", () => {
  const content = makeContent("name: test");
  const agent = parseAgentDefinition(content, "/test.md", "global", { thinking: "high" });
  assert.equal(agent.thinking, "high");
});

// ─── Enum Validation ─────────────────────────────────────────────────────────

test("schema: invalid mode throws", () => {
  const content = makeContent("name: test\nmode: invalid");
  assert.throws(
    () => parseAgentDefinition(content, "/test.md", "global", DEFAULTS),
    AgentParseError,
  );
});

test("schema: invalid thinking throws", () => {
  const content = makeContent("name: test\nthinking: super");
  assert.throws(
    () => parseAgentDefinition(content, "/test.md", "global", DEFAULTS),
    /invalid value "super"/,
  );
});

test("schema: invalid systemPrompt throws", () => {
  const content = makeContent("name: test\nsystemPrompt: merge");
  assert.throws(
    () => parseAgentDefinition(content, "/test.md", "global", DEFAULTS),
    /invalid value "merge"/,
  );
});

// ─── OpenCode Aliases ────────────────────────────────────────────────────────

test("schema: maxSteps alias for steps", () => {
  const content = makeContent("name: test\nmaxSteps: 25");
  const agent = parseAgentDefinition(content, "/test.md", "global", DEFAULTS);
  assert.equal(agent.steps, 25);
});

test("schema: top_p with underscore", () => {
  const content = makeContent("name: test\ntop_p: 0.9");
  const agent = parseAgentDefinition(content, "/test.md", "global", DEFAULTS);
  assert.equal(agent.topP, 0.9);
});

test("schema: topP camelCase also works", () => {
  const content = makeContent("name: test\ntopP: 0.8");
  const agent = parseAgentDefinition(content, "/test.md", "global", DEFAULTS);
  assert.equal(agent.topP, 0.8);
});

test("schema: system-prompt with hyphen alias", () => {
  const content = makeContent("name: test\nsystem-prompt: replace");
  const agent = parseAgentDefinition(content, "/test.md", "global", DEFAULTS);
  assert.equal(agent.systemPrompt, "replace");
});

// ─── Permission Parsing ──────────────────────────────────────────────────────

test("schema: simple permission rules", () => {
  const content = makeContent(
    "name: test\npermission:\n  bash: allow\n  read: deny",
  );
  const agent = parseAgentDefinition(content, "/test.md", "global", DEFAULTS);

  assert.ok(agent.permission);
  assert.equal(agent.permission.bash, "allow");
  assert.equal(agent.permission.read, "deny");
});

test("schema: nested permission with patterns", () => {
  const content = makeContent(
    'name: test\npermission:\n  edit:\n    "*.env": deny\n    "*.md": allow',
  );
  const agent = parseAgentDefinition(content, "/test.md", "global", DEFAULTS);

  assert.ok(agent.permission);
  const editRules = agent.permission.edit as Record<string, string>;
  assert.equal(editRules['*.env'], "deny");
  assert.equal(editRules['*.md'], "allow");
});

test("schema: invalid permission action throws", () => {
  const content = makeContent("name: test\npermission:\n  bash: maybe");
  assert.throws(
    () => parseAgentDefinition(content, "/test.md", "global", DEFAULTS),
    /invalid permission action "maybe"/,
  );
});

// ─── OpenCode Tools Map → Permission ─────────────────────────────────────────

test("schema: OC tools map converts to permission", () => {
  const content = makeContent(
    "name: test\ntools:\n  read: true\n  bash: false\n  write: true",
  );
  const agent = parseAgentDefinition(content, "/test.md", "global", DEFAULTS);

  assert.ok(agent.permission);
  assert.equal(agent.permission.read, "allow");
  assert.equal(agent.permission.bash, "deny");
  // write maps to edit (OpenCode convention)
  assert.equal(agent.permission.edit, "allow");
  assert.equal(agent.tools, undefined);
});

test("schema: pi CSV tools parsed as array", () => {
  const content = makeContent("name: test\ntools: read, bash, edit");
  const agent = parseAgentDefinition(content, "/test.md", "global", DEFAULTS);

  assert.ok(agent.tools);
  assert.deepEqual(agent.tools, ["read", "bash", "edit"]);
});

// ─── Mixed Agent Definition ──────────────────────────────────────────────────

test("schema: full mixed OC + pi agent", () => {
  const content = `---
name: triage-agent
description: Triage specialist
mode: subagent
hidden: true
color: "#44BA81"
model: zai/glm-5.2
thinking: xhigh
systemPrompt: replace
maxDepth: 5
allowedAgents: explorer, git-sync
skills: lark-*, github
permission:
  bash: deny
  read: allow
  edit:
    "*.md": ask
steps: 30
temperature: 0.5
---
You are a triage specialist agent.`;

  const agent = parseAgentDefinition(content, "/test.md", "global", DEFAULTS);

  assert.equal(agent.name, "triage-agent");
  assert.equal(agent.mode, "subagent");
  assert.equal(agent.hidden, true);
  assert.equal(agent.color, "#44BA81");
  assert.equal(agent.model, "zai/glm-5.2");
  assert.equal(agent.thinking, "xhigh");
  assert.equal(agent.systemPrompt, "replace");
  assert.equal(agent.maxDepth, 5);
  assert.deepEqual(agent.allowedAgents, ["explorer", "git-sync"]);
  assert.deepEqual(agent.skills, ["lark-*", "github"]);
  assert.equal(agent.steps, 30);
  assert.equal(agent.temperature, 0.5);
  assert.equal(agent.prompt, "You are a triage specialist agent.");

  assert.ok(agent.permission);
  assert.equal(agent.permission.bash, "deny");
  assert.equal(agent.permission.read, "allow");
  const editRules = agent.permission.edit as Record<string, string>;
  assert.equal(editRules['*.md'], "ask");
});

// ─── Disable Flag ────────────────────────────────────────────────────────────

test("schema: disabled agents are parseable", () => {
  const content = makeContent("name: test\ndisable: true");
  const agent = parseAgentDefinition(content, "/test.md", "global", DEFAULTS);
  assert.equal(agent.disable, true);
});
