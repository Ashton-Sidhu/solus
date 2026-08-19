import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const taskSidebarSource = readFileSync(
  join(
    import.meta.dir,
    "@solus/workspace-ui/components/tasks/task-page/TaskSidebar.svelte",
  ),
  "utf8",
);
const taskSkeletonSource = readFileSync(
  join(
    import.meta.dir,
    "@solus/workspace-ui/components/tasks/task-page/TaskPageSkeleton.svelte",
  ),
  "utf8",
);
const prActivityRailSource = readFileSync(
  join(
    import.meta.dir,
    "@solus/workspace-ui/components/pr-review/PrActivityRail.svelte",
  ),
  "utf8",
);

describe("detail page right rail widths", () => {
  test("keeps task and PR content roomy at laptop widths", () => {
    // WHY: wide metadata rails squeeze the primary reading column on laptops.
    // Both detail pages must use the same compact rail scale and still fold
    // below their existing narrow-layout breakpoints.
    expect(taskSidebarSource).toContain("[--task-rail-width:308px]");
    expect(taskSidebarSource).toContain(
      "[.is-laptop-display_&]:[--task-rail-width:260px]",
    );
    expect(taskSkeletonSource).toContain(
      "[.is-laptop-display_&]:[--task-rail-width:260px]",
    );
    expect(taskSidebarSource).toContain("@max-[60rem]:w-full");
    expect(taskSkeletonSource).toContain("@max-[60rem]:w-full");
    expect(prActivityRailSource).toContain(
      "[--pr-activity-rail-width:clamp(280px,22%,360px)]",
    );
    expect(prActivityRailSource).toContain(
      "[.is-laptop-display_&]:[--pr-activity-rail-width:clamp(260px,20%,320px)]",
    );
    expect(prActivityRailSource).toContain("@max-[1000px]:w-full");
  });
});
