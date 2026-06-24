/**
 * Permission evaluator.
 *
 * Implements last-match-wins evaluation (like CSS specificity).
 *
 * Given a tool name and its argument, walks the rule list in order.
 * The last matching rule determines the action.
 * If no rule matches, the default action is "ask".
 *
 * Also provides:
 * - Tool → permission category mapping (write → edit, etc.)
 * - disabled() — tools that should never be sent to the LLM
 */

import type { PermissionAction, PermissionRule } from "../types.ts";
import { matchPattern } from "./matcher.ts";

// ─── Tool → Permission Mapping ───────────────────────────────────────────────

/**
 * Map a tool name to its permission category.
 *
 * Multiple tools can share a permission category:
 *   write, edit, apply_patch  → "edit"
 *   list_mcp_resources, read_mcp_resource → "read"
 *
 * Everything else maps by tool name directly.
 */
export function toolToPermission(toolName: string): string {
  // File-editing tools all map to "edit"
  if (toolName === "write" || toolName === "edit" || toolName === "apply_patch") {
    return "edit";
  }

  // MCP read tools map to "read"
  if (toolName === "list_mcp_resources" || toolName === "read_mcp_resource") {
    return "read";
  }

  // Everything else uses its own name as the permission key
  return toolName;
}

// ─── Evaluation ──────────────────────────────────────────────────────────────

export interface EvalResult {
  /** The action to take: allow, deny, or ask */
  action: PermissionAction;
  /** The permission category that was matched */
  permission: string;
  /** The pattern that was matched, or "*" if no rule matched */
  pattern: string;
  /** Whether any rule matched (false = default action applied) */
  matched: boolean;
}

/**
 * Evaluate permission for a tool call.
 *
 * @param toolName    The tool being called (e.g. "edit", "bash")
 * @param arg         The primary argument (file path, command, etc.)
 * @param rules       Ordered permission rules (last-match-wins)
 * @returns           Evaluation result
 */
export function evaluate(
  toolName: string,
  arg: string | undefined,
  rules: PermissionRule[],
): EvalResult {
  const permission = toolToPermission(toolName);
  const value = arg ?? "";

  // Walk all rules, keep track of the last match
  let lastMatch: PermissionRule | undefined;

  for (const rule of rules) {
    // Permission must match (with wildcard support on the permission key too)
    if (!matchPermissionKey(rule.permission, permission)) continue;

    // Pattern must match the argument
    if (!matchPattern(rule.pattern, value)) continue;

    lastMatch = rule;
  }

  if (lastMatch) {
    return {
      action: lastMatch.action,
      permission: lastMatch.permission,
      pattern: lastMatch.pattern,
      matched: true,
    };
  }

  // No rule matched — default to "ask"
  return {
    action: "ask",
    permission,
    pattern: "*",
    matched: false,
  };
}

/**
 * Match a permission key, with wildcard support.
 *
 * "edit" matches "edit"
 * "*" matches anything
 * "edit" matches "e*" (not typical, but supported)
 */
function matchPermissionKey(rulePermission: string, toolPermission: string): boolean {
  if (rulePermission === "*") return true;
  return matchPattern(rulePermission, toolPermission);
}

// ─── Disabled Tools ──────────────────────────────────────────────────────────

/**
 * Determine which tools are disabled (should never be sent to the LLM).
 *
 * A tool is disabled if the last matching rule for it (with pattern "*")
 * is "deny". This means the tool is globally forbidden for this agent.
 *
 * Tools that are "ask" or "allow" with pattern "*" are NOT disabled —
 * they may be used, just with or without confirmation.
 *
 * @param toolNames  All available tool names
 * @param rules      Permission rules to evaluate against
 * @returns          Set of tool names that should be disabled
 */
export function getDisabledTools(
  toolNames: string[],
  rules: PermissionRule[],
): Set<string> {
  const disabled = new Set<string>();

  for (const toolName of toolNames) {
    const result = evaluate(toolName, undefined, rules);
    if (result.action === "deny" && result.pattern === "*") {
      disabled.add(toolName);
    }
  }

  return disabled;
}

/**
 * Filter a list of tools, removing disabled ones.
 */
export function filterDisabledTools<T extends { name: string }>(
  tools: T[],
  rules: PermissionRule[],
): T[] {
  const disabled = getDisabledTools(
    tools.map((t) => t.name),
    rules,
  );

  return tools.filter((t) => !disabled.has(t.name));
}
