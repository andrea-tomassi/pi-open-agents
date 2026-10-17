/**
 * Tests for the status banner's showAgentDescription setting.
 *
 * Covers the on/off matrix: `false` omits the description line, while an
 * absent/undefined setting preserves the upstream default (description shown).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { setShowAgentDescription, updateBanner } from "../src/tui/banner.ts";
import type { AgentDefinition } from "../src/types.ts";

const AGENT: AgentDefinition = {
  name: "main",
  description: "does main things",
  mode: "primary",
  hidden: false,
  disable: false,
  model: "test/model",
  thinking: "off",
  systemPrompt: "append",
  maxDepth: 10,
  prompt: "",
  source: "global",
  filePath: "/main.md",
};

/** Minimal fake UI that records the rendered banner lines. */
function makeUi(): { ui: ExtensionUIContext; banner(): string | undefined } {
  const widgets = new Map<string, string[] | undefined>();
  const ui = {
    theme: {
      bold: (value: string): string => value,
      fg: (_color: string, value: string): string => value,
    },
    setWidget: (name: string, content: string[] | undefined): void => {
      widgets.set(name, content);
    },
  } as unknown as ExtensionUIContext;
  return { ui, banner: () => widgets.get("open-agents-banner")?.[0] };
}

test("banner: absent showAgentDescription keeps the description (upstream default)", () => {
  setShowAgentDescription(undefined);
  const { ui, banner } = makeUi();
  updateBanner(ui, AGENT, 1);
  assert.equal(banner(), "▸ main — does main things [test/model]");
});

test("banner: showAgentDescription=false omits the description", () => {
  setShowAgentDescription(false);
  const { ui, banner } = makeUi();
  updateBanner(ui, AGENT, 1);
  assert.equal(banner(), "▸ main [test/model]");
  assert.ok(!banner()!.includes("does main things"));
});

test("banner: showAgentDescription=true shows the description", () => {
  setShowAgentDescription(true);
  const { ui, banner } = makeUi();
  updateBanner(ui, AGENT, 1);
  assert.equal(banner(), "▸ main — does main things [test/model]");
});
