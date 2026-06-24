/**
 * Permission config parser.
 *
 * Flattens a PermissionConfig (from frontmatter) into a flat list of
 * PermissionRule objects that the evaluator can process.
 *
 * Input:
 *   bash: allow
 *   edit:
 *     "*.env": deny
 *     "*.md": allow
 *   read: allow
 *
 * Output:
 *   [
 *     { permission: "bash",  pattern: "*",    action: "allow" },
 *     { permission: "edit",  pattern: "*.env", action: "deny"  },
 *     { permission: "edit",  pattern: "*.md",  action: "allow" },
 *     { permission: "read",  pattern: "*",    action: "allow" },
 *   ]
 */

import type { PermissionConfig, PermissionRule } from "../types.ts";
import { toolToPermission } from "./evaluator.ts";

/**
 * Flatten a PermissionConfig into ordered PermissionRule[].
 *
 * Rules from nested objects are expanded with their pattern.
 * Simple string values get pattern "*".
 *
 * Permission keys are normalized via toolToPermission (write → edit, etc.)
 * so that both "write: deny" and "edit: deny" affect the edit tool.
 *
 * Order is preserved as written (object key order).
 */
export function parsePermissionRules(config: PermissionConfig): PermissionRule[] {
  const rules: PermissionRule[] = [];

  for (const [permission, value] of Object.entries(config)) {
    // Normalize tool name to permission category (write -> edit, etc.)
    const normalizedPerm = toolToPermission(permission);

    if (typeof value === "string") {
      // Simple form: bash: allow
      rules.push({
        permission: normalizedPerm,
        pattern: "*",
        action: value,
      });
    } else if (typeof value === "object" && value !== null) {
      // Pattern form: edit: { "*.env": deny, "*.md": allow }
      for (const [pattern, action] of Object.entries(value)) {
        if (typeof action === "string") {
          rules.push({
            permission: normalizedPerm,
            pattern,
            action,
          });
        }
      }
    }
  }

  return rules;
}

/**
 * Merge multiple permission configs into a single rule list.
 * Later configs take precedence (appended last, last-match-wins).
 */
export function mergePermissionConfigs(...configs: (PermissionConfig | undefined)[]): PermissionRule[] {
  const rules: PermissionRule[] = [];

  for (const config of configs) {
    if (!config) continue;
    rules.push(...parsePermissionRules(config));
  }

  return rules;
}
