import { describe, expect, test } from "bun:test";
import type { SessionProgress } from "../../src/shared/types";
import {
  buildSessionProgressRing,
  shouldShowSessionProgressRing,
} from "../../src/renderer/components/layout/lib/session-progress-ring";

function progress(
  statuses: SessionProgress["todos"][number]["status"][],
): SessionProgress {
  const todos = statuses.map((status, index) => ({
    content: `Step ${index + 1}`,
    status,
  }));
  return {
    todos,
    currentStep: statuses.filter((status) => status === "completed").length,
    totalSteps: statuses.length,
  };
}

describe("background session progress ring", () => {
  test("only replaces the status glyph for inactive running sessions with steps", () => {
    const liveProgress = progress(["in_progress", "pending"]);

    expect(shouldShowSessionProgressRing(liveProgress, "running", false)).toBe(
      true,
    );
    expect(
      shouldShowSessionProgressRing(liveProgress, "connecting", false),
    ).toBe(true);
    expect(shouldShowSessionProgressRing(liveProgress, "running", true)).toBe(
      false,
    );
    expect(
      shouldShowSessionProgressRing(liveProgress, "awaiting_input", false),
    ).toBe(false);
    expect(
      shouldShowSessionProgressRing(progress([]), "running", false),
    ).toBe(false);
  });

  test("renders one stateful segment per step for short sessions", () => {
    const ring = buildSessionProgressRing(
      progress(["completed", "in_progress", "pending"]),
    );

    expect(ring.mode).toBe("segmented");
    expect(ring.segments.map((segment) => segment.state)).toEqual([
      "completed",
      "in_progress",
      "pending",
    ]);
    expect(ring.segments[0].start).toBe(0);
    expect(ring.segments[1].start).toBeCloseTo(100 / 3);
    expect(ring.label).toBe(
      "1 of 3 steps complete · Running: Step 2",
    );
  });

  test("shows the next pending step as current while a session starts it", () => {
    const ring = buildSessionProgressRing(
      progress(["completed", "pending", "pending"]),
    );

    expect(ring.segments.map((segment) => segment.state)).toEqual([
      "completed",
      "in_progress",
      "pending",
    ]);
    expect(ring.label).toContain("Running: Step 2");
  });

  test("uses a continuous summary for long sessions", () => {
    const ring = buildSessionProgressRing(
      progress([
        "completed",
        "completed",
        "in_progress",
        "pending",
        "pending",
        "pending",
        "pending",
        "pending",
        "pending",
        "pending",
        "pending",
      ]),
    );

    expect(ring.mode).toBe("continuous");
    expect(ring.segments).toHaveLength(3);
    expect(ring.segments[1]).toMatchObject({
      start: 0,
      state: "completed",
    });
    expect(ring.segments[1].length).toBeCloseTo((2 / 11) * 100);
    expect(ring.segments[2].start).toBeCloseTo((2 / 11) * 100);
    expect(ring.segments[2].length).toBeCloseTo((1 / 11) * 100);
  });
});
