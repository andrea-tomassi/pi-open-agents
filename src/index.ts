/**
 * pi-open-agents — Unified agent and subagent management for pi.
 *
 * Replaces pi-agent-mode and pi-subagents with a single, coherent system.
 * OpenCode-compatible agent definitions.
 *
 * F1: Foundation (types, parser, schema, discovery) ✅
 * F4: Permission engine (parser, matcher, evaluator) ✅
 * F2: Primary agents (this phase) ✅
 * F3: Subagent engine (planned)
 * F5: OpenCode compat (planned)
 * F6: Polish (planned)
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import type { AgentDefinition, ThinkingLevel } from "./types.ts";
import { loadAgents, selectableAgents } from "./discovery/loader.ts";
import { AgentManager } from "./primary/manager.ts";
import { refreshAgentTools, buildSystemPrompt } from "./primary/executor.ts";
import { updateBanner } from "./tui/banner.ts";
import { registerTuiControls } from "./tui/selector.ts";
import { registerAgentTools } from "./tui/tools.ts";

// ─── Settings ────────────────────────────────────────────────────────────────

interface Settings {
  defaultAgent?: string;
  defaultThinkingLevel?: ThinkingLevel;
}

function loadSettings(cwd: string): Settings {
  const globalPath = join(getAgentDir(), "settings.json");
  const projectPath = join(cwd, ".pi", "settings.json");

  let settings: Settings = {};

  for (const p of [globalPath, projectPath]) {
    if (existsSync(p)) {
      try {
        const content = readFileSync(p, "utf-8");
        const parsed = JSON.parse(content) as Settings;
        settings = { ...settings, ...parsed };
      } catch {
        // ignore invalid json
      }
    }
  }

  return settings;
}

// ─── Extension Entry Point ───────────────────────────────────────────────────

export default function piOpenAgents(pi: ExtensionAPI): void {
  const manager = new AgentManager();

  // ── Session Start: Load agents and apply default ───────────────────────────

  pi.on("session_start", async (event, ctx) => {
    // Load settings for thinking fallback
    const settings = loadSettings(ctx.cwd);

    // Load all agent definitions from discovery paths
    const result = await loadAgents({
      cwd: ctx.cwd,
      agentDir: getAgentDir(),
      defaults: { thinking: settings.defaultThinkingLevel ?? "off" },
    });

    // Log any parse warnings
    for (const w of result.warnings) {
      ctx.ui.notify(`Agent parse warning: ${w.filePath}: ${w.message}`, "warning");
    }

    manager.setAgents(result.agents);

    // Register TUI controls + tools (now that agents are loaded)
    registerTuiControls(manager, pi);
    registerAgentTools(manager, pi);

    // Check for --agent CLI flag first (highest priority)
    const agentFlag = pi.getFlag("agent");
    if (typeof agentFlag === "string" && agentFlag) {
      const agent = manager.getAgent(agentFlag);
      if (agent) {
        await manager.apply(agentFlag, pi, ctx);
      }
      updateBanner(ctx.ui, manager.getActive(), selectableAgents(manager.getAgents()).length);
      return;
    }

    // Try to restore from session state (if resuming)
    if (event.reason === "resume" || event.reason === "fork") {
      const entries = ctx.sessionManager.getEntries();
      const agentEntry = entries
        .filter((e: { type: string; customType?: string }) =>
          e.type === "custom" && e.customType === "open-agents-state")
        .pop() as { data?: { name: string } } | undefined;

      if (agentEntry?.data?.name) {
        manager.restoreFromSession(agentEntry.data.name);
        // Re-apply tools on resume (model preserved from session)
        const active = manager.getActive();
        if (active) {
          refreshAgentTools(active, pi);
        }
        updateBanner(ctx.ui, manager.getActive(), selectableAgents(manager.getAgents()).length);
        return;
      }
    }

    // Try to load from settings (defaultAgent)
    if (settings.defaultAgent) {
      const agent = manager.getAgent(settings.defaultAgent);
      if (agent) {
        await manager.apply(settings.defaultAgent, pi, ctx);
      }
    }

    // Show status
    updateBanner(ctx.ui, manager.getActive(), selectableAgents(manager.getAgents()).length);
  });

  // ── Before Agent Start: Inject system prompt + refresh tools ───────────────

  pi.on("before_agent_start", async (event) => {
    const active = manager.getActive();
    if (!active) return;

    // Re-evaluate tool set (catches async-registered tools like MCP)
    refreshAgentTools(active, pi);

    // Inject system prompt
    const modifiedPrompt = buildSystemPrompt(active, event.systemPrompt);
    if (modifiedPrompt) {
      return { systemPrompt: modifiedPrompt };
    }
  });

  // ── Turn Start: Persist agent state (only on change) ───────────────────────

  pi.on("turn_start", async () => {
    if (manager.shouldPersist()) {
      pi.appendEntry("open-agents-state", { name: manager.getActiveName() });
      manager.markPersisted();
    }
  });
}

// ─── Re-exports ──────────────────────────────────────────────────────────────

export * from "./types.ts";
export { parseFrontmatter } from "./config/frontmatter.ts";
export type { ParsedFrontmatter } from "./config/frontmatter.ts";
export { parseAgentDefinition, AgentParseError, SCHEMA_DEFAULTS } from "./config/schema.ts";
export type { SchemaDefaults } from "./config/schema.ts";
export { getDiscoveryPaths, deriveAgentName } from "./config/paths.ts";
export type { DiscoveryPath } from "./config/paths.ts";
export { loadAgents, selectableAgents, spawnableAgents, agentsAvailableTo } from "./discovery/loader.ts";
export type { LoadAgentsOptions } from "./discovery/loader.ts";
export { parsePermissionRules, mergePermissionConfigs } from "./permission/parser.ts";
export { matchPattern, isWildcardPattern } from "./permission/matcher.ts";
export { evaluate, toolToPermission, getDisabledTools, filterDisabledTools } from "./permission/evaluator.ts";
