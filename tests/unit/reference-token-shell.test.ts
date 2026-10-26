import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/*
 * One shell for every reference chip, in every surface.
 *
 * Every reference kind carries one hue; a kind without one silently falls back
 * to the neutral foreground and reads as a code span. Code spans, by contrast,
 * are literals and must never pick up an accent.
 *
 * Geometry lives on the base rule alone, in `em`, so the chip follows the text
 * it sits in. A surface or kind that restates a metric puts chips of different
 * kinds at different heights on the same line — the drift this replaced had six
 * font-size rungs and three icon sizes across four surfaces.
 */
const css = readFileSync(
  join(import.meta.dir, "../../packages/workspace-ui/src/workspace.css"),
  "utf8",
);
const prose = readFileSync(
  join(import.meta.dir, "../../packages/workspace-ui/src/prose.css"),
  "utf8",
);

const TOKEN_VARIANTS = [
  "plan-pending",
  "plan-accepted",
  "plan-rejected",
  "session",
  "work",
  "pr",
  "task",
  "automation",
  "file",
  "slash",
] as const;

function accentFor(variant: string): string | null {
  // A variant may share a declaration with siblings in a selector list.
  const rule = new RegExp(
    `(?:\\.solus-token--[\\w-]+,\\s*)*\\.solus-token--${variant}(?:,\\s*\\.solus-token--[\\w-]+)*\\s*\\{[^}]*--solus-token-accent:\\s*(oklch\\([^)]+\\))`,
  );
  return css.match(rule)?.[1] ?? null;
}

describe("reference token shell", () => {
  test("every token variant declares its own accent", () => {
    for (const variant of TOKEN_VARIANTS) {
      expect(accentFor(variant), variant).not.toBeNull();
    }
  });

  test("accents share one lightness and stay inside the art palette's chroma", () => {
    const seen = new Set<string>();
    for (const variant of TOKEN_VARIANTS) {
      const accent = accentFor(variant)!;
      const [lightness, chroma] = accent
        .replace(/^oklch\(|\)$/g, "")
        .split(/\s+/)
        .map(Number);
      expect(lightness, variant).toBe(0.62);
      expect(chroma, variant).toBeLessThanOrEqual(0.13);
      seen.add(accent);
    }
    // Plan statuses share a hue by design; every other kind is distinct.
    expect(seen.size).toBe(TOKEN_VARIANTS.length - 2);
  });

  test("the base shell sets every metric in em", () => {
    const base = css.match(/\n\.solus-token \{([^}]*)\}/)?.[1] ?? "";
    for (const property of ["padding", "font-size"]) {
      const value = base.match(new RegExp(`\\n\\s*${property}:\\s*([^;]+);`))?.[1];
      expect(value, property).toBeDefined();
      expect(value, property).not.toMatch(/rem\b/);
    }
    const icon = css.match(/\n\.solus-token__icon \{([^}]*)\}/)?.[1] ?? "";
    for (const property of ["width", "height", "margin-right"]) {
      expect(icon, property).toMatch(new RegExp(`\\n\\s*${property}:\\s*[\\d.]+em;`));
    }
  });

  test("no kind or surface restates a chip metric", () => {
    const METRICS = /\n\s*(padding|font-size|width|height|margin-right|border-radius):/;
    // Comments may name `.solus-token` beside a rule that is not one.
    const uncommented = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const rules = uncommented.matchAll(/([^{}]*\.solus-token[^{}]*)\{([^}]*)\}/g);
    for (const [, selector, body] of rules) {
      // The capture starts after the previous rule; the selector list is what
      // follows the last blank line.
      const trimmed = selector.trim().split(/\n\s*\n/).pop()!.trim();
      if (trimmed === ".solus-token" || trimmed === ".solus-token__icon") continue;
      // The icon's svg fills its box and a copy-only span collapses to nothing;
      // neither is a chip metric.
      if (trimmed === ".solus-token__icon svg" || trimmed === ".solus-token__copy-only") continue;
      expect(body, trimmed).not.toMatch(METRICS);
    }
  });

  test("a code span is never a chip", () => {
    // WHY: a chip is a reference you can click. A literal drawn in the same
    // box reads as one, so inline code is mono text and nothing else: no
    // fill, no border, and never a token accent.
    const code = prose.match(/\n\s*\.prose :not\(pre\) > code \{([^}]*)\}/)?.[1];
    expect(code).toBeDefined();
    for (const property of ["background", "border", "padding", "--solus-token-accent"]) {
      expect(code!, property).not.toMatch(new RegExp(`\\n\\s*${property}[\\w-]*:`));
    }
  });

  test("a code span sets at the body's x-height", () => {
    // WHY: a mono face at a fixed ratio such as 0.9em reads smaller than the
    // text around it, and by a different amount for each face. The prose
    // root resolves `font-size-adjust` from its own face; the code span keeps
    // 1em and inherits that ratio, so its lowercase letters match the body's.
    const root = prose.match(/\n\s*\.prose \{([^}]*)\}/)?.[1] ?? "";
    expect(root).toMatch(/\n\s*font-size-adjust:\s*from-font;/);
    const code = prose.match(/\n\s*\.prose :not\(pre\) > code \{([^}]*)\}/)?.[1] ?? "";
    expect(code).toMatch(/\n\s*font-size:\s*1em;/);
    expect(code).not.toMatch(/font-size-adjust/);
  });
});
