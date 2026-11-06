/**
 * Tests for subagent model provider retention (issue #27).
 *
 * The progress header and `AgentResult.model` started life as the
 * `provider/model` string from the agent definition, but the first assistant
 * `message_end` overwrote it with the bare `message.model` — dropping the
 * provider with no way to tell which of several providers actually ran.
 * `modelFromMessage` now returns `provider/model` when the message carries a
 * provider (it always does: `AssistantMessage.provider` is required), keeps
 * the bare id otherwise, and never double-prefixes an already-qualified id.
 *
 * These tests drive `runSubagent` with a fake runner replaying synthetic
 * event streams — no child process, no LLM cost. The optional peer dependency
 * handling mirrors the other executor suites (skip in publish CI).
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

const baseAgent: AgentDefinition = {
  name: "explorer",
  mode: "subagent",
  hidden: true,
  disable: false,
  thinking: "off",
  systemPrompt: "replace",
  maxDepth: 1,
  prompt: "You are an explorer subagent.",
  source: "project",
  filePath: "/tmp/explorer.agent.md",
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

function makeRunner(events: object[]): ProcessRunner {
  return async (_invocation, handlers) => {
    for (const e of events) handlers.stdout(JSON.stringify(e) + "\n");
    return { exitCode: 0 };
  };
}

async function runWith(
  events: object[],
  onProgress?: (progress: { model?: string }) => void,
) {
  return runSubagent!({
    agent: baseAgent,
    task: "explore",
    cwd: process.cwd(),
    runner: makeRunner(events),
    fs: fakeFs,
    resolvePi: fakeResolvePi,
    ...(onProgress ? { onProgress: onProgress as never } : {}),
  });
}

// ─── Criterion 1: provider survives the first reply ──────────────────────────

run("#27: message_end with provider keeps provider/model in progress and result", async () => {
  const seen: Array<string | undefined> = [];
  const result = await runWith(
    [
      { type: "message_end", message: { role: "user", content: [{ type: "text", text: "Task: explore" }] } },
      {
        type: "message_end",
        message: {
          role: "assistant",
          provider: "custom-gateway",
          model: "claude-sonnet-4-5",
          content: [{ type: "text", text: "done" }],
          usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0.001 } },
        },
      },
      {
        type: "agent_end",
        messages: [
          { role: "user", content: [{ type: "text", text: "Task: explore" }] },
          { role: "assistant", provider: "custom-gateway", model: "claude-sonnet-4-5" },
        ],
      },
    ],
    (p) => {
      seen.push(p.model);
    },
  );

  assert.equal(result.model, "custom-gateway/claude-sonnet-4-5");
  assert.ok(
    seen.includes("custom-gateway/claude-sonnet-4-5"),
    `progress updates must carry the qualified model, saw: ${JSON.stringify(seen)}`,
  );
  // Usage still flows through the same messages (criterion 4).
  assert.equal(result.usage.input, 10);
  assert.equal(result.usage.output, 5);
});

// ─── Criterion 2: agent_end path (lastAssistantModel) ────────────────────────

run("#27: agent_end alone qualifies the final model even if message_end had none", async () => {
  const result = await runWith([
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
      },
    },
    {
      type: "agent_end",
      messages: [
        { role: "assistant", provider: "direct", model: "gpt-x" },
      ],
    },
  ]);
  assert.equal(result.model, "direct/gpt-x");
});

// ─── Criterion 3: no double prefix; namespaced ids round-trip ───────────────

run("#27: already-qualified id is not double-prefixed", async () => {
  const result = await runWith([
    {
      type: "message_end",
      message: {
        role: "assistant",
        provider: "openrouter",
        model: "openrouter/anthropic/claude-opus-5.5",
        content: [{ type: "text", text: "done" }],
      },
    },
    { type: "agent_end", messages: [] },
  ]);
  assert.equal(result.model, "openrouter/anthropic/claude-opus-5.5");
});

run("#27: namespaced model id under a provider round-trips the frontmatter format", async () => {
  // agent `model: openrouter/anthropic/claude-opus-5.5` → requested as
  // provider=openrouter + model=anthropic/claude-opus-5.5; the child's reply
  // must reassemble exactly the frontmatter string (cf. #16 first-slash split).
  const result = await runWith([
    {
      type: "message_end",
      message: {
        role: "assistant",
        provider: "openrouter",
        model: "anthropic/claude-opus-5.5",
        content: [{ type: "text", text: "done" }],
      },
    },
    { type: "agent_end", messages: [] },
  ]);
  assert.equal(result.model, "openrouter/anthropic/claude-opus-5.5");
});

// ─── Non-provider messages keep the legacy bare id ───────────────────────────

run("#27 non-regression: message without provider keeps the bare id", async () => {
  const result = await runWith([
    {
      type: "message_end",
      message: {
        role: "assistant",
        model: "test/model",
        content: [{ type: "text", text: "done" }],
      },
    },
    { type: "agent_end", messages: [] },
  ]);
  assert.equal(result.model, "test/model");
});

run("#27 non-regression: message without any model keeps the agent definition default", async () => {
  const agentWithModel: AgentDefinition = { ...baseAgent, model: "prov/default-model" };
  const result = await runSubagent!({
    agent: agentWithModel,
    task: "explore",
    cwd: process.cwd(),
    runner: makeRunner([
      {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      },
      { type: "agent_end", messages: [] },
    ]),
    fs: fakeFs,
    resolvePi: fakeResolvePi,
  });
  assert.equal(result.model, "prov/default-model");
});
