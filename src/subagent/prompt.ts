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
  /**
   * Commissioned deliverable path (issue #32). When set, the child is told
   * to write its main deliverable there and cite it in the outcome block.
   * Already resolved against the child cwd by the caller.
   */
  outputPath?: string;
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
 * Child-side result contract (issue #32).
 *
 * Every run archives the full output to a temp file and returns only a
 * short outcome inline — the child must therefore END its final message
 * with a brief outcome block after a `## Outcome` marker line, cite
 * commissioned files as `` `<path>` — <one-line description> '' ›, and keep
 * errors inline (never behind a file reference).
 */
export function buildClosingContract(outputPath?: string): string {
  const lines = [
    "",
    "",
    "## Result Contract",
    "",
    "When your task is complete, end your final message with a short outcome block,",
    "separated from the rest by a line containing exactly `## Outcome`:",
    "",
    "## Outcome",
    "Outcome: <one line — done / failed + why>",
    "Details: <what matters for the caller's next step, 2-3 lines>",
    "",
    "If you produced files the caller asked for, list each on its own line as",
    "`<path>` — <one line describing the content>.",
    "Keep the outcome block to 2-3 lines. Never paste the full output after the",
    "marker when a file reference suffices; never hide an error behind a file reference.",
  ];
  if (outputPath) {
    lines.push(
      "",
      `The caller expects its deliverable at \`${outputPath}\` — write it there with your file tools`,
      "and cite it in the outcome block.",
    );
  }
  return lines.join("\n");
}
/**
 * Build the system prompt for a subagent.
 *
 * Starts with the agent body, appends skill injection if the agent has skills,
 * then the result-closing contract (issue #32).
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

  prompt = `${prompt}${buildClosingContract(options.outputPath)}`;

  return { prompt, skills: skillsResult };
}
