/**
 * Tests for the file + summary result contract (issue #32).
 *
 * Every subagent run archives its verbatim output to a temp file and returns
 * only the child's closing outcome block inline (mechanics inspired by
 * @EduardoOrtiz89's fork `output`/`outputMode`, redesigned as the default
 * instead of an opt-in). Without the outcome block (older agents, error
 * paths) the executor falls back to today's truncated inline.
 *
 * Drives `runSubagent` with a fake runner replaying synthetic event streams
 * and a fake fs capturing writes — no child process, no LLM cost.
 * Peer-dependency handling mirrors the other suites (skip in publish CI).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { AgentDefinition } from "../src/types.ts";
import type {
  ProcessRunner,
  ExecutorFs,
  PiResolution,
} from "../src/subagent/executor.ts";

type ExecutorModule = typeof import("../src/subagent/executor.ts");
type PromptModule = typeof import("../src/subagent/prompt.ts");
type ToolModule = typeof import("../src/subagent/tool.ts");

let executor: ExecutorModule | undefined;
let promptMod: PromptModule | undefined;
let toolMod: ToolModule | undefined;
try {
  executor = await import("../src/subagent/executor.ts");
  promptMod = await import("../src/subagent/prompt.ts");
  toolMod = await import("../src/subagent/tool.ts");
} catch {
  executor = undefined;
}

const run = executor && promptMod && toolMod ? test : test.skip;

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

const fakeResolvePi = async (): Promise<PiResolution> => ({
  command: "node",
  entryPoint: "/fake/cli.js",
});

interface CapturingFs extends ExecutorFs {
  written: Map<string, string>;
  failWrites: boolean;
}

function makeFs(): CapturingFs {
  const written = new Map<string, string>();
  const fs: CapturingFs = {
    written,
    failWrites: false,
    makeTempDir: async () => "/fake/tmp",
    writeFile: async (p, content) => {
      if (fs.failWrites) throw new Error("disk full");
      written.set(p, content);
    },
    removeDir: async () => {},
  };
  return fs;
}

function makeRunner(events: object[]): { runner: ProcessRunner; seenArgs: string[][] } {
  const seenArgs: string[][] = [];
  const runner: ProcessRunner = async (invocation, handlers) => {
    seenArgs.push(invocation.args);
    for (const e of events) handlers.stdout(JSON.stringify(e) + "\n");
    return { exitCode: 0 };
  };
  return { runner, seenArgs };
}

function assistantEvent(text: string, extra: Record<string, unknown> = {}) {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      usage: { input: 1, output: 1, totalTokens: 2 },
      ...extra,
    },
  };
}

// ─── Outcome block extraction ────────────────────────────────────────────────

run("#32: extractOutcomeBlock takes text after the last marker", () => {
  const { extractOutcomeBlock } = executor!;
  assert.equal(
    extractOutcomeBlock("body\n## Outcome\nOutcome: done\nDetails: fine"),
    "Outcome: done\nDetails: fine",
  );
  assert.equal(extractOutcomeBlock("## outcome\nOutcome: x"), "Outcome: x");
  assert.equal(extractOutcomeBlock("body\n  ## Outcome  \nOutcome: x\n"), "Outcome: x");
  assert.equal(
    extractOutcomeBlock("a\n## Outcome\nfirst\n## Outcome\nOutcome: last"),
    "Outcome: last",
  );
});

run("#32: extractOutcomeBlock degrades to undefined without a usable block", () => {
  const { extractOutcomeBlock } = executor!;
  assert.equal(extractOutcomeBlock("plain body, no marker"), undefined);
  assert.equal(extractOutcomeBlock("body\n## Outcome"), undefined);
  assert.equal(extractOutcomeBlock("body\n## Outcome\n   \n"), undefined);
});

// ─── Closing contract text ───────────────────────────────────────────────────

run("#32: closing contract names the marker and cites the deliverable path", () => {
  const { buildClosingContract } = promptMod!;
  const plain = buildClosingContract();
  assert.ok(plain.includes("## Outcome"));
  assert.ok(plain.includes("never hide an error"));
  assert.ok(!plain.includes("/x/y.md"));
  const withPath = buildClosingContract("/proj/report.md");
  assert.ok(withPath.includes("`/proj/report.md`"));
});

// ─── File + summary result ───────────────────────────────────────────────────

run("#32: outcome block becomes the inline result, full text goes to the archive", async () => {
  const body = Array.from({ length: 20 }, (_, i) => `transcript line ${i}`).join("\n");
  const full = `${body}\n## Outcome\nOutcome: report ready\nDetails: 12 findings, see file`;
  const fs = makeFs();
  const { runner } = makeRunner([assistantEvent(full), { type: "agent_end", messages: [] }]);

  const result = await executor!.runSubagent({
    agent: baseAgent,
    task: "explore",
    cwd: process.cwd(),
    runner,
    fs,
    resolvePi: fakeResolvePi,
    outputArchiveDir: "/fake/archive",
  });

  assert.ok(result.output.startsWith("Outcome: report ready"), `inline must be the outcome, got: ${result.output.slice(0, 60)}`);
  assert.ok(result.output.includes("Full output: /fake/archive/"), "inline must reference the archive");
  assert.ok(!result.output.includes("transcript line 5"), "body must not leak inline");
  const archives = [...fs.written.entries()].filter(([p]) => p.startsWith("/fake/archive/"));
  assert.equal(archives.length, 1, "exactly one archive file");
  assert.equal(archives[0]![1], full, "archive holds the verbatim full output");
});

run("#32: missing marker falls back to truncated inline + archive note", async () => {
  const long = Array.from({ length: 3000 }, (_, i) => `line ${i} with padding text to grow bytes`).join("\n");
  const fs = makeFs();
  const { runner } = makeRunner([assistantEvent(long), { type: "agent_end", messages: [] }]);

  const result = await executor!.runSubagent({
    agent: baseAgent,
    task: "explore",
    cwd: process.cwd(),
    runner,
    fs,
    resolvePi: fakeResolvePi,
    outputArchiveDir: "/fake/archive",
  });

  assert.ok(result.output.includes("[Output truncated:"), "long output still truncates");
  assert.ok(result.output.includes("Full output: /fake/archive/"), "note points at the archive");
  const archives = [...fs.written.entries()].filter(([p]) => p.startsWith("/fake/archive/"));
  assert.equal(archives[0]![1], long, "archive holds the full untruncated output");
});

run("#32: tiny output without marker stays fully inline (plus archive)", async () => {
  const fs = makeFs();
  const { runner } = makeRunner([assistantEvent("short answer"), { type: "agent_end", messages: [] }]);

  const result = await executor!.runSubagent({
    agent: baseAgent,
    task: "explore",
    cwd: process.cwd(),
    runner,
    fs,
    resolvePi: fakeResolvePi,
    outputArchiveDir: "/fake/archive",
  });

  assert.equal(result.output, "short answer");
  assert.equal([...fs.written.entries()].filter(([p]) => p.startsWith("/fake/archive/")).length, 1);
});

// ─── Commissioned deliverable ────────────────────────────────────────────────

run("#32: outputPath is injected into the child task and prompt", async () => {
  const fs = makeFs();
  const { runner, seenArgs } = makeRunner([
    assistantEvent("did it\n## Outcome\nOutcome: done\nDetails: see file"),
    { type: "agent_end", messages: [] },
  ]);

  await executor!.runSubagent({
    agent: baseAgent,
    task: "write the report",
    cwd: "/proj",
    runner,
    fs,
    resolvePi: fakeResolvePi,
    outputArchiveDir: "/fake/archive",
    outputPath: "report.md",
  });

  const taskArg = seenArgs[0]!.at(-1)!;
  assert.ok(taskArg.includes("/proj/report.md"), `task must name the resolved deliverable path, got: ${taskArg.slice(0, 120)}`);
  const promptFile = fs.written.get("/fake/tmp/system-prompt.md")!;
  assert.ok(promptFile.includes("`/proj/report.md`"), "system prompt must carry the closing contract with path");
  assert.ok(promptFile.includes("## Result Contract"), "system prompt must carry the closing contract");
});

// ─── Robustness ──────────────────────────────────────────────────────────────

run("#32: archive write failure degrades to inline-only without throwing", async () => {
  const fs = makeFs();
  const realWrite = fs.writeFile;
  fs.writeFile = async (p, content) => {
    // Only the archive write fails — the prompt must still land, otherwise
    // nothing could run at all. That is exactly the production guarantee:
    // a failed temp archive never breaks delegation.
    if (p.startsWith("/fake/archive/")) throw new Error("disk full");
    return realWrite(p, content);
  };
  const { runner } = makeRunner([
    assistantEvent("body\n## Outcome\nOutcome: done"),
    { type: "agent_end", messages: [] },
  ]);

  const result = await executor!.runSubagent({
    agent: baseAgent,
    task: "explore",
    cwd: process.cwd(),
    runner,
    fs,
    resolvePi: fakeResolvePi,
    outputArchiveDir: "/fake/archive",
  });

  assert.equal(result.isError, false, "delegation must not fail over an archive write");
  assert.ok(result.output.includes("Outcome: done"));
});

run("#32: failing child keeps the error inline", async () => {
  const fs = makeFs();
  const failingRunner: ProcessRunner = async (invocation, handlers) => {
    handlers.stdout(JSON.stringify(assistantEvent("partial work")) + "\n");
    handlers.stderr("boom: something failed\n");
    return { exitCode: 1 };
  };

  const result = await executor!.runSubagent({
    agent: baseAgent,
    task: "explore",
    cwd: process.cwd(),
    runner: failingRunner,
    fs,
    resolvePi: fakeResolvePi,
    outputArchiveDir: "/fake/archive",
  });

  assert.equal(result.isError, true);
  assert.ok(result.output.includes("partial work"), "error output stays inline");
});

// ─── Live progress cap ─────────────────────────────────────────────────────

run("#32 cap: tailTextByBytes keeps short text, tails long text", () => {
  const { tailTextByBytes, LIVE_PROGRESS_MAX_BYTES } = toolMod!;
  assert.equal(tailTextByBytes("short", LIVE_PROGRESS_MAX_BYTES), "short");
  const long = `${"x".repeat(5000)}-TAIL`;
  const tailed = tailTextByBytes(long, 100);
  assert.ok(tailed.endsWith("-TAIL"), "tail keeps the end");
  assert.ok(tailed.length <= 100, `tail stays in budget, got ${tailed.length}`);
  assert.ok(tailTextByBytes("héllo-wörld-ünïcödé", 1000).endsWith("ünïcödé"), "multibyte-safe");
});

run("#32 cap: live updates carry the tail, final result stays whole", async () => {
  const { registerSubagentTool } = toolMod!;
  const body = Array.from({ length: 200 }, (_, i) => `transcript line ${i} with padding`).join("\n");
  const fullWithOutcome = `${body}\n## Outcome\nOutcome: done\nDetails: fine`;
  const emptyUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 };
  // Fake the executor: emit growing progress like a long run, then resolve
  // with the full output (the archive split happens in the real runSubagent,
  // covered by the tests above — here only the live-update path matters).
  const fakeRun = async (opts: { onProgress?: (p: never) => void }) => {
    for (let i = 1; i <= 3; i++) {
      opts.onProgress?.({
        agent: "worker", status: "running", output: body.slice(0, Math.floor((body.length * i) / 3)),
        tools: [], usage: { ...emptyUsage }, startedAt: 0, elapsedMs: 0,
      } as never);
    }
    return {
      agent: "worker", status: "done", output: fullWithOutcome, tools: [],
      usage: { ...emptyUsage }, startedAt: 0, elapsedMs: 0,
      isError: false, exitCode: 0, stderr: "",
    };
  };
  const updates: string[] = [];
  let capturedExecute: ((params: unknown, ctx: unknown) => Promise<unknown>) | undefined;
  const fakePi = {
    registerTool: (def: { execute: (t: string, p: unknown, s: unknown, u: unknown, c: unknown) => Promise<unknown> }) => {
      capturedExecute = (p, c) =>
        def.execute("id", p, undefined, (r: { content: Array<{ text: string }> }) => {
          updates.push(r.content[0]!.text);
        }, c);
    },
  };
  registerSubagentTool(fakePi as never, { agents: [baseAgent], run: fakeRun } as never);
  const final = (await capturedExecute!(
    { agent: "worker", task: "t" },
    { cwd: process.cwd() },
  )) as { content: Array<{ text: string }> };
  const finalContent = final.content[0]!.text;
  assert.ok(updates.length === 3, `expected 3 live updates, got ${updates.length}`);
  for (const u of updates) {
    assert.ok(
      u.length <= 2048 + 40,
      `live update capped, got ${u.length} chars`,
    );
  }
  assert.ok(
    updates.some((u) => u.includes("[…earlier live output omitted…]")),
    "long run marks the omission",
  );
  assert.ok(finalContent.includes("Outcome: done"), "final result keeps the whole outcome");
  assert.ok(finalContent.includes("transcript line 0"), "final result is NOT capped (archive split happens upstream)");
});
