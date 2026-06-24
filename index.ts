/**
 * pi-open-agents entry point.
 *
 * Re-exports from src/index.ts so pi can resolve the extension name
 * from the package root (not the "src" directory).
 */
export { default } from "./src/index.ts";
export * from "./src/index.ts";
