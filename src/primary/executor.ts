/**
 * Agent executor — applies agent configuration to the current session.
 *
 * Handles:
 * - Model switching (provider/model-id resolution)
 * - Thinking level (per-agent, with fallback to session default)
 * - Tool filtering via permission engine
 * - System prompt injection (via before_agent_start hook)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentDefinition, ModelRef, PermissionRule } from "../types.ts";
import { parsePermissionRules } from "../permission/parser.ts";
import { getDisabledTools } from "../permission/evaluator.ts";
import { spawnableAgents } from "../discovery/loader.ts";

// ─── Model Resolution ────────────────────────────────────────────────────────

/**
 * Parse a model reference string "provider/model-id" into components.
 */
export function parseModelRef(ref: string): ModelRef | undefined {
  const slashIdx = ref.indexOf("/");
  if (slashIdx === -1) return undefined;
  return {
    provider: ref.slice(0, slashIdx),
    modelId: ref.slice(slashIdx + 1),
  };
}

/**
 * Apply model override if the agent specifies one.
 */
async function applyModel(agent: AgentDefinition, pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  if (!agent.model) return;

  const ref = parseModelRef(agent.model);
  if (!ref) return;

  const model = ctx.modelRegistry.find(ref.provider, ref.modelId);
  if (!model) {
    const available = ctx.modelRegistry.getAvailable().map((m: Model<any>) => `${m.provider}/${m.id}`).join(", ");
    ctx.ui.notify(
      `Agent "${agent.name}": Model ${ref.provider}/${ref.modelId} not found in registry. Available: ${available}`,
      "warning",
    );
    return;
  }

  const success = await pi.setModel(model);
  if (!success) {
    ctx.ui.notify(
      `Agent "${agent.name}": No API key for ${ref.provider}/${ref.modelId}`,
      "warning",
    );
  }
}

// ─── Thinking Level ──────────────────────────────────────────────────────────

/**
 * Apply thinking level override.
 * Falls back to the session's current thinking level if agent doesn't specify one.
 */
function applyThinking(agent: AgentDefinition, pi: ExtensionAPI): void {
  // Cast: pi-open-agents accepts "max" (aligned with CLI); pi-agent-core type lags behind
  pi.setThinkingLevel(agent.thinking as any);
}

// ─── Tool Filtering ──────────────────────────────────────────────────────────

/**
 * Apply tool restrictions based on agent configuration.
 *
 * Logic:
 * 1. If agent has permission rules → filter via permission engine
 * 2. Else if agent has tools whitelist → filter to only those
 * 3. Otherwise → all tools active
 *
 * Filtering covers ALL registered tool sources (builtin, extension, MCP,
 * SDK): a restricted profile can hide extension tools (web, LSP, …) from
 * the model, not just block their calls. Only blanket `deny` rules hide a
 * tool statically — argument-pattern denies and `ask` stay enforced by the
 * runtime gate (#20), which also remains the backstop for tools registered
 * after the agent started (issue #18).
 *
 * @returns The applied active tool names (for the subagent-hidden warning).
 */
export function computeActiveTools(
  agent: AgentDefinition,
  allTools: Array<{ name: string }>,
): string[] {
  // Case 1: Permission-based filtering (all sources)
  if (agent.permission) {
    const rules = parsePermissionRules(agent.permission);
    const disabled = getDisabledTools(
      allTools.map((t) => t.name),
      rules,
    );
    return allTools.filter((t) => !disabled.has(t.name)).map((t) => t.name);
  }

  // Case 2: Simple tools whitelist (all sources)
  if (agent.tools && agent.tools.length > 0) {
    const whitelist = new Set(agent.tools.map((t) => t.toLowerCase()));
    return allTools
      .filter((t) => whitelist.has(t.name.toLowerCase()))
      .map((t) => t.name);
  }

  // Case 3: No restrictions — keep all tools
  return allTools.map((t) => t.name);
}

function applyTools(agent: AgentDefinition, pi: ExtensionAPI): string[] {
  const active = computeActiveTools(agent, pi.getAllTools());
  pi.setActiveTools(active);
  return active;
}

