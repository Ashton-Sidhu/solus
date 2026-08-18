import { describe, expect, test } from "bun:test";
import type { Message } from "../../src/shared/types";
import {
  conversationFindTopInset,
  findConversationMatches,
  isSearchableConversationMessage,
} from "../../src/renderer/components/conversation/lib/find";

function message(
  id: string,
  role: Message["role"],
  content: string,
  extra: Partial<Message> = {},
): Message {
  return { id, role, content, timestamp: 1, ...extra };
}

describe("conversation find", () => {
  test("clears the floating conversation breadcrumb without moving other surfaces", () => {
    // WHY: the retained transcript slot is paint-contained, so the find bar
    // cannot use z-index to rise above the sibling breadcrumb stacking layer.
    expect(conversationFindTopInset(true)).toBe(66);
    expect(conversationFindTopInset(false)).toBe(8);
  });

  test("searches only visible user and plain assistant prose", () => {
    const messages = [
      message("user", "user", "Find this"),
      message("assistant", "assistant", "and FIND this"),
      message("tool", "tool", "find this"),
      message("plan", "plan", "find this"),
      message("work", "assistant", "find this", {
        workRef: { workId: "work-1", title: "Result" },
      }),
    ];

    expect(findConversationMatches(messages, "find")).toEqual([
      { messageId: "user", occurrence: 0 },
      { messageId: "assistant", occurrence: 0 },
    ]);
  });

  test("preserves message order and occurrence order", () => {
    const messages = [
      message("first", "user", "echo echo"),
      message("second", "assistant", "Echo"),
    ];

    expect(findConversationMatches(messages, "ECHO")).toEqual([
      { messageId: "first", occurrence: 0 },
      { messageId: "first", occurrence: 1 },
      { messageId: "second", occurrence: 0 },
    ]);
  });

  test("excludes provider interrupt notices that render as status rows", () => {
    const notice = message(
      "notice",
      "user",
      "[Request interrupted by user for tool use]",
    );
    expect(isSearchableConversationMessage(notice)).toBe(false);
  });
});
