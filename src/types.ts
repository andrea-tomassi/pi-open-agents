/**
 * Core type definitions for pi-open-agents.
 *
 * AgentDefinition is the unified superset of OpenCode and pi agent formats.
 * Every .md agent file — regardless of source path or frontmatter dialect —
 * is parsed into this single type.
 */

// ─── Enums ───────────────────────────────────────────────────────────────────

export type AgentMode = "primary" | "subagent" | "all";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type SystemPromptMode = "append" | "replace" | "replace-all";

export type PermissionAction = "allow" | "deny" | "ask";

export type AgentSource = "global" | "project";

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off", "minimal", "low", "medium", "high", "xhigh",
] as const;

export const SYSTEM_PROMPT_MODES: readonly SystemPromptMode[] = [
  "append", "replace", "replace-all",
] as const;

export const AGENT_MODES: readonly AgentMode[] = [
  "primary", "subagent", "all",
] as const;

export const PERMISSION_ACTIONS: readonly PermissionAction[] = [
  "allow", "deny", "ask",
] as const;

// ─── Permission ──────────────────────────────────────────────────────────────

/**
 * Permission config as written in frontmatter.
 *
 * Simple form (string per tool):
 *   bash: allow
 *
 * Pattern form (nested object):
 *   edit:
 *     "*.env": deny
 *     "*.md": allow
 */
export type PermissionConfig = Record<string, PermissionAction | Record<string, PermissionAction>>;

/**
 * Flattened permission rule after parsing.
 * Evaluation is last-match-wins (like CSS specificity).
 */
export interface PermissionRule {
  /** Tool or permission category, e.g. "bash", "edit", "read" */
  permission: string;
  /** Glob pattern for the argument, e.g. "*.env", "*" */
  pattern: string;
  /** Action to take */
  action: PermissionAction;
}

// ─── Agent Definition ────────────────────────────────────────────────────────

/**
 * The unified agent definition — superset of OpenCode and pi formats.
 *
 * Fields are grouped by purpose. OpenCode-compatible fields are marked (OC),
 * pi-specific extensions are marked (PI).
 */
export interface AgentDefinition {
  // === Identity ===
  name: string;
  description?: string;
  /** (OC) Controls visibility: primary = user-selectable, subagent = delegation only, all = both */
  mode: AgentMode;
  /** (OC) Hide from TUI selectors, keep programmatic access */
  hidden: boolean;
  /** (OC) UI accent color */
  color?: string;
  /** (OC) Remove agent entirely */
  disable: boolean;

  // === Model ===
  /** "provider/model-id" */
  model?: string;
  /** (OC) Model variant name, e.g. "thinking" */
  variant?: string;
  /** (OC) Generation temperature */
  temperature?: number;
  /** (OC) Generation top_p */
  topP?: number;

  // === Execution Control ===
  /** (PI) Reasoning effort level */
  thinking: ThinkingLevel;
  /** (OC) Max agentic iterations before forced text-only */
  steps?: number;
  /** (PI) How agent body interacts with system prompt */
  systemPrompt: SystemPromptMode;

  // === Tools & Permissions ===
  /** (OC) Permission rules for tool usage */
  permission?: PermissionConfig;
  /** (PI) Simple tool whitelist (converted to permission if no permission block) */
  tools?: string[];

  // === Subagent Controls ===
  /** (PI) Maximum recursion depth when spawning subagents */
  maxDepth: number;
  /** (PI) Which subagents this agent is allowed to spawn */
  allowedAgents?: string[];
  /** (PI) Per-agent skill loading with wildcard support */
  skills?: string[];

  // === Content & Metadata ===
  /** Markdown body (content after frontmatter) */
  prompt: string;
  /** Discovery origin */
  source: AgentSource;
  /** Absolute path to the .md file */
  filePath: string;
}

// ─── Loading Results ─────────────────────────────────────────────────────────

export interface AgentLoadWarning {
  filePath: string;
  message: string;
}

export interface AgentLoadResult {
  agents: AgentDefinition[];
  warnings: AgentLoadWarning[];
}

// ─── Filesystem Abstraction (for testing) ────────────────────────────────────

export interface AgentFs {
  listFiles(dir: string): Promise<string[]>;
  readFile(filePath: string): Promise<string>;
  exists(dir: string): Promise<boolean>;
}

// ─── Model Reference ─────────────────────────────────────────────────────────

export interface ModelRef {
  provider: string;
  modelId: string;
}
