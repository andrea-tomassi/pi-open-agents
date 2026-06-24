# Test Workspace

This is a dummy project for manual testing of pi-open-agents inside Docker.

## Structure

```
test-workspace/
├── .pi/agents/               ← Project pi agents
│   ├── primary-coder.md       (mode: primary, full permissions)
│   ├── primary-researcher.md  (mode: primary, restricted, zai/glm-5.2)
│   ├── subagent-explorer.md   (mode: subagent, read-only)
│   ├── subagent-tester.md     (mode: subagent, QA, zai/glm-5.2)
│   ├── dual-purpose.md        (mode: all)
│   └── hidden-admin.md        (mode: primary, hidden: true)
├── .opencode/agent/          ← OpenCode format agents
│   └── oc-triage.md           (tools map style, tests OC compat)
├── .agents/                  ← Shared format
│   └── shared-utility.md
└── README.md
```

## What to test

| # | Command | Expected |
|---|---------|----------|
| 1 | `/agents` | 8 agents listed (global-default + 7 project) |
| 2 | `/agent` | Selector shows: global-default, primary-coder, primary-researcher, dual-purpose (4 only — not subagents, not hidden) |
| 3 | Ctrl+Shift+M | Cycles through 4 selectable + (none) |
| 4 | `/agent primary-researcher` | Switches agent, banner shows `zai/glm-5.2 {xhigh}` |
| 5 | `Alt+S` then "explorer" | Search finds subagent-explorer |
| 6 | Ask LLM to delegate | `subagent` tool available, can spawn subagent-explorer/subagent-tester |
| 7 | `/agent hidden-admin` | Should fail (hidden, not in selector). But `set_agent` tool works |
| 8 | Permission test | Switch to primary-researcher, try editing a .env file → should be denied |
