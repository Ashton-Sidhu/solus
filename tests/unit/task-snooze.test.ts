import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import {
  taskSnoozeAnchorTarget,
  taskSnoozeToastLabel,
  taskSnoozeUntil,
} from "@solus/workspace-ui/components/session/lib/task-snooze";

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

/** "Not now, soon" is the common snooze, so the short presets must wake exactly
 *  that span from now — never at a clock time that could already have passed. */
describe("taskSnoozeUntil", () => {
  const now = new Date("2026-08-21T14:37:12.500Z");

  const relative = [
    { preset: "15m", minutes: 15 },
    { preset: "30m", minutes: 30 },
    { preset: "1h", minutes: 60 },
    { preset: "3h", minutes: 180 },
    { preset: "6h", minutes: 360 },
    { preset: "12h", minutes: 720 },
    { preset: "24h", minutes: 1440 },
  ] as const;

  for (const { preset, minutes } of relative) {
    test(`${preset} wakes ${minutes} minutes from now`, () => {
      expect(taskSnoozeUntil(preset, now) - now.getTime()).toBe(minutes * 60 * 1000);
    });
  }

  test("clock-time presets stay in the future", () => {
    for (const preset of ["evening", "tomorrow", "week"] as const) {
      expect(taskSnoozeUntil(preset, now)).toBeGreaterThan(now.getTime());
    }
  });
});

/** Snoozing a running task leaves the agent running. The user has no way to see
 *  that from the row leaving the list, so the confirmation has to say it — or
 *  they are left guessing whether their work was paused or thrown away. */
describe("taskSnoozeToastLabel", () => {
  test("says the agent keeps working when a turn is in flight", () => {
    expect(taskSnoozeToastLabel({ count: 1, hasNote: false, keepsRunning: true }))
      .toBe("Task snoozed — the agent keeps working");
    expect(taskSnoozeToastLabel({ count: 3, hasNote: false, keepsRunning: true }))
      .toBe("3 tasks snoozed — their agents keep working");
  });

  test("claims nothing about work that is not running", () => {
    expect(taskSnoozeToastLabel({ count: 1, hasNote: true, keepsRunning: false }))
      .toBe("Task snoozed with a reminder");
  });
});
