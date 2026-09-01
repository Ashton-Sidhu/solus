import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The bulk action bar is the only control that appears *because* the user made
 * a selection, so it is also the only one they cannot navigate away from to
 * reach. That makes its narrow rung a correctness question rather than a
 * cosmetic one: an action pushed past the pane edge is an action the selection
 * cannot be undone or acted on with.
 *
 * These rules live entirely in markup, so they are asserted against the source.
 * Each is a rule the redesign states and that nothing else in the suite can
 * fail on.
 */
const source = readFileSync(
  join(
    import.meta.dir,
    "../../packages/workspace-ui/src/components/tasks/TasksPage.svelte",
  ),
  "utf8",
);

/** The bar only — so a rule proved here cannot be satisfied by the page around it. */
const bar = (() => {
  const start = source.indexOf("<!-- Bulk action bar");
  const end = source.indexOf("{#if composing}", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
})();

const RUNG = "@max-[30rem]/pane";

describe("the bulk action bar at the record rung", () => {
  it("clears the home indicator instead of sitting under it", () => {
    // At 393px the bar is full-width at the foot of the pane, where the OS
    // draws its own gesture area. Without the inset the last action is under it.
    expect(bar).toContain(
      `${RUNG}:pb-[max(0.5rem,env(safe-area-inset-bottom,0px))]`,
    );
  });

  it("wraps rather than scrolling or clipping", () => {
    // A scroller would hide Delete and Clear behind a swipe with nothing to say
    // they were there — the failure the wide pill already had at this width.
    expect(bar).toContain(`${RUNG}:flex-wrap`);
    expect(bar).not.toContain("overflow-x-auto");
    expect(bar).not.toContain("overflow-hidden");
  });

  it("never cuts a label", () => {
    // "In progress" wrapped mid-control before the rung existed. Every action
    // keeps its whole word, on its own line if that is what it takes.
    expect(bar).not.toContain("truncate");
    expect(bar).not.toContain("text-ellipsis");
    const labelled = bar.match(/whitespace-nowrap/g) ?? [];
    expect(labelled.length).toBeGreaterThanOrEqual(5);
  });

  it("collapses the four status buttons into one menu, losing no status", () => {
    // Four labelled statuses do not fit beside Complete, Unread and Delete, so
    // at the rung they become a menu. Both spellings must set the same statuses:
    // the run of buttons and the run of menu items each cover every column.
    const setStatusCalls = bar.match(/bulkSetStatus\(col\.status\)/g) ?? [];
    expect(setStatusCalls.length).toBe(2);

    const eachColumn = bar.match(/\{#each BOARD_COLUMNS as col \(col\.status\)\}/g) ?? [];
    expect(eachColumn.length).toBe(2);

    // The wide run is hidden at the rung; the menu trigger is hidden above it.
    expect(bar).toContain(`${RUNG}:hidden`);
    expect(bar).toContain(`${RUNG}:inline-flex`);
  });

  it("keeps every other action reachable at the rung", () => {
    // Nothing may be dropped to make room: the rung re-plots the bar, it does
    // not shorten it. Each handler must still be bound exactly once.
    for (const handler of [
      "bulkComplete()",
      "bulkMarkUnread()",
      "bulkDelete",
      "selection.clear()",
    ]) {
      expect(bar.includes(handler)).toBe(true);
    }
  });

  it("gives every action a thumb-sized target", () => {
    // Below 36px a control beside three others is a mis-tap. The wide pill's
    // 26px rows are correct for a pointer and wrong for a thumb.
    const touchTargets = bar.match(/@max-\[30rem\]\/pane:h-9/g) ?? [];
    expect(touchTargets.length).toBe(5);
  });
});
