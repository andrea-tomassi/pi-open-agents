/**
 * Agent definition schema: validation, normalization, and default application.
 *
 * This is the brain of the parsing pipeline. Raw frontmatter goes in,
 * a fully validated AgentDefinition comes out.
 *
 * Handles:
 * - Required field validation (name)
 * - Enum validation (mode, thinking, systemPrompt)
 * - Type coercion (numbers, booleans, arrays)
 * - OpenCode aliases (prompt → body, tools map → permission, maxSteps → steps)
 * - Default application (with settings fallbacks for thinking)
 */

import type {
  AgentDefinition,
  AgentMode,
  AgentSource,
  PermissionAction,
  PermissionConfig,
  SystemPromptMode,
  ThinkingLevel,
} from "../types.ts";
import {
  AGENT_MODES,
  PERMISSION_ACTIONS,
  SYSTEM_PROMPT_MODES,
  THINKING_LEVELS,
} from "../types.ts";
import { parseFrontmatter } from "./frontmatter.ts";

// ─── Defaults ────────────────────────────────────────────────────────────────

export interface SchemaDefaults {
  /** Default thinking level, typically from settings.json defaultThinkingLevel */
  thinking: ThinkingLevel;
}

export const SCHEMA_DEFAULTS: SchemaDefaults = {
  thinking: "off",
};

// ─── Parse Error ─────────────────────────────────────────────────────────────

export class AgentParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentParseError";
  }
}

// ─── Main Entry Point ────────────────────────────────────────────────────────

/**
 * Parse raw .md file content into a validated AgentDefinition.
 *
 * @param content     Raw file content (with frontmatter)
 * @param filePath    Absolute path to the file
 * @param source      Discovery origin (global/project)
 * @param defaults    Schema defaults (thinking fallback)
 * @param nameHint    Optional name derived from file path (used if no frontmatter name)
 */
export function parseAgentDefinition(
  content: string,
  filePath: string,
  source: AgentSource,
  defaults: SchemaDefaults = SCHEMA_DEFAULTS,
  nameHint?: string,
): AgentDefinition {
  const { data, body } = parseFrontmatter(content);

  // ── Name (required) ──
  const name = parseString(data.name) ?? nameHint;
  if (!name) {
    throw new AgentParseError("missing required field: name");
  }

  // ── Prompt: body wins over frontmatter "prompt" field ──
  // OpenCode uses frontmatter "prompt" field; pi uses the body.
  // If both exist, body takes precedence (pi convention).
  const frontmatterPrompt = parseString(data.prompt);
  const prompt = body || frontmatterPrompt || "";

  // ── Identity fields ──
  const mode = parseEnum<AgentMode>(data.mode, AGENT_MODES, "all");
  const hidden = parseBoolean(data.hidden, false);
  const color = parseOptionalString(data.color);
  const disable = parseBoolean(data.disable, false);
  const description = parseOptionalString(data.description);

  // ── Model fields ──
  const model = parseOptionalString(data.model);
  const variant = parseOptionalString(data.variant);
  const temperature = parseOptionalNumber(data.temperature);
  const topP = parseOptionalNumber(data["top_p"] ?? data.topP);

  // ── Execution control ──
  const thinking = parseEnum<ThinkingLevel>(data.thinking, THINKING_LEVELS, defaults.thinking);
  const steps = parseOptionalNumber(data.steps ?? data.maxSteps); // maxSteps is OC alias
  const systemPrompt = parseEnum<SystemPromptMode>(
    data.systemPrompt ?? data["system-prompt"],
    SYSTEM_PROMPT_MODES,
    "append",
  );

  // ── Tools & permissions ──
  const { permission, tools } = parseToolsAndPermission(data);

  // ── Subagent controls ──
  const maxDepth = parseNumber(data.maxDepth, 10);
  const allowedAgents = parseStringArray(data.allowedAgents);
  const skills = parseStringArray(data.skills);

  return {
    name,
    description,
    mode,
    hidden,
    color,
    disable,
    model,
    variant,
    temperature,
    topP,
    thinking,
    steps,
    systemPrompt,
    permission,
    tools,
    maxDepth,
    allowedAgents: allowedAgents.length > 0 ? allowedAgents : undefined,
    skills: skills.length > 0 ? skills : undefined,
    prompt,
    source,
    filePath,
  };
}

// ─── Tools & Permission Resolution ───────────────────────────────────────────

