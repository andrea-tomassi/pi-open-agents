/**
 * pi-open-agents — Unified agent and subagent management for pi.
 *
 * Entry point for the pi extension.
 * Currently a stub — hooks and execution will be added in F2-F6.
 *
 * F1 (this phase) provides:
 * - types:        AgentDefinition and related types
 * - config:       frontmatter parser, schema validation, discovery paths
 * - discovery:    multi-path agent loader with merge semantics
 */

// Re-export all public types
export * from "./types.ts";

// Re-export config modules
export { parseFrontmatter } from "./config/frontmatter.ts";
export type { ParsedFrontmatter } from "./config/frontmatter.ts";

export {
  parseAgentDefinition,
  AgentParseError,
  SCHEMA_DEFAULTS,
} from "./config/schema.ts";
export type { SchemaDefaults } from "./config/schema.ts";

export {
  getDiscoveryPaths,
  deriveAgentName,
} from "./config/paths.ts";
export type { DiscoveryPath } from "./config/paths.ts";

export {
  loadAgents,
  selectableAgents,
  spawnableAgents,
  agentsAvailableTo,
} from "./discovery/loader.ts";
export type { LoadAgentsOptions } from "./discovery/loader.ts";

// Extension entry point — will be implemented in F2
export default function piOpenAgents(): void {
  // Stub: full implementation in F2-F6
}
