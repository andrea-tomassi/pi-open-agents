/**
 * Subagent tool registration.
 *
 * Registers the "subagent" tool that the LLM can call to delegate tasks
 * to named subagents running in isolated child pi processes.
 *
 * The tool:
 * - Filters available agents by mode (subagent|all) and allowedAgents
 * - Checks recursion depth via PI_OPEN_AGENTS_* env vars
 * - Spawns the child process via the executor
 * - Renders progress and results in the TUI
 */

import type {
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, keyHint } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import type { AgentDefinition } from "../types.ts";
import { spawnableAgents } from "../discovery/loader.ts";
import {
  availableSubagentsForAgent,
  resolveSubagentSession,
  runSubagent,
  type AgentProgress,
  type AgentResult,
  type SubagentSessionMode,
} from "./executor.ts";
import {
  contextUsageSeverity,
  formatSubagentCall,
  formatResultLines,
  formatUsage,
} from "./render.ts";
import { allowedAgentNames, isPastMaxDepth, type RecursionEnv } from "./env.ts";
import { preview, shortenPath, stringArg } from "../utils/format.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

interface SubagentParams {
  agent: string;
  task: string;
  cwd?: string;
  session?: SubagentSessionMode;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

type ThemeLike = {
  fg: (name: ThemeColor, text: string) => string;
  bold: (text: string) => string;
};

function availableAgentsText(agents: AgentDefinition[]): string {
  return (
    agents
      .map((agent) => agent.name)
      .sort()
      .join(", ") || "none"
  );
}

function toToolResult(result: AgentResult) {
  return {
    content: [{ type: "text" as const, text: result.output || "(no output)" }],
    details: result,
    isError: result.isError,
  };
}

function toProgressResult(progress: AgentProgress) {
  return {
    content: [{ type: "text" as const, text: progress.output || "(running...)" }],
    details: progress,
  };
}

// ─── Styled Rendering ────────────────────────────────────────────────────────

function styledPathArg(args: Record<string, unknown>, theme: ThemeLike, fallback?: string): string {
  const p = shortenPath(args.path ?? args.file_path) ?? fallback;
  return p ? theme.fg("accent", p) : theme.fg("toolOutput", "...");
}

function styledLineRange(args: Record<string, unknown>, theme: ThemeLike): string {
  if (args.offset === undefined && args.limit === undefined) return "";
  const start = (args.offset as number) ?? 1;
  const limit = args.limit as number | undefined;
  const end = limit !== undefined ? start + limit - 1 : undefined;
  return theme.fg("warning", `:${start}${end !== undefined ? `-${end}` : ""}`);
}

function styledToolTitle(name: string, args: Record<string, unknown>, theme: ThemeLike): string {
  switch (name) {
    case "read":
      return `${theme.fg("toolTitle", theme.bold("read"))} ${styledPathArg(args, theme)}${styledLineRange(args, theme)}`;
    case "bash": {
      const cmd = stringArg(args, "command") ?? "";
      return `${theme.fg("toolTitle", theme.bold(`$ ${cmd || "..."}`))}`;
    }
    case "edit":
      return `${theme.fg("toolTitle", theme.bold("edit"))} ${styledPathArg(args, theme)}`;
    case "write":
      return `${theme.fg("toolTitle", theme.bold("write"))} ${styledPathArg(args, theme)}`;
    case "grep": {
      const pattern = stringArg(args, "pattern") ?? "";
      return `${theme.fg("toolTitle", theme.bold("grep"))} ${theme.fg("syntaxKeyword", `/${pattern}/`)}`;
    }
    case "subagent": {
      const agent = stringArg(args, "agent") ?? "";
      const task = stringArg(args, "task");
      return `${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", agent)}${task ? ` ${theme.fg("dim", JSON.stringify(preview(task, 60)))}` : ""}`.trimEnd();
    }
    default: {
      const values = Object.values(args).filter((v) => typeof v === "string") as string[];
      return `${theme.fg("toolTitle", theme.bold(name))}${values.length > 0 ? ` ${theme.fg("dim", JSON.stringify(preview(values[0], 80)))}` : ""}`;
    }
  }
}

function styledCollapsedLine(
  line: { kind: string; text: string; tool?: { name: string; args: Record<string, unknown>; status: string } },
  details: AgentResult | AgentProgress,
  theme: ThemeLike,
): string {
  if (line.kind === "status")
    return theme.fg(details.status === "error" ? "error" : "success", line.text);
  if (line.kind === "hint") return theme.fg("dim", line.text);
  if (line.kind === "tool" && line.tool) {
    const prefix = line.tool.status === "running" ? theme.fg("warning", "▸") : " ";
    return `${prefix} ${styledToolTitle(line.tool.name, line.tool.args, theme)}`;
  }
  if (line.kind === "usage") return theme.fg(contextUsageSeverity(details.usage), line.text);
  return line.text;
}

function renderResultLines(
  details: AgentResult | AgentProgress,
  theme: ThemeLike,
  options: { expanded: boolean; suppressOutput?: boolean; suppressUsage?: boolean; expandHint?: string },
): Container {
  const container = new Container();
  for (const line of formatResultLines(details, options)) {
    if (line.kind === "blank") {
      container.addChild(new Spacer(1));
      continue;
    }
    container.addChild(new Text(styledCollapsedLine(line, details, theme), 0, 0));
  }
  return container;
}

// ─── Tool Registration ───────────────────────────────────────────────────────

export interface RegisterSubagentToolOptions {
  agents: AgentDefinition[];
  run?: typeof runSubagent;
  env?: RecursionEnv;
  agentDir?: string;
}

/**
 * Register the subagent tool.
 *
 * Does nothing if past max recursion depth or no spawnable agents.
 */
export function registerSubagentTool(
  pi: ExtensionAPI,
  options: RegisterSubagentToolOptions,
): void {
  const env: RecursionEnv = options.env ?? process.env;
  if (isPastMaxDepth(env)) return;

  // Filter by parent's allowed agents
  const allowed = allowedAgentNames(env);
  const allSpawnable = spawnableAgents(options.agents);
  const agents = allowed
    ? allSpawnable.filter((a) => allowed.has(a.name))
    : allSpawnable;

  if (agents.length === 0) return;

  const runner = options.run ?? runSubagent;
  const availableSubagents = agents.map((a) => a.name);
  const agentNames = [...availableSubagents].sort().join(", ");
  const sessionGuideline =
    'Use session: "fork" when the delegated task depends on the current conversation, prior discussion, or parent session history. Use the default session: "none" for self-contained tasks.';
  const promptGuidelines =
    agentNames.length > 0 ? [`Available subagents: ${agentNames}`, sessionGuideline] : undefined;

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Delegate a task to a named sub-agent running in an isolated pi process.",
    promptSnippet: "Delegate isolated tasks with subagent({ agent, task, cwd?, session? }).",
    promptGuidelines,
    parameters: Type.Object({
      agent: Type.String({ description: "Name of the agent to invoke" }),
      task: Type.String({ description: "Task to delegate to the agent" }),
      cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
      session: Type.Optional(
        Type.Union([Type.Literal("none"), Type.Literal("fork")], {
          description: 'Parent session handling: none starts a fresh subagent session, fork branches from the current session',
        }),
      ),
    }),

    async execute(
      _toolCallId: string,
      params: SubagentParams,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<AgentProgress> | undefined,
      ctx: ExtensionContext,
    ) {
      const agent = agents.find((a) => a.name === params.agent);
      if (!agent) {
        throw new Error(
          `Unknown agent: ${params.agent}. Available agents: ${availableAgentsText(agents)}.`,
        );
      }

      const childCwd = params.cwd ?? ctx.cwd;
      const session = resolveSubagentSession(
        params.session,
        childCwd,
        ctx.sessionManager?.getSessionFile(),
        ctx.sessionManager?.getLeafId(),
        options.agentDir,
      );

      const result = await runner({
        agent,
        task: params.task,
        cwd: childCwd,
        signal,
        depth: Number(env.PI_OPEN_AGENTS_DEPTH ?? "0") + 1,
        availableAgents: availableSubagentsForAgent(agent, availableSubagents),
        agentDir: options.agentDir,
        session,
        onProgress: (progress) => onUpdate?.(toProgressResult(progress)),
      });

      return toToolResult(result);
    },

    renderCall(args, theme, context) {
      const typedArgs = args as SubagentParams;
      const title = `${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", typedArgs.agent ?? "...")}`;
      if (context.expanded) return new Text(`${title}\n${theme.fg("dim", typedArgs.task ?? "...")}`, 0, 0);
      const callText = formatSubagentCall({ agent: typedArgs.agent, task: typedArgs.task });
      return new Text(`${title} ${theme.fg("dim", callText.replace(/^subagent \S+ /, ""))}`, 0, 0);
    },

    renderResult(result, renderOpts, theme) {
      const details = result.details as AgentResult | AgentProgress | undefined;
      if (!details) {
        const first = result.content[0];
        return new Text(first?.type === "text" ? first.text : "(no output)", 0, 0);
      }

      if (renderOpts.expanded) {
        const container = renderResultLines(details, theme, {
          expanded: true,
          suppressOutput: true,
          suppressUsage: true,
        });
        container.addChild(new Spacer(1));
        container.addChild(new Markdown(details.output || "(no output)", 0, 0, getMarkdownTheme()));
        container.addChild(new Spacer(1));
        container.addChild(
          new Text(theme.fg(contextUsageSeverity(details.usage), formatUsage(details)), 0, 0),
        );
        return container;
      }

      return renderResultLines(details, theme, {
        expanded: false,
        expandHint: keyHint("app.tools.expand", "to expand"),
      });
    },
  });
}
