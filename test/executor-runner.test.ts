/**
 * Regression coverage for the "subagent hangs after finishing" bug.
 *
 * The child pi process finishes its answer, but a grandchild it spawned and left behind (an
 * MCP server, an extension host, a detached local model server) keeps the child's stdout/stderr
 * descriptors open. Node then fires `close` minutes or hours after `exit`, so a runner that
 * waits only on `close` looks hung until the user presses escape. The runner must therefore
 * settle on `exit` once the output has had a moment to drain.
 *
 * Each case runs real processes: a child shell that writes, then spawns a sleeper inheriting
 * stdout, then exits.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

const runnerModule = (await import("../src/subagent/executor.ts")) as {
  defaultRunner?: (
    invocation: { command: string; args: string[]; cwd: string; env: Record<string, string> },
    handlers: { stdout: (chunk: string) => void; stderr: (chunk: string) => void },
    signal?: AbortSignal,
  ) => Promise<{ exitCode: number }>;
};

const runner = runnerModule.defaultRunner;

/** Writes a line, leaves a sleeper holding stdout for `seconds`, then exits with `code`. */
function invocationWithLeftover(seconds: number, code = 0) {
  const script = `printf 'finished'; sleep ${seconds} & exit ${code}`;
  return { command: "sh", args: ["-c", script], cwd: process.cwd(), env: { ...process.env } as Record<string, string> };
}

test("settles on exit even when a leftover descendant keeps stdout open", { skip: !runner }, async () => {
  const started = Date.now();
  let output = "";
  const result = await runner!(invocationWithLeftover(120), {
    stdout: (chunk) => (output += chunk),
    stderr: () => {},
  });
  const elapsed = Date.now() - started;

  assert.equal(result.exitCode, 0, "reports the child exit code");
  assert.match(output, /finished/, "keeps the output written before exit");
  // The sleeper holds stdout for two minutes; without the fix this resolves only when it dies.
  assert.ok(elapsed < 15000, `resolved in ${elapsed}ms, not after the descendant exited`);
});

test("passes a non-zero exit code through", { skip: !runner }, async () => {
  const result = await runner!(invocationWithLeftover(60, 7), { stdout: () => {}, stderr: () => {} });
  assert.equal(result.exitCode, 7);
});

test("a child that exits promptly is unaffected by the grace timer", { skip: !runner }, async () => {
  const started = Date.now();
  const result = await runner!(
    { command: "sh", args: ["-c", "printf hello"], cwd: process.cwd(), env: { ...process.env } as Record<string, string> },
    { stdout: () => {}, stderr: () => {} },
  );
  const elapsed = Date.now() - started;
  assert.equal(result.exitCode, 0);
  assert.ok(elapsed < 1500, `no artificial delay: ${elapsed}ms`);
});

test("an aborted run still resolves through the runner", { skip: !runner }, async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);
  const started = Date.now();
  const result = await runner!(
    {
      command: "sh",
      args: ["-c", "sleep 30; exit 0"],
      cwd: process.cwd(),
      env: { ...process.env } as Record<string, string>,
    },
    { stdout: () => {}, stderr: () => {} },
    controller.signal,
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 10000, `abort ends the wait: ${elapsed}ms`);
  // A signal-killed child reports `code === null`; the runner has always mapped that to 0
  // (`code ?? 0`), so the assertion here is only that the wait ends promptly.
  assert.equal(typeof result.exitCode, "number");
});
