import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

function source(relativePath: string): string {
  return readFileSync(join(import.meta.dir, "../../", relativePath), "utf8");
}

const taskHeader = source(
  "src/renderer/components/tasks/task-page/TaskHeader.svelte",
);
const prActivity = source(
  "src/renderer/components/pr-review/ActivityFeed.svelte",
);
const rendererCss = source("src/renderer/index.css");

describe("desktop description typography", () => {
  test("steps up task and pull request descriptions only on desktop", () => {
    // WHY: descriptions are primary reading content on desktop, but mobile and
    // denser PR conversation bodies must keep their existing compact size.
    expect(taskHeader).toContain("task-description-prose");
    expect(prActivity).toContain("prose-pr-description");
    expect(rendererCss).toMatch(
      /@media \(pointer: fine\) \{[\s\S]*?\.prose-pr-description,[\s\S]*?\.task-description-prose \.solus-doc-editor \.ProseMirror \{[\s\S]*?--prose-pr-size: calc\(0\.875rem \* var\(--solus-font-scale, 1\)\);/,
    );
    expect(rendererCss).toMatch(
      /:is\(\.prose-pr-description, \.task-description-prose \.solus-doc-editor \.ProseMirror\)[\s\S]*?:is\(h1, h2, h3, h4, h5, h6, li, blockquote, \.markdown-alert\) \{[\s\S]*?font-size: var\(--prose-pr-size\);/,
    );
  });
});
