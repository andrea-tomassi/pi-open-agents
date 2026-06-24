/**
 * TUI rendering for subagent results.
 *
 * Provides collapsed and expanded views showing:
 * - Status line (✓/✗ agent — N tools · Xs)
 * - Tool call list
 * - Output summary (collapsed) or full output (expanded)
 * - Usage stats
 */

import type { AgentProgress, AgentResult } from "./executor.ts";
import { numberArg, preview, shortenPath, stringArg, formatTokens } from "../utils/format.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RenderOptions {
  expanded: boolean;
  suppressOutput?: boolean;
  suppressUsage?: boolean;
  expandHint?: string;
}

export type ResultLineKind = "status" | "tool" | "hint" | "usage" | "output" | "blank";

export interface ResultLine {
  text: string;
  kind: ResultLineKind;
  singleLine: boolean;
  tool?: {
    name: string;
    args: Record<string, unknown>;
    status: "running" | "done" | "error";
  };
}

export type ContextUsageSeverity = "dim" | "warning" | "error";

const TOOL_LOG_LIMIT = 20;

// ─── Usage Formatting ────────────────────────────────────────────────────────

export function contextUsageSeverity(usage: {
  contextTokens?: number;
  contextWindow?: number;
}): ContextUsageSeverity {
  if (!usage.contextWindow || usage.contextWindow <= 0) return "dim";
  const percent = (usage.contextTokens ?? 0) / usage.contextWindow;
  if (percent >= 0.9) return "error";
  if (percent >= 0.7) return "warning";
  return "dim";
}

function elapsedSeconds(ms: number): number {
  return Math.round(ms / 1000);
}

export function formatUsage(progress: AgentProgress): string {
  const usage = progress.usage;
  const parts: string[] = [];

  if (usage.contextWindow && usage.contextWindow > 0) {
    const percent = ((usage.contextTokens / usage.contextWindow) * 100).toFixed(1);
    parts.push(`${percent}%/${formatTokens(usage.contextWindow)}`);
  }

  parts.push(`↑${formatTokens(usage.input)}`);
  parts.push(`↓${formatTokens(usage.output)}`);
  parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  parts.push(`$${usage.cost.toFixed(3)}`);

  return parts.join(" ");
}

// ─── Tool Title Formatting ───────────────────────────────────────────────────

function pathArg(args: Record<string, unknown>, fallback?: string): string {
  return shortenPath(args.path ?? args.file_path) ?? fallback ?? "...";
}

function lineRange(args: Record<string, unknown>): string {
  if (args.offset === undefined && args.limit === undefined) return "";
  const startLine = numberArg(args, "offset") ?? 1;
  const limit = numberArg(args, "limit");
  const endLine = limit !== undefined ? startLine + limit - 1 : undefined;
  return `:${startLine}${endLine !== undefined ? `-${endLine}` : ""}`;
}

function limitSuffix(args: Record<string, unknown>): string {
  const limit = numberArg(args, "limit");
  return limit !== undefined ? ` (limit ${limit})` : "";
}

function formatToolTitle(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "read":
      return `read ${pathArg(args)}${lineRange(args)}`;
    case "bash": {
      const command = stringArg(args, "command") ?? "";
      const timeout = numberArg(args, "timeout");
      return `$ ${command}${timeout !== undefined ? ` (timeout ${timeout}s)` : ""}`;
    }
    case "edit":
      return `edit ${pathArg(args)}`;
    case "write":
      return `write ${pathArg(args)}`;
    case "find": {
      const pattern = stringArg(args, "pattern") ?? "";
      return `find ${pattern} in ${pathArg(args, ".")}${limitSuffix(args)}`;
    }
    case "grep": {
      const pattern = stringArg(args, "pattern") ?? "";
      const glob = stringArg(args, "glob");
      const globSuffix = glob ? ` (${glob})` : "";
      const limit = numberArg(args, "limit");
      const limitText = limit !== undefined ? ` limit ${limit}` : "";
      return `grep /${pattern}/ in ${pathArg(args, ".")}${globSuffix}${limitText}`;
    }
    case "ls":
      return `ls ${pathArg(args, ".")}${limitSuffix(args)}`;
    case "webfetch": {
      const url = stringArg(args, "url") ?? "";
      const mode = stringArg(args, "mode");
      return `webfetch ${url}${mode ? ` (${mode})` : ""}`.trimEnd();
    }
    case "subagent": {
      const agent = stringArg(args, "agent");
      const task = stringArg(args, "task");
      const taskPreview = task ? ` ${JSON.stringify(preview(task, 60))}` : "";
      return `${name} ${agent ?? ""}${taskPreview}`.trimEnd();
    }
    default: {
      const values = Object.values(args).filter((v) => typeof v === "string") as string[];
      return `${name}${values.length > 0 ? ` ${JSON.stringify(preview(values[0], 80))}` : ""}`;
    }
  }
}

