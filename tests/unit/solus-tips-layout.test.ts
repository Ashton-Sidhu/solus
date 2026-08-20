import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const tipsSource = readFileSync(
  join(
    import.meta.dir,
    "../../packages/workspace-ui/src/components/layout/SolusTips.svelte",
  ),
  "utf8",
);

describe("session composer tips", () => {
  test("wraps long tips inside a narrow mobile viewport", () => {
    // WHY: composer tips are absolutely positioned across the pane. A no-wrap
    // line can exceed a phone viewport even when the pane itself is contained.
    expect(tipsSource).toContain("max-w-full");
    expect(tipsSource).toContain("whitespace-normal");
    expect(tipsSource).toContain('<span class="min-w-0">{tip}</span>');
    expect(tipsSource).not.toContain("whitespace-nowrap");
  });
});
