/**
 * Programmatic tools for agent switching.
 *
 * Registers:
 * - set_agent: LLM-callable tool to switch agents
 * - search_agents: LLM-callable tool to search agents
 *
 * These tools can access all agents (including hidden ones),
 * bypassing the TUI mode-based filtering.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentDefinition } from "../types.ts";
import { selectableAgents } from "../discovery/loader.ts";
import type { AgentManager } from "../primary/manager.ts";
import { updateBanner } from "./banner.ts";

/**
 * Register the set_agent and search_agents tools.
 */
export function registerAgentTools(manager: AgentManager, pi: ExtensionAPI): void {
  // ─── set_agent tool ─────────────────────────────────────────────────────────

  pi.registerTool({
    name: "set_agent",
    label: "Set Agent",
    description:
      "Switch to a different agent mode programmatically. Use this when the current task requires a different set of tools or specialized behavior.",
    parameters: Type.Object({
      agent: Type.String({ description: "Name of the agent to switch to" }),
      reason: Type.Optional(Type.String({ description: "Reason for switching agents" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
      const { agent: name, reason } = params;

      const agent = manager.getAgent(name);
      if (!agent) {
        const available = manager.getAgents().map((a) => a.name).join(", ") || "(none defined)";
        throw new Error(`Unknown agent "${name}". Available: ${available}`);
      }

      const success = await manager.apply(name, pi, ctx);
      if (!success) {
        throw new Error(`Failed to apply agent "${name}"`);
      }

      const msg = reason ? `Switched to agent "${name}". Reason: ${reason}` : `Switched to agent "${name}"`;
      ctx.ui.notify(msg, "info");
      updateBanner(ctx.ui, manager.getActive(), selectableAgents(manager.getAgents()).length);

      return {
        content: [{ type: "text", text: msg }],
        details: { agent: name, reason },
      };
    },
  });

  // ─── search_agents tool ─────────────────────────────────────────────────────

  pi.registerTool({
    name: "search_agents",
    label: "Search Agents",
    description:
      "Search available agents by name, description, or body content. Returns ranked results with relevance scores and matching snippets.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query to match against agent name, description, or body content" }),
      limit: Type.Optional(Type.Number({ description: "Maximum number of results to return (default: 5)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx: ExtensionContext) {
      const { query, limit = 5 } = params;
      const agents = manager.getAgents();
      const results = rankAgents(agents, query).slice(0, limit);

      if (results.length === 0) {
        return {
          content: [{ type: "text", text: `No agents found matching "${query}".` }],
          details: { query, results: [] },
        };
      }

      const lines = results.map((r, i) => {
        const active = manager.isActive(r.name) ? " [ACTIVE]" : "";
        let line = `${i + 1}. ${r.name}${active} (score: ${r.score})`;
        if (r.agent.description) line += `\n   Description: ${r.agent.description}`;
        if (r.agent.model) line += `\n   Model: ${r.agent.model}`;
        if (r.snippets.length > 0) {
          line += `\n   Matches: ${r.snippets.slice(0, 2).join(" | ")}`;
        }
        return line;
      });

      const text = `Found ${results.length} agent(s) matching "${query}":\n\n${lines.join("\n\n")}`;

      return {
        content: [{ type: "text", text }],
        details: { query, totalResults: results.length, results },
      };
    },
  });
}

// ─── Agent Ranking ───────────────────────────────────────────────────────────

interface RankedAgent {
  name: string;
  agent: AgentDefinition;
  score: number;
  snippets: string[];
}

function rankAgents(agents: AgentDefinition[], query: string): RankedAgent[] {
  const q = query.toLowerCase();
  const results: RankedAgent[] = [];

  for (const agent of agents) {
    let score = 0;

    if (agent.name.toLowerCase() === q) score += 100;
    else if (agent.name.toLowerCase().includes(q)) score += 50;

    if (agent.description?.toLowerCase().includes(q)) score += 30;
    if (agent.model?.toLowerCase().includes(q)) score += 20;

    const bodyLower = agent.prompt.toLowerCase();
    const bodyMatches = (bodyLower.match(new RegExp(q, "g")) || []).length;
    score += Math.min(bodyMatches * 5, 25);

    if (score < 1) continue;

    const snippets: string[] = [];
    if (agent.description) {
      const idx = agent.description.toLowerCase().indexOf(q);
      if (idx !== -1) snippets.push(agent.description.slice(0, 80));
    }
    const bodyIdx = bodyLower.indexOf(q);
    if (bodyIdx !== -1) {
      const start = Math.max(0, bodyIdx - 20);
      const end = Math.min(agent.prompt.length, bodyIdx + q.length + 20);
      snippets.push(agent.prompt.slice(start, end).replace(/\n/g, " "));
    }

    results.push({ name: agent.name, agent, score, snippets });
  }

  return results.sort((a, b) => b.score - a.score);
}
