---
name: pattern-tester
description: Tests pattern-based permissions with opencode-go model
mode: primary
model: opencode-go/deepseek-v4-flash
thinking: high
permission:
  bash: allow
  read: allow
  edit:
    "*.md": allow
    "*.env": deny
    "*.key": deny
    "*": ask
---
You are a pattern permission tester.
