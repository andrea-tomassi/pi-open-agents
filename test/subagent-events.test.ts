/**
 * Regression coverage for the pi 0.83.0 JSON event-stream change.
 *
 * pi 0.83.0 emits a `message_end` event for EVERY message role (user,
 * assistant, toolResult) — previously only the assistant message_end was
 * emitted. The executor must capture text/usage/model only from
 * `role === "assistant"` messages, otherwise the echoed user task ("Task: …")
 * and raw tool results leak into the subagent output.
 *
 * These tests drive `runSubagent` end-to-end with an injected fake runner that
 * replays a captured 0.83.0 event stream, so no real child pi process is
 * spawned. `executor.ts` imports the optional peer dependency
 * `@earendil-works/pi-coding-agent` at module load; we skip gracefully when it
 * is absent (publish CI) and run wherever it is present (local dev).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { AgentDefinition } from "../src/types.ts";
import type { ProcessRunner, ExecutorFs, PiResolution } from "../src/subagent/executor.ts";

type RunSubagent = typeof import("../src/subagent/executor.ts").runSubagent;

let runSubagent: RunSubagent | undefined;
try {
  ({ runSubagent } = await import("../src/subagent/executor.ts"));
} catch {
  runSubagent = undefined;
}

const run = runSubagent ? test : test.skip;

// ─── Fixtures ────────────────────────────────────────────────────────────────

const baseAgent: AgentDefinition = {
  name: "worker",
  mode: "subagent",
  hidden: true,
  disable: false,
  thinking: "off",
  systemPrompt: "replace",
  maxDepth: 1,
  prompt: "You are a worker subagent.",
  source: "project",
  filePath: "/tmp/worker.agent.md",
};

const fakeFs: ExecutorFs = {
  makeTempDir: async () => "/tmp/fake-subagent",
  writeFile: async () => {},
  removeDir: async () => {},
};

const fakeResolvePi = async (): Promise<PiResolution> => ({
  command: "node",
  entryPoint: "/fake/cli.js",
});

/** Build a runner that replays a captured event stream to the stdout handler. */
function makeRunner(events: object[]): ProcessRunner {
  return async (_invocation, handlers) => {
    for (const e of events) handlers.stdout(JSON.stringify(e) + "\n");
    return { exitCode: 0 };
  };
}

async function runWith(events: object[]) {
  return runSubagent!({
    agent: baseAgent,
    task: "Task: read foo and summarize",
    cwd: process.cwd(),
    runner: makeRunner(events),
    fs: fakeFs,
    resolvePi: fakeResolvePi,
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

run("message_end: captures the assistant answer despite user/toolResult echoes (0.83.0)", async () => {
  // Mirrors a real 0.83.0 stream: user task echo, a tool-call assistant turn,
  // a toolResult echo, then the final assistant text answer.
  const result = await runWith([
    { type: "session", path: "/s", id: "s1" },
    { type: "agent_start" },
    { type: "entry_appended" },
    { type: "turn_start" },
    { type: "message_start" },
    { type: "message_end", message: { role: "user", content: [{ type: "text", text: "Task: read foo and summarize" }] } },
    { type: "turn_start" },
    { type: "message_start" },
    { type: "message_end", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] } },
    { type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: {} },
    { type: "tool_execution_end", toolCallId: "t1" },
    { type: "message_start" },
    { type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "RAW FILE CONTENTS" }] } },
    { type: "turn_end" },
    { type: "turn_start" },
    { type: "message_start" },
    {
      type: "message_end",
      message: {
        role: "assistant",
        model: "test/model",
        content: [{ type: "text", text: "It is written in Python." }],
        usage: { totalTokens: 50, cost: { total: 0.001 } },
      },
    },
    { type: "turn_end" },
    {
      type: "agent_end",
      messages: [
        { role: "user", content: [{ type: "text", text: "Task: read foo and summarize" }] },
        { role: "assistant", model: "test/model", usage: { totalTokens: 50, cost: { total: 0.001 } } },
      ],
    },
  ]);

  assert.equal(result.output, "It is written in Python.");
  assert.equal(result.isError, false);
  assert.equal(result.model, "test/model");
});

run("message_end: does not echo the task/toolResult when the final assistant turn has no text (0.83.0 regression)", async () => {
  // The agent's final assistant turn carries only a thinking part (no text).
  // Before the fix, output leaked the last text-bearing message_end — the
  // toolResult "RAW FILE CONTENTS" (or the echoed task). With the role guard,
  // output stays empty instead of leaking request/tool data to the parent.
  const result = await runWith([
    { type: "session", path: "/s", id: "s1" },
    { type: "agent_start" },
    { type: "entry_appended" },
    { type: "turn_start" },
    { type: "message_start" },
    { type: "message_end", message: { role: "user", content: [{ type: "text", text: "Task: read foo and summarize" }] } },
    { type: "turn_start" },
    { type: "message_start" },
    { type: "message_end", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] } },
    { type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: {} },
    { type: "tool_execution_end", toolCallId: "t1" },
    { type: "message_start" },
    { type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "RAW FILE CONTENTS" }] } },
    { type: "turn_end" },
    { type: "turn_start" },
    { type: "message_start" },
    { type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "done" }] } },
    { type: "turn_end" },
    {
      type: "agent_end",
      messages: [
        { role: "user", content: [{ type: "text", text: "Task: read foo and summarize" }] },
        { role: "assistant", model: "test/model", usage: { totalTokens: 50, cost: { total: 0.001 } } },
      ],
    },
  ]);

  assert.notEqual(result.output, "Task: read foo and summarize", "must not echo the user task");
  assert.notEqual(result.output, "RAW FILE CONTENTS", "must not leak raw tool output");
  assert.equal(result.output, "", "no assistant text produced → empty output, not leaked data");
});
