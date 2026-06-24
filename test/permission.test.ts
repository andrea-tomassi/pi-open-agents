/**
 * Tests for the permission parser, matcher, and evaluator.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePermissionRules, mergePermissionConfigs } from "../src/permission/parser.ts";
import { matchPattern, isWildcardPattern } from "../src/permission/matcher.ts";
import { evaluate, toolToPermission, getDisabledTools, filterDisabledTools } from "../src/permission/evaluator.ts";
import type { PermissionConfig, PermissionRule } from "../src/types.ts";

// ─── Parser Tests ────────────────────────────────────────────────────────────

test("parser: simple config to rules", () => {
  const config: PermissionConfig = {
    bash: "allow",
    read: "deny",
  };

  const rules = parsePermissionRules(config);

  assert.equal(rules.length, 2);
  assert.deepEqual(rules[0], { permission: "bash", pattern: "*", action: "allow" });
  assert.deepEqual(rules[1], { permission: "read", pattern: "*", action: "deny" });
});

test("parser: pattern config to rules", () => {
  const config: PermissionConfig = {
    edit: {
      "*.env": "deny",
      "*.md": "allow",
    },
  };

  const rules = parsePermissionRules(config);

  assert.equal(rules.length, 2);
  assert.deepEqual(rules[0], { permission: "edit", pattern: "*.env", action: "deny" });
  assert.deepEqual(rules[1], { permission: "edit", pattern: "*.md", action: "allow" });
});

test("parser: mixed simple and pattern", () => {
  const config: PermissionConfig = {
    bash: "allow",
    edit: {
      "*.env": "deny",
    },
    read: "ask",
  };

  const rules = parsePermissionRules(config);

  assert.equal(rules.length, 3);
  assert.deepEqual(rules[0], { permission: "bash", pattern: "*", action: "allow" });
  assert.deepEqual(rules[1], { permission: "edit", pattern: "*.env", action: "deny" });
  assert.deepEqual(rules[2], { permission: "read", pattern: "*", action: "ask" });
});

test("parser: merge configs in order", () => {
  const base: PermissionConfig = { bash: "allow" };
  const override: PermissionConfig = { bash: "deny" };

  const rules = mergePermissionConfigs(base, override);

  assert.equal(rules.length, 2);
  assert.equal(rules[0].action, "allow");
  assert.equal(rules[1].action, "deny");
});

test("parser: merge skips undefined configs", () => {
  const rules = mergePermissionConfigs(undefined, { bash: "allow" }, undefined);
  assert.equal(rules.length, 1);
});

// ─── Matcher Tests ───────────────────────────────────────────────────────────

test("matcher: star matches anything", () => {
  assert.ok(matchPattern("*", "anything"));
  assert.ok(matchPattern("*", "path/to/file.env"));
});

test("matcher: exact match", () => {
  assert.ok(matchPattern("exact", "exact"));
  assert.ok(!matchPattern("exact", "other"));
});

test("matcher: extension pattern", () => {
  assert.ok(matchPattern("*.env", "secret.env"));
  assert.ok(matchPattern("*.env", "db.env"));
  assert.ok(!matchPattern("*.env", "secret.env.bak"));
});

test("matcher: star does not cross slash", () => {
  assert.ok(!matchPattern("*.env", "dir/secret.env"));
});

test("matcher: double-star crosses slash", () => {
  assert.ok(matchPattern("**/*.env", "secret.env"));
  assert.ok(matchPattern("**/*.env", "dir/secret.env"));
  assert.ok(matchPattern("**/*.env", "a/b/c.env"));
});

test("matcher: question mark single char", () => {
  assert.ok(matchPattern("?.env", "a.env"));
  assert.ok(!matchPattern("?.env", "ab.env"));
});

test("matcher: isWildcardPattern", () => {
  assert.ok(isWildcardPattern("*.env"));
  assert.ok(isWildcardPattern("test?"));
  assert.ok(!isWildcardPattern("exact"));
});

// ─── Tool → Permission Mapping ───────────────────────────────────────────────

test("toolToPermission: write maps to edit", () => {
  assert.equal(toolToPermission("write"), "edit");
  assert.equal(toolToPermission("edit"), "edit");
  assert.equal(toolToPermission("apply_patch"), "edit");
});

