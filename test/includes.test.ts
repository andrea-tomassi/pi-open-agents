/**
 * Tests for body-level include directive resolution in the loader.
 *
 * Directives of the form `include: "path"`, `include: 'path'`, or
 * `include: path` on their own line are replaced by the referenced file's
 * content, resolved relative to the directory of the file containing the
 * directive. Recursive, cycle-safe, depth-capped, fail-soft.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadAgents } from "../src/discovery/loader.ts";
import type { AgentFs, AgentLoadResult } from "../src/types.ts";

// ─── Test Filesystem ─────────────────────────────────────────────────────────

/**
 * Mock fs backed by an in-memory map. Unlike loader.test.ts's mock, readFile
 * throws for missing files so the fail-soft include path is exercised.
 */
function makeMockFs(files: Record<string, string>): AgentFs {
  return {
    async listFiles(dir: string): Promise<string[]> {
      return Object.keys(files)
        .filter((f) => f.startsWith(dir + "/") && f.endsWith(".md"))
        .sort();
    },

    async readFile(filePath: string): Promise<string> {
      if (!(filePath in files)) {
        throw new Error(`ENOENT: no such file: ${filePath}`);
      }
      return files[filePath];
    },

    async exists(dir: string): Promise<boolean> {
      return Object.keys(files).some((f) => f.startsWith(dir + "/"));
    },
  };
}

