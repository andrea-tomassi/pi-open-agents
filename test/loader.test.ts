/**
 * Tests for agent discovery, loading, and filtering.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadAgents, selectableAgents, spawnableAgents, agentsAvailableTo } from "../src/discovery/loader.ts";
import type { AgentDefinition, AgentFs } from "../src/types.ts";

// ─── Test Filesystem ─────────────────────────────────────────────────────────

function makeMockFs(files: Record<string, string>): AgentFs {
  return {
    async listFiles(dir: string): Promise<string[]> {
      // Return files that are directly in this dir (not subdirs)
      const result: string[] = [];
      for (const fpath of Object.keys(files)) {
        const parent = fpath.substring(0, fpath.lastIndexOf("/"));
        if (parent === dir && fpath.endsWith(".md")) {
          result.push(fpath);
        }
        // Handle subdirectories recursively
        if (fpath.startsWith(dir + "/") && fpath.endsWith(".md")) {
          if (!result.includes(fpath)) {
            result.push(fpath);
          }
        }
      }
      return result.sort();
    },

    async readFile(filePath: string): Promise<string> {
      return files[filePath] ?? "";
    },

    async exists(dir: string): Promise<boolean> {
      // Check if any file starts with this dir
      return Object.keys(files).some((f) => f.startsWith(dir));
    },
  };
}

// ─── Loading Tests ───────────────────────────────────────────────────────────

test("loader: loads agents from global path", async () => {
  const fs = makeMockFs({
    "/global/my-agent.md": `---
name: my-agent
description: Global agent
mode: primary
---
Body`,
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
  assert.equal(result.agents[0].name, "my-agent");
  assert.equal(result.agents[0].source, "global");
  assert.equal(result.warnings.length, 0);
});

test("loader: project overrides global by name", async () => {
  const fs = makeMockFs({
    "/global/shared.md": `---
name: shared
description: Global version
mode: primary
---
Global body`,
    "/project/shared.md": `---
name: shared
description: Project override
mode: subagent
---
Project body`,
  });

  const result = await loadAgents({
    fs,
    paths: [
      { dir: "/global", source: "global", family: "pi", subdirs: [""] },
      { dir: "/project", source: "project", family: "pi", subdirs: [""] },
    ],
  });

  assert.equal(result.agents.length, 1);
  assert.equal(result.agents[0].description, "Project override");
  assert.equal(result.agents[0].mode, "subagent");
  assert.equal(result.agents[0].source, "project");
});

test("loader: collects parse warnings for invalid enum", async () => {
  const fs = makeMockFs({
    "/global/bad.md": `---
name: bad
mode: invalid-mode
---
Body`,
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

  assert.equal(result.agents.length, 0);
  assert.equal(result.warnings.length, 1);
  assert.ok(result.warnings[0].message.includes("invalid"));
});

test("loader: skips disabled agents", async () => {
  const fs = makeMockFs({
    "/global/disabled.md": `---
name: disabled
disable: true
---
Body`,
    "/global/active.md": `---
name: active
mode: primary
---
Body`,
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

test("loader: loads from multiple subdirs (OpenCode pattern)", async () => {
  const fs = makeMockFs({
    "/oc/agent/triage.md": `---
name: triage
mode: subagent
---
Triage body`,
    "/oc/agent/reviewer.md": `---
name: reviewer
mode: subagent
---
Review body`,
    "/oc/mode/planner.md": `---
name: planner
mode: primary
---
Plan body`,
  });

  const result = await loadAgents({
    fs,
    paths: [{
      dir: "/oc",
      source: "global",
      family: "opencode",
      subdirs: ["agent", "mode"],
    }],
  });

  assert.equal(result.agents.length, 3);
  const names = result.agents.map((a) => a.name).sort();
  assert.deepEqual(names, ["planner", "reviewer", "triage"]);
});

// ─── Filtering Tests ─────────────────────────────────────────────────────────

const SAMPLE_AGENTS: AgentDefinition[] = [
  { name: "primary-1", mode: "primary", hidden: false, disable: false, thinking: "off", systemPrompt: "append", maxDepth: 10, prompt: "", source: "global", filePath: "/a.md" },
  { name: "primary-2", mode: "primary", hidden: false, disable: false, thinking: "off", systemPrompt: "append", maxDepth: 10, prompt: "", source: "global", filePath: "/b.md" },
  { name: "sub-1", mode: "subagent", hidden: false, disable: false, thinking: "off", systemPrompt: "append", maxDepth: 10, prompt: "", source: "global", filePath: "/c.md" },
  { name: "sub-2", mode: "subagent", hidden: true, disable: false, thinking: "off", systemPrompt: "append", maxDepth: 10, prompt: "", source: "global", filePath: "/d.md" },
  { name: "both-1", mode: "all", hidden: false, disable: false, thinking: "off", systemPrompt: "append", maxDepth: 10, prompt: "", source: "global", filePath: "/e.md" },
  { name: "hidden-primary", mode: "primary", hidden: true, disable: false, thinking: "off", systemPrompt: "append", maxDepth: 10, prompt: "", source: "global", filePath: "/f.md" },
];

test("selectableAgents: shows primary and all, excludes hidden", () => {
  const result = selectableAgents(SAMPLE_AGENTS);
  const names = result.map((a) => a.name);
  assert.ok(names.includes("primary-1"));
  assert.ok(names.includes("primary-2"));
  assert.ok(names.includes("both-1"));
  assert.ok(!names.includes("sub-1"));
  assert.ok(!names.includes("sub-2"));
  assert.ok(!names.includes("hidden-primary"));
});

test("spawnableAgents: shows subagent and all", () => {
  const result = spawnableAgents(SAMPLE_AGENTS);
  const names = result.map((a) => a.name);
  assert.ok(names.includes("sub-1"));
  assert.ok(names.includes("sub-2"));
  assert.ok(names.includes("both-1"));
  assert.ok(!names.includes("primary-1"));
  assert.ok(!names.includes("primary-2"));
});

test("agentsAvailableTo: filters by allowedAgents", () => {
  const parent: AgentDefinition = {
    ...SAMPLE_AGENTS[0],
    name: "parent",
    allowedAgents: ["sub-1", "both-1"],
  };

  const result = agentsAvailableTo(SAMPLE_AGENTS, parent);
  const names = result.map((a) => a.name);
  assert.ok(names.includes("sub-1"));
  assert.ok(names.includes("both-1"));
  assert.ok(!names.includes("sub-2"));
});

test("agentsAvailableTo: no allowedAgents means all spawnable", () => {
  const parent: AgentDefinition = {
    ...SAMPLE_AGENTS[0],
    name: "parent",
    allowedAgents: undefined,
  };

  const result = agentsAvailableTo(SAMPLE_AGENTS, parent);
  const names = result.map((a) => a.name);
  assert.ok(names.includes("sub-1"));
  assert.ok(names.includes("sub-2"));
  assert.ok(names.includes("both-1"));
});
