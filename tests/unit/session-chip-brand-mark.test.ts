/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const chipSource = readFileSync(
  join(
    import.meta.dir,
    "../../packages/workspace-ui/src/components/pickers/SessionChip.svelte",
  ),
  "utf8",
);

const iconSource = readFileSync(
  join(import.meta.dir, "../../packages/workspace-ui/src/components/ClaudeIcon.svelte"),
  "utf8",
);

// The brand mark carries the only accent on the model picker control. The mark
// takes its colour from the text colour, so a branch that sets no colour makes
// the glyph fall back to the button's secondary text and read as black. Codex
// fast mode is the one deliberate exception: it swaps the accent for amber.
describe("model picker brand mark", () => {
  test("the Claude mark is filled by the inherited text colour", () => {
    expect(iconSource).toContain('fill="currentColor"');
  });

  test("every brand-mark branch sets a colour, so no branch falls back to body text", () => {
    const markClass = chipSource.match(
      /class="flex flex-shrink-0 items-center justify-center \{isCodex[\s\S]*?\}"/,
    );
    expect(markClass).not.toBeNull();

    const branches = markClass![0].match(/'[^']*'/g) ?? [];
    expect(branches.length).toBeGreaterThan(0);
    for (const branch of branches) {
      expect(branch).toMatch(/text-\(--solus-accent\)|text-amber-500/);
    }
  });

  test("Claude and the fallback mark take the accent, not Codex's amber", () => {
    expect(chipSource).toContain(": 'text-(--solus-accent)'}\"");
  });
});
