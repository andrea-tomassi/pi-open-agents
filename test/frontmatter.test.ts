/**
 * Tests for the unified frontmatter parser.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatter } from "../src/config/frontmatter.ts";

test("parseFrontmatter: flat key-value", () => {
  const content = `---
name: my-agent
description: A test agent
model: opencode/claude-sonnet-4
---
Body text here`;

  const { data, body } = parseFrontmatter(content);

  assert.equal(data.name, "my-agent");
  assert.equal(data.description, "A test agent");
  assert.equal(data.model, "opencode/claude-sonnet-4");
  assert.equal(body, "Body text here");
});

test("parseFrontmatter: nested permission object", () => {
  const content = `---
name: safe-agent
permission:
  bash: allow
  edit:
    "*.env": deny
    "*.md": allow
  read: allow
---
Body`;

  const { data } = parseFrontmatter(content);

  assert.equal(data.name, "safe-agent");
  const perm = data.permission as Record<string, unknown>;
  assert.equal(perm.bash, "allow");
  assert.equal(perm.read, "allow");

  const editRules = perm.edit as Record<string, string>;
  assert.equal(editRules['*.env'], "deny");
  assert.equal(editRules['*.md'], "allow");
});

test("parseFrontmatter: boolean coercion", () => {
  const content = `---
name: test
hidden: false
disable: true
debug: true
---
Body`;

  const { data } = parseFrontmatter(content);

  assert.equal(data.hidden, false);
  assert.equal(data.disable, true);
  assert.equal(data.debug, true);
});

test("parseFrontmatter: number coercion", () => {
  const content = `---
name: test
maxDepth: 15
temperature: 0.7
steps: 50
---
Body`;

  const { data } = parseFrontmatter(content);

  assert.equal(data.maxDepth, 15);
  assert.equal(data.temperature, 0.7);
  assert.equal(data.steps, 50);
});

test("parseFrontmatter: quoted values", () => {
  const content = `---
name: test
color: "#44BA81"
description: "Has spaces and # symbols"
---
Body`;

  const { data } = parseFrontmatter(content);

  assert.equal(data.color, "#44BA81");
  assert.equal(data.description, "Has spaces and # symbols");
});

test("parseFrontmatter: inline array", () => {
  const content = `---
name: test
tools: [read, bash, edit]
---
Body`;

  const { data } = parseFrontmatter(content);

  assert.deepEqual(data.tools, ["read", "bash", "edit"]);
});

test("parseFrontmatter: no frontmatter", () => {
  const content = "Just body text, no frontmatter";

  const { data, body } = parseFrontmatter(content);

  assert.deepEqual(data, {});
  assert.equal(body, "Just body text, no frontmatter");
});

test("parseFrontmatter: comments are ignored", () => {
  const content = `---
# This is a comment
name: test
# Another comment
description: hello
---
Body`;

  const { data } = parseFrontmatter(content);

  assert.equal(data.name, "test");
  assert.equal(data.description, "hello");
  assert.equal(Object.keys(data).length, 2);
});

test("parseFrontmatter: empty frontmatter", () => {
  const content = `---
---
Body`;

  const { data, body } = parseFrontmatter(content);

  assert.deepEqual(data, {});
  assert.equal(body, "Body");
});

test("parseFrontmatter: closing --- at start position", () => {
  const content = `---\n---\nBody`;

  const result = parseFrontmatter(content);
  assert.deepEqual(result.data, {});
  assert.equal(result.body, "Body");
});

test("parseFrontmatter: multiline body preserved", () => {
  const content = `---
name: test
---
# Heading

Some paragraph text.

\`\`\`typescript
const x = 1;
\`\`\``;

  const { body } = parseFrontmatter(content);

  assert.ok(body.includes("# Heading"));
  assert.ok(body.includes("const x = 1;"));
  assert.ok(body.includes("```"));
});
