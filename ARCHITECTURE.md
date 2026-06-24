# pi-open-agents — Architecture

Unified agent and subagent management for [pi](https://github.com/earendil-works/pi-coding-agent),
with [OpenCode](https://github.com/anomalyco/opencode)-compatible agent definitions.

## Why this exists

Pi delegates agent management to two separate npm plugins that use incompatible
frontmatter schemas, divergent defaults, and fragmented semantics. This plugin
replaces both with a single, coherent system that is also cross-compatible with
OpenCode agent definitions.

See `ATTRIBUTION.md` for the source projects this builds upon.

---

## Core decisions

### 1. Single AgentDefinition — superset of all three systems

Every `.md` agent file produces one `AgentDefinition`, regardless of how it
will be executed (primary inline or subagent subprocess).

```typescript
interface AgentDefinition {
  // === Identity ===
  name: string;                             // required, unique key
  description?: string;                     // when-to-use text
  mode: "primary" | "subagent" | "all";    // OpenCode-compatible, default: "all"
  hidden: boolean;                          // hide from TUI selectors
  color?: string;                           // UI accent color
  disable: boolean;                         // remove agent entirely

  // === Model ===
  model?: string;                           // "provider/model-id"
  variant?: string;                         // model variant (e.g. "thinking")
  temperature?: number;                     // generation params
  topP?: number;

  // === Execution control ===
  thinking: ThinkingLevel;                  // off|minimal|low|medium|high|xhigh
  steps?: number;                           // max agentic iterations before text-only
  systemPrompt: SystemPromptMode;           // append|replace|replace-all

  // === Tools & permissions ===
  permission?: PermissionConfig;            // OpenCode-style allow/deny/ask rules
  tools?: string[];                         // simple whitelist (fallback if no permission)

  // === Subagent controls ===
  maxDepth: number;                         // recursion depth limit
  allowedAgents?: string[];                 // which subagents this agent can spawn
  skills?: string[];                        // per-agent skill loading with wildcards

  // === Content & metadata ===
  prompt: string;                           // markdown body (after frontmatter)
  source: "global" | "project";             // discovery origin
  filePath: string;                         // absolute path to .md file
}
```

### 2. Three-way agent visibility

The `mode` field controls where an agent appears:

| `mode` | TUI selector / cycle | subagent tool targets | `set_agent` tool |
|--------|---------------------|----------------------|------------------|
| `primary` | ✅ visible | ❌ hidden | ✅ available |
| `subagent` | ❌ hidden | ✅ available | ✅ available |
| `all` (default) | ✅ visible | ✅ available | ✅ available |

Additional filters:
- `hidden: true` — removes from TUI selectors but keeps programmatic access
- `disable: true` — removes from everything entirely

This keeps the interactive selector clean (only primary/all agents)
while subagents remain available for delegation.

### 3. Default `mode: all` (backward compatible)

If an agent does not specify `mode`, it defaults to `all` — meaning it works
both as a user-selectable agent and as a subagent target. This ensures
existing agent definitions continue to work without modification.

### 4. Permission as first-class citizen

The OpenCode permission system is adopted as the primary tool-restriction
mechanism, replacing the simple `tools` whitelist.

Permission rules use allow/deny/ask with glob patterns and last-match-wins
evaluation (like CSS specificity):

```yaml
permission:
  bash: allow
  edit:
    "*.env": deny
    "*.md": allow
  read: allow
  webfetch: ask
```

The `tools` field is kept as a fallback: if no `permission` is specified but
`tools` is present, it is converted to permission rules at parse time.

The permission engine is shared between both execution paths:

- **Primary agent**: filter available tools at apply time; evaluate before
  each tool call (allow = proceed, deny = reject, ask = prompt user)
- **Subagent**: inherit parent's deny rules + apply agent's own rules;
  passed to child process via environment variables

### 5. Separate execution, shared definition

```
AgentDefinition (shared)
    │
    ├── mode: primary|all → InlineExecutor (pi hooks)
    │   • setModel() / setThinkingLevel()
    │   • filter tools via permission engine
    │   • inject system prompt via before_agent_start
    │   • session runs inline in the same process
    │
    └── mode: subagent|all → SubprocessExecutor (child pi CLI)
        • build CLI args from AgentDefinition
        • spawn child process with scoped tools, model, thinking
        • stream JSON events from stdout
        • render live TUI progress
        • return result to parent agent
```

### 6. Thinking level unified

The thinking level is resolved consistently for both paths:

- **Primary**: `pi.setThinkingLevel(agent.thinking)` — falls back to
  `settings.json` `defaultThinkingLevel` if not specified
- **Subagent**: `--thinking {level}` CLI flag — same fallback to
  `settings.json`, NOT hardcoded `off`

This fixes the original bug where subagents always defaulted to `off`
regardless of global settings.

### 7. OpenCode compatibility layer

Compatibility is achieved through discovery path scanning and frontmatter
aliases, not a separate "OpenCode mode":

**Discovery paths** (all scanned, project overrides global by name):

```
Pi paths:
  ~/.pi/agent/agents/*.md
  .pi/agents/*.md

OpenCode paths:
  ~/.opencode/agent/*.md
  ~/.opencode/agents/*.md
  ~/.opencode/mode/*.md
  .opencode/agent/*.md
  .opencode/agents/*.md
  .opencode/mode/*.md

Shared paths:
  .agents/*.md
```

**Frontmatter aliases** (transparent at parse time):

| OpenCode field | Maps to | Notes |
|---|---|---|
| `prompt` (frontmatter field) | body content | If both frontmatter `prompt` and body exist, body wins |
| `tools` (map of bool) | `permission` rules | `true` → allow, `false` → deny |
| `maxSteps` | `steps` | Deprecated alias |

Fields that are OpenCode-only (`variant`, `temperature`, `topP`, `steps`,
`hidden`, `color`, `disable`) are stored but may be no-ops in pi until
the runtime supports them.

Fields that are pi-only (`thinking`, `systemPrompt`, `maxDepth`,
`allowedAgents`, `skills`) are ignored by OpenCode without breaking.

---

## Module structure

```
src/
├── index.ts                     # Entry point — wires everything together
├── types.ts                     # AgentDefinition, PermissionRule, AgentResult, etc.
│
├── config/
│   ├── frontmatter.ts           # Unified YAML parser (replaces both regex parsers)
│   ├── schema.ts                # Validation + normalization (aliases, defaults, deprecations)
│   └── paths.ts                 # Discovery path list (pi + opencode + shared)
│
├── discovery/
│   └── loader.ts                # Multi-path scan, parse, validate, merge global→project
│
├── permission/
│   ├── parser.ts                # PermissionConfig → PermissionRule[]
│   ├── matcher.ts               # Glob/wildcard pattern matching
│   └── evaluator.ts             # Last-match-wins evaluation → allow|deny|ask
│
├── primary/
│   ├── manager.ts               # Active agent state, applyAgent / restoreDefault
│   ├── executor.ts              # Model + thinking + tools + prompt injection via hooks
│   └── persistence.ts           # Session resume/fork state persistence
│
├── subagent/
│   ├── executor.ts              # Subprocess spawning, CLI args, env vars
│   ├── tool.ts                  # subagent tool registration + validation + depth check
│   ├── prompt.ts                # Child system prompt construction (skills XML)
│   ├── skills.ts                # Per-agent skill resolution with wildcard support
│   ├── render.ts                # TUI: collapsed/expanded view, nested recursive rendering
│   └── env.ts                   # PI_OPEN_AGENTS_* env var management (depth, allowed, etc.)
│
├── tui/
│   ├── selector.ts              # /agent command, Ctrl+Shift+M cycle (primary|all only)
│   ├── search.ts                # /agent-search, Alt+S, ranking algorithm
│   ├── banner.ts                # Status widget showing active agent
│   └── tools.ts                 # set_agent + search_agents programmatic tools
│
└── utils/
    ├── model.ts                 # "provider/model-id" parsing + registry resolution
    ├── fs.ts                    # File helpers, temp dir management, output archiving
    └── format.ts                # preview(), shortenPath(), truncate(), usage formatting
```

---

## Data flow

```
                    ┌─────────────────────────────┐
                    │   Agent .md files            │
                    │   (pi + opencode + shared)   │
                    └──────────────┬──────────────┘
                                   ↓
                    ┌──────────────────────────────┐
                    │       discovery/loader        │
                    │   scan paths → parse →        │
                    │   validate → merge            │
                    └──────────────┬───────────────┘
                                   ↓
                    ┌──────────────────────────────┐
                    │        AgentRegistry          │
                    │    (Map<name, Definition>)    │
                    └─────┬────────────────┬───────┘
                          │                │
          ┌───────────────▼──┐     ┌───────▼──────────────┐
          │  PRIMARY PATH     │     │  SUBAGENT PATH        │
          │                   │     │                       │
          │  session_start    │     │  subagent tool         │
          │       ↓           │     │  called by LLM         │
          │  applyAgent()     │     │       ↓                │
          │   • set model     │     │  filter by mode        │
          │   • set thinking  │     │  + allowedAgents       │
          │   • filter tools  │     │       ↓                │
          │     (permission)  │     │  build CLI args        │
          │   • inject prompt │     │       ↓                │
          │       ↓           │     │  spawn child pi        │
          │  before_agent_    │     │       ↓                │
          │  start hook       │     │  stream JSON events    │
          │       ↓           │     │       ↓                │
          │  session runs     │     │  render live TUI       │
          │  inline           │     │       ↓                │
          │                   │     │  return result         │
          └───────────────────┘     └───────────────────────┘
                    ↑                           ↑
                    │                           │
          ┌─────────┴───────────┐   ┌──────────┴──────────┐
          │  TUI selectors       │   │  Permission engine   │
          │  (primary|all only)  │   │  (shared, both paths)│
          │  + hidden filter     │   │                      │
          └─────────────────────┘   └──────────────────────┘
```

---

## TUI interaction model

### Interactive selection (primary agents only)

| Action | What it does |
|---|---|
| `/agent` | Opens selector showing `mode: primary \| all`, excludes `hidden` and `disable` |
| `/agent <name>` | Switch directly to a primary/all agent |
| `Ctrl+Shift+M` | Cycle through primary/all agents |
| `/agents` | List all agents with mode indicators |
| `/agent-search <query>` | Search across primary/all agents |
| `Alt+S` | Search prompt → ranked results |
| `--agent <name>` | CLI flag for startup agent |

### Programmatic switching (all agents)

| Tool | Scope |
|---|---|
| `set_agent` | Can switch to any agent except `disable: true` (ignores `hidden`) |
| `search_agents` | Searches all agents regardless of mode/hidden |

### Subagent delegation (subagents only)

| Tool | Scope |
|---|---|
| `subagent` | Lists `mode: subagent \| all` agents, filtered by parent's `allowedAgents` |

---

## Environment variables

Subagent recursion is controlled via environment variables passed to the
child process:

| Variable | Purpose |
|---|---|
| `PI_OPEN_AGENTS_DEPTH` | Current recursion depth (child = parent + 1) |
| `PI_OPEN_AGENTS_MAX_DEPTH` | Maximum depth allowed |
| `PI_OPEN_AGENTS_NAME` | Name of the running subagent |
| `PI_OPEN_AGENTS_SYSTEM_PROMPT_MODE` | `append \| replace \| replace-all` |
| `PI_OPEN_AGENTS_SESSION` | `none \| fork` |
| `PI_OPEN_AGENTS_ALLOWED` | Comma-separated visible subagent names |
| `PI_OPEN_AGENTS_PERMISSION` | Inherited deny rules from parent |
| `PI_OPEN_AGENTS_DEBUG` | `true \| false` |

---

## Implementation phases

| Phase | Scope | Output |
|---|---|---|
| **F1 — Foundation** | `types.ts`, `config/`, `discovery/` | Unified parser, validation, multi-path discovery. Unit-testable in isolation |
| **F4 — Permission** | `permission/` | Parser, matcher, evaluator. Standalone, no pi dependencies |
| **F2 — Primary** | `primary/`, `tui/` | Parity with pi-agent-mode + unified thinking + permission filtering + mode-based visibility |
| **F3 — Subagent** | `subagent/` | Parity with pi-subagents + unified thinking defaults + env var rename |
| **F5 — OpenCode compat** | `config/paths.ts`, `config/schema.ts` | OC discovery paths, frontmatter aliases, `tools` map conversion |
| **F6 — Polish** | CLI flag, persistence, edge cases, tests | Feature-complete, ready to replace both plugins |

**Recommended order**: F1 → F4 → F2 → F3 → F5 → F6

F2 and F3 are independent once F1 and F4 are complete.

---

## Migration path

When this plugin is ready to replace the existing plugins:

1. Install: `pi install pi-open-agents`
2. Remove from `settings.json` packages:
   - `npm:pi-agent-mode`
   - `npm:@johnnywu/pi-subagents`
3. Add: `pi-open-agents` (or `npm:pi-open-agents`)
4. Existing agent `.md` files continue to work without changes (default `mode: all`)
5. Gradually add `mode: primary` or `mode: subagent` to agent definitions
6. Gradually adopt `permission:` syntax over `tools:` whitelist
