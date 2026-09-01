import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(
  join(import.meta.dir, "../../packages/workspace-ui/src/index.css"),
  "utf8",
);

/** Declarations only — a comment may name the shape it is explaining away. */
function ruleBody(selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  expect(start).toBeGreaterThan(-1);
  const open = css.indexOf("{", start);
  return css
    .slice(open + 1, css.indexOf("}", open))
    .replaceAll(/\/\*[\s\S]*?\*\//g, "");
}

describe("reference chip copies inline with its sentence", () => {
  test("the chip is not a flex container", () => {
    // WHY: every child of a flex container is blockified, and the clipboard
    // serializer starts a new line at each block box. As a flex row, a chip in
    // the middle of a sentence copied as three lines — the reason the shape is
    // inline-block and the icon carries its own margin instead of a gap.
    const chip = ruleBody(".solus-token");

    expect(chip).toContain("display: inline-block");
    expect(chip).not.toContain("flex");
    expect(chip).not.toContain("gap:");
  });

  test("no chip variant reintroduces a gap", () => {
    // A `gap` only does anything on a flex or grid box, so a variant that sets
    // one is a variant that has switched the shape back.
    const variants = css
      .split("\n")
      .filter((line) => line.includes("solus-token") && line.includes("gap:"));

    expect(variants).toEqual([]);
  });

  test("the chip stays selectable", () => {
    // `user-select: none` here made a selection dragged across a chip skip it,
    // so the file never reached the clipboard at all.
    expect(ruleBody("button.solus-token")).not.toContain("user-select");
  });

  test("copy-only text stays an inline box", () => {
    // It carries the part of the path the chip does not show. A block box
    // (`position: absolute` blockifies) would put the label on its own line,
    // and `display: none` / `visibility: hidden` drop out of the clipboard.
    const copyOnly = ruleBody(".solus-token__copy-only");

    expect(copyOnly).toContain("font-size: 0");
    expect(copyOnly).not.toContain("position: absolute");
    expect(copyOnly).not.toContain("display: none");
    expect(copyOnly).not.toContain("visibility: hidden");
  });
});
