import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const tasksPage = readFileSync(
  join(
    import.meta.dir,
    "../../packages/workspace-ui/src/components/tasks/TasksPage.svelte",
  ),
  "utf8",
);
const inboxRow = readFileSync(
  join(
    import.meta.dir,
    "../../packages/workspace-ui/src/components/ui/list-page/InboxRow.svelte",
  ),
  "utf8",
);

describe("Tasks inbox multi-select", () => {
  test("reuses the list checkbox and bulk-action bar in the inbox", () => {
    // WHY: All tasks and My inbox are views of the same task records. They must
    // not drift into separate selection controls or bulk-action implementations.
    expect(tasksPage).toMatch(
      /<InboxRow[\s\S]*?{#snippet leading\(\)}[\s\S]*?{@render rowCheckbox\(item\.row\.key\)}/,
    );
    expect(tasksPage).toContain(
      '{#if layout === "list" && selection.size > 0 && !panelOpen}',
    );
    expect(tasksPage).not.toContain(
      'layout === "board" || view === "inbox" || !open',
    );
  });

  test("gives the shared inbox row a page-owned leading-control slot", () => {
    // WHY: Checkbox behavior belongs to TasksPage, while InboxRow only provides
    // the same composable control slot as the regular list row.
    expect(inboxRow).toContain("leading?: Snippet");
    expect(inboxRow).toContain("{#if leading}{@render leading()}{/if}");
  });

  test("uses the active view order for range selection and keyboard movement", () => {
    // WHY: Shift-select in My inbox must follow the inbox order, not the hidden
    // order of the All tasks view.
    expect(tasksPage).toMatch(
      /const flatVisibleIds = \$derived\([\s\S]*?view === "inbox" \? inboxGroups : groups/,
    );
  });
});
