/**
 * Tests for the subagent executor's model-registry construction.
 *
 * Regression coverage for the crash where `AuthStorage` is `undefined` on newer
 * pi-coding-agent hosts (removed in 0.80.x). The registry is best-effort and
 * must never throw — otherwise subagent delegation breaks entirely.
 *
 * `executor.ts` imports `@earendil-works/pi-coding-agent` (an OPTIONAL peer
 * dependency) at module load. The publish CI installs only devDependencies, so
 * that package is absent there. We resolve the module dynamically and skip
 * these tests gracefully when the peer dependency is unavailable; they run
 * wherever it is present (local dev, host-integrated environments).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

type BuildModelRegistry = (
  agentDir: string | undefined,
  factories?: { auth?: unknown; model?: unknown },
) => unknown;

let buildModelRegistry: BuildModelRegistry | undefined;
try {
  ({ buildModelRegistry } = (await import("../src/subagent/executor.ts")) as {
    buildModelRegistry: BuildModelRegistry;
  });
} catch {
  buildModelRegistry = undefined;
}

// Run the suite when the optional peer dependency is present; skip in CI.
const run = buildModelRegistry ? test : test.skip;

// ─── Failure path: host lacks AuthStorage/ModelRegistry (the original bug) ───

run("buildModelRegistry: returns undefined when host lacks AuthStorage (version drift)", () => {
  // Simulates pi-coding-agent 0.80.x which removed the AuthStorage export.
  // Previously this threw "Cannot read properties of undefined (reading 'create')".
  const reg = buildModelRegistry!("/agent", { auth: undefined, model: undefined });
  assert.equal(reg, undefined, "must not throw; must return undefined");
});

run("buildModelRegistry: returns undefined when only auth is missing", () => {
  const fakeModel = { create: () => ({ find: () => ({ contextWindow: 128000 }) }) };
  const reg = buildModelRegistry!("/agent", { auth: undefined, model: fakeModel });
  assert.equal(reg, undefined);
});

run("buildModelRegistry: returns undefined when a factory throws", () => {
  const throwingAuth = { create: () => { throw new Error("boom"); } };
  const fakeModel = { create: () => ({ find: () => undefined }) };
  const reg = buildModelRegistry!("/agent", { auth: throwingAuth, model: fakeModel });
  assert.equal(reg, undefined);
});

// ─── Happy path: factories available ─────────────────────────────────────────

run("buildModelRegistry: builds a registry when factories are available", () => {
  let observedAuthPath: string | undefined;
  let observedModelsPath: string | undefined;
  const fakeAuth = { create: (p?: string) => { observedAuthPath = p; return {}; } };
  const fakeModel = {
    create: (authStore: unknown, modelsPath: string | undefined) => {
      observedModelsPath = modelsPath;
      assert.ok(authStore, "auth store should be forwarded");
      return { find: () => ({ contextWindow: 200000 }) };
    },
  };

  const reg = buildModelRegistry!("/agent", { auth: fakeAuth, model: fakeModel });
  assert.ok(reg, "expected a registry");
  assert.equal(typeof (reg as { find: unknown }).find, "function");
  assert.equal(observedAuthPath, "/agent/auth.json");
  assert.equal(observedModelsPath, "/agent/models.json");
});

run("buildModelRegistry: handles undefined agentDir (no paths)", () => {
  const fakeAuth = { create: (p?: string) => { assert.equal(p, undefined); return {}; } };
  const fakeModel = {
    create: (_a: unknown, m?: string) => { assert.equal(m, undefined); return { find: () => undefined }; },
  };
  const reg = buildModelRegistry!(undefined, { auth: fakeAuth, model: fakeModel });
  assert.ok(reg);
});
