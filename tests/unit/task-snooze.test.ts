import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { taskSnoozeAnchorTarget } from "@solus/workspace-ui/components/session/lib/task-snooze";

const dom = new JSDOM("<button id=\"snooze\"></button>");
Object.assign(globalThis, {
  HTMLElement: dom.window.HTMLElement,
  DOMRect: dom.window.DOMRect,
});

/** The snooze menu is a dropdown now, so it must hang off whatever opened it:
 *  a row's button positions from the button, and a context menu — which has no
 *  element to point at — positions from the point the user clicked. */
describe("taskSnoozeAnchorTarget", () => {
  test("follows the button that opened the menu", () => {
    const button = dom.window.document.getElementById("snooze")!;
    button.getBoundingClientRect = () => new DOMRect(10, 20, 24, 24);
    const target = taskSnoozeAnchorTarget(button);
    button.getBoundingClientRect = () => new DOMRect(10, 60, 24, 24);
    expect(target.getBoundingClientRect().top).toBe(60);
  });

  /** The row hides its action cluster the moment the pointer leaves it — which
   *  is exactly the trip to the menu the user just opened. */
  test("holds the last seen position once the button is hidden", () => {
    const button = dom.window.document.getElementById("snooze")!;
    button.getBoundingClientRect = () => new DOMRect(10, 60, 24, 24);
    const target = taskSnoozeAnchorTarget(button);
    button.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
    const rect = target.getBoundingClientRect();
    expect([rect.left, rect.top, rect.width]).toEqual([10, 60, 24]);
  });

  test("turns a context-menu point into a rect at that point", () => {
    const rect = taskSnoozeAnchorTarget({ x: 120, y: 240 }).getBoundingClientRect();
    expect([rect.left, rect.top, rect.width, rect.height]).toEqual([120, 240, 0, 0]);
  });
});
