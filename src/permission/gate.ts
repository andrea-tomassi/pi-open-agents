/**
 * Runtime permission gate.
 *
 * Enforces allow/deny/ask on every tool call via pi's `tool_call` hook:
 *
 * - deny  → the call is blocked with a model-visible reason
 * - ask   → interactive select dialog (allow once / always this session / deny)
 * - ask in a non-interactive process (headless subagent) → fail-closed block
 * - allow / no matching rule → the call proceeds
 *
 * This complements the static toolset filtering in `evaluator.ts`:
 * pre-filtering hides tools that are denied with pattern "*"; the gate
 * enforces argument-aware rules (file paths, bash commands) that cannot be
 * derived statically, and implements `ask` — which has no other executor.
 *
 * Semantics (documented):
 * - Rules are scoped by permission category: if the agent has no rule whose
 *   permission key matches the call's category, the call is not gated.
 * - Within a gated category, last-match-wins; a call that matches no pattern
 *   proceeds (unmatched ≠ ask — write an explicit `"*": "ask"` rule to ask
 *   for the remainder).
 * - A dialog returning "always" memoizes the category for the process
 *   (i.e. for the session — subagent children are separate processes).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { AgentDefinition, PermissionAction, PermissionRule } from "../types.ts";
import { evaluate, matchPermissionKey, toolToPermission } from "./evaluator.ts";
import { parsePermissionRules } from "./parser.ts";

// ─── Argument Extraction ─────────────────────────────────────────────────────

/**
 * Extract the string argument a permission pattern is matched against.
 *
 * - bash/powershell → the command
 * - file tools → the path (pi uses `file_path`; some tools use `path`)
 * - grep/find → path when present, else the pattern
 * - unknown tools → first conventional string field, else undefined
 *   (only `"*"` patterns match undefined)
 */
export function extractToolArg(toolName: string, input: Record<string, unknown>): string | undefined {
  const str = (key: string): string | undefined =>
    typeof input[key] === "string" ? (input[key] as string) : undefined;

  switch (toolName) {
    case "bash":
    case "powershell":
    case "shell":
      return str("command");
    case "read":
    case "edit":
    case "write":
    case "apply_patch":
    case "ls":
      return str("file_path") ?? str("path");
    case "grep":
    case "find":
      return str("path") ?? str("pattern");
    default:
      return str("path") ?? str("file_path") ?? str("command") ?? str("pattern") ?? str("url");
  }
}

// ─── Decision ────────────────────────────────────────────────────────────────

export interface GateDecision {
  /** Effective action for this call */
  action: PermissionAction;
  /** Permission category (write → edit, etc.) */
  category: string;
  /** Matched rule, if any */
  matched?: { permission: string; pattern: string; action: PermissionAction };
  /** Whether the call is gated at all (false = no rules for the category) */
  gated: boolean;
}

/**
 * Decide the effective action for a tool call.
 *
 * Ungated categories (no rules) return `allow` — this keeps the gate opt-in
 * per category and preserves behavior for agents without permission config.
 */
export function decideToolCall(
  toolName: string,
  input: Record<string, unknown>,
  rules: PermissionRule[],
): GateDecision {
  const category = toolToPermission(toolName);

  const categoryHasRules = rules.some((rule) => matchPermissionKey(rule.permission, category));
  if (!categoryHasRules) {
    return { action: "allow", category, gated: false };
  }

  const arg = extractToolArg(toolName, input);
  const result = evaluate(toolName, arg, rules);

  if (!result.matched) {
    // Explicit rules exist for the category but none matched this call:
    // unmatched proceeds (deny/ask lists are not exhaustive allowlists).
    return { action: "allow", category, gated: true };
  }

  return {
    action: result.action,
    category,
    gated: true,
    matched: { permission: result.permission, pattern: result.pattern, action: result.action },
  };
}

// ─── Reason Formatting ───────────────────────────────────────────────────────

function preview(value: string, max = 80): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function formatDenyReason(toolName: string, decision: GateDecision, arg: string | undefined): string {
  const rule = decision.matched;
  const target = arg ? ` (${preview(arg)})` : "";
  return `Permission denied: agent rules deny "${toolName}"${target} [rule: ${rule?.permission} "${rule?.pattern}" → deny]`;
}

function formatHeadlessAskReason(toolName: string, decision: GateDecision): string {
  const rule = decision.matched;
  return (
    `Permission required: the active agent asks for confirmation on "${toolName}" ` +
    `[rule: ${rule?.permission} "${rule?.pattern}" → ask], but this process is non-interactive ` +
    `(subagent) — the call was blocked (fail-closed). Add an explicit allow rule to permit it.`
  );
}

// ─── Gate Registration ───────────────────────────────────────────────────────

export interface PermissionGateOptions {
  /** Resolve the agent whose rules apply (active agent, or the subagent's own definition). */
  resolveAgent: () => AgentDefinition | undefined;
  /** Session-scoped "always allow" memo (per process). Injectable for tests. */
  alwaysAllow?: Map<string, boolean>;
  /**
   * Rules inherited from the delegating parent (#8). Appended AFTER the
   * agent's own rules — last-match-wins, so an inherited deny/ask always
   * beats the child's own allow for the same call (authority ceiling).
   */
  inheritedRules?: () => PermissionRule[];
}

/**
 * Register the permission gate on the `tool_call` event.
 *
 * Does nothing when neither the agent nor the chain contributes rules.
 */
export function registerPermissionGate(pi: ExtensionAPI, options: PermissionGateOptions): void {
  const alwaysAllow = options.alwaysAllow ?? new Map<string, boolean>();

  pi.on("tool_call", async (event, ctx: ExtensionContext) => {
    const agent = options.resolveAgent();
    const ownRules = agent?.permission ? parsePermissionRules(agent.permission) : [];
    const inherited = options.inheritedRules?.() ?? [];
    if (ownRules.length === 0 && inherited.length === 0) return undefined;

    const input = (event as { input?: Record<string, unknown> }).input ?? {};
    // Parent rules last: last-match-wins makes an inherited deny/ask beat
    // the child's own allow — the authority ceiling cannot be widened (#8).
    const rules = [...ownRules, ...inherited];
    const decision = decideToolCall(event.toolName, input, rules);

    if (!decision.gated || decision.action === "allow") return undefined;

    const arg = extractToolArg(event.toolName, input);

    if (decision.action === "deny") {
      return { block: true, reason: formatDenyReason(event.toolName, decision, arg) };
    }

    // ── ask ──
    if (alwaysAllow.get(decision.category)) return undefined;

    if (!ctx.hasUI) {
      return { block: true, reason: formatHeadlessAskReason(event.toolName, decision) };
    }

    const target = arg ? `: ${preview(arg)}` : "";
    const choice = await ctx.ui.select(
      `Permission: allow ${event.toolName}${target}?`,
      ["Allow once", "Allow always (this session)", "Deny"],
    );

    if (choice === "Allow always (this session)") {
      alwaysAllow.set(decision.category, true);
      return undefined;
    }
    if (choice === "Allow once") return undefined;

    const how = choice === undefined ? "no answer was given" : "the user denied it";
    return {
      block: true,
      reason: `Permission denied: ${how} for "${event.toolName}".`,
    };
  });
}
