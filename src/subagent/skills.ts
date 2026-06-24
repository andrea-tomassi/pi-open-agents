/**
 * Per-agent skill resolution with wildcard support.
 *
 * Collects skills from multiple directories and resolves them against
 * an agent's skill list (which may include wildcards like "lark-*").
 */

import {
  DefaultPackageManager,
  SettingsManager,
  getAgentDir,
  type ResolvedResource,
} from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseFrontmatter } from "../config/frontmatter.ts";

export interface ResolvedSkill {
  name: string;
  description: string;
  location: string;
}

export interface ResolveSkillsOptions {
  cwd: string;
  agentDir?: string;
  globalDir?: string;
  fs?: SkillResolverFs;
  packageSkillFiles?: string[];
}

export interface ResolveSkillsResult {
  resolved: ResolvedSkill[];
  missing: string[];
  skippedPackages: string[];
  warnings: string[];
}

export interface SkillResolverFs {
  exists(filePath: string): boolean;
  readFile(filePath: string): string;
  listFiles?(dir: string): string[];
}

// ─── Default FS ──────────────────────────────────────────────────────────────

const defaultSkillFs: SkillResolverFs = {
  exists(filePath) {
    return fs.existsSync(filePath);
  },
  readFile(filePath) {
    return fs.readFileSync(filePath, "utf-8");
  },
  listFiles(dir) {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .map((entry) => path.join(dir, entry.name))
        .sort();
    } catch {
      return [];
    }
  },
};

function defaultGlobalSkillsDir(): string {
  return path.join(os.homedir(), ".pi", "agent", "skills");
}

// ─── Skill File Reading ──────────────────────────────────────────────────────

interface ReadSkillResult {
  skill?: ResolvedSkill;
  warning?: string;
}

function readSkill(filePath: string, fileSystem: SkillResolverFs): ReadSkillResult | undefined {
  const content = fileSystem.readFile(filePath);
  const { data } = parseFrontmatter(content);

  const name = typeof data.name === "string" ? data.name.trim() : "";
  const description = typeof data.description === "string" ? data.description.trim() : "";

  if (!name) {
    return { warning: `skill missing required field: name: ${filePath}` };
  }
  if (!description) return undefined;

  return {
    skill: { name, description, location: filePath },
  };
}

// ─── Collection ──────────────────────────────────────────────────────────────

interface CollectedSkills {
  byName: Map<string, ResolvedSkill>;
  warnings: string[];
  skippedPackages: string[];
}

const collectedSkillsCache = new Map<string, Promise<CollectedSkills>>();

function listSkillFilesInDir(dir: string, fileSystem: SkillResolverFs): string[] {
  if (!fileSystem.listFiles) return [];
  return fileSystem
    .listFiles(dir)
    .map((entry) => path.join(entry, "SKILL.md"))
    .filter((filePath) => fileSystem.exists(filePath));
}

function addSkillFile(
  filePath: string,
  fileSystem: SkillResolverFs,
  byName: Map<string, ResolvedSkill>,
  warnings: string[],
): void {
  try {
    const result = readSkill(filePath, fileSystem);
    if (!result) return;
    if (result.warning) warnings.push(result.warning);
    if (result.skill && !byName.has(result.skill.name)) {
      byName.set(result.skill.name, result.skill);
    }
  } catch (error) {
    warnings.push(
      `skill could not be read: ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function resolvePackageSkillFiles(
  options: ResolveSkillsOptions,
): Promise<{ files: string[]; skippedPackages: string[] }> {
  if (options.packageSkillFiles) {
    return { files: options.packageSkillFiles, skippedPackages: [] };
  }
  if (options.fs) {
    return { files: [], skippedPackages: [] };
  }

  const skippedPackages: string[] = [];
  const agentDir = options.agentDir ?? getAgentDir();
  const settingsManager = SettingsManager.create(options.cwd, agentDir);
  const packageManager = new DefaultPackageManager({
    cwd: options.cwd,
    agentDir,
    settingsManager,
  });
  const resolvedPaths = await packageManager.resolve(async (source) => {
    skippedPackages.push(source);
    return "skip";
  });

  return {
    files: resolvedPaths.skills
      .filter((resource: ResolvedResource) => resource.enabled)
      .map((resource: ResolvedResource) => resource.path),
    skippedPackages,
  };
}

async function collectSkills(options: ResolveSkillsOptions): Promise<CollectedSkills> {
  const cwd = options.cwd;
  const globalDir = options.globalDir ?? defaultGlobalSkillsDir();
  const fileSystem = options.fs ?? defaultSkillFs;
  const byName = new Map<string, ResolvedSkill>();
  const warnings: string[] = [];

  for (const dir of [
    path.join(cwd, ".agents", "skills"),
    path.join(cwd, ".pi", "skills"),
    globalDir,
    path.join(os.homedir(), ".agents", "skills"),
  ]) {
    for (const filePath of listSkillFilesInDir(dir, fileSystem)) {
      addSkillFile(filePath, fileSystem, byName, warnings);
    }
  }

  const packageSkills = await resolvePackageSkillFiles(options);
  for (const filePath of packageSkills.files) {
    addSkillFile(filePath, fileSystem, byName, warnings);
  }

  return { byName, warnings, skippedPackages: packageSkills.skippedPackages };
}

function skillsCacheKey(options: ResolveSkillsOptions): string | undefined {
  if (options.fs) return undefined;
  return JSON.stringify({
    cwd: options.cwd,
    agentDir: options.agentDir,
    globalDir: options.globalDir ?? defaultGlobalSkillsDir(),
    packageSkillFiles: options.packageSkillFiles,
  });
}

async function getCollectedSkills(options: ResolveSkillsOptions): Promise<CollectedSkills> {
  const cacheKey = skillsCacheKey(options);
  if (!cacheKey) return collectSkills(options);

  let cached = collectedSkillsCache.get(cacheKey);
  if (!cached) {
    cached = collectSkills(options);
    collectedSkillsCache.set(cacheKey, cached);
  }
  return cached;
}

// ─── Wildcard Matching ───────────────────────────────────────────────────────

function wildcardToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function hasWildcard(pattern: string): boolean {
  return pattern.includes("*");
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Resolve an agent's skill list into concrete skill definitions.
 *
 * Supports exact names and wildcards (e.g. "lark-*", "github").
 */
export async function resolveSkills(
  skillNames: string[],
  options: ResolveSkillsOptions,
): Promise<ResolveSkillsResult> {
  const requestedNames = skillNames.map((name) => name.trim()).filter(Boolean);
  if (requestedNames.length === 0) {
    return { resolved: [], missing: [], skippedPackages: [], warnings: [] };
  }

  const collected = await getCollectedSkills(options);
  const resolved: ResolvedSkill[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();

  function addSkill(skill: ResolvedSkill): void {
    if (seen.has(skill.name)) return;
    seen.add(skill.name);
    resolved.push(skill);
  }

  for (const requestedName of requestedNames) {
    if (hasWildcard(requestedName)) {
      const regex = wildcardToRegex(requestedName);
      let matched = false;
      for (const skill of collected.byName.values()) {
        if (!regex.test(skill.name)) continue;
        matched = true;
        addSkill(skill);
      }
      if (!matched) missing.push(requestedName);
      continue;
    }

    const skill = collected.byName.get(requestedName);
    if (skill) addSkill(skill);
    else missing.push(requestedName);
  }

  return {
    resolved,
    missing,
    skippedPackages: collected.skippedPackages,
    warnings: collected.warnings,
  };
}
