import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL(
    "../../packages/workspace-ui/src/components/diff/DiffStream.svelte",
    import.meta.url,
  ),
  "utf8",
);

describe("diff thread annotation context", () => {
  test("inherits the workspace context when mounting a review thread", () => {
    // WHY: @pierre/diffs mounts annotations outside DiffStream's component tree.
    // A review comment containing inline code renders CodeSpan, which reads the
    // workspace context and otherwise throws Svelte's missing_context error.
    expect(source).toContain("const annotationContexts = getAllContexts();");
    expect(source).toMatch(
      /mount\(DiffThreadComment, \{[\s\S]*?target,[\s\S]*?context: annotationContexts,[\s\S]*?props:/,
    );
  });
});
