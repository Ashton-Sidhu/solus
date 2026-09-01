import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const source = readFileSync(
  join(
    import.meta.dir,
    "../../packages/workspace-ui/src/components/project-panel/EnvironmentSection.svelte",
  ),
  "utf8",
);

describe("the environment branch row", () => {
  test("clicking the branch copies its full ref instead of only its display name", () => {
    // Worktree labels can be shortened for display. The clipboard must receive
    // the real branch ref so the pasted value remains valid for Git commands.
    expect(source).toContain("await copyText(copyableBranch)");
    expect(source).toContain("onclick={copyBranchName}");
    expect(source).not.toContain("copyText(displayedBranch)");
  });

  test("branch switching remains a separate keyboard-accessible action", () => {
    // Copy is the large row target. The disclosure still owns the picker, so a
    // user can switch environments without making the copy action ambiguous.
    expect(source).toContain('class="branch-picker-trigger"');
    expect(source).toContain("bind:this={branchTriggerEl}");
    expect(source).toContain('aria-label={pendingDispatch ? "Select a remote worktree"');
  });
});
