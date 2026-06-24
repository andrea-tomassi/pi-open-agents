# pi-open-agents

Unified agent and subagent management for [pi](https://github.com/earendil-works/pi-coding-agent), with [OpenCode](https://github.com/sst/opencode)-compatible agent definitions.

Replaces `pi-agent-mode` and `@johnnywu/pi-subagents` with a single, coherent system.

## Why

Pi delegates agent management to two separate npm plugins that use incompatible frontmatter schemas, divergent defaults, and fragmented semantics. This plugin replaces both with one unified system that also reads OpenCode-format agent definitions.

## Features

- **Unified agent definitions** — one `.md` file format, superset of OpenCode + pi
- **Mode-based visibility** — `primary` agents in the TUI selector, `subagent` agents for delegation, `all` for both
- **OpenCode-compatible** — reads agents from `.opencode/agent/`, `.opencode/mode/`, and `.agents/`
- **Permission system** — OpenCode-style `allow`/`deny`/`ask` with glob patterns, last-match-wins
- **Thinking level per-agent** — `off`/`minimal`/`low`/`medium`/`high`/`xhigh`, with fallback to `settings.json`
- **Subagent execution** — child pi process spawning with scoped tools, skills, and session fork
- **Skill loading** — per-agent skills with wildcard support (`lark-*`, `github`)

## Installation

```bash
pi install pi-open-agents
```

Then remove the old plugins from `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "pi-open-agents"
  ]
}
```

## Agent Definition Format

```yaml
---
# === Identity ===
name: my-agent                    # required
description: When to use this agent
mode: primary|subagent|all        # default: all
hidden: false                     # hide from TUI selectors
color: "#44BA81"

# === Model ===
model: provider/model-id          # per-agent override
variant: thinking                 # model variant
temperature: 0.7
top_p: 0.95

# === Execution ===
thinking: xhigh                   # off|minimal|low|medium|high|xhigh
steps: 50                         # max agentic iterations
systemPrompt: append|replace|replace-all  # default: append

# === Permissions (OpenCode-style) ===
permission:
  bash: allow
  edit:
    "*.env": deny
    "*.md": allow
  read: allow

# === Subagent controls ===
maxDepth: 10                      # recursion limit
allowedAgents: worker, explorer   # which subagents this can spawn
skills: lark-*, github            # per-agent skills with wildcards
---
You are a specialized agent. Your markdown body becomes the system prompt.
```

## Discovery Paths

Agents are loaded from multiple locations (project overrides global by name):

| Path | Scope | Format |
|------|-------|--------|
| `~/.pi/agent/agents/*.md` | Global | pi |
| `~/.opencode/{agent,agents,mode}/*.md` | Global | OpenCode |
| `.pi/agents/*.md` | Project | pi |
| `.opencode/{agent,agents,mode}/*.md` | Project | OpenCode |
| `.agents/*.md` | Project | Shared |

## Usage

### Interactive

| Action | What it does |
|---|---|
| `/agent` | Open agent selector (primary/all only) |
| `/agent <name>` | Switch to agent directly |
| `/agents` | List all agents |
| `/agent-search <query>` | Search agents |
| `Ctrl+Shift+M` | Cycle agents |
| `Alt+S` | Search prompt |
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

## Development

```bash
npm install
npm test          # 84 tests
npm run typecheck # tsc --noEmit
```

## Attribution

This project builds on code and ideas from:

- [pi-agent-mode](https://github.com/ZGltYQ/agent-mode) by ZGltYQ (MIT)
- [pi-subagents](https://github.com/jwu/pi-subagents) by jwu (MIT)
- [opencode](https://github.com/sst/opencode) by sst (MIT)

See `ATTRIBUTION.md` for details.

## License

MIT
