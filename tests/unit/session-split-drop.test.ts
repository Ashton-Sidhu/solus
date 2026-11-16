import { describe, expect, test } from "bun:test";
import { sessionSplitDropZone } from "@solus/workspace-ui/components/layout/lib/session-split-drop";

const split = { left: 200, right: 1200 };

describe("sessionSplitDropZone", () => {
  test("with the companion pane closed, only the half it opens into takes the session", () => {
    expect(sessionSplitDropZone(500, split, null)).toBeNull();
    expect(sessionSplitDropZone(699, split, null)).toBeNull();
    expect(sessionSplitDropZone(700, split, null)).toEqual({ left: 700, right: 1200 });
    expect(sessionSplitDropZone(1150, split, null)).toEqual({ left: 700, right: 1200 });
  });

  test("with the companion pane open, the pane takes the session wherever it sits", () => {
    const companion = { left: 900, right: 1200 };
    // Right of the middle, but over the destination: the destination keeps it.
    expect(sessionSplitDropZone(800, split, companion)).toBeNull();
    expect(sessionSplitDropZone(950, split, companion)).toEqual(companion);
  });

  test("a pointer outside the workspace takes nothing", () => {
    expect(sessionSplitDropZone(1300, split, null)).toBeNull();
  });
});
