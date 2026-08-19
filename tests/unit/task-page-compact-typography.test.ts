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
const taskPage = source(
  "src/renderer/components/tasks/task-page/TaskPage.svelte",
);
const tasksPage = source("src/renderer/components/tasks/TasksPage.svelte");
const listRow = source("src/renderer/components/ui/list-page/ListRow.svelte");
const rendererCss = source("src/renderer/index.css");

describe("compact task typography", () => {
  test("uses metadata-sized text throughout task detail content", () => {
    // WHY: laptop task pages need to spend their limited width on content, not
    // oversized labels. The title remains a page title by product decision.
    //
    // Every part below used to name that size itself, and the page then had to
    // overwrite `--text-workspace-chrome` inline so all six agreed on 12px. Six
    // declarations for one decision: change the page and five files silently
    // disagree with it. The page now declares `text-chrome-dense` once and the
    // header, sidebar, session list, linked table and PR list inherit it. Same
    // rendered size; one place to change it.
    expect(taskPage).toContain("text-chrome-dense");
    expect(taskPage).not.toContain("[--text-workspace-chrome:");
    for (const part of [header, sidebar, sessions, linked, taskPrs]) {
      expect(part).not.toContain("text-workspace-chrome");
    }
    // The description is prose, not chrome, so it takes its size from a var
    // rather than a class — but from the same rung the page declares.
    expect(rendererCss).toMatch(
      /\.task-description-prose \.solus-doc-editor \.ProseMirror \{\s*--prose-pr-size: var\(--text-chrome-dense\);/,
    );
    expect(header).toContain("text-2xl");
  });

  test("uses the canonical responsive rung for task list titles", () => {
    // WHY: task list titles stay compact on laptops but increase on large
    // desktop displays and coarse-pointer mobile clients.
    expect(tasksPage).not.toContain("[--text-workspace-chrome:0.75rem]");
    expect(tasksPage).not.toContain(
      "pointer-coarse:[--text-workspace-chrome:0.875rem]",
    );
    expect(tasksPage).toMatch(/<ListRow[\s\S]*?responsiveTitle/);
    expect(listRow).toContain("responsiveTitle?: boolean");
    // The opt-in still names the responsive rung. What changed is the branch
    // that declines it: it used to pin `text-sm`, a fixed 14px that ignored the
    // list page hosting it. It now says nothing, so the title inherits the
    // surface — which is the same compact rung, and stays that way if the
    // surface ever moves.
    expect(listRow).toMatch(
      /responsiveTitle[\s\S]*?'text-workspace-chrome'[\s\S]*?: ''/,
    );
    expect(listRow).not.toContain("'text-sm'");
  });
});
