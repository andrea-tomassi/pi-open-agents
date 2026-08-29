# pi × Herdr × pi-open-agents — the fleet stack

This page documents the stack we run in production on our workstations:
[Herdr](https://herdr.dev) (terminal workspace manager for AI coding agents) +
[pi](https://pi.dev) (the agent kernel) + **pi-open-agents** (agent definitions,
permissions, in-process delegation).

Three orthogonal layers, zero overlap:

```
Herdr            fleet: workspaces, tabs, panes, dispatch, monitoring, cross-agent
pi               kernel: one agent, one session — context, skills, tools
pi-open-agents   in-pi: .agent.md definitions, permissions, subagent delegation
```

pi deliberately stays minimal ("no built-in sub-agents, permission popups, …").
Herdr deliberately has no LLM. The plugin binds agent *policy* to pi.
Together they cover the full spectrum.

---

## Why Herdr (and not tmux)

tmux multiplexes terminals. Herdr multiplexes **agents**. The difference:

| | tmux | Herdr |
|---|---|---|
| Workspaces/tabs/panes | ✅ | ✅ |
| **Persistence** | Server survives close, but panes are anonymous shells | Server **+ identity**: workspace bound to a repo cwd, tab/pane state persisted (`session.json`), agents reattach with their live session |
| **Mouse usage** | Optional, clunky, config-dependent | First-class: focus, resize, sidebar, scroll — VS Code-style sidebar plugin (file explorer + source control) included |
| **Agent awareness** | None — panes are opaque | Detects **25 agent kinds** (pi first-class); tracks lifecycle `idle / working / blocked / done` |
| **Kernel-level state** | N/A | Agents *push* their state via socket — for pi, Herdr has `full_lifecycle_hook_authority` (no screen-scraping) |
| **Session correlation** | N/A | Maps each pane to the exact pi session JSONL file |
| **Scriptable fleet API** | tmux CLI, string-based | JSON CLI: `herdr agent list/prompt/read/wait/send-keys` — an agent can drive other agents |
| **Git worktrees** | DIY | `herdr worktree create/open` for parallel work on one repo |
| **Notifications** | None | Desktop notifications when background agents finish or block |

The killer feature is **agent-to-agent awareness**: any agent running inside a
Herdr pane gets `HERDR_ENV=1`, a socket API, and (with the Herdr skill
installed) can inspect siblings, dispatch prompts, wait for `blocked` states,
and harvest results. A pi orchestrator can literally herd a team of pi
workers — or mix kinds (pi + codex + claude in one fleet).

---

## Tutorial — reproduce our workstation setup

Tested on our Ubuntu workstation, Herdr 0.8.2, pi + pi-open-agents.

### 1. Install Herdr

```bash
curl -fsSL https://herdr.dev/install.sh | sh
```

Also available via Homebrew, mise, Nix, and Windows PowerShell
(`irm https://herdr.dev/install.ps1 | iex`). Updates: `herdr update`.
License: Apache 2.0. Full docs: <https://herdr.dev/docs/install/>.

### 2. Install the pi integration (lifecycle authority)

```bash
herdr integration install pi
```

This drops a small managed extension (`~/.pi/agent/extensions/herdr-agent-state.ts`)
that pushes `working / blocked / idle` states from inside pi to the Herdr
server via socket, and exposes the live session file path. This is what gives
Herdr authoritative state — no terminal scraping.

### 3. Install pi-open-agents

```bash
pi install npm:pi-open-agents
```

Your `.agent.md` files (pi, OpenCode, or shared `.agents/` layout) now drive
per-agent model, thinking, permissions, and subagent tool restrictions.

### 4. (Recommended) Install the Herdr skill into pi

Gives the agent itself fleet-control capability:

```bash
npx skills add herdrdev/herdr --skill herdr -g
```

### 5. Spawn a fleet

Split a pane (keep focus where you are) and start named agents:

```bash
herdr pane split --current --direction right --cwd "$PWD" --no-focus
herdr agent start reviewer --kind pi --pane <pane-id> --  # pi in the new pane
herdr agent prompt reviewer "Review the current diff." --wait
herdr agent read reviewer --source recent-unwrapped --lines 120
```

---

## Reference setup (our machine)

One workspace bound to the monorepo root, one tab per mission, roles encoded
in tab titles. `herdr agent list` at any moment:

```
π - [prod]   tracker                  idle
π - [client] acme                     idle
π - [client] portal                   idle
π - [client] contoso                  idle
π - [infra]  gpu                      idle
π - [oss]    pi-open-agents           working
```

Six pi agents, six independent sessions, one screen. Each tab's agent carries
its own pi-open-agents config — e.g. the `[infra]` agent runs with a
restricted `tools:` map (`read`, `bash` scoped to kubectl/systemctl patterns),
while `[oss]` gets the full toolset. Herdr supervises the fleet; pi-open-agents
defines what each soldier may do.

### Operating patterns we use daily

- **Dispatch & wait**: `agent prompt --wait` sends work and returns on the
  first settled state (`idle`/`done`/`blocked`)
- **Approval routing**: `agent wait <name> --until blocked` — park a watcher
  on agents that will ask for confirmation; you (the human) get a desktop
  notification instead of watching panes
- **Harvest**: `agent read --source recent-unwrapped` pulls the tail of a
  finished run; long outputs are read from files the agent writes on request
- **Parallel isolation**: `herdr worktree create` + one agent per worktree —
  two agents refactor the same repo without stepping on each other

---

## How this maps to the ecosystem's most-wanted features

- **Agent Teams / multi-agent orchestration** (the top request on Gemini CLI,
  Crush, Claude Code) → solved by the stack, not by bloating the kernel:
  Herdr is the orchestrator layer, pi the executor, pi-open-agents the policy
- **Fleet UI** → Herdr sidebar replaces any in-TUI agent dashboard
- **Parallel-limit guardrails** → breadth is managed at the fleet level;
  in-process subagents keep their own (see roadmap #11)

> Herdr is an independent project (Apache 2.0) — we document it here because
> this is the stack this plugin is developed and daily-driven on.
