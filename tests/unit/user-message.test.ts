import { describe, expect, test } from "bun:test";
import { shouldCollapseUserMessage } from "@solus/workspace-ui/components/conversation/lib/user-message";

describe("user message truncation", () => {
  test("keeps routine prompts fully visible", () => {
    expect(shouldCollapseUserMessage("Explain this function.")).toBe(false);
    expect(shouldCollapseUserMessage("x".repeat(700))).toBe(false);
  });

  test("collapses pasted text once it exceeds the character budget", () => {
    expect(shouldCollapseUserMessage("x".repeat(701))).toBe(true);
  });

  test("collapses vertically long content even when it is short", () => {
    expect(
      shouldCollapseUserMessage(
        Array.from({ length: 12 }, () => "x").join("\n"),
      ),
    ).toBe(false);
    expect(
      shouldCollapseUserMessage(
        Array.from({ length: 13 }, () => "x").join("\n"),
      ),
    ).toBe(true);
  });
});
