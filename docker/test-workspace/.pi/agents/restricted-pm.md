---
name: restricted-pm
description: PM that can only delegate to explorer
mode: primary
model: opencode-go/deepseek-v4-flash
thinking: high
allowedAgents: subagent-explorer
permission:
  bash: allow
  read: allow
  edit: allow
---
You are a restricted project manager. You can only delegate to subagent-explorer.
