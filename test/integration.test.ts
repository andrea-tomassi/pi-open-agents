/**
 * End-to-end integration tests.
 *
 * Tests the full pipeline: raw .md files → discovery → parsing →
 * validation → merged registry → filtering → permission evaluation.
 *
 * Simulates a realistic multi-source agent setup with both pi and
 * OpenCode format agents.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { getDiscoveryPaths } from "../src/config/paths.ts";
import { loadAgents, selectableAgents, spawnableAgents, agentsAvailableTo } from "../src/discovery/loader.ts";
import { parsePermissionRules } from "../src/permission/parser.ts";
import { evaluate, getDisabledTools } from "../src/permission/evaluator.ts";
import type { AgentFs } from "../src/types.ts";

// ─── Full Project Simulation ─────────────────────────────────────────────────

/**
 * Simulates a realistic workspace with:
 * - Global pi agents (~/.pi/agent/agents/)
 * - Project pi agents (.pi/agents/)
 * - Project OpenCode agents (.opencode/agent/)
 * - Shared agents (.agents/)
 */
function makeProjectFs(): AgentFs {
  const files: Record<string, string> = {
    // ── Global pi agents ──
    "/home/user/.pi/agent/agents/sw-engineer.md": `---
name: SW Engineer
mode: primary
description: Everyday coding companion
model: opencode-go/deepseek-v4-flash
thinking: high
permission:
  bash: allow
  edit: allow
  read: allow
---
You are a software engineer.`,

    "/home/user/.pi/agent/agents/explorer.md": `---
name: explorer
mode: subagent
description: Codebase exploration
tools: read, bash, grep, find, ls
maxDepth: 5
---
You explore codebases.`,

    // ── Project pi agents ──
    "/project/.pi/agents/project-pm.md": `---
name: project-manager
mode: primary
model: zai/glm-5.2
thinking: xhigh
systemPrompt: append
allowedAgents: tech-lead, skilled-coder, qa-engineer, git-sync
---
You coordinate implementation work.`,

    "/project/.pi/agents/tech-lead.md": `---
name: tech-lead
mode: subagent
model: zai/glm-5.2
thinking: xhigh
permission:
  bash: deny
  edit: deny
  read: allow
---
You assess code and write plans.`,

    "/project/.pi/agents/qa-engineer.md": `---
name: qa-engineer
mode: subagent
model: zai/glm-5.2
thinking: xhigh
tools: read, bash, grep
---
You run QA checks.`,

    // ── Project OpenCode agents ──
    "/project/.opencode/agent/triage.md": `---
name: triage
mode: subagent
hidden: true
model: opencode/gpt-5.4-mini
tools:
  read: true
  bash: false
---
You triage issues.`,

    // ── Shared agents ──
    "/project/.agents/docs-writer.md": `---
name: docs-writer
mode: all
description: Technical documentation writer
permission:
  read: allow
  edit:
    "*.md": allow
    "*.env": deny
  bash: deny
---
You write documentation.`,
  };

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

// ─── Tests ───────────────────────────────────────────────────────────────────

test("integration: full pipeline loads all agents", async () => {
  const fs = makeProjectFs();
  const paths = getDiscoveryPaths("/project", "/home/user/.pi/agent");

  const result = await loadAgents({
    fs,
    cwd: "/project",
    agentDir: "/home/user/.pi/agent",
    defaults: { thinking: "high" },
    paths,
  });

  // All 7 agents should be loaded
  assert.equal(result.agents.length, 7);
  assert.equal(result.warnings.length, 0);

  const names = result.agents.map((a) => a.name).sort();
  assert.ok(names.includes("SW Engineer"));
  assert.ok(names.includes("explorer"));
  assert.ok(names.includes("project-manager"));
  assert.ok(names.includes("tech-lead"));
  assert.ok(names.includes("qa-engineer"));
  assert.ok(names.includes("triage"));
  assert.ok(names.includes("docs-writer"));
});

test("integration: selectable agents = primary only", async () => {
  const fs = makeProjectFs();
  const paths = getDiscoveryPaths("/project", "/home/user/.pi/agent");
  const result = await loadAgents({ fs, cwd: "/project", agentDir: "/home/user/.pi/agent", paths });

  const selectable = selectableAgents(result.agents);
  const names = selectable.map((a) => a.name).sort();

  // SW Engineer (primary), project-manager (primary), docs-writer (all)
  assert.ok(names.includes("SW Engineer"));
  assert.ok(names.includes("project-manager"));
  assert.ok(names.includes("docs-writer"));
  // NOT: explorer, tech-lead, qa-engineer, triage (all subagent)
  assert.ok(!names.includes("explorer"));
  assert.ok(!names.includes("tech-lead"));
  assert.ok(!names.includes("qa-engineer"));
  assert.ok(!names.includes("triage"));
});

test("integration: spawnable agents = subagent + all", async () => {
  const fs = makeProjectFs();
  const paths = getDiscoveryPaths("/project", "/home/user/.pi/agent");
  const result = await loadAgents({ fs, cwd: "/project", agentDir: "/home/user/.pi/agent", paths });

  const spawnable = spawnableAgents(result.agents);
  const names = spawnable.map((a) => a.name).sort();

  assert.ok(names.includes("explorer"));
  assert.ok(names.includes("tech-lead"));
  assert.ok(names.includes("qa-engineer"));
  assert.ok(names.includes("triage"));
  assert.ok(names.includes("docs-writer"));
  // NOT: SW Engineer, project-manager (primary)
  assert.ok(!names.includes("SW Engineer"));
  assert.ok(!names.includes("project-manager"));
});

test("integration: allowedAgents restricts delegation", async () => {
  const fs = makeProjectFs();
  const paths = getDiscoveryPaths("/project", "/home/user/.pi/agent");
  const result = await loadAgents({ fs, cwd: "/project", agentDir: "/home/user/.pi/agent", paths });

  const pm = result.agents.find((a) => a.name === "project-manager")!;
  const available = agentsAvailableTo(result.agents, pm);

  // PM allows: tech-lead, skilled-coder, qa-engineer, git-sync
  // Available spawnable: explorer, tech-lead, qa-engineer, triage, docs-writer
  // Intersection: tech-lead, qa-engineer
  const names = available.map((a) => a.name).sort();
  assert.ok(names.includes("tech-lead"));
  assert.ok(names.includes("qa-engineer"));
  assert.ok(!names.includes("explorer"));
  assert.ok(!names.includes("triage"));
});

test("integration: permission filtering works on loaded agents", async () => {
  const fs = makeProjectFs();
  const paths = getDiscoveryPaths("/project", "/home/user/.pi/agent");
  const result = await loadAgents({ fs, cwd: "/project", agentDir: "/home/user/.pi/agent", paths });

  // docs-writer has: read=allow, edit(*.md)=allow, edit(*.env)=deny, bash=deny
  const docsWriter = result.agents.find((a) => a.name === "docs-writer")!;
  assert.ok(docsWriter.permission);

  const rules = parsePermissionRules(docsWriter.permission!);

  // bash should be denied
  const bashResult = evaluate("bash", "ls", rules);
  assert.equal(bashResult.action, "deny");

  // edit *.md should be allowed
  const editMdResult = evaluate("edit", "README.md", rules);
  assert.equal(editMdResult.action, "allow");

  // edit *.env should be denied
  const editEnvResult = evaluate("edit", "secret.env", rules);
  assert.equal(editEnvResult.action, "deny");

  // read should be allowed
  const readResult = evaluate("read", "any-file", rules);
  assert.equal(readResult.action, "allow");
});

test("integration: disabled tools correctly identified", async () => {
  const fs = makeProjectFs();
  const paths = getDiscoveryPaths("/project", "/home/user/.pi/agent");
  const result = await loadAgents({ fs, cwd: "/project", agentDir: "/home/user/.pi/agent", paths });

  // tech-lead has: bash=deny, edit=deny, read=allow
  const techLead = result.agents.find((a) => a.name === "tech-lead")!;
  const rules = parsePermissionRules(techLead.permission!);

  const disabled = getDisabledTools(["bash", "edit", "read", "write", "grep"], rules);

  assert.ok(disabled.has("bash"));
  assert.ok(disabled.has("edit"));
  assert.ok(disabled.has("write")); // write → edit → denied
  assert.ok(!disabled.has("read"));
  assert.ok(!disabled.has("grep"));
});

test("integration: OpenCode tools map agent has correct permissions", async () => {
  const fs = makeProjectFs();
  const paths = getDiscoveryPaths("/project", "/home/user/.pi/agent");
  const result = await loadAgents({ fs, cwd: "/project", agentDir: "/home/user/.pi/agent", paths });

  // triage has OC tools map: read=true, bash=false
  const triage = result.agents.find((a) => a.name === "triage")!;

  // Should have permission, not tools array
  assert.ok(triage.permission);
  assert.equal(triage.permission!.read, "allow");
  assert.equal(triage.permission!.bash, "deny");
});

test("integration: thinking defaults applied correctly", async () => {
  const fs = makeProjectFs();
  const paths = getDiscoveryPaths("/project", "/home/user/.pi/agent");
  const result = await loadAgents({
    fs,
    cwd: "/project",
    agentDir: "/home/user/.pi/agent",
    defaults: { thinking: "high" },
    paths,
  });

  // SW Engineer explicitly sets thinking: high
  const swEng = result.agents.find((a) => a.name === "SW Engineer")!;
  assert.equal(swEng.thinking, "high");

  // docs-writer doesn't specify thinking → falls back to default
  const docsWriter = result.agents.find((a) => a.name === "docs-writer")!;
  assert.equal(docsWriter.thinking, "high");
});
