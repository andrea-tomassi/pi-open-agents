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

  const GLOBAL_FAMILY_RANK: Record<string, number> = { pi: 2, opencode: 1, shared: 1 };
  const globalRanks = new Map<string, number>();

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

          // Resolve body-level include directives (fail-soft, never throws)
          agent.prompt = await resolveIncludes(agent.prompt, path.dirname(filePath), {
            fs: fileSystem,
            reportedMissing: new Set(),
          }, new Set([path.resolve(filePath)]), 0);

          // Add to the appropriate map
          if (discPath.source === "project") {
            projectAgents.set(agent.name, agent);
          } else {
            const rank = GLOBAL_FAMILY_RANK[discPath.family] ?? 0;
            const prevRank = globalRanks.get(agent.name);
            if (prevRank === undefined || rank >= prevRank) {
              globalAgents.set(agent.name, agent);
              globalRanks.set(agent.name, rank);
            }
          }
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

// ─── Include Directive Resolution ───────────────────────────────────────────

/** Max recursion depth for include directives. */
const INCLUDE_MAX_DEPTH = 8;

/**
 * A full-line include directive: `include: "path"`, `include: 'path'`,
 * or `include: path`. Case-sensitive, must start at column 0 and occupy
 * the whole line (trailing whitespace allowed). Occurrences inside
 * sentences, indented lines, or fenced code blocks never match.
 */
const INCLUDE_LINE_RE = /^include:[ \t]+(?:"([^"]*)"|'([^']*)'|([^\s"']+))[ \t]*$/;

/** Opening/closing fenced code block markers (``` or ~~~, optionally indented). */
const FENCE_RE = /^[ \t]*(```|~~~)/;

/** Shared state for one loadAgents run. */
interface IncludeContext {
  /** Filesystem abstraction (honors the custom fs used for tests). */
  fs: AgentFs;
  /** Resolved paths already warned about (one warning per missing path). */
  reportedMissing: Set<string>;
}

function warnInclude(message: string): void {
  console.error(`[pi-open-agents] include: ${message}`);
}

/**
 * Resolve body-level include directives in agent markdown.
 *
 * Each directive line is replaced by the content of the referenced file,
 * resolved relative to the directory of the file containing the directive.
 * Includes are recursive under the same rule. Cycles are detected via the
 * set of absolute paths on the current expansion path, and nesting is
 * capped at INCLUDE_MAX_DEPTH.
 *
 * Fail-soft: missing files, cycles, and over-deep nesting remove the
 * directive line and warn on stderr, but never throw.
 *
 * @param content  Markdown body to process
 * @param baseDir  Directory of the file containing the directives
 * @param ctx      Shared per-load state
 * @param visited  Absolute paths on the current expansion path (cycle guard)
 * @param depth    Current inclusion depth (0 = the agent file itself)
 */
async function resolveIncludes(
  content: string,
  baseDir: string,
  ctx: IncludeContext,
  visited: Set<string>,
  depth: number,
): Promise<string> {
  const lines = content.split("\n");
  const out: string[] = [];
  let inFence = false;

  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }

    if (inFence) {
      out.push(line);
      continue;
    }

    const match = INCLUDE_LINE_RE.exec(line);
    const includePath = match ? (match[1] ?? match[2] ?? match[3]) : undefined;
    if (!includePath) {
      out.push(line);
      continue;
    }

    const resolved = path.resolve(baseDir, includePath);

    if (visited.has(resolved)) {
      warnInclude(`cycle detected for "${includePath}" (${resolved}); directive dropped`);
      continue;
    }

    if (depth >= INCLUDE_MAX_DEPTH) {
      warnInclude(`max depth ${INCLUDE_MAX_DEPTH} exceeded for "${includePath}"; directive dropped`);
      continue;
    }

    let raw: string;
    try {
      raw = await ctx.fs.readFile(resolved);
    } catch {
      if (!ctx.reportedMissing.has(resolved)) {
        ctx.reportedMissing.add(resolved);
        warnInclude(`file not found: "${includePath}" (${resolved}); directive dropped`);
      }
      continue;
    }

    visited.add(resolved);
    const expanded = await resolveIncludes(raw, path.dirname(resolved), ctx, visited, depth + 1);
    visited.delete(resolved);
    out.push(expanded);
  }

  return out.join("\n");
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
