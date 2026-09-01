import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  INBOX_RECORD_ROW_HEIGHT,
  LIST_RECORD_ROW_HEIGHT,
  TASK_RECORD_ROW_HEIGHT,
  inboxRowHeight,
  listRowHeight,
} from "@solus/workspace-ui/components/ui/list-page/list-page";

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A virtualiser is told a row's height before the browser lays that row out, so
 * the number here and the CSS over there are one fact kept in two places. When
 * they disagreed — a title free to wrap onto a third line inside a slot sized
 * for one — the row painted past its slot and over the row beneath it, which
 * only became visible once a row was selected and had a background to paint.
 *
 * These tests pin the agreement itself: every record shape must have a ceiling
 * in CSS, and the number must be that ceiling.
 */

const COMPONENTS = resolve(
  import.meta.dir,
  "../../packages/workspace-ui/src/components",
);
const source = (path: string) =>
  readFileSync(resolve(COMPONENTS, path), "utf8");

const RUNG = "@max-[30rem]/pane";

describe("the record rung's two row shapes", () => {
  it("gives tasks the drawer row and everything else the three-line record", () => {
    // Same rung, two rows: a pull request has a branch, a check state and a
    // diffstat to say; a task is very nearly just its title.
    expect(listRowHeight({ record: true, split: false, drawerRow: true }))
      .toBe(TASK_RECORD_ROW_HEIGHT);
    expect(listRowHeight({ record: true, split: false })).toBe(
      LIST_RECORD_ROW_HEIGHT,
    );
    expect(TASK_RECORD_ROW_HEIGHT).not.toBe(LIST_RECORD_ROW_HEIGHT);
  });

  it("keeps one row above the rung, where the shape decides nothing", () => {
    // The shape is a record-rung question. Above it both surfaces are the same
    // single line, and asking for a drawer must not quietly resize that line.
    for (const split of [true, false]) {
      expect(listRowHeight({ record: false, split, drawerRow: true }))
        .toBe(listRowHeight({ record: false, split }));
    }
  });
});

describe("every record height is a ceiling the stylesheet is held to", () => {
  it("bounds the three-line record's title, and counts the bound into its height", () => {
    // 95 was the height of a one-line title. The second line is the clamp, so
    // the constant has to carry it — otherwise the clamp is the only thing that
    // moved and the overlap comes back at two lines instead of three.
    expect(source("ui/list-page/ListRow.svelte")).toContain(
      `${RUNG}:line-clamp-2`,
    );
    expect(LIST_RECORD_ROW_HEIGHT).toBe(95 + 19);
  });

  it("fixes the task row's height outright, so there is nothing left to disagree", () => {
    // The drawer row has no wrapping text at all: one line of title, one line
    // of meta, a stated height. A `line-clamp` here would mean the title had
    // been allowed to wrap in the first place.
    const taskRow = source("tasks/TaskListRow.svelte");
    expect(taskRow).toContain("h-[3.875rem]");
    expect(TASK_RECORD_ROW_HEIGHT).toBe(3.875 * 16);
    expect(taskRow).toContain("truncate");
    expect(taskRow).not.toContain("line-clamp");
    expect(taskRow).not.toContain("h-auto");
  });

  it("draws the task row at the spec's measurements", () => {
    // 62px, a 28px state tile, an 11px gutter — the same row the web client's
    // session drawer already draws from a `SidebarTask`. Two components, one
    // spec; if these drift the two surfaces stop being the same row.
    const taskRow = source("tasks/TaskListRow.svelte");
    const drawerRow = readFileSync(
      resolve(import.meta.dir, "../../apps/client/src/components/MobileTaskRow.svelte"),
      "utf8",
    );
    for (const measurement of ["h-[3.875rem]", "gap-[0.6875rem]", "size-7", "px-3"]) {
      expect(taskRow).toContain(measurement);
      expect(drawerRow).toContain(measurement);
    }
  });
});

describe("the inbox record puts its verbs on a line of their own", () => {
  const inboxRow = source("ui/list-page/InboxRow.svelte");

  it("measures the row it actually draws", () => {
    // 55px of row inside a 106px slot left ~51px of dead air under every row —
    // the same desync as the overlap, with the sign flipped.
    expect(inboxRow).toContain(`${RUNG}:h-[99px]`);
    expect(inboxRowHeight(true)).toBe(INBOX_RECORD_ROW_HEIGHT);
    expect(INBOX_RECORD_ROW_HEIGHT).toBe(20 + 39 + 6 + 34);
    expect(inboxRowHeight(false)).toBe(55);
  });

  it("holds the same height whether the row can be acted on or not", () => {
    // The right end is a swap: verbs when there is something to do, chips and
    // a time when there is not. Both ends take the record's third line and both
    // are 34px, so a row in "Done" measures the same as a row in "Needs you".
    const line = inboxRow.match(
      new RegExp(`${escapeRegExp(RUNG)}:h-\\[34px\\]`, "g"),
    ) ?? [];
    // Both ends of the swap, plus the two buttons that sit in one of them.
    expect(line.length).toBe(4);
    const basis = inboxRow.match(
      new RegExp(`${escapeRegExp(RUNG)}:basis-full`, "g"),
    ) ?? [];
    expect(basis.length).toBe(2);
  });

  it("gives the verbs a thumb-sized target and keeps their labels whole", () => {
    expect(inboxRow).toContain(`${RUNG}:px-3.5`);
    const nowrap = inboxRow.match(/whitespace-nowrap/g) ?? [];
    expect(nowrap.length).toBeGreaterThanOrEqual(2);
  });

  it("drops the keyboard hint on a pointer that has no keyboard", () => {
    // The hand, not the window: a tablet with a keyboard attached keeps it.
    expect(inboxRow).toContain("pointer-coarse:hidden");
  });
});

describe("the pages ask for the shape they render", () => {
  it("the task list asks for the drawer row it draws", () => {
    // A page that renders `TaskListRow` and sizes its slots as a record would
    // reintroduce the original defect with the numbers swapped.
    const tasksPage = source("tasks/TasksPage.svelte");
    expect(tasksPage).toContain("TaskListRow");
    expect(tasksPage).toContain("drawerRow: true");
  });

  it("the pull request list keeps the record, and says so by not asking", () => {
    const prsPage = source("prs/PrsPage.svelte");
    expect(prsPage).not.toContain("drawerRow");
    expect(prsPage).not.toContain("TaskListRow");
  });
});
