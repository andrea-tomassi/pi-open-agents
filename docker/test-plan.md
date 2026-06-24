# Autonomous Test Plan

Tests that can be run non-interactively via `--mode print`.

## 1. Thinking level per-agent
- Agent with `thinking: xhigh` → verify it's applied
- Agent with `thinking: low` → verify it's different

## 2. System prompt injection
- Agent body should appear in system prompt
- Agent identity should be reflected in responses

## 3. Subagent mode filtering
- subagent-explorer (mode: subagent) should NOT be in TUI selector
- But should be spawnable via subagent tool

## 4. Allowed agents filtering
- Agent with allowedAgents should only see those subagents

## 5. Subagent depth control
- maxDepth should prevent infinite recursion

## 6. Hidden agent access
- hidden-admin should not be in selector
- But accessible via set_agent tool

## 7. OpenCode tools map → permission
- oc-triage should have read=allow, bash=deny, edit=deny

## 8. Permission edge cases
- Pattern-specific deny doesn't disable tool globally
- edit with *.env deny but *.md allow

## 9. Model switching
- Agent with model override should use that model

## 10. Session persistence
- Agent state should persist in session entries
