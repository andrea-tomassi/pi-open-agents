/**
 * OpenCode compatibility tests.
 *
 * Verifies that agent definitions in OpenCode format are loaded
 * and parsed correctly by our unified system.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadAgents } from "../src/discovery/loader.ts";
import { parseAgentDefinition } from "../src/config/schema.ts";
import { deriveAgentName } from "../src/config/paths.ts";
import type { AgentFs } from "../src/types.ts";

// ─── Mock FS ─────────────────────────────────────────────────────────────────

function makeMockFs(files: Record<string, string>): AgentFs {
  return {
    async listFiles(dir: string): Promise<string[]> {
      const result: string[] = [];
      for (const fpath of Object.keys(files)) {
        if (fpath.startsWith(dir + "/") && fpath.endsWith(".md")) {
          result.push(fpath);
        }
      }
      return result.sort();
    },
    async readFile(filePath: string): Promise<string> {
      return files[filePath] ?? "";
    },
    async exists(dir: string): Promise<boolean> {
      return Object.keys(files).some((f) => f.startsWith(dir));
    },
  };
}

// ─── OpenCode Agent Format ───────────────────────────────────────────────────

test("OC compat: loads agent from .opencode/agent/ directory", async () => {
  const fs = makeMockFs({
    "/project/.opencode/agent/triage.md": `---
name: triage
description: Triage GitHub issues
mode: subagent
model: opencode/gpt-5.4-mini
---
You are a triage agent.`,
  });

  const result = await loadAgents({
    fs,
    cwd: "/project",
    paths: [{
      dir: "/project/.opencode",
      source: "project",
      family: "opencode",
      subdirs: ["agent"],
    }],
  });

  assert.equal(result.agents.length, 1);
  assert.equal(result.agents[0].name, "triage");
  assert.equal(result.agents[0].mode, "subagent");
  assert.equal(result.agents[0].model, "opencode/gpt-5.4-mini");
});

test("OC compat: loads agent from .opencode/mode/ directory", async () => {
  const fs = makeMockFs({
    "/project/.opencode/mode/planner.md": `---
name: planner
description: Planning mode
mode: primary
hidden: false
---
You are a planner.`,
  });

  const result = await loadAgents({
    fs,
    cwd: "/project",
    paths: [{
      dir: "/project/.opencode",
      source: "project",
      family: "opencode",
      subdirs: ["mode"],
    }],
  });

  assert.equal(result.agents.length, 1);
  assert.equal(result.agents[0].name, "planner");
  assert.equal(result.agents[0].mode, "primary");
});

test("OC compat: loads from both agent/ and mode/ subdirs", async () => {
  const fs = makeMockFs({
    "/project/.opencode/agent/reviewer.md": `---
name: reviewer
mode: subagent
---
Review code.`,
    "/project/.opencode/mode/build.md": `---
name: build
mode: primary
---
Build mode.`,
  });

  const result = await loadAgents({
    fs,
    cwd: "/project",
    paths: [{
      dir: "/project/.opencode",
      source: "project",
      family: "opencode",
      subdirs: ["agent", "mode"],
    }],
  });

  assert.equal(result.agents.length, 2);
  const names = result.agents.map((a) => a.name).sort();
  assert.deepEqual(names, ["build", "reviewer"]);
});

// ─── OpenCode Frontmatter Fields ─────────────────────────────────────────────

test("OC compat: all OpenCode fields parsed", () => {
  const content = `---
name: full-oc-agent
description: Full OC agent
mode: primary
hidden: true
color: "#44BA81"
model: opencode/claude-sonnet-4
variant: thinking
temperature: 0.7
top_p: 0.95
steps: 30
disable: false
prompt: "Inline prompt override"
---
Body text here`;

  const agent = parseAgentDefinition(content, "/test.md", "global", { thinking: "off" });

  assert.equal(agent.name, "full-oc-agent");
  assert.equal(agent.mode, "primary");
  assert.equal(agent.hidden, true);
  assert.equal(agent.color, "#44BA81");
  assert.equal(agent.model, "opencode/claude-sonnet-4");
  assert.equal(agent.variant, "thinking");
  assert.equal(agent.temperature, 0.7);
  assert.equal(agent.topP, 0.95);
  assert.equal(agent.steps, 30);
  assert.equal(agent.disable, false);
  // Body takes precedence over frontmatter "prompt"
  assert.equal(agent.prompt, "Body text here");
});

test("OC compat: frontmatter prompt used when no body", () => {
  const content = `---
name: prompt-only
prompt: "This is the prompt"
---
`;

  const agent = parseAgentDefinition(content, "/test.md", "global", { thinking: "off" });
  assert.equal(agent.prompt, "This is the prompt");
});

// ─── OpenCode Tools Map ──────────────────────────────────────────────────────

test("OC compat: deprecated tools map converts to permission", () => {
  const content = `---
name: restricted
tools:
  read: true
  write: false
  bash: true
  webfetch: false
---
Agent body`;

  const agent = parseAgentDefinition(content, "/test.md", "global", { thinking: "off" });

  assert.ok(agent.permission);
  assert.equal(agent.permission.read, "allow");
  assert.equal(agent.permission.bash, "allow");
  // write → edit (OC convention)
  assert.equal(agent.permission.edit, "deny");
  assert.equal(agent.permission.webfetch, "deny");
  // tools array is NOT set (map was converted to permission)
  assert.equal(agent.tools, undefined);
});

test("OC compat: explicit permission takes precedence over tools map", () => {
  const content = `---
name: mixed
tools:
  read: true
  bash: false
permission:
  bash: allow
---
Agent body`;

  const agent = parseAgentDefinition(content, "/test.md", "global", { thinking: "off" });

  // Explicit permission wins
  assert.ok(agent.permission);
  assert.equal(agent.permission.bash, "allow");
});

// ─── Path Naming ─────────────────────────────────────────────────────────────

test("OC compat: deriveAgentName strips subdir prefix", () => {
  // agent/triage.md → triage
  assert.equal(
    deriveAgentName("/project/.opencode/agent/triage.md", "/project/.opencode", "agent"),
    "triage",
  );

  // mode/planner.md → planner
  assert.equal(
    deriveAgentName("/project/.opencode/mode/planner.md", "/project/.opencode", "mode"),
    "planner",
  );
});

// ─── Cross-Format: Same Agent in Both Pi and OC ──────────────────────────────

test("OC compat: pi format and OC format produce equivalent agents", () => {
  const piFormat = `---
name: worker
description: Worker agent
model: zai/glm-5.2
thinking: xhigh
systemPrompt: append
tools: read, bash, edit
---
You are a worker.`;

  const ocFormat = `---
name: worker
description: Worker agent
model: zai/glm-5.2
mode: all
tools:
  read: true
  bash: true
  edit: true
---
You are a worker.`;

  const piAgent = parseAgentDefinition(piFormat, "/pi.md", "global", { thinking: "xhigh" });
  const ocAgent = parseAgentDefinition(ocFormat, "/oc.md", "global", { thinking: "xhigh" });

  assert.equal(piAgent.name, ocAgent.name);
  assert.equal(piAgent.description, ocAgent.description);
  assert.equal(piAgent.model, ocAgent.model);
  assert.equal(piAgent.prompt, ocAgent.prompt);
  assert.equal(piAgent.thinking, ocAgent.thinking);

  // Pi format has tools array, OC format has permission (from tools map)
  assert.deepEqual(piAgent.tools, ["read", "bash", "edit"]);
  assert.ok(ocAgent.permission);
  assert.equal(ocAgent.permission.read, "allow");
  assert.equal(ocAgent.permission.bash, "allow");
  assert.equal(ocAgent.permission.edit, "allow");
});

// ─── Disabled Agent ──────────────────────────────────────────────────────────

test("OC compat: disable: true removes agent from loading", async () => {
  const fs = makeMockFs({
    "/global/disabled.md": `---
name: disabled
disable: true
---
Should not load`,
    "/global/active.md": `---
name: active
mode: primary
---
Should load`,
  });

  const result = await loadAgents({
    fs,
    paths: [{
      dir: "/global",
      source: "global",
      family: "pi",
      subdirs: [""],
    }],
  });

  assert.equal(result.agents.length, 1);
  assert.equal(result.agents[0].name, "active");
});

// ─── Shared .agents/ Directory ───────────────────────────────────────────────

test("OC compat: loads from shared .agents/ directory", async () => {
  const fs = makeMockFs({
    "/project/.agents/shared-agent.md": `---
name: shared-agent
mode: all
description: Works in both pi and opencode
---
Shared agent body.`,
  });

  const result = await loadAgents({
    fs,
    cwd: "/project",
    paths: [{
      dir: "/project/.agents",
      source: "project",
      family: "shared",
      subdirs: [""],
    }],
  });

  assert.equal(result.agents.length, 1);
  assert.equal(result.agents[0].name, "shared-agent");
  assert.equal(result.agents[0].source, "project");
});
