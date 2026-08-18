import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const pageSource = readFileSync(
  join(import.meta.dir, "../../src/renderer/components/insights/InsightsPage.svelte"),
  "utf8",
);

const dialogSource = readFileSync(
  join(import.meta.dir, "../../src/renderer/components/insights/SaveQueryDialog.svelte"),
  "utf8",
);

describe("Insights saved-query naming", () => {
  test("the bookmark opens an in-app naming dialog instead of a browser prompt", () => {
    expect(pageSource).not.toContain("globalThis.prompt");
    expect(pageSource).toContain("onSaveCurrent={() => (saveQueryOpen = true)}");
    expect(pageSource).toContain("<SaveQueryDialog");
  });

  test("a name is required and Enter can submit it", () => {
    expect(dialogSource).toContain('submitOn="enter"');
    expect(dialogSource).toContain("disabled={!name.trim() || saving}");
    expect(dialogSource).toContain("await onSave(trimmedName)");
  });
});
