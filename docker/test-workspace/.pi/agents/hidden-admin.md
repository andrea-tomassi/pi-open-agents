---
name: hidden-admin
description: Hidden agent for privileged operations, not in selector
mode: primary
hidden: true
model: opencode-go/deepseek-v4-flash
thinking: high
permission:
  bash: allow
  read: allow
  edit: allow
  write: allow
---
You are an administrative agent with full access. Hidden from the interactive
selector but accessible via the set_agent tool.