/**
 * Resolve tools and permission from raw frontmatter data.
 *
 * Logic:
 * 1. If `permission` field exists → use it
 * 2. Else if `tools` field exists:
 *    a. If tools is a map (OpenCode style) → convert to permission rules
 *    b. If tools is a CSV string/array (pi style) → keep as whitelist
 * 3. Both can coexist: permission for rules, tools for simple whitelist
 */
function parseToolsAndPermission(
  data: Record<string, unknown>,
): { permission?: PermissionConfig; tools?: string[] } {
  let permission: PermissionConfig | undefined;
  let tools: string[] | undefined;

  const rawPermission = data.permission;
  const rawTools = data.tools;

  // Parse permission block
  if (rawPermission !== undefined && rawPermission !== null) {
    permission = parsePermissionConfig(rawPermission);
  }

  // Parse tools field
  if (rawTools !== undefined && rawTools !== null) {
    if (typeof rawTools === "object" && !Array.isArray(rawTools)) {
      // OpenCode-style tools map: { "read": true, "write": false }
      // Convert to permission if no explicit permission block
      if (!permission) {
        permission = toolsMapToPermission(rawTools as Record<string, unknown>);
      }
    } else {
      // pi-style CSV or array: "read, bash, edit"
      tools = parseStringArray(rawTools);
    }
  }

  return { permission, tools };
}

/**
 * Convert OpenCode-style tools map to PermissionConfig.
 *
 * { "read": true, "write": false } → { "read": "allow", "write": "deny" }
 */
function toolsMapToPermission(toolsMap: Record<string, unknown>): PermissionConfig {
  const config: PermissionConfig = {};

  for (const [toolName, enabled] of Object.entries(toolsMap)) {
    // Skip non-boolean values
    if (typeof enabled !== "boolean") continue;

    // Map edit-like tools to "edit" permission (OpenCode convention)
    const permKey = toolName === "write" || toolName === "edit" || toolName === "apply_patch"
      ? "edit"
      : toolName;

    config[permKey] = enabled ? "allow" : "deny";
  }

  return config;
}

/**
 * Parse and validate a PermissionConfig from raw frontmatter data.
 */
function parsePermissionConfig(raw: unknown): PermissionConfig | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new AgentParseError(`invalid permission: expected object, got ${typeof raw}`);
  }

  const config: PermissionConfig = {};
  const obj = raw as Record<string, unknown>;

  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string") {
      // Simple form: bash: allow
      const action = validateAction(value, key);
      config[key] = action;
    } else if (typeof value === "object" && value !== null) {
      // Pattern form: edit: { "*.env": deny }
      const nested: Record<string, PermissionAction> = {};
      for (const [pattern, action] of Object.entries(value as Record<string, unknown>)) {
        if (typeof action === "string") {
          nested[pattern] = validateAction(action, `${key}.${pattern}`);
        }
      }
      config[key] = nested;
    }
  }

  return Object.keys(config).length > 0 ? config : undefined;
}

function validateAction(value: string, context: string): PermissionAction {
  const action = value as PermissionAction;
  if (!PERMISSION_ACTIONS.includes(action)) {
    throw new AgentParseError(
      `invalid permission action "${value}" for "${context}": must be allow, deny, or ask`,
    );
  }
  return action;
}

// ─── Type Helpers ────────────────────────────────────────────────────────────

function parseString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return String(value).trim() || undefined;
}

function parseOptionalString(value: unknown): string | undefined {
  return parseString(value);
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value === "true") return true;
    if (value === "false") return false;
  }
  return fallback;
}

function parseNumber(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "number") return value;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function parseOptionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return value;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function parseEnum<T extends string>(
  value: unknown,
  validValues: readonly T[],
  fallback: T,
): T {
  if (value === undefined || value === null) return fallback;
  const str = String(value).trim() as T;
  if (!validValues.includes(str)) {
    throw new AgentParseError(
      `invalid value "${str}": must be one of ${validValues.join(", ")}`,
    );
  }
  return str;
}

function parseStringArray(value: unknown): string[] {
  if (value === undefined || value === null) return [];

  if (Array.isArray(value)) {
    // Already an array (from YAML parser for inline arrays)
    return value.map((v) => String(v).trim()).filter(Boolean);
  }

  if (typeof value === "string") {
    // CSV string: "read, bash, edit"
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  return [];
}
