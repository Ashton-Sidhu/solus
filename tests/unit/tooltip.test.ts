import { describe, expect, test } from "bun:test";
import { tooltipDisplay } from "../../src/renderer/components/ui/tooltip/content";

describe("tooltip display content", () => {
  test("separates parenthesized keyboard shortcuts into a scannable keycap", () => {
    expect(tooltipDisplay("Change project (⌥⇧O)")).toEqual({
      label: "Change project",
      shortcut: "⌥⇧O",
    });
    expect(tooltipDisplay("Send (Enter)")).toEqual({
      label: "Send",
      shortcut: "Enter",
    });
  });

  test("separates dot-delimited shortcuts without treating ordinary metadata as a keycap", () => {
    expect(tooltipDisplay("Send to new session · ⌘⇧↵")).toEqual({
      label: "Send to new session",
      shortcut: "⌘⇧↵",
    });
    expect(tooltipDisplay("Pull requests · 3")).toEqual({
      label: "Pull requests · 3",
    });
  });

  test("preserves explicit labels and shortcuts for product-specific copy", () => {
    expect(
      tooltipDisplay({
        label: "Change the project for this chat",
        shortcut: "⌥⇧⌘O",
      }),
    ).toEqual({
      label: "Change the project for this chat",
      shortcut: "⌥⇧⌘O",
    });
  });
});
