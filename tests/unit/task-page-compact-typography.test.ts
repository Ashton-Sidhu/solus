import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

function source(relativePath: string): string {
  return readFileSync(join(import.meta.dir, "../../", relativePath), "utf8");
}

const header = source(
  "src/renderer/components/tasks/task-page/TaskHeader.svelte",
);
const sidebar = source(
  "src/renderer/components/tasks/task-page/TaskSidebar.svelte",
);
const sessions = source(
  "src/renderer/components/tasks/task-page/TaskSessionsList.svelte",
);
const linked = source(
  "src/renderer/components/tasks/task-page/TaskLinkedTable.svelte",
);
const taskPrs = source(
  "src/renderer/components/tasks/task-page/TaskPrList.svelte",
);
const tasksPage = source("src/renderer/components/tasks/TasksPage.svelte");
const listRow = source("src/renderer/components/ui/list-page/ListRow.svelte");
const rendererCss = source("src/renderer/index.css");

describe("compact task typography", () => {
  test("uses metadata-sized text throughout task detail content", () => {
    // WHY: laptop task pages need to spend their limited width on content, not
    // oversized labels. The title remains a page title by product decision.
    expect(header).toContain(
      '<div class="flex items-center gap-[13px] pb-[11px] text-workspace-chrome">',
    );
    expect(header).toContain(
      '<div class="task-description-prose pt-[18px] text-workspace-chrome">',
    );
    expect(rendererCss).toMatch(
      /\.task-description-prose \.solus-doc-editor \.ProseMirror \{\s*--prose-pr-size: var\(--text-workspace-chrome\);/,
    );
    expect(header).toContain("text-2xl");
    expect(sidebar).toContain("text-workspace-chrome");
    expect(sessions).toContain("text-workspace-chrome font-medium");
    expect(linked).toContain("truncate text-workspace-chrome");
    expect(taskPrs).toContain("text-workspace-chrome font-normal");
  });

  test("keeps task list titles compact on laptops and larger on wide displays", () => {
    // WHY: laptop task rows need density, while wide displays have room for a
    // more readable task title without changing the shared PR list scale.
    expect(tasksPage).toMatch(/<ListRow[\s\S]*?responsiveTitle/);
    expect(listRow).toContain("responsiveTitle?: boolean");
    expect(listRow).toMatch(
      /responsiveTitle[\s\S]*?'text-workspace-chrome'[\s\S]*?: 'text-sm'/,
    );
  });
});
