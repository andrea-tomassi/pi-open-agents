//
// Glob/wildcard pattern matching for permission evaluation.
//
// Supports:
// - star: matches any number of characters (except /)
// - double-star: matches any number of characters including /
// - ?: matches exactly one character
// - Literal characters match themselves
//
// Examples:
//   match("star.env", "secret.env")     → true (star matches)
//   match("star.env", "dir/secret.env") → false (star doesn't cross /)
//   match("double-star.env", "a/b.env") → true (double-star crosses /)
//

//
// Match a glob pattern against a string.
//
// @param pattern  Glob pattern (e.g. star.env, double-star.ts, exact-match)
// @param value    String to test (e.g. a file path, tool argument)
// @returns        true if the pattern matches the entire string
//
export function matchPattern(pattern: string, value: string): boolean {
  // Fast path: * matches everything
  if (pattern === "*") return true;

  // Fast path: exact match
  if (pattern === value) return true;

  // No wildcard characters — must be exact
  if (!pattern.includes("*") && !pattern.includes("?")) {
    return pattern === value;
  }

  // Convert glob to regex
  const regexStr = globToRegex(pattern);
  const regex = new RegExp(`^${regexStr}$`);
  return regex.test(value);
}

/**
 * Convert a glob pattern to a regex string.
 *
 * Handles * (non-greedy, no /), ** (greedy, includes /), ? (single char).
 */
function globToRegex(pattern: string): string {
  let result = "";
  let i = 0;

  while (i < pattern.length) {
    const char = pattern[i];

    // Check for ** (must come before single *)
    if (char === "*" && pattern[i + 1] === "*") {
      // ** matches everything including /
      // Also handle **/ (match zero or more path segments)
      if (pattern[i + 2] === "/") {
        result += "(?:.*/)?"; // match "a/b/" or ""
        i += 3;
      } else {
        result += ".*";
        i += 2;
      }
    } else if (char === "*") {
      // * matches any chars except /
      result += "[^/]*";
      i++;
    } else if (char === "?") {
      // ? matches exactly one char (except /)
      result += "[^/]";
      i++;
    } else {
      // Escape regex special characters
      result += escapeRegexChar(char);
      i++;
    }
  }

  return result;
}

/**
 * Escape a character for use in a regex.
 * Only escapes characters that have special meaning.
 */
function escapeRegexChar(char: string): string {
  const special = ".+^${}()|[]\\";
  if (special.includes(char)) {
    return "\\" + char;
  }
  return char;
}

/**
 * Check if a pattern contains wildcards.
 */
export function isWildcardPattern(pattern: string): boolean {
  return pattern.includes("*") || pattern.includes("?");
}
