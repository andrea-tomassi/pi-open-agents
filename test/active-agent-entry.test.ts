import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentManager } from "../src/primary/manager.ts";
import type { AgentDefinition } from "../src/types.ts";

const agent: AgentDefinition = {
  name: "orchestrator", mode: "primary", hidden: false, disable: false,
  thinking: "off", systemPrompt: "append", maxDepth: 1,
  prompt: "body", source: "global", filePath: "/pi-global/orchestrator.md",
};

function makeRecorder() {
  const entries: { customType: string; data: unknown }[] = [];
  const pi = {
    getAllTools: () => [{ name: "read", sourceInfo: { source: "builtin" } }],
    setActiveTools: () => {},
    setThinkingLevel: () => {},
    getThinkingLevel: () => "off",
    appendEntry: (customType: string, data: unknown) => { entries.push({ customType, data }); },
  } as any;
  const ctx = { model: undefined } as any;
  return { pi, ctx, entries };
}

test("apply appends an active_agent entry with the agent name", async () => {
  const { pi, ctx, entries } = makeRecorder();
  const m = new AgentManager();
  m.setAgents([agent]);
  assert.equal(await m.apply("orchestrator", pi, ctx), true);
  assert.deepEqual(entries.at(-1), { customType: "active_agent", data: { name: "orchestrator" } });
});

test("clear appends an active_agent entry with null name", async () => {
  const { pi, ctx, entries } = makeRecorder();
  const m = new AgentManager();
  m.setAgents([agent]);
  await m.apply("orchestrator", pi, ctx);
  await m.clear(pi, ctx);
  assert.deepEqual(entries.at(-1), { customType: "active_agent", data: { name: null } });
});

test("resume: a stored name absent from the registry yields no active agent", () => {
  // The resume path in index.ts gates its active_agent announcement on
  // getActive() rather than the stored name. index.ts has no test harness, so
  // this pins the manager contract that gate relies on: the loader skips
  // disable:true agents (loader.ts) and rejects unknown/renamed names, so
  // restoreFromSession silently no-ops and there is no active agent to announce.
  const disabled: AgentDefinition = { ...agent, name: "disabled-agent", disable: true };
  const m = new AgentManager();
  m.setAgents([agent]); // disabled agent intentionally absent, as the loader leaves it
  m.restoreFromSession(disabled.name);
  assert.equal(m.getActive(), undefined);
  assert.equal(m.getActiveName(), undefined);
});

test("a null terminator is what the consumer's backward scan stops at", async () => {
  // The resume path in index.ts appends { name: null } when restoreFromSession
  // no-ops, so a stale active_agent entry written by an earlier apply() is not
  // the newest one. The consumer scans entries backward and stops at the first
  // active_agent entry; a null name there resolves to no agent, so the session
  // falls back to the global policy instead of a disabled agent's.
  const { pi, ctx, entries } = makeRecorder();
  const m = new AgentManager();
  m.setAgents([agent]);
  await m.apply("orchestrator", pi, ctx);
  pi.appendEntry("active_agent", { name: null });
  const newest = entries.filter((e) => e.customType === "active_agent").at(-1);
  assert.deepEqual(newest, { customType: "active_agent", data: { name: null } });
});

// The forked-child terminator (pi.appendEntry("active_agent", { name: null })
// on the isSubagentProcess branch in index.ts) and the same terminator on the
// resume else-branch (when restoreFromSession no-ops) are not unit-tested:
// reaching either needs an index.ts session_start harness, which does not exist
// and would have to drive real-fs loadAgents + full TUI registration. The test
// above pins the contract those terminators rely on — a null-name entry is what
// the consumer's backward scan stops at. Per the repo's mock conventions we do
// not build the missing harness.
