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
  if (!model) return;

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
  pi.setThinkingLevel(agent.thinking);
}

// ─── Tool Filtering ──────────────────────────────────────────────────────────

/**
 * Apply tool restrictions based on agent configuration.
 *
 * Logic:
 * 1. If agent has permission rules → filter via permission engine
 * 2. Else if agent has tools whitelist → filter to only those (builtin only)
 * 3. Otherwise → all tools active
 *
 * Extension-provided tools (MCP, SDK) always remain active.
 */
function applyTools(agent: AgentDefinition, pi: ExtensionAPI): void {
  const allTools = pi.getAllTools();

  // Case 1: Permission-based filtering
  if (agent.permission) {
    const rules = parsePermissionRules(agent.permission);
    const disabled = getDisabledTools(
      allTools.map((t) => t.name),
      rules,
    );
    const filtered = allTools
      .filter((t) => {
        // Always keep non-builtin tools (extensions, MCP)
        if (t.sourceInfo?.source !== "builtin") return true;
        return !disabled.has(t.name);
      })
      .map((t) => t.name);
    pi.setActiveTools(filtered);
    return;
  }

  // Case 2: Simple tools whitelist (builtin only)
  if (agent.tools && agent.tools.length > 0) {
    const whitelist = new Set(agent.tools.map((t) => t.toLowerCase()));
    const filtered = allTools
      .filter((t) => {
        if (t.sourceInfo?.source !== "builtin") return true;
        return whitelist.has(t.name.toLowerCase());
      })
      .map((t) => t.name);
    pi.setActiveTools(filtered);
    return;
  }

  // Case 3: No restrictions — keep all tools
  pi.setActiveTools(allTools.map((t) => t.name));
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
  applyTools(agent, pi);
}

/**
 * Re-evaluate tool restrictions.
 * Called from before_agent_start to catch async-registered tools.
 */
export function refreshAgentTools(agent: AgentDefinition, pi: ExtensionAPI): void {
  applyTools(agent, pi);
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
      // Replace the provider prompt but keep context files
      // In inline mode, we can only append — full replace requires
      // the subprocess executor (subagent path)
      // For primary agents, "replace" behaves like append for now
      return `${agent.prompt}\n\n${currentPrompt}`;

    case "replace-all":
      // Full replacement — only agent body
      return agent.prompt;

    default:
      return undefined;
  }
}
