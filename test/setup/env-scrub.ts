/**
 * Clean the harness environment before any test file loads.
 *
 * pi-open-agents passes recursion state to child processes through
 * `PI_OPEN_AGENTS_*` variables (depth, max depth, allowed agents). When the suite runs inside
 * an agent session — a delegating subagent, or any shell started from one — those variables are
 * already present, so `registerSubagentTool` correctly refuses to register (past max depth) and
 * `index.ts` filters agent definitions by `PI_OPEN_AGENTS_ALLOWED`. Tests that exercise those
 * code paths then fail for reasons unrelated to the code under test.
 *
 * Tests that need the variables set them explicitly; nothing here should mask a real defect.
 */

const PREFIXES = ["PI_OPEN_AGENTS_", "PI_SUBAGENT_"];
// The agent directory of the session running the suite would leak into discovery tests.
const EXACT = ["PI_CODING_AGENT_DIR"];

for (const key of Object.keys(process.env)) {
  if (PREFIXES.some((prefix) => key.startsWith(prefix)) || EXACT.includes(key)) {
    delete process.env[key];
  }
}
