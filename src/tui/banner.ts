/**
 * Status banner widget for the TUI.
 *
 * Shows the active agent name, model, and description above the editor.
 */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { AgentDefinition } from "../types.ts";

/**
 * Update the status widget to reflect the active agent.
 * Pass undefined to show "no agent selected" hint.
 */
export function updateBanner(
  ui: ExtensionUIContext,
  activeAgent: AgentDefinition | undefined,
  selectableCount: number,
): void {
  if (activeAgent) {
    const parts: string[] = [];
    parts.push(ui.theme.bold(ui.theme.fg("accent", activeAgent.name)));

    if (activeAgent.description) {
      parts.push(ui.theme.fg("muted", `— ${activeAgent.description}`));
    }

    if (activeAgent.model) {
      parts.push(ui.theme.fg("dim", `[${activeAgent.model}]`));
    }

    if (activeAgent.thinking !== "off") {
      parts.push(ui.theme.fg("dim", `{${activeAgent.thinking}}`));
    }

    const banner = ui.theme.fg("accent", "▸ ") + parts.join(" ");
    ui.setWidget("open-agents-banner", [banner]);
  } else {
    // Show hint when agents are available but none active
    if (selectableCount > 0) {
      const hint = ui.theme.fg(
        "dim",
        "[No agent selected — /agent, Ctrl+Shift+M, Alt+S]",
      );
      ui.setWidget("open-agents-banner", [hint]);
    } else {
      ui.setWidget("open-agents-banner", undefined);
    }
  }
}
