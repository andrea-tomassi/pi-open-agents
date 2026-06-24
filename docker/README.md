# Docker Testing for pi-open-agents

Isolated testing environment for pi-open-agents. No conflict with host pi installation.

## Quick Start

```bash
# Build the image
docker compose build

# Run pi interactively
docker compose run --rm pi-sandbox

# With a specific agent
docker compose run --rm pi-sandbox --agent primary-coder
```

## What's Inside

- **pi** installed globally (latest)
- **pi-open-agents** as the ONLY extension (no pi-agent-mode, no pi-subagents)
- **Auth + models** bind-mounted read-only from host
- **Test agents** in 3 formats: pi (`.pi/agents/`), OpenCode (`.opencode/agent/`), shared (`.agents/`)

## Hot Reload

The `src/` directory is bind-mounted. After editing TypeScript:

```bash
# Inside the container, in pi:
/reload
```

## Test Checklist

See `test-workspace/README.md` for the full checklist.

## Teardown

```bash
docker compose down
```

No host files are modified. Auth and models are read-only.
