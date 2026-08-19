import { describe, expect, test } from "bun:test";
import type { PlanDescriptor } from "@solus/contracts/types";
import { filterPlanAutocompleteDescriptors } from "@solus/workspace-ui/components/editor/autocomplete.svelte";

function descriptor(
  title: string,
  cwd: string,
  timestamp: number,
): PlanDescriptor {
  return {
    provider: "claude-code",
    sessionId: `session-${timestamp}`,
    planToolUseId: `plan-${timestamp}`,
    projectPath: "-repo",
    cwd,
    timestamp,
    title,
    excerpt: "",
    status: "pending",
    commentCount: 0,
    bookmarked: false,
    revisions: [],
  };
}

describe("plan autocomplete", () => {
  test("filters the gallery's loaded plan universe to the composer project", () => {
    // WHY: opening # autocomplete must be able to render the already-warmed
    // all-project gallery cache synchronously instead of starting a second scan.
    const loaded = [
      descriptor("Older matching plan", "/repo/packages/app", 1),
      descriptor("Other project", "/elsewhere", 3),
      descriptor("Newest matching plan", "/repo", 2),
    ];

    expect(
      filterPlanAutocompleteDescriptors(loaded, "matching", ["/repo"]),
    ).toEqual([loaded[2], loaded[0]]);
  });
});