test("toolToPermission: MCP read tools map to read", () => {
  assert.equal(toolToPermission("list_mcp_resources"), "read");
  assert.equal(toolToPermission("read_mcp_resource"), "read");
});

test("toolToPermission: other tools map by name", () => {
  assert.equal(toolToPermission("bash"), "bash");
  assert.equal(toolToPermission("grep"), "grep");
  assert.equal(toolToPermission("read"), "read");
});

// ─── Evaluator Tests ─────────────────────────────────────────────────────────

const RULES: PermissionRule[] = [
  { permission: "bash", pattern: "*", action: "allow" },
  { permission: "edit", pattern: "*.env", action: "deny" },
  { permission: "edit", pattern: "*.md", action: "allow" },
  { permission: "read", pattern: "*", action: "allow" },
];

test("evaluator: simple allow", () => {
  const result = evaluate("bash", "ls -la", RULES);
  assert.equal(result.action, "allow");
  assert.ok(result.matched);
});

test("evaluator: deny by pattern", () => {
  const result = evaluate("edit", "secret.env", RULES);
  assert.equal(result.action, "deny");
  assert.equal(result.pattern, "*.env");
});

test("evaluator: allow by pattern", () => {
  const result = evaluate("edit", "README.md", RULES);
  assert.equal(result.action, "allow");
  assert.equal(result.pattern, "*.md");
});

test("evaluator: write maps to edit permission", () => {
  const result = evaluate("write", "file.env", RULES);
  assert.equal(result.action, "deny");
  assert.equal(result.permission, "edit");
});

test("evaluator: no match defaults to ask", () => {
  const result = evaluate("webfetch", "https://example.com", RULES);
  assert.equal(result.action, "ask");
  assert.ok(!result.matched);
});

test("evaluator: last match wins", () => {
  const rules: PermissionRule[] = [
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "rm *", action: "deny" },
    { permission: "bash", pattern: "*", action: "ask" }, // overrides first
  ];

  const result = evaluate("bash", "ls", rules);
  assert.equal(result.action, "ask"); // last * wins, not the first
});

test("evaluator: last match wins with overlapping patterns", () => {
  const rules: PermissionRule[] = [
    { permission: "edit", pattern: "*.md", action: "allow" },
    { permission: "edit", pattern: "secret.md", action: "deny" }, // more specific, but later
  ];

  const result = evaluate("edit", "secret.md", rules);
  assert.equal(result.action, "deny"); // later wins
});

test("evaluator: no argument matches * patterns", () => {
  const result = evaluate("read", undefined, RULES);
  assert.equal(result.action, "allow");
});

// ─── Disabled Tools ──────────────────────────────────────────────────────────

test("getDisabledTools: deny with * disables tool", () => {
  const rules: PermissionRule[] = [
    { permission: "bash", pattern: "*", action: "deny" },
    { permission: "read", pattern: "*", action: "allow" },
    { permission: "edit", pattern: "*", action: "deny" },
  ];

  const tools = ["bash", "read", "edit", "write"];
  const disabled = getDisabledTools(tools, rules);

  assert.ok(disabled.has("bash"));
  assert.ok(disabled.has("edit"));
  assert.ok(disabled.has("write")); // write maps to edit
  assert.ok(!disabled.has("read"));
});

test("getDisabledTools: pattern-specific deny does not disable", () => {
  const rules: PermissionRule[] = [
    { permission: "edit", pattern: "*.env", action: "deny" },
  ];

  const tools = ["edit", "write"];
  const disabled = getDisabledTools(tools, rules);

  assert.equal(disabled.size, 0); // not globally disabled, just pattern-specific
});

test("filterDisabledTools: removes disabled tools from list", () => {
  const rules: PermissionRule[] = [
    { permission: "bash", pattern: "*", action: "deny" },
  ];

  const tools = [
    { name: "bash" },
    { name: "read" },
    { name: "edit" },
  ];

  const filtered = filterDisabledTools(tools, rules);

  assert.equal(filtered.length, 2);
  assert.equal(filtered[0].name, "read");
  assert.equal(filtered[1].name, "edit");
});

test("filterDisabledTools: empty rules keeps all", () => {
  const tools = [{ name: "bash" }, { name: "read" }];
  const filtered = filterDisabledTools(tools, []);
  assert.equal(filtered.length, 2);
});
