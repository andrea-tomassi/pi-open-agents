/**
 * Tests for the subagent executor's model-registry construction.
 *
 * Regression coverage for the crash where `AuthStorage` is `undefined` on newer
 * pi-coding-agent hosts (it was removed in 0.80.x). The registry is best-effort
 * and must never throw — otherwise subagent delegation breaks entirely.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildModelRegistry } from "../src/subagent/executor.ts";

// ─── Failure path: host lacks AuthStorage/ModelRegistry (the original bug) ───

test("buildModelRegistry: returns undefined when host lacks AuthStorage (version drift)", () => {
  // Simulates pi-coding-agent 0.80.x which removed the AuthStorage export.
  // Previously this threw "Cannot read properties of undefined (reading 'create')".
  const reg = buildModelRegistry("/agent", { auth: undefined, model: undefined });
  assert.equal(reg, undefined, "must not throw; must return undefined");
});

test("buildModelRegistry: returns undefined when only auth is missing", () => {
  const fakeModel = { create: () => ({ find: () => ({ contextWindow: 128000 }) }) };
  const reg = buildModelRegistry("/agent", { auth: undefined, model: fakeModel });
  assert.equal(reg, undefined);
});

test("buildModelRegistry: returns undefined when a factory throws", () => {
  const throwingAuth = { create: () => { throw new Error("boom"); } };
  const fakeModel = { create: () => ({ find: () => undefined }) };
  const reg = buildModelRegistry("/agent", { auth: throwingAuth, model: fakeModel });
  assert.equal(reg, undefined);
});

// ─── Happy path: factories available ─────────────────────────────────────────

test("buildModelRegistry: builds a registry when factories are available", () => {
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

  const reg = buildModelRegistry("/agent", { auth: fakeAuth, model: fakeModel });
  assert.ok(reg, "expected a registry");
  assert.equal(typeof reg!.find, "function");
  assert.equal(observedAuthPath, "/agent/auth.json");
  assert.equal(observedModelsPath, "/agent/models.json");
});

test("buildModelRegistry: handles undefined agentDir (no paths)", () => {
  const fakeAuth = { create: (p?: string) => { assert.equal(p, undefined); return {}; } };
  const fakeModel = { create: (_a: unknown, m?: string) => { assert.equal(m, undefined); return { find: () => undefined }; } };
  const reg = buildModelRegistry(undefined, { auth: fakeAuth, model: fakeModel });
  assert.ok(reg);
});
