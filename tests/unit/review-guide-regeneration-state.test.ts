import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const guideSurface = readFileSync(
  new URL(
    "../../packages/workspace-ui/src/components/review/GuideSurface.svelte",
    import.meta.url,
  ),
  "utf8",
);

describe("review guide regeneration state", () => {
  test("shows progress instead of the cached guide while regeneration runs", () => {
    // WHY: regeneration keeps the previous guide in the loader until its
    // replacement is ready. The running state must take precedence or users
    // continue to see content that they explicitly asked Solus to replace.
    expect(guideSurface).toContain(
      "{#if loader.loading || generationInProgress}",
    );
    expect(guideSurface).not.toContain(
      "(loader.loading || generationInProgress) && loader.guide === null",
    );
  });
});
