/**
 * TUI selectors for agent switching.
 *
 * Implements:
 * - Agent picker (selectlist with primary|all agents)
 * - Cycle shortcut (Ctrl+Shift+M)
 * - Search (Alt+S, /agent-search)
 * - Commands (/agent, /agents, /agent-search)
 */

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Key,
  type SelectItem,
  SelectList,
  Text,
} from "@earendil-works/pi-tui";
import type { AgentDefinition } from "../types.ts";
import { selectableAgents } from "../discovery/loader.ts";
import type { AgentManager } from "../primary/manager.ts";
import { updateBanner } from "./banner.ts";

// ─── Search Helpers ──────────────────────────────────────────────────────────

interface SearchResult {
  name: string;
  agent: AgentDefinition;
  score: number;
  snippets: string[];
}

/**
 * Score an agent against a search query.
 */
function scoreAgent(agent: AgentDefinition, query: string): number {
  const q = query.toLowerCase();
  let score = 0;

  if (agent.name.toLowerCase() === q) score += 100;
  else if (agent.name.toLowerCase().includes(q)) score += 50;

  if (agent.description?.toLowerCase().includes(q)) score += 30;
  if (agent.model?.toLowerCase().includes(q)) score += 20;

  const bodyLower = agent.prompt.toLowerCase();
  const bodyMatches = (bodyLower.match(new RegExp(q, "g")) || []).length;
  score += Math.min(bodyMatches * 5, 25);

  return score;
}

/**
 * Extract context snippets around query matches.
 */
function extractSnippets(text: string, query: string, max = 2, len = 40): string[] {
  const q = query.toLowerCase();
  const lower = text.toLowerCase();
  const snippets: string[] = [];
  let pos = 0;

  while (pos < lower.length && snippets.length < max) {
    const idx = lower.indexOf(q, pos);
    if (idx === -1) break;

    const start = Math.max(0, idx - len);
    const end = Math.min(text.length, idx + q.length + len);
    let snippet = text.slice(start, end).replace(/\n/g, " ");
    if (start > 0) snippet = "…" + snippet;
    if (end < text.length) snippet += "…";

    snippets.push(snippet);
    pos = idx + q.length;
  }

  return snippets;
}

/**
 * Search agents and return ranked results.
 */
function searchAgents(agents: AgentDefinition[], query: string, min = 1): SearchResult[] {
  if (!query.trim()) return [];

  const results: SearchResult[] = [];
  for (const agent of agents) {
    const score = scoreAgent(agent, query);
    if (score >= min) {
      const snippets: string[] = [];
      if (agent.description) {
        snippets.push(...extractSnippets(agent.description, query, 1, 30));
      }
      snippets.push(...extractSnippets(agent.prompt, query, 2, 35));
      results.push({ name: agent.name, agent, score, snippets });
    }
  }

  return results.sort((a, b) => b.score - a.score);
}

// ─── Description Builder ─────────────────────────────────────────────────────

function buildDescription(agent: AgentDefinition): string {
  const parts: string[] = [];
  if (agent.model) parts.push(agent.model);
  if (agent.thinking !== "off") parts.push(`thinking:${agent.thinking}`);
  if (agent.description) parts.push(agent.description);
  return parts.join(" | ") || "No description";
}

// ─── Picker UI ───────────────────────────────────────────────────────────────

/**
 * Render a generic agent picker using pi's custom component API.
 */
