/**
 * Agent discovery and loading.
 *
 * Scans all discovery paths (pi, OpenCode, shared), parses each .md file
 * into an AgentDefinition, and merges by name with project overriding global.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { AgentDefinition, AgentFs, AgentLoadResult } from "../types.ts";
import type { SchemaDefaults } from "../config/schema.ts";
import type { DiscoveryPath } from "../config/paths.ts";
import { deriveAgentName, getDiscoveryPaths } from "../config/paths.ts";
import { parseAgentDefinition } from "../config/schema.ts";
import { SCHEMA_DEFAULTS } from "../config/schema.ts";

// ─── Default Filesystem ──────────────────────────────────────────────────────

const defaultFs: AgentFs = {
  async listFiles(dir: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isFile() || entry.isSymbolicLink()) {
          if (entry.name.endsWith(".md")) {
            files.push(fullPath);
          }
        } else if (entry.isDirectory()) {
          // Recurse into subdirectories (for OpenCode-style nested agents)
          const nested = await this.listFiles(fullPath);
          files.push(...nested);
        }
      }
      return files.sort();
    } catch {
      return [];
    }
  },

  async readFile(filePath: string): Promise<string> {
    return fs.readFile(filePath, "utf8");
  },

  async exists(dir: string): Promise<boolean> {
    try {
      await fs.access(dir);
      return true;
    } catch {
      return false;
    }
  },
};

// ─── Load Options ────────────────────────────────────────────────────────────

export interface LoadAgentsOptions {
  /** Current working directory (project root). Defaults to process.cwd() */
  cwd?: string;
  /** pi agent directory. Defaults to ~/.pi/agent */
  agentDir?: string;
  /** Schema defaults (thinking level fallback). */
  defaults?: SchemaDefaults;
  /** Custom filesystem implementation (for testing). */
  fs?: AgentFs;
  /** Custom discovery paths (overrides auto-detection). */
  paths?: DiscoveryPath[];
}

// ─── Main Loader ─────────────────────────────────────────────────────────────

/**
 * Load all agent definitions from discovery paths.
 *
 * Scan order: global paths first, then project paths.
 * Merge rule: project overrides global by name.
 */
export async function loadAgents(options: LoadAgentsOptions = {}): Promise<AgentLoadResult> {
  const fileSystem = options.fs ?? defaultFs;
  const cwd = options.cwd ?? process.cwd();
  const agentDir = options.agentDir ?? defaultAgentDir();
  const defaults = options.defaults ?? SCHEMA_DEFAULTS;

  // Build discovery paths
  const paths = options.paths ?? getDiscoveryPaths(cwd, agentDir);

  // Scan each path, collecting agents grouped by source
  const globalAgents = new Map<string, AgentDefinition>();
  const projectAgents = new Map<string, AgentDefinition>();
  const warnings: AgentLoadResult["warnings"] = [];

  for (const discPath of paths) {
    // For each subdir pattern, scan the directory
    for (const subdir of discPath.subdirs) {
      const scanDir = subdir ? path.join(discPath.dir, subdir) : discPath.dir;

      if (!(await fileSystem.exists(scanDir))) continue;

      const files = await fileSystem.listFiles(scanDir);

      for (const filePath of files) {
        if (!filePath.endsWith(".md")) continue;

        try {
          const content = await fileSystem.readFile(filePath);
          const nameHint = deriveAgentName(filePath, discPath.dir, subdir);
          const agent = parseAgentDefinition(content, filePath, discPath.source, defaults, nameHint);

          // Skip disabled agents entirely
          if (agent.disable) continue;

          // Add to the appropriate map
          const target = discPath.source === "project" ? projectAgents : globalAgents;
          target.set(agent.name, agent);
        } catch (error) {
          warnings.push({
            filePath,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  // Merge: project overrides global
  const merged = new Map<string, AgentDefinition>();
  for (const agent of globalAgents.values()) merged.set(agent.name, agent);
  for (const agent of projectAgents.values()) merged.set(agent.name, agent);

  return {
    agents: [...merged.values()],
    warnings,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function defaultAgentDir(): string {
  return path.join(process.env.HOME ?? "", ".pi", "agent");
}

// ─── Filtering Utilities ────────────────────────────────────────────────────

/**
 * Filter agents that are visible in the TUI selector.
 * Shows: mode primary|all, excludes hidden and disable.
 */
export function selectableAgents(agents: AgentDefinition[]): AgentDefinition[] {
  return agents.filter(
    (a) => !a.hidden && (a.mode === "primary" || a.mode === "all"),
  );
}

/**
 * Filter agents that can be spawned as subagents.
 * Shows: mode subagent|all.
 */
export function spawnableAgents(agents: AgentDefinition[]): AgentDefinition[] {
  return agents.filter((a) => a.mode === "subagent" || a.mode === "all");
}

/**
 * Filter agents available to a parent for delegation.
 * Applies the parent's allowedAgents whitelist if present.
 */
export function agentsAvailableTo(
  agents: AgentDefinition[],
  parent?: AgentDefinition,
): AgentDefinition[] {
  const spawnable = spawnableAgents(agents);

  if (!parent?.allowedAgents || parent.allowedAgents.length === 0) {
    return spawnable;
  }

  return spawnable.filter((a) => parent.allowedAgents!.includes(a.name));
}
