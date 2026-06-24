/**
 * Discovery paths for agent definition files.
 *
 * Scans three path families: pi, OpenCode, and shared.
 * Project paths override global paths by agent name.
 */

import * as path from "node:path";
import * as os from "node:os";

export interface DiscoveryPath {
  /** Absolute directory path to scan */
  dir: string;
  /** Whether this is a global or project-scoped path */
  source: "global" | "project";
  /** Which path family this belongs to */
  family: "pi" | "opencode" | "shared";
  /**
   * Subdirectory pattern within the dir to scan.
   * If empty, scans the dir directly.
   * Multiple patterns are tried in order.
   */
  subdirs: string[];
}

// ─── Path Builders ───────────────────────────────────────────────────────────

/**
 * Build all discovery paths for the given cwd and agent dir.
 *
 * @param cwd       Current working directory (project root)
 * @param agentDir  pi agent directory (~/.pi/agent by default)
 * @returns Ordered list of paths to scan (global first, then project)
 */
export function getDiscoveryPaths(cwd: string, agentDir: string): DiscoveryPath[] {
  const home = os.homedir();
  const opencodeHome = path.join(home, ".opencode");
  const opencodeConfig = path.join(home, ".config", "opencode");

  const paths: DiscoveryPath[] = [];

  // ── Global paths (scanned first, lower priority) ──

  // pi global
  paths.push({
    dir: path.join(agentDir, "agents"),
    source: "global",
    family: "pi",
    subdirs: [""],
  });

  // OpenCode global (config dir)
  paths.push({
    dir: opencodeConfig,
    source: "global",
    family: "opencode",
    subdirs: ["agent", "agents", "mode", "modes"],
  });

  // OpenCode global (home .opencode)
  paths.push({
    dir: opencodeHome,
    source: "global",
    family: "opencode",
    subdirs: ["agent", "agents", "mode", "modes"],
  });

  // ── Project paths (scanned after global, higher priority) ──

  // pi project
  paths.push({
    dir: path.join(cwd, ".pi", "agents"),
    source: "project",
    family: "pi",
    subdirs: [""],
  });

  // OpenCode project
  paths.push({
    dir: path.join(cwd, ".opencode"),
    source: "project",
    family: "opencode",
    subdirs: ["agent", "agents", "mode", "modes"],
  });

  // Shared (cross-runtime)
  paths.push({
    dir: path.join(cwd, ".agents"),
    source: "project",
    family: "shared",
    subdirs: [""],
  });

  return paths;
}

/**
 * Derive the agent name from a file path, using the discovery path info.
 *
 * For pi/shared: uses the filename without extension
 *   .pi/agents/my-agent.md → "my-agent"
 *
 * For OpenCode: strips the subdir prefix
 *   .opencode/agent/triage.md → "triage"
 *   .opencode/agents/deep/code-review.md → "deep-code-review" (flattened)
 *
 * An explicit `name:` in frontmatter always takes precedence.
 */
export function deriveAgentName(filePath: string, basePath: string, subdir: string): string {
  const fullPath = subdir ? path.join(basePath, subdir) : basePath;
  const relative = path.relative(fullPath, filePath);

  // Remove .md extension
  const withoutExt = relative.replace(/\.md$/i, "");

  // Normalize path separators
  const normalized = withoutExt.replace(/[/\\]/g, "-");

  return normalized;
}
