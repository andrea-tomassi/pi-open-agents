/**
 * Recursion environment variable management.
 *
 * Controls subagent spawning depth, allowed agents, and system prompt mode
 * via environment variables passed from parent to child process.
 *
 * Renamed from PI_SUBAGENT_* (pi-subagents) to PI_OPEN_AGENTS_*.
 */

import type { SystemPromptMode } from "../types.ts";

// ─── Env Vars ────────────────────────────────────────────────────────────────

export type RecursionEnv = Partial<
  Record<
    | "PI_OPEN_AGENTS_DEPTH"
    | "PI_OPEN_AGENTS_MAX_DEPTH"
    | "PI_OPEN_AGENTS_NAME"
    | "PI_OPEN_AGENTS_SYSTEM_PROMPT_MODE"
    | "PI_OPEN_AGENTS_ALLOWED"
    | "PI_OPEN_AGENTS_SESSION"
    | "PI_OPEN_AGENTS_PARENT_RULES"
    | "PI_OPEN_AGENTS_DEBUG",
    string
  >
>;

// ─── Parsers ─────────────────────────────────────────────────────────────────

function parseEnvNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// ─── Queries ─────────────────────────────────────────────────────────────────

/**
 * Get the set of allowed agent names from env, or undefined if no restriction.
 */
export function allowedAgentNames(env: RecursionEnv): Set<string> | undefined {
  const raw = env?.PI_OPEN_AGENTS_ALLOWED;
  if (!raw) return undefined;
  return new Set(
    raw
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  );
}

/**
 * Check if the current process is past the max recursion depth.
 */
export function isPastMaxDepth(env: RecursionEnv): boolean {
  const depth = parseEnvNumber(env?.PI_OPEN_AGENTS_DEPTH);
  const maxDepth = parseEnvNumber(env?.PI_OPEN_AGENTS_MAX_DEPTH);
  return depth !== undefined && maxDepth !== undefined && depth > maxDepth;
}

/**
 * Check if the current process is a subagent (depth > 0).
 */
export function isSubagentProcess(env: RecursionEnv): boolean {
  const depth = parseEnvNumber(env?.PI_OPEN_AGENTS_DEPTH);
  return depth !== undefined && depth > 0;
}

/**
 * Get the parent's inherited deny/ask rules from env (issue #8).
 *
 * The delegating parent serializes the restrictive subset of its permission
 * rules (deny/ask, pattern-level included) as JSON. The child's permission
 * gate appends them after its own rules (last-match-wins → parent wins).
 * Malformed or absent → no inheritance (empty list).
 */
export function parentInheritedRules(
  env: RecursionEnv,
): Array<{ permission: string; pattern: string; action: "deny" | "ask" }> {
  const raw = env?.PI_OPEN_AGENTS_PARENT_RULES;
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is { permission: string; pattern: string; action: "deny" | "ask" } =>
        typeof r === "object" &&
        r !== null &&
        typeof (r as any).permission === "string" &&
        typeof (r as any).pattern === "string" &&
        ((r as any).action === "deny" || (r as any).action === "ask"),
    );
  } catch {
    return [];
  }
}

/**
 * Get the system prompt mode from env.
 */
export function getSystemPromptMode(env: RecursionEnv): SystemPromptMode | undefined {
  const mode = env?.PI_OPEN_AGENTS_SYSTEM_PROMPT_MODE;
  if (mode === "replace" || mode === "replace-all" || mode === "append") return mode;
  return undefined;
}

/**
 * Check if we're a subagent running with replace/replace-all system prompt mode.
 */
export function isSubagentReplaceSystemPrompt(env: RecursionEnv): boolean {
  const mode = getSystemPromptMode(env);
  return isSubagentProcess(env) && (mode === "replace" || mode === "replace-all");
}

// ─── Builders ────────────────────────────────────────────────────────────────

export interface SubagentEnvVars {
  depth: number;
  maxDepth: number;
  agentName: string;
  systemPromptMode: SystemPromptMode;
  session: "none" | "fork";
  allowedAgents?: string[];
  parentRules?: string;
  debug: boolean;
}

/**
 * Build the environment variables to pass to a child subagent process.
 */
export function buildSubagentEnv(vars: SubagentEnvVars): Record<string, string> {
  const env: Record<string, string> = {
    PI_OPEN_AGENTS_DEPTH: String(vars.depth),
    PI_OPEN_AGENTS_MAX_DEPTH: String(vars.maxDepth),
    PI_OPEN_AGENTS_NAME: vars.agentName,
    PI_OPEN_AGENTS_SYSTEM_PROMPT_MODE: vars.systemPromptMode,
    PI_OPEN_AGENTS_SESSION: vars.session,
    PI_OPEN_AGENTS_DEBUG: vars.debug ? "true" : "false",
  };

  if (vars.allowedAgents && vars.allowedAgents.length > 0) {
    env.PI_OPEN_AGENTS_ALLOWED = vars.allowedAgents.join(",");
  }

  if (vars.parentRules) {
    env.PI_OPEN_AGENTS_PARENT_RULES = vars.parentRules;
  }

  return env;
}
