/**
 * Format utilities for subagent TUI rendering and output.
 *
 * Extracted from tool-args.ts and subagent-render.ts (pi-subagents reference).
 */

import { homedir } from "node:os";

/**
 * Truncate text with ellipsis.
 */
export function preview(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length)}...` : text;
}

/**
 * Shorten a file path by replacing the home directory with ~.
 */
export function shortenPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const home = homedir();
  return value.startsWith(`${home}/`) ? `~/${value.slice(home.length + 1)}` : value;
}

/**
 * Type-safe string extraction from a record.
 */
export function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Type-safe number extraction from a record.
 */
export function numberArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" ? value : undefined;
}

/**
 * Escape XML special characters.
 */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Format a token count compactly (e.g. 1500 → "1.5k", 2000000 → "2m").
 */
export function formatTokens(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}m`;
  if (Math.abs(value) >= 1_000) return `${Number((value / 1_000).toFixed(1))}k`;
  return String(value);
}

/**
 * Sanitize a string for use as a filename component.
 */
export function safeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "_");
}

/**
 * Get byte length of a UTF-8 string.
 */
export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Keep the tail of a string within a byte budget.
 */
export function keepTailByBytes(text: string, maxBytes: number): string {
  let kept = text;
  while (byteLength(kept) > maxBytes) kept = kept.slice(1);
  return kept;
}

/**
 * Truncate content from the head, keeping the tail.
 * Returns undefined if no truncation needed.
 */
export function truncateHeadContent(
  text: string,
  maxBytes: number,
  maxLines: number,
): string | undefined {
  const lines = text.split("\n");
  if (byteLength(text) <= maxBytes && lines.length <= maxLines) return undefined;

  const lineLimited = lines.length > maxLines ? lines.slice(-maxLines).join("\n") : text;
  return keepTailByBytes(lineLimited, maxBytes);
}
