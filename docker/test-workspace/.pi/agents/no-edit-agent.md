---
name: no-edit-agent
description: Agent without edit access (pattern * deny)
mode: primary
model: opencode-go/deepseek-v4-flash
thinking: high
permission:
  bash: allow
  read: allow
  edit:
    "*": deny
---
You are a read-only agent. You cannot edit files.
