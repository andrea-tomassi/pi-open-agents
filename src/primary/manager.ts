/**
 * Agent state management.
 *
 * Tracks the active agent, handles apply/clear/restore lifecycle,
 * and coordinates with the executor for model/thinking/tools/prompt.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentDefinition, ThinkingLevel } from "../types.ts";
import { applyAgentConfig } from "./executor.ts";

interface OriginalState {
  model: Model<any> | undefined;
  thinkingLevel: ThinkingLevel;
  toolNames: string[];
}

export class AgentManager {
  private agents: Map<string, AgentDefinition> = new Map();
  private activeName: string | undefined;
  private active: AgentDefinition | undefined;
  private originalState: OriginalState | undefined;
  private lastPersistedName: string | undefined;

  /** Reload agent definitions from the registry */
  setAgents(agents: AgentDefinition[]): void {
    this.agents = new Map(agents.map((a) => [a.name, a]));
  }

  getAgents(): AgentDefinition[] {
    return [...this.agents.values()];
  }

  getAgent(name: string): AgentDefinition | undefined {
    return this.agents.get(name);
  }

  getActive(): AgentDefinition | undefined {
    return this.active;
  }

  getActiveName(): string | undefined {
    return this.activeName;
  }

  isActive(name: string): boolean {
    return this.activeName === name;
  }

  /**
   * Apply an agent configuration to the current session.
   * Applies model, thinking level, tools, and stores the active agent.
   */
  async apply(name: string, pi: ExtensionAPI, ctx: ExtensionContext): Promise<boolean> {
    const agent = this.agents.get(name);
    if (!agent) return false;

    // Snapshot state on first apply (for restore on clear)
    if (this.activeName === undefined) {
      this.originalState = {
        model: ctx.model,
        thinkingLevel: pi.getThinkingLevel() as ThinkingLevel,
        toolNames: pi.getAllTools().map((t) => t.name),
      };
    }

    this.activeName = name;
    this.active = agent;

    await applyAgentConfig(agent, pi, ctx);

    return true;
  }

  /**
   * Clear the active agent and restore original state.
   */
  async clear(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
    if (this.originalState) {
      // Restore model
      if (this.originalState.model) {
        await pi.setModel(this.originalState.model);
      }
      // Restore thinking level
      pi.setThinkingLevel(this.originalState.thinkingLevel);
      // Restore tools
      pi.setActiveTools(this.originalState.toolNames);
    } else {
      // No snapshot — just restore all tools
      pi.setActiveTools(pi.getAllTools().map((t) => t.name));
    }

    this.activeName = undefined;
    this.active = undefined;
  }

  /**
   * Cycle to the next selectable agent (primary|all only).
   * Includes "(none)" to allow clearing.
   */
  async cycle(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
    const selectable = [...this.agents.values()]
      .filter((a) => !a.hidden && (a.mode === "primary" || a.mode === "all"))
      .map((a) => a.name)
      .sort();

    if (selectable.length === 0) return;

    const cycleList = ["(none)", ...selectable];
    const current = this.activeName ?? "(none)";
    const idx = cycleList.indexOf(current);
    const next = cycleList[idx === -1 ? 0 : (idx + 1) % cycleList.length];

    if (next === "(none)") {
      await this.clear(pi, ctx);
    } else {
      await this.apply(next, pi, ctx);
    }
  }

  // ─── Persistence ───────────────────────────────────────────────────────────

  /**
   * Check if agent state should be persisted (only on change).
   */
  shouldPersist(): boolean {
    return this.activeName !== undefined && this.activeName !== this.lastPersistedName;
  }

  markPersisted(): void {
    this.lastPersistedName = this.activeName;
  }

  /**
   * Restore agent from session state (without re-applying model/tools).
   * Used on session resume.
   */
  restoreFromSession(name: string): void {
    const agent = this.agents.get(name);
    if (agent) {
      this.activeName = name;
      this.active = agent;
      this.lastPersistedName = name;
    }
  }
}
