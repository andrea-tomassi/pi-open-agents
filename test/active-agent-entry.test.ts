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
