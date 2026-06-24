# pi-open-agents

[![npm version](https://img.shields.io/npm/v/pi-open-agents.svg)](https://www.npmjs.com/package/pi-open-agents)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![pi](https://img.shields.io/badge/pi-coding%20agent-blue)](https://pi.dev)

Unified agent and subagent management for [pi](https://pi.dev), with [OpenCode](https://github.com/sst/opencode)-compatible agent definitions.

Replaces `pi-agent-mode` and `@johnnywu/pi-subagents` with a single, coherent plugin.

---

## Why

Pi delegates agent management to two separate npm plugins that use incompatible
frontmatter schemas, divergent defaults, and fragmented semantics. This plugin
replaces both with one unified system that also reads OpenCode-format agent
definitions — so your agents work in **both** pi and OpenCode without modification.

### Comparison

| Feature | `pi-agent-mode` | `@johnnywu/pi-subagents` | `pi-open-agents` |
|---------|-----------------|--------------------------|------------------|
| Primary agent switching | ✅ | ❌ | ✅ |
| Subagent delegation | ❌ | ✅ | ✅ |
| Per-agent thinking level | ❌ *(broken)* | ❌ *(defaults to `off`)* | ✅ |
| OpenCode permission system | ❌ | ❌ | ✅ |
| OpenCode `.agent.md` format | ❌ | ❌ | ✅ |
| One plugin for everything | ❌ | ❌ | ✅ |

## Who is this for?

- **Pi users** frustrated with managing two plugins for agent switching and delegation
- **OpenCode users** who want to try pi without rewriting their agent definitions
- **Teams** who want a portable, version-controlled agent library that works across harnesses
- **Anyone** who wants per-agent thinking levels, permission rules, or model overrides in pi

## Quick start

```bash
pi install pi-open-agents
```

Remove the old plugins from `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "npm:pi-open-agents"
  ]
}
```

That's it. Existing `.agent.md` files work without changes (default `mode: all`).

## Features

- **Unified agent definitions** — one `.md` format, superset of OpenCode + pi
- **Mode-based visibility** — `primary` in the TUI selector, `subagent` for delegation, `all` for both
- **OpenCode-compatible** — reads agents from `.opencode/agent/`, `.opencode/mode/`, and `.agents/`
- **Permission system** — OpenCode-style `allow`/`deny`/`ask` with glob patterns, last-match-wins
- **Thinking level per-agent** — `off`/`minimal`/`low`/`medium`/`high`/`xhigh`, with fallback to `settings.json`
- **Subagent execution** — child pi process spawning with scoped tools, skills, and session fork
- **Skill loading** — per-agent skills with wildcard support (`lark-*`, `github`)

## Agent definition format

```yaml
---
# === Identity ===
name: code-reviewer                # required
description: Reviews code for quality and security issues
mode: subagent                     # primary | subagent | all (default: all)
hidden: false                      # hide from TUI selectors
color: "#44BA81"

# === Model ===
model: anthropic/claude-sonnet     # per-agent override

# === Execution ===
thinking: xhigh                    # off|minimal|low|medium|high|xhigh
systemPrompt: append               # append | replace | replace-all (default: append)

# === Permissions (OpenCode-style) ===
permission:
  "*": allow
  "edit": deny                     # read-only agent
  "bash":
    "git *": allow                 # can run git commands only

# === Subagent controls ===
maxDepth: 5                        # recursion limit when spawning subagents
allowedAgents: [explorer]          # which subagents this can spawn
skills: security-audit, git-*      # per-agent skills with wildcards
---
You are a code reviewer. Analyze code for bugs, security vulnerabilities,
and maintainability issues. Never modify files — report findings only.
```

### How the body becomes the system prompt

The markdown body after the frontmatter becomes the agent's prompt. The `systemPrompt`
field controls how it interacts with pi's default system prompt:

| Mode | Behavior |
|------|----------|
| `append` (default) | Agent body is prepended to pi's system prompt |
| `replace` | Agent body replaces pi's prompt (primary agents: same as `append` in inline mode) |
| `replace-all` | Only the agent body is used — pi's prompt is discarded entirely |

For **subagents** (child process), the agent body **is** the system prompt — pi's default
prompt is not included. If the agent has `skills:`, they are injected as an XML block
after the body.

## Discovery paths

Agents are loaded from multiple locations (project overrides global by name):

| Path | Scope | Format |
|------|-------|--------|
| `~/.pi/agent/agents/*.md` | Global | pi |
| `~/.opencode/{agent,agents,mode}/*.md` | Global | OpenCode |
| `.pi/agents/*.md` | Project | pi |
| `.opencode/{agent,agents,mode}/*.md` | Project | OpenCode |
| `.agents/*.md` | Project | Shared |

### Mode-based visibility

| `mode` | TUI selector | `subagent` tool | `set_agent` tool |
|--------|-------------|-----------------|------------------|
| `primary` | ✅ visible | ❌ | ✅ |
| `subagent` | ❌ | ✅ available | ✅ |
| `all` (default) | ✅ visible | ✅ available | ✅ |

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

## Migration from pi-agent-mode + pi-subagents

1. Install: `pi install pi-open-agents`
2. Remove `npm:pi-agent-mode` and `npm:@johnnywu/pi-subagents` from settings
3. Existing agent `.md` files work without changes (default `mode: all`)
4. Gradually add `mode: primary` or `mode: subagent` to control visibility
5. Gradually adopt `permission:` over `tools:` whitelist

### Using OpenCode agents in pi

If you already have OpenCode agent definitions in `.opencode/agent/`, they work
out of the box — no conversion needed:

```yaml
---
# OpenCode format — works as-is in pi
name: triage
mode: subagent
model: openai/gpt-4o
tools:
  read: true
  bash: false
description: Triages issues by reading and categorizing them.
---
You are an issue triage agent...
```

The `tools` map is automatically converted to permission rules (`true` → `allow`,
`false` → `deny`). Fields that are pi-specific (`thinking`, `maxDepth`,
`allowedAgents`) are ignored by OpenCode without breaking.

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

## Attribution

This project builds on code and ideas from:

- [pi-agent-mode](https://github.com/ZGltYQ/agent-mode) by ZGltYQ (MIT)
- [pi-subagents](https://github.com/jwu/pi-subagents) by jwu (MIT)
- [opencode](https://github.com/sst/opencode) by sst (MIT)

See [ATTRIBUTION.md](./ATTRIBUTION.md) for details.

## License

MIT
