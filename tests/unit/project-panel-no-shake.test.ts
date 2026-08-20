import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const menuRowSource = readFileSync(
  join(
    import.meta.dir,
    "../../packages/workspace-ui/src/components/project-panel/MenuRow.svelte",
  ),
  "utf8",
);

describe("project panel row motion", () => {
  test("never shakes Git action rows", () => {
    // WHY: commit, push, and pull request failures must not move the project
    // panel. The error is already reported through the Git action feedback.
    expect(menuRowSource).not.toContain("@keyframes shake");
    expect(menuRowSource).not.toContain("animation: shake");
    expect(menuRowSource).not.toContain("class:is-error");
  });
});