async function showPicker(
  ctx: ExtensionContext,
  items: SelectItem[],
  headerText: string,
  maxVisible: number,
): Promise<string | null> {
  return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold(headerText))));

    const selectList = new SelectList(items, Math.min(items.length, maxVisible), {
      selectedPrefix: (text: string) => theme.fg("accent", text),
      selectedText: (text: string) => theme.fg("accent", text),
      description: (text: string) => theme.fg("muted", text),
      scrollInfo: (text: string) => theme.fg("dim", text),
      noMatch: (text: string) => theme.fg("warning", text),
    });

    selectList.onSelect = (item) => done(item.value);
    selectList.onCancel = () => done(null);
    container.addChild(selectList);
    container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel")));
    container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

    return {
      render(width: number) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        selectList.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

// ─── Selection Handlers ──────────────────────────────────────────────────────

async function handleSelection(
  result: string | null,
  manager: AgentManager,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> {
  if (!result) return;

  if (result === "(none)") {
    await manager.clear(pi, ctx);
    ctx.ui.notify("Agent cleared, defaults restored", "info");
    updateBanner(ctx.ui, manager.getActive(), selectableAgents(manager.getAgents()).length);
    return;
  }

  const success = await manager.apply(result, pi, ctx);
  if (success) {
    updateBanner(ctx.ui, manager.getActive(), selectableAgents(manager.getAgents()).length);
  }
}

// ─── Public Functions ────────────────────────────────────────────────────────

/**
 * Show the agent selector UI (all primary|all agents).
 */
export async function showAgentSelector(
  manager: AgentManager,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> {
  const agents = selectableAgents(manager.getAgents());

  if (agents.length === 0) {
    ctx.ui.notify(
      "No selectable agents found. Create agent .md files in ~/.pi/agent/agents/ or .pi/agents/",
      "warning",
    );
    return;
  }

  const items: SelectItem[] = agents.map((agent) => ({
    value: agent.name,
    label: manager.isActive(agent.name) ? `${agent.name} (active)` : agent.name,
    description: buildDescription(agent),
  }));

  items.push({
    value: "(none)",
    label: "(none)",
    description: "Clear active agent, restore defaults",
  });

  const result = await showPicker(ctx, items, "Select Agent", 10);
  await handleSelection(result, manager, pi, ctx);
}

/**
 * Show search results UI.
 */
export async function showSearchResults(
  manager: AgentManager,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  query: string,
): Promise<void> {
  const agents = selectableAgents(manager.getAgents());
  const results = searchAgents(agents, query);

  if (results.length === 0) {
    ctx.ui.notify(`No agents found matching "${query}"`, "warning");
    return;
  }

  const items: SelectItem[] = results.map((r) => {
    const snippet = r.snippets.length > 0 ? r.snippets[0].slice(0, 80) : buildDescription(r.agent);
    const active = manager.isActive(r.name) ? " (active)" : "";
    return {
      value: r.name,
      label: `${r.name}${active} [${r.score}]`,
      description: snippet,
    };
  });

  const result = await showPicker(ctx, items, `Search: "${query}" (${results.length} found)`, 8);
  await handleSelection(result, manager, pi, ctx);
}

// ─── Command + Shortcut Registration ─────────────────────────────────────────

/**
 * Register all TUI commands, shortcuts, and CLI flags.
 */
export function registerTuiControls(manager: AgentManager, pi: ExtensionAPI): void {
  // CLI flag
  pi.registerFlag("agent", {
    description: "Default agent to use at startup",
    type: "string",
  });

  // Ctrl+Shift+M: Cycle agents
  pi.registerShortcut(Key.ctrlShift("m"), {
    description: "Cycle agents",
    handler: async (ctx) => {
      await manager.cycle(pi, ctx);
      updateBanner(ctx.ui, manager.getActive(), selectableAgents(manager.getAgents()).length);
    },
  });

  // Alt+S: Search agents
  pi.registerShortcut("alt+s", {
    description: "Search agents",
    handler: async (ctx) => {
      const query = await ctx.ui.input("Search agents:", "name, description, or content");
      if (query?.trim()) {
        await showSearchResults(manager, pi, ctx, query.trim());
      }
    },
  });

  // /agent command
  pi.registerCommand("agent", {
    description: "Switch active agent",
    handler: async (args, ctx: ExtensionCommandContext) => {
      if (args?.trim()) {
        const name = args.trim();
        if (name === "none" || name === "clear") {
          await manager.clear(pi, ctx);
          ctx.ui.notify("Agent cleared, defaults restored", "info");
          updateBanner(ctx.ui, manager.getActive(), selectableAgents(manager.getAgents()).length);
          return;
        }
        const success = await manager.apply(name, pi, ctx);
        if (!success) {
          const available = manager.getAgents().map((a) => a.name).join(", ") || "(none defined)";
          ctx.ui.notify(`Unknown agent "${name}". Available: ${available}`, "error");
          return;
        }
        updateBanner(ctx.ui, manager.getActive(), selectableAgents(manager.getAgents()).length);
        return;
      }
      await showAgentSelector(manager, pi, ctx);
    },
  });

  // /agents command
  pi.registerCommand("agents", {
    description: "List available agents",
    handler: async (_args, ctx) => {
      const agents = manager.getAgents();
      if (agents.length === 0) {
        ctx.ui.notify("No agents found.", "warning");
        return;
      }
      const lines = agents.map((a) => {
        const marker = manager.isActive(a.name) ? "● " : "○ ";
        const mode = a.mode === "all" ? "" : ` [${a.mode}]`;
        const desc = a.description ? ` - ${a.description}` : "";
        return `${marker}${a.name}${mode}${desc}`;
      });
      ctx.ui.notify(`Available agents:\n${lines.join("\n")}`, "info");
    },
  });

  // /agent-search command
  pi.registerCommand("agent-search", {
    description: "Search agents by name, description, or content",
    handler: async (args, ctx: ExtensionCommandContext) => {
      if (args?.trim()) {
        await showSearchResults(manager, pi, ctx, args.trim());
        return;
      }
      const query = await ctx.ui.input("Search agents:", "name, description, or content");
      if (query?.trim()) {
        await showSearchResults(manager, pi, ctx, query.trim());
      }
    },
  });
}