/** Capture stderr (console.error) while running fn. */
async function captureStderr(fn: () => Promise<void>): Promise<string[]> {
  const captured: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    captured.push(args.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return captured;
}

async function loadOne(fs: AgentFs): Promise<AgentLoadResult> {
  return loadAgents({
    fs,
    paths: [{ dir: "/global", source: "global", family: "pi", subdirs: [""] }],
  });
}

// ─── Basic Resolution ────────────────────────────────────────────────────────

test("include: single directive is replaced by file content", async () => {
  const fs = makeMockFs({
    "/global/agent.md": `---
name: agent
mode: subagent
---
Intro line
include: "_faq.prompt.txt"
Outro line`,
    "/global/_faq.prompt.txt": "FAQ content here",
  });

  const result = await loadOne(fs);

  assert.equal(result.agents.length, 1);
  assert.equal(result.agents[0].prompt, "Intro line\nFAQ content here\nOutro line");
});

test("include: single-quoted and unquoted paths work", async () => {
  const fs = makeMockFs({
    "/global/single.md": "---\nname: single\nmode: subagent\n---\ninclude: '_a.txt'",
    "/global/unquoted.md": "---\nname: unquoted\nmode: subagent\n---\ninclude: _b.txt",
    "/global/_a.txt": "AAA",
    "/global/_b.txt": "BBB",
  });

  const result = await loadOne(fs);

  const single = result.agents.find((a) => a.name === "single");
  const unquoted = result.agents.find((a) => a.name === "unquoted");
  assert.equal(single?.prompt, "AAA");
  assert.equal(unquoted?.prompt, "BBB");
});

test("include: multiple directives preserve order", async () => {
  const fs = makeMockFs({
    "/global/agent.md": `---
name: agent
mode: subagent
---
Start
include: "_first.txt"
Middle
include: "_second.txt"
End`,
    "/global/_first.txt": "FIRST",
    "/global/_second.txt": "SECOND",
  });

  const result = await loadOne(fs);

  assert.equal(result.agents[0].prompt, "Start\nFIRST\nMiddle\nSECOND\nEnd");
});

test("include: recursive includes resolve relative to their own file", async () => {
  const fs = makeMockFs({
    // agent/ dir: the top-level agent includes b relative to agent/
    "/global/agent/main.md": `---
name: main
mode: subagent
---
include: "b.md"`,
    // b (in agent/) reaches ../shared/c.txt relative to its own dir
    "/global/agent/b.md": "B body\ninclude: \"../shared/c.txt\"",
    "/global/shared/c.txt": "C body",
  });

  const result = await loadOne(fs);

  assert.equal(result.agents[0].prompt, "B body\nC body");
});

// ─── Cycle & Depth Guards ────────────────────────────────────────────────────

test("include: cycles keep the directive literal, agent still loads", async () => {
  const fs = makeMockFs({
    "/global/a.md": "---\nname: a\nmode: subagent\n---\nA body\ninclude: \"b.md\"",
    // Helper is itself discoverable — disable it so only "a" loads as an agent.
    "/global/b.md": "---\nname: b\ndisable: true\n---\nB body\ninclude: \"a.md\"",
  });

  let result!: AgentLoadResult;
  const stderr = await captureStderr(async () => {
    result = await loadOne(fs);
  });

  assert.equal(result.agents.length, 1);
  assert.equal(result.agents[0].name, "a");
  assert.ok(result.agents[0].prompt.includes("A body"));
  assert.ok(result.agents[0].prompt.includes("B body"));
  assert.ok(result.agents[0].prompt.includes('include: "a.md"'), "cycle directive stays literal");
  assert.ok(stderr.some((l) => l.includes("cycle")), "cycle warning on stderr");
});

test("include: diamond includes are not cycles (expanded each time)", async () => {
  const fs = makeMockFs({
    "/global/main.md": `---
name: main
mode: subagent
---
include: "left.txt"
==
include: "right.txt"`,
    "/global/left.txt": "L\ninclude: \"leaf.txt\"",
    "/global/right.txt": "R\ninclude: \"leaf.txt\"",
    "/global/leaf.txt": "LEAF",
  });

  const result = await loadOne(fs);

  assert.equal(result.agents.length, 1);
  assert.equal(result.agents[0].prompt, "L\nLEAF\n==\nR\nLEAF");
});

test("include: nesting is capped at depth 8", async () => {
  const files: Record<string, string> = {
    "/global/main.md": "---\nname: main\nmode: subagent\n---\ninclude: \"c1.md\"",
  };
  for (let i = 1; i <= 8; i++) {
    // Helper .md files are discoverable too — disable them so only main loads.
    files[`/global/c${i}.md`] = `---\nname: c${i}\ndisable: true\n---\nC${i}\ninclude: "c${i + 1}.md"`;
  }
  files["/global/c9.md"] = "---\nname: c9\ndisable: true\n---\nC9";

  const result = await loadOne(makeMockFs(files));

  const prompt = result.agents.find((a) => a.name === "main")!.prompt;
  assert.ok(prompt.includes("C8"), "depth-8 content should be inlined");
  assert.ok(!prompt.includes("C9"), "beyond depth 8 must not be inlined");
  assert.ok(prompt.includes('include: "c9.md"'), "over-depth directive stays literal");
});

// ─── Missing Files (fail-soft) ───────────────────────────────────────────────

test("include: missing file keeps the directive literal, warns once, agent loads", async () => {
  const fs = makeMockFs({
    "/global/agent.md": `---
name: agent
mode: subagent
---
Keep me
include: "_nope.txt"
Keep me too
include: "_nope.txt"`,
  });

  let result!: AgentLoadResult;
  const stderr = await captureStderr(async () => {
    result = await loadOne(fs);
  });

  assert.equal(result.agents.length, 1);
  assert.equal(
    result.agents[0].prompt,
    'Keep me\ninclude: "_nope.txt"\nKeep me too\ninclude: "_nope.txt"',
  );
  const missingWarnings = stderr.filter((l) => l.includes("_nope.txt"));
  assert.equal(missingWarnings.length, 1, "one warning per missing path");
});

// ─── Lookalike Lines Are Untouched ───────────────────────────────────────────

test("include: lookalike lines are left untouched", async () => {
  const fs = makeMockFs({
    "/global/agent.md": `---
name: agent
mode: subagent
---
Body starts here.
  include: "_t.txt"
See include: "_t.txt" for details
include:"_t.txt"
Include: "_t.txt"
\`\`\`
include: "_t.txt"
\`\`\`
Trailing text include: _t.txt after words`,
    "/global/_t.txt": "SHOULD-NOT-APPEAR",
  });

  const result = await loadOne(fs);

  const prompt = result.agents[0].prompt;
  assert.ok(!prompt.includes("SHOULD-NOT-APPEAR"), "no lookalike may resolve");
  assert.ok(prompt.includes("\n  include: \"_t.txt\""), "indented line untouched");
  assert.ok(prompt.includes('See include: "_t.txt" for details'), "inline sentence untouched");
  assert.ok(prompt.includes('include:"_t.txt"'), "missing space after colon untouched");
  assert.ok(prompt.includes('Include: "_t.txt"'), "case-sensitive: capital I untouched");
  assert.ok(prompt.includes('include: "_t.txt"\n```'), "directive inside code fence untouched");
  assert.ok(prompt.includes("Trailing text include: _t.txt after words"), "mid-line directive untouched");
});
