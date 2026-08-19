import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const taskPicker = readFileSync(
  join(
    import.meta.dir,
    "@solus/workspace-ui/components/session/TaskPicker.svelte",
  ),
  "utf8",
);

describe("task picker layout", () => {
  test("gives the task preview more width on laptop displays", () => {
    // WHY: the task preview holds a list and a reading pane side by side. The
    // old three-quarter width left both columns cramped on laptop displays.
    expect(taskPicker).toContain("max-h-[75%] w-4/5");
    expect(taskPicker).toContain("[.is-laptop-display_&]:w-[90%]");
    expect(taskPicker).toContain("max-md:w-full");
  });

  test("aligns preview metadata on the responsive chrome type rung", () => {
    // WHY: status, priority, project, and opened time are one metadata row.
    // Mixed 12px and 14px values made their baselines and heights disagree.
    expect(taskPicker).toContain(
      "gap-y-1.5 pb-[11px] text-workspace-chrome leading-5",
    );
    expect(taskPicker).not.toContain(
      'text-xs text-(--solus-text-tertiary) opacity-75">opened',
    );
    expect(taskPicker).not.toContain(
      'text-sm text-(--solus-text-tertiary)">{projectLabel(selectedTask)}',
    );
  });
});
