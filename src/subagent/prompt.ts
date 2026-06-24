/**
 * Child system prompt construction for subagents.
 *
 * Builds the system prompt that will be passed to the child pi process.
 * Includes the agent body and optional skill injection.
 */

import type { AgentDefinition } from "../types.ts";
import { escapeXml } from "../utils/format.ts";
import { resolveSkills, type ResolveSkillsResult } from "./skills.ts";

export interface BuildPromptOptions {
  agent: AgentDefinition;
  cwd: string;
  agentDir?: string;
}

export interface BuildPromptResult {
  prompt: string;
  skills: ResolveSkillsResult;
}

/**
 * Format resolved skills as an XML block for injection into the system prompt.
 */
function formatSkillsForPrompt(
  skills: Array<{ name: string; description: string; location: string }>,
): string {
  if (skills.length === 0) return "";

  const lines = [
    "\n\nThe following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>",
  ];

  for (const skill of skills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.location)}</location>`);
    lines.push("  </skill>");
  }

  lines.push("</available_skills>");
  return lines.join("\n");
}

/**
 * Build the system prompt for a subagent.
 *
 * Starts with the agent body, appends skill injection if the agent has skills.
 */
export async function buildSubagentPrompt(options: BuildPromptOptions): Promise<BuildPromptResult> {
  let prompt = options.agent.prompt;

  let skillsResult: ResolveSkillsResult = {
    resolved: [],
    missing: [],
    skippedPackages: [],
    warnings: [],
  };

  if (options.agent.skills && options.agent.skills.length > 0) {
    skillsResult = await resolveSkills(options.agent.skills, {
      cwd: options.cwd,
      agentDir: options.agentDir,
    });

    const injection = formatSkillsForPrompt(skillsResult.resolved);
    if (injection) {
      prompt = `${prompt}${injection}`;
    }
  }

  return { prompt, skills: skillsResult };
}
