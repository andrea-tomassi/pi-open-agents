# Contributing to pi-open-agents

Thanks for your interest in contributing! This guide covers the essentials.

## Development setup

```bash
git clone https://github.com/andrea-tomassi/pi-open-agents.git
cd pi-open-agents
npm install
```

Requirements:

- **Node.js ≥ 20** (≥ 22 recommended)
- TypeScript via `tsx` (installed automatically)

The `@earendil-works/pi-coding-agent` package is an **optional peer dependency** — it's
present in dev for integration tests but not required at install time. Some tests
are skipped gracefully when it's absent.

## Testing

```bash
npm test           # Run all tests (node:test + tsx)
npm run typecheck  # TypeScript type checking (no emit)
```

**Both must pass before submitting a PR.** The test suite uses Node.js's built-in
test runner (`node:test`) with `node:assert/strict`.

### Test conventions

- **Unit tests** live in `test/` and are named `<topic>.test.ts`
- **Integration tests** use in-memory fakes — no real pi process is spawned
- For subagent executor tests, inject a `captureRunner` to assert CLI args
  (see `test/subagent-tools.test.ts` for the pattern)
- Every new feature or bug fix should include a test

## Code style

- **TypeScript + ESM** (`"type": "module"` in package.json)
- **No bundler, no transpile step** — source `.ts` files run directly via `tsx`
- Use `import type` for type-only imports
- Follow existing patterns in the codebase — match naming, indentation, structure
- Keep functions focused and documented with JSDoc when non-obvious

## Pull request process

1. **Fork & branch** — create a branch from `main`:
   ```bash
   git checkout -b fix/short-description
   ```
2. **Write tests first** (TDD encouraged) — add or update tests that capture the
   bug or feature
3. **Implement** — make the tests pass
4. **Link issues** — use `Fixes #N` in the PR body to auto-close issues on merge
5. **Keep PRs focused** — one logical change per PR

### What we look for in review

- Tests that exercise the **actual code path**, not a copy of the logic
- No regressions in existing tests
- Permission changes documented with clear before/after behavior
- `npm test` + `npm run typecheck` clean

## Project structure

```
src/
  config/          Frontmatter parsing, schema validation, discovery paths
  discovery/       Agent file loading (pi + OpenCode directories)
  permission/      Permission rule parsing, evaluation, tool matching
  primary/         Primary agent executor + manager (switching, apply)
  subagent/        Subagent executor, env, prompt, skills, tool registration
  tui/             Banner, selector, tool display
  types.ts         Shared type definitions
  index.ts         Plugin entry point (ExtensionAPI hooks)
test/              Unit + integration tests (one file per module)
```

## Release process (maintainers)

Releases are automated via GitHub Actions + npm Trusted Publishing (OIDC):

1. Ensure working tree is clean
2. `npm test && npm run typecheck`
3. `npm version patch` (or `minor` / `major`)
4. `git push origin main --follow-tags` — triggers the publish workflow
5. `gh release create` — the workflow does **not** auto-create GitHub releases

## License

MIT. By contributing, you agree that your contributions will be licensed under
the MIT License.
