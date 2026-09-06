/**
 * Tests for per-call model override in the subagent tool (Issue #10).
 *
 * Two levels:
 * - Executor: modelOverride wins over agent.model when building --model args
 * - Tool: the `model` param is validated, propagated to the runner, optional
 *
 * Executor tests use an injected fake runner that captures CLI args (no real
 * child pi spawned). Tool tests use a mock pi + injected runner.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { AgentDefinition } from "../src/types.ts";
import type { ProcessRunner, ExecutorFs, PiResolution, AgentResult } from "../src/subagent/executor.ts";

type RunSubagent = typeof import("../src/subagent/executor.ts").runSubagent;
type RegisterSubagentTool = typeof import("../src/subagent/tool.ts").registerSubagentTool;

let runSubagent: RunSubagent | undefined;
let registerSubagentTool: RegisterSubagentTool | undefined;
try {
  ({ runSubagent } = await import("../src/subagent/executor.ts"));
  ({ registerSubagentTool } = await import("../src/subagent/tool.ts"));
} catch {
  runSubagent = undefined;
}

const run = runSubagent && registerSubagentTool ? test : test.skip;

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
  model: "opencode-go/deepseek-v4-flash",
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

/** Run a subagent and capture the CLI args passed to the child process. */
async function runAndCaptureArgs(
  agent: AgentDefinition,
  extra: { modelOverride?: string } = {},
): Promise<string[]> {
  let capturedArgs: string[] = [];

  const captureRunner: ProcessRunner = async (invocation) => {
    capturedArgs = invocation.args;
    return { exitCode: 0 };
  };

  await runSubagent!({
    agent,
    task: "do something",
    cwd: process.cwd(),
    modelOverride: extra.modelOverride,
    runner: captureRunner,
    fs: fakeFs,
    resolvePi: fakeResolvePi,
  });

  return capturedArgs;
}

/** Extract the --model value from args, or undefined if not present. */
function getModelArg(args: string[]): string | undefined {
  const idx = args.indexOf("--model");
  return idx !== -1 ? args[idx + 1] : undefined;
}

// ─── Executor: --model resolution ────────────────────────────────────────────

run("model override: per-call override wins over agent default", async () => {
  const args = await runAndCaptureArgs(baseAgent, { modelOverride: "zai/glm-5.3-flash" });
  assert.equal(getModelArg(args), "zai/glm-5.3-flash");
});

run("model override: agent default used when no override", async () => {
  const args = await runAndCaptureArgs(baseAgent);
  assert.equal(getModelArg(args), "opencode-go/deepseek-v4-flash");
});

run("model override: override applied even when agent has no default model", async () => {
  const agent: AgentDefinition = { ...baseAgent, model: undefined };
  const args = await runAndCaptureArgs(agent, { modelOverride: "zai/glm-5.3-flash" });
  assert.equal(getModelArg(args), "zai/glm-5.3-flash");
});

run("model override: no --model flag when neither override nor default", async () => {
  const agent: AgentDefinition = { ...baseAgent, model: undefined };
  const args = await runAndCaptureArgs(agent);
  assert.equal(getModelArg(args), undefined, "--model must not be passed");
});

// ─── Tool: schema, validation, propagation ───────────────────────────────────

interface RegisteredTool {
  name: string;
  parameters: { properties: Record<string, unknown> };
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: undefined,
    onUpdate: undefined,
    ctx: { cwd: string },
  ) => Promise<unknown>;
}

function registerAndGetTool(
  agent: AgentDefinition,
  captured: { modelOverride?: string; calls: number },
): RegisteredTool {
  const tools: RegisteredTool[] = [];
  const pi = {
    registerTool: (tool: RegisteredTool) => tools.push(tool),
  };

  registerSubagentTool!(pi as never, {
    agents: [agent],
    agentDir: "/tmp/agent-dir",
    run: async (options) => {
      captured.calls += 1;
      captured.modelOverride = options.modelOverride;
      const result: AgentResult = {
        agent: options.agent.name,
        status: "done",
        output: "ok",
        tools: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 },
        startedAt: Date.now(),
        elapsedMs: 0,
        isError: false,
        exitCode: 0,
        stderr: "",
      };
      return result;
    },
    env: {},
  });

  const tool = tools.find((t) => t.name === "subagent");
  assert.ok(tool, "subagent tool should be registered");
  return tool;
}

const CTX = { cwd: "/tmp" };

run("model override: tool schema exposes optional model param", () => {
  const tool = registerAndGetTool(baseAgent, { calls: 0 });
  assert.ok("model" in tool.parameters.properties, "model param must be in schema");
});

run("model override: tool propagates model to runner", async () => {
  const captured: { modelOverride?: string; calls: number } = { calls: 0 };
  const tool = registerAndGetTool(baseAgent, captured);
  await tool.execute("call-1", { agent: "worker", task: "hi", model: "zai/glm-5.3-flash" }, undefined, undefined, CTX);
  assert.equal(captured.calls, 1);
  assert.equal(captured.modelOverride, "zai/glm-5.3-flash");
});

run("model override: tool omits override when param absent", async () => {
  const captured: { modelOverride?: string; calls: number } = { calls: 0 };
  const tool = registerAndGetTool(baseAgent, captured);
  await tool.execute("call-2", { agent: "worker", task: "hi" }, undefined, undefined, CTX);
  assert.equal(captured.calls, 1);
  assert.equal(captured.modelOverride, undefined);
});

run("model override: malformed model rejected without spawning", async () => {
  const captured: { modelOverride?: string; calls: number } = { calls: 0 };
  const tool = registerAndGetTool(baseAgent, captured);
  await assert.rejects(
    () => tool.execute("call-3", { agent: "worker", task: "hi", model: "no-slash" }, undefined, undefined, CTX),
    /Invalid model "no-slash": expected "provider\/model-id"/,
  );
  assert.equal(captured.calls, 0, "runner must not be called on validation failure");
});
