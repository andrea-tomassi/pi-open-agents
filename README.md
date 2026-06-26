# pi-open-agents

<p align="center">
  <img src="https://raw.githubusercontent.com/andrea-tomassi/pi-open-agents/refs/heads/main/pi-open-agents-banner.png" alt="pi-open-agents" width="768">
</p>

[![npm version](https://img.shields.io/npm/v/pi-open-agents.svg)](https://www.npmjs.com/package/pi-open-agents)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![pi](https://img.shields.io/badge/pi-coding%20agent-blue)](https://pi.dev)

Unified agent and subagent management for [pi](https://pi.dev), with [OpenCode](https://github.com/sst/opencode)-compatible agent definitions.

Replaces `pi-agent-mode` + `@johnnywu/pi-subagents` with one coherent plugin.

> **Why pi?** Pi's minimalist core keeps system prompts under 1,000 tokens — making it exceptionally fast on local models and cheap on cloud APIs. pi-open-agents is built to leverage that minimalism. See [Pi vs OpenCode: Performance & Architecture](./PI-VS-OPencode.md) for a detailed comparison.

---

## Quick start

```bash
pi install pi-open-agents
```

Remove old plugins from `~/.pi/agent/settings.json`:

```json
{
  "packages": ["npm:pi-open-agents"]
}
```

Existing `.agent.md` files work without changes (default `mode: all`).

---

## Why this exists

Pi splits agent management across two separate plugins — one for primary agents,
one for subagents. They use incompatible schemas, conflict on model routing, and
have no permission system. `pi-open-agents` replaces both:

| | `pi-agent-mode` | `pi-subagents` | `pi-open-agents` |
|---|---|---|---|
| Primary agent switching | ✅ | ❌ | ✅ |
| Subagent delegation | ❌ | ✅ | ✅ |
| Per-agent thinking level | ❌ | ❌ | ✅ |
| Permission system | ❌ | ❌ | ✅ |
| OpenCode `.agent.md` format | ❌ | ❌ | ✅ |

---

## Features

### Per-agent model, thinking, and permissions

Every agent defines its own `model:`, `thinking:`, and `permission:` — no global
overrides, no sentinel values, no workarounds. An orchestrator can run on a strong
reasoning model while subagents run on a fast local model:

```yaml
---
name: orchestrator
mode: primary
model: anthropic/claude-sonnet
thinking: high
---
```

```yaml
---
name: fast-worker
mode: subagent
model: lm-studio/qwen-2.5-coder
thinking: off
---
```

### Permission system

Go beyond a simple tool whitelist. OpenCode-style rules with glob patterns, deny
rules, and per-action restrictions:

```yaml
permission:
  "*": allow              # default: everything allowed
  "edit": deny            # read-only agent
  "bash":
    "git *": allow        # only git commands
    "rm *": deny          # never delete
  "subagent": deny        # no delegation
```

Tool names are normalized automatically: `write` → `edit`, `task` → `subagent`,
`vscode` → `read`.

### Auto-injected delegation guidance

If an agent has the `subagent` tool, the plugin automatically appends a
`## Subagent Delegation` block to its system prompt — listing available
subagents and the correct call syntax:

```
subagent({ agent: "<name>", task: "<task>" })
```

You never need to explain delegation mechanics in agent prompts. The plugin
handles it, the same way pi handles tool descriptions.

### Subagent execution engine

When an agent delegates, the plugin spawns a child pi process with the target
agent's configuration. The child runs in isolation — it gets `--model`,
`--system-prompt`, and `--tools` from the executor, not from `settings.json`.
This means:

- The primary agent's `defaultAgent` never leaks into subagents
- Each subagent runs with exactly the model and tools it declares
- Skills load per-agent, with wildcard support (`security-*`, `git-*`)

### OpenCode compatibility

Your `.opencode/agent/` files work as-is. The `tools` map format is auto-converted
to permission rules, and pi-specific fields (`thinking`, `maxDepth`, `allowedAgents`)
are simply ignored by OpenCode without breaking:

```yaml
# OpenCode format — works in pi without changes
name: triage
mode: subagent
tools:
  read: true
  bash: false
```

### Mode-based visibility

| `mode` | TUI selector | `subagent` tool | `set_agent` tool |
|--------|-------------|-----------------|------------------|
| `primary` | ✅ visible | ❌ | ✅ |
| `subagent` | ❌ | ✅ available | ✅ |
| `all` (default) | ✅ visible | ✅ available | ✅ |

Use `primary` for user-facing agents, `subagent` for delegated workers, `all` when
an agent serves both roles.

---

## Agent definition format

```yaml
---
name: my-agent                          # required
description: One-line description
mode: subagent                          # primary | subagent | all (default: all)
hidden: false                           # hide from TUI selectors
color: "#44BA81"

model: anthropic/claude-sonnet          # per-agent model override
thinking: xhigh                         # off|minimal|low|medium|high|xhigh
systemPrompt: replace                   # append | replace | replace-all (default: append)

permission:
  "*": allow
  "question": deny
  "edit":
    "*.env": deny

maxDepth: 5                             # subagent recursion limit
allowedAgents: [explorer]               # restrict which subagents this can spawn
skills: security-audit, git-*           # per-agent skills with wildcards
---
Your prompt goes here. This becomes the agent's system prompt.
```

### System prompt modes

The `systemPrompt` field controls how the agent body interacts with pi's default
prompt and workspace context files (CLAUDE.md, etc.):

| Mode | System prompt | Context files |
|------|---------------|---------------|
| `append` (default) | pi's prompt + agent body | ✅ loaded |
| `replace` | Agent body only | ✅ loaded |
| `replace-all` | Agent body only | ❌ disabled |

Use `replace-all` for fully isolated agents that should not be influenced by
workspace context — e.g., a subagent that must run identically regardless of
the project it's invoked from.

For **subagents** (child process), the agent body **is** the system prompt —
pi's default prompt is not included. Skills are injected as an XML block after
the body.

---

## Discovery paths

Agents are loaded from multiple locations (project overrides global by name):

| Path | Scope | Format |
|------|-------|--------|
| `~/.pi/agent/agents/*.md` | Global | pi |
| `~/.opencode/{agent,agents,mode}/*.md` | Global | OpenCode |
| `.pi/agents/*.md` | Project | pi |
| `.opencode/{agent,agents,mode}/*.md` | Project | OpenCode |
| `.agents/*.md` | Project | Shared |

---

## Usage

### Interactive

| Action | What it does |
|---|---|
| `/agent` | Open agent selector (primary/all only) |
| `/agent <name>` | Switch to agent directly |
| `/agents` | List all agents |
| `/agent-search <query>` | Search agents |
| `Ctrl+Shift+M` | Cycle agents |
| `--agent <name>` | CLI flag for startup agent |

### Programmatic (LLM tools)

| Tool | Description |
|---|---|
| `set_agent` | Switch agent programmatically |
| `search_agents` | Search agents by name/description/body |
| `subagent` | Delegate task to a subagent (subagent/all mode only) |

---

## Migration

```bash
pi install pi-open-agents
```

Remove `npm:pi-agent-mode` and `npm:@johnnywu/pi-subagents` from `settings.json`.
Existing agent `.md` files work without changes.

Optional cleanup:

1. Add `mode: primary` or `mode: subagent` to agent files for explicit visibility
2. Gradually adopt `permission:` over the old `tools:` whitelist

---

## Development

```bash
npm install
npm test          # 84 tests
npm run typecheck # tsc --noEmit
```

### Docker testing

```bash
docker compose run --rm pi-sandbox
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full technical design.

---

## Attribution

This project builds on code and ideas from:

- [pi-agent-mode](https://github.com/ZGltYQ/agent-mode) by ZGltYQ (MIT)
- [pi-subagents](https://github.com/jwu/pi-subagents) by jwu (MIT)
- [opencode](https://github.com/sst/opencode) by sst (MIT)

See [ATTRIBUTION.md](./ATTRIBUTION.md) for details.

## License

MIT