/**
 * Warn when an agent's static restrictions hide the `subagent` tool (#18).
 *
 * Without it the model cannot delegate at all — that may be exactly what a
 * locked-down profile wants, but it must be a deliberate choice, never a
 * surprise from an allowlist that simply forgot to name it.
 */
export function warnIfHidingSubagent(
  agent: AgentDefinition,
  allNames: string[],
  activeNames: string[],
  ui: ExtensionContext["ui"],
): void {
  const restricted = agent.permission !== undefined || (agent.tools?.length ?? 0) > 0;
  if (!restricted) return;
  if (!allNames.includes("subagent")) return;
  if (activeNames.includes("subagent")) return;
  ui.notify(
    `Agent "${agent.name}": tool restrictions hide the "subagent" tool — this agent cannot delegate. ` +
      `Add "subagent" to the allowlist if delegation is intended.`,
    "warning",
  );
}

// ─── Main Entry Point ────────────────────────────────────────────────────────

/**
 * Apply an agent's model, thinking, and tools configuration.
 * System prompt injection happens in the before_agent_start hook.
 */
export async function applyAgentConfig(
  agent: AgentDefinition,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> {
  await applyModel(agent, pi, ctx);
  applyThinking(agent, pi);
  const before = pi.getAllTools().map((t) => t.name);
  const active = applyTools(agent, pi);
  warnIfHidingSubagent(agent, before, active, ctx.ui);
}

/**
 * Re-evaluate tool restrictions.
 * Called from before_agent_start to catch async-registered tools.
 */
export function refreshAgentTools(agent: AgentDefinition, pi: ExtensionAPI): void {
  applyTools(agent, pi);
}

/**
 * Build subagent delegation guidance to inject into the system prompt.
 *
 * Teaches the model HOW to delegate — specifically that subagent names
 * are NOT CLI commands and must be invoked via the `subagent` tool.
 * This is injected automatically, so agent authors don't need to explain
 * the delegation mechanism in their prompts.
 *
 * Works for both primary agents and subagent child processes.
 */
export function buildSubagentGuidance(
  agents: AgentDefinition[],
  allowedAgents?: string[],
): string | undefined {
  const allSpawnable = spawnableAgents(agents);

  // Filter by allowedAgents whitelist if specified
  let available: AgentDefinition[];
  if (allowedAgents && allowedAgents.length > 0) {
    const allowed = new Set(allowedAgents);
    available = allSpawnable.filter((a) => allowed.has(a.name));
  } else {
    available = allSpawnable;
  }

  if (available.length === 0) return undefined;

  const list = available
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((a) => `- ${a.name}: ${a.description ?? "Subagent for delegated tasks."}`)
    .join("\n");

  return `\n\n## Subagent Delegation\n\nYou have ${available.length} subagent(s) available. Delegate isolated tasks using the \`subagent\` tool:\n\nsubagent({ agent: "<name>", task: "<task description>" })\n\nAvailable subagents:\n${list}\n\nSubagent output: every run saves its full output to a temp file and returns only a short outcome summary — open the file only if the summary is not enough to decide your next step. Pass \`output: "<path>"\` when the deliverable itself is a file (report, patch, doc): the child writes it there and cites it in its summary. On failure the child always returns the error inline.\n\nIMPORTANT: Subagent names are NOT bash commands. Always use the \`subagent\` tool to delegate — never write scripts that call agent names as CLI commands.`;
}

/**
 * Build the system prompt injection for the active agent.
 *
 * Returns the modified system prompt (agent body prepended),
 * or undefined if no injection is needed.
 */
export function buildSystemPrompt(
  agent: AgentDefinition,
  currentPrompt: string,
): string | undefined {
  if (!agent.prompt) return undefined;

  switch (agent.systemPrompt) {
    case "append":
      // Prepend agent body to system prompt
      return `${agent.prompt}\n\n${currentPrompt}`;

    case "replace":
      // Replace the provider/system prompt entirely with the agent body
      return agent.prompt;

    case "replace-all":
      // Full replacement — only agent body
      return agent.prompt;

    default:
      return undefined;
  }
}
