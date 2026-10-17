/**
 * Tests for reload-aware session_start (issue #9).
 *
 * pi's built-in /reload replaces the extension runtime and re-fires
 * session_start with reason "reload". The plugin must:
 *   1. re-discover agent definitions (fresh loadAgents — edits/new files win)
 *   2. keep the agent the session was USING (restore from the
 *      open-agents-state entry), NOT re-apply the --agent flag or
 *      settings.defaultAgent
 *   3. fall back cleanly (terminator, no crash) when the restored agent was
 *      deleted meanwhile
 *
 * These drive the REAL factory from index.ts with a fake ExtensionAPI/Context,
 * filling the index.ts harness gap noted in active-agent-entry.test.ts for
 * the session_start path specifically.
 *
 * index.ts imports the pi host package at module load; we skip gracefully
 * when the peer dependency is absent (publish CI).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type PiOpenAgents = typeof import("../src/index.ts").default;
let piOpenAgents: PiOpenAgents | undefined;
try {
  ({ default: piOpenAgents } = await import("../src/index.ts"));
} catch {
  piOpenAgents = undefined;
}

const run = piOpenAgents ? test : test.skip;

// ─── Harness ─────────────────────────────────────────────────────────────────

interface RecordedEntry {
  customType: string;
  data: unknown;
}

function makeHarness() {
  const handlers = new Map<string, Array<(event: any, ctx: any) => Promise<unknown>>>();
  assert.ok(piOpenAgents, "factory available");
  const entries: RecordedEntry[] = [];
  const widgets = new Map<string, string[] | undefined>();
  const flags = new Map<string, string>();
  const builtinTools = ["read", "bash", "edit", "write", "grep", "find", "ls"];

  const pi = {
    on: (event: string, handler: (event: any, ctx: any) => Promise<unknown>) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
    registerFlag: (name: string, _opts: unknown) => {
      flags.set(name, flags.get(name) ?? "");
    },
    registerCommand: (_name: string, _opts: unknown) => {},
    registerTool: (_def: unknown) => {},
    registerShortcut: (_combo: unknown, _handler: unknown) => {},
    getFlag: (name: string) => flags.get(name),
    getAllTools: () => builtinTools.map((name) => ({ name, sourceInfo: { source: "builtin" } })),
    getActiveTools: () => builtinTools.slice(),
    setActiveTools: (_names: string[]) => {},
    getThinkingLevel: () => "off",
    setThinkingLevel: (_level: string) => {},
    setModel: async (_model: unknown) => true,
    appendEntry: (customType: string, data: unknown) => {
      entries.push({ customType, data });
    },
  };

  const notifications: string[] = [];
  const ui = {
    notify: (message: string) => notifications.push(message),
    theme: { bold: (s: string) => s, fg: (_c: string, s: string) => s },
    setWidget: (key: string, content: string[] | undefined) => widgets.set(key, content),
  };
  const ctx = {
    cwd: "",
    model: undefined,
    mode: "tui",
    hasUI: true,
    ui,
    modelRegistry: { find: () => undefined, getAvailable: () => [] },
    sessionManager: {
      getEntries: () => [],
      getSessionFile: () => undefined,
      getLeafId: () => undefined,
    },
  };

  async function fireSessionStart(reason: string) {
    const list = handlers.get("session_start") ?? [];
    assert.equal(list.length, 1, "exactly one session_start handler");
    await list[0]!({ type: "session_start", reason }, ctx);
  }

  function banner(): string {
    return (widgets.get("open-agents-banner") ?? []).join("\n");
  }

  // Fresh runtime per scenario (pi re-runs the factory on reload) — register
  // handlers before firing.
  piOpenAgents!(pi as never);

  function setFlag(name: string) {
    flags.set("agent", name);
  }

  return { pi, ctx, entries, notifications, fireSessionStart, banner, setFlag };
}

// ─── Fixture workspace ───────────────────────────────────────────────────────

function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "poa-reload-"));
  const agentsDir = join(root, ".pi", "agents");
  mkdirSync(agentsDir, { recursive: true });
  const agentDir = join(root, "agent-home");
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const writeAgent = (name: string, description: string) => {
    writeFileSync(
      join(agentsDir, `${name}.agent.md`),
      `---\nname: ${name}\nmode: primary\ndescription: ${description}\n---\nBody of ${name}.\n`,
    );
  };

  return {
    root,
    writeAgent,
    removeAgent: (name: string) => rmSync(join(agentsDir, `${name}.agent.md`)),
    dispose: () => {
      rmSync(root, { recursive: true, force: true });
      delete process.env.PI_CODING_AGENT_DIR;
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

run("reload #9: startup applies the --agent flag (baseline preserved)", async () => {
  const ws = makeWorkspace();
  try {
    ws.writeAgent("rlh-alpha", "flag agent");
    const h = makeHarness();
    h.ctx.cwd = ws.root;
    h.setFlag("rlh-alpha");

    await h.fireSessionStart("startup");

    assert.deepEqual(h.entries.at(-1), { customType: "active_agent", data: { name: "rlh-alpha" } });
    assert.match(h.banner(), /rlh-alpha/);
    assert.match(h.banner(), /flag agent/);
  } finally {
    ws.dispose();
  }
});

run("reload #9: reload re-discovers definitions and keeps the USED agent, not the flag", async () => {
  const ws = makeWorkspace();
  try {
    ws.writeAgent("rlh-alpha", "flag agent");
    ws.writeAgent("rlh-beta", "desc-v1");

    // Startup with the flag: alpha applied, then the user switched to beta —
    // the session's latest state entry is beta (written each turn_start).
    const h = makeHarness();
    h.ctx.cwd = ws.root;
    h.setFlag("rlh-alpha");
    h.ctx.sessionManager.getEntries = () => [
      { type: "custom", customType: "open-agents-state", data: { name: "rlh-beta" } },
    ] as never;

    // Simulate editing the file, then /reload (fresh runtime, same harness
    // would be replaced by pi; here the same fake re-fires the handler).
    ws.writeAgent("rlh-beta", "desc-v2");
    await h.fireSessionStart("reload");

    // The USED agent wins over the startup flag…
    assert.deepEqual(h.entries.at(-1), { customType: "active_agent", data: { name: "rlh-beta" } });
    // …and the re-discovered definition carries the EDITED description.
    assert.match(h.banner(), /rlh-beta/);
    assert.match(h.banner(), /desc-v2/);
    assert.ok(!h.banner().includes("desc-v1"), "stale definition must not survive reload");
    assert.ok(!h.banner().includes("rlh-alpha"), "flag agent must not be re-applied on reload");
  } finally {
    ws.dispose();
  }
});

run("reload #9: deleted active agent falls back with a terminator, no crash", async () => {
  const ws = makeWorkspace();
  try {
    ws.writeAgent("rlh-gamma", "doomed");
    const h = makeHarness();
    h.ctx.cwd = ws.root;
    h.ctx.sessionManager.getEntries = () => [
      { type: "custom", customType: "open-agents-state", data: { name: "rlh-gamma" } },
    ] as never;

    ws.removeAgent("rlh-gamma"); // agent deleted before /reload
    await h.fireSessionStart("reload");

    assert.deepEqual(h.entries.at(-1), { customType: "active_agent", data: { name: null } });
    assert.ok(!h.banner().includes("rlh-gamma"), "no ghost agent in the banner");
  } finally {
    ws.dispose();
  }
});

run("reload #9: reload with no active agent keeps the no-agent state", async () => {
  const ws = makeWorkspace();
  try {
    ws.writeAgent("rlh-delta", "not selected");
    const h = makeHarness();
    h.ctx.cwd = ws.root;
    h.ctx.sessionManager.getEntries = () => [] as never; // nothing ever applied

    await h.fireSessionStart("reload");

    assert.deepEqual(h.entries, []); // no announcement, no application
    assert.ok(h.banner().includes("/agent") || h.banner().length === 0, "no-agent hint");
    assert.ok(!h.banner().includes("rlh-delta"), "must not auto-apply agents on reload");
  } finally {
    ws.dispose();
  }
});