// ─── Line Formatting ─────────────────────────────────────────────────────────

function indent(text: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function summaryText(markdown: string): string {
  return markdown.split("\n").slice(0, 20).join("\n");
}

function formatToolLineItems(
  progress: AgentProgress,
  options: RenderOptions,
): ResultLine[] {
  const lines: ResultLine[] = [];
  const hiddenCount = options.expanded ? 0 : Math.max(0, progress.tools.length - TOOL_LOG_LIMIT);
  const visibleTools = progress.tools.slice(hiddenCount);

  if (hiddenCount > 0) {
    const expandHint = options.expandHint ?? "to expand";
    lines.push({
      text: `  ... (${hiddenCount} earlier tool calls, ${expandHint})`,
      kind: "hint",
      singleLine: true,
    });
  }

  for (const tool of visibleTools) {
    lines.push({
      text: `${tool.status === "running" ? "▸" : " "} ${formatToolTitle(tool.name, tool.args)}`,
      kind: "tool",
      singleLine: true,
      tool: { name: tool.name, args: tool.args, status: tool.status },
    });
    if ((options.expanded || progress.status === "running") && tool.nested) {
      for (const line of formatResultLines(tool.nested, {
        expanded: false,
        suppressOutput: true,
      })) {
        lines.push({ ...line, text: indent(line.text, 2) });
      }
    }
  }

  return lines;
}

export function formatSubagentCall(args: {
  agent?: string;
  task?: string;
}, options: Partial<RenderOptions> = {}): string {
  if (options.expanded) return `subagent ${args.agent ?? "..."}\n${args.task ?? "..."}`;
  return `subagent ${args.agent ?? "..."} ${preview(args.task ?? "...", 60)}`;
}

export function formatResultLines(
  progress: AgentProgress,
  options: RenderOptions,
): ResultLine[] {
  const icon = progress.status === "error" ? "✗" : progress.status === "done" ? "✓" : "▸";
  const sessionBadge = progress.session?.effective === "fork" ? " [fork]" : "";
  const statusLine = `${icon} ${progress.agent}${sessionBadge}${progress.model ? ` (${progress.model})` : ""} — ${progress.tools.length} tools · ${elapsedSeconds(progress.elapsedMs)}s`;
  const toolLines = formatToolLineItems(progress, options);
  const usage = formatUsage(progress);

  const lines: ResultLine[] = [
    { text: "", kind: "blank", singleLine: false },
    { text: statusLine, kind: "status", singleLine: false },
    ...(progress.session?.warning
      ? [{ text: `session: ${progress.session.warning}`, kind: "hint" as const, singleLine: true }]
      : []),
    ...toolLines,
  ];

  if (progress.status === "running" || options.suppressOutput) {
    if (!options.suppressUsage) {
      lines.push({ text: "", kind: "blank", singleLine: false });
      lines.push({ text: usage, kind: "usage", singleLine: false });
    }
    return lines;
  }

  const output = options.expanded
    ? progress.output || "(no output)"
    : summaryText(progress.output) || "(no output)";

  lines.push({ text: "", kind: "blank", singleLine: false });
  lines.push({ text: output, kind: "output", singleLine: false });

  if (!options.expanded) {
    const totalLines = (progress.output || "").split("\n").length;
    if (totalLines > 20) {
      const hidden = totalLines - 20;
      const expandHint = options.expandHint ?? "to expand";
      lines.push({
        text: `... (${hidden} more lines, ${expandHint})`,
        kind: "hint",
        singleLine: true,
      });
    }
  }

  if (!options.suppressUsage) {
    lines.push({ text: "", kind: "blank", singleLine: false });
    lines.push({ text: usage, kind: "usage", singleLine: false });
  }

  return lines;
}
