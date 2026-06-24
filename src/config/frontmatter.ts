/**
 * Self-contained YAML frontmatter parser.
 *
 * Handles the subset of YAML used by agent definitions:
 * - Flat key-value pairs
 * - Nested objects (for permission rules)
 * - Type coercion (boolean, number, string)
 * - Quoted values
 *
 * No external dependencies — works in isolation for testing.
 */

interface RawLine {
  indent: number;
  content: string;
  lineNumber: number;
}

export interface ParsedFrontmatter {
  data: Record<string, unknown>;
  body: string;
}

/**
 * Extract and parse frontmatter from markdown content.
 *
 * Returns { data: {}, body: content } if no frontmatter is present.
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // No frontmatter block
  if (!normalized.startsWith("---")) {
    return { data: {}, body: normalized.trim() };
  }

  // Find the closing ---
  // Skip the opening --- and the newline after it
  const afterOpening = normalized.slice(3);
  if (!afterOpening.startsWith("\n") && !afterOpening.startsWith("\r")) {
    // --- immediately followed by content (not a frontmatter block)
    return { data: {}, body: normalized.trim() };
  }

  const closingIdx = normalized.indexOf("\n---", 3);
  if (closingIdx === -1) {
    // No closing delimiter — treat entire content as body
    return { data: {}, body: normalized.trim() };
  }

  const yamlString = normalized.slice(4, closingIdx);
  const body = normalized.slice(closingIdx + 4).replace(/^\n/, "").trim();

  const data = parseYaml(yamlString);

  return { data, body };
}

// ─── Minimal YAML Parser ─────────────────────────────────────────────────────

/**
 * Parse a YAML string into a nested object.
 *
 * Handles:
 * - key: value          (flat string/number/boolean)
 * - key:                (start of nested object)
 * -   subkey: value     (nested under parent)
 * - key: [a, b, c]      (inline array)
 * - Comments (# ...)
 * - Quoted values
 */
function parseYaml(input: string): Record<string, unknown> {
  const lines = preprocessLines(input);
  const root: Record<string, unknown> = {};
  parseBlock(lines, 0, lines.length, 0, root);
  return root;
}

function preprocessLines(input: string): RawLine[] {
  const result: RawLine[] = [];
  const rawLines = input.split("\n");

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];

    // Skip empty lines and comments
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Calculate indentation (spaces only, tabs not supported in YAML)
    const indent = line.length - line.trimStart().length;

    result.push({
      indent,
      content: line.trim(),
      lineNumber: i + 1,
    });
  }

  return result;
}

/**
 * Recursively parse a block of lines at a given indentation level.
 *
 * @param lines    All preprocessed lines
 * @param start    Start index in lines array
 * @param end      End index (exclusive)
 * @param indent   Expected indentation level for this block
 * @param target   Object to populate
 * @returns        Number of lines consumed
 */
function parseBlock(
  lines: RawLine[],
  start: number,
  end: number,
  indent: number,
  target: Record<string, unknown>,
): number {
  let i = start;

  while (i < end) {
    const line = lines[i];

    // This line belongs to a shallower scope — we're done with this block
    if (line.indent < indent) break;

    // Deeper indentation without a parent key — skip (malformed)
    if (line.indent > indent) {
      i++;
      continue;
    }

    const colonIdx = line.content.indexOf(":");
    if (colonIdx === -1) {
      // No colon — skip malformed line
      i++;
      continue;
    }

    const key = line.content.slice(0, colonIdx).trim().replace(/^['"]|['"]$/g, "");
    const rawValue = line.content.slice(colonIdx + 1).trim();

    if (!key) {
      i++;
      continue;
    }

    if (rawValue === "") {
      // Value is empty — check if next lines are nested
      if (i + 1 < end && lines[i + 1].indent > indent) {
        // Parse nested object
        const nested: Record<string, unknown> = {};
        const childIndent = lines[i + 1].indent;
        let consumed = 0;
        let j = i + 1;

        while (j < end && lines[j].indent >= childIndent) {
          if (lines[j].indent === childIndent) {
            const subColon = lines[j].content.indexOf(":");
            if (subColon === -1) {
              j++;
              continue;
            }
            const subKey = lines[j].content.slice(0, subColon).trim().replace(/^['"]|['"]$/g, "");
            const subRaw = lines[j].content.slice(subColon + 1).trim();

            if (subRaw === "" && j + 1 < end && lines[j + 1].indent > childIndent) {
              // Double nesting (e.g. edit: { "*.env": deny })
              const deepNested: Record<string, unknown> = {};
              const deepIndent = lines[j + 1].indent;
              let deepJ = j + 1;
              while (deepJ < end && lines[deepJ].indent >= deepIndent) {
                if (lines[deepJ].indent === deepIndent) {
                  const dColon = lines[deepJ].content.indexOf(":");
                  if (dColon !== -1) {
                    const dKey = lines[deepJ].content.slice(0, dColon).trim().replace(/^['"]|['"]$/g, "");
                    const dVal = lines[deepJ].content.slice(dColon + 1).trim();
                    deepNested[dKey] = coerceValue(dVal);
                  }
                }
                deepJ++;
              }
              nested[subKey] = deepNested;
              j = deepJ;
            } else {
              nested[subKey] = coerceValue(subRaw);
              j++;
            }
          } else {
            j++;
          }
        }
        target[key] = nested;
        i = j;
      } else {
        // Empty value with no children
        target[key] = "";
        i++;
      }
    } else {
      // Inline value
      target[key] = coerceValue(rawValue);
      i++;
    }
  }

  return i - start;
}

/**
 * Coerce a raw string value into the appropriate JS type.
 *
 * Handles:
 * - Quoted strings: "hello" or 'hello' → hello
 * - Booleans: true/false
 * - Numbers: 42, 0.7
 * - Inline arrays: [a, b, c]
 * - Everything else: string
 */
function coerceValue(raw: string): unknown {
  // Inline array: [a, b, c]
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((s) => coerceValue(s.trim()) as string);
  }

  // Quoted strings — strip quotes, keep inner content
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1);
  }

  // Booleans
  if (raw === "true") return true;
  if (raw === "false") return false;

  // Numbers (integer or float)
  if (/^-?\d+$/.test(raw)) return parseInt(raw, 10);
  if (/^-?\d+\.\d+$/.test(raw)) return parseFloat(raw);

  // Plain string
  return raw;
}
