import { describe, expect, test } from "bun:test";
import type { Message } from "@solus/contracts/types";
import {
  findConversationMatches,
  isSearchableConversationMessage,
  stepConversationMatch,
} from "@solus/workspace-ui/components/conversation/lib/find";

function message(
  id: string,
  role: Message["role"],
  content: string,
  extra: Partial<Message> = {},
): Message {
  return { id, role, content, timestamp: 1, ...extra };
}

describe("conversation find", () => {
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

  test("a message seen on screen counts only the matches the reader can see", () => {
    // The link target and the chip's hidden folders hold "plans/", but the
    // screen shows it once: an active match on a hidden one is never on screen.
    const content = "See [the plan](docs/plans/a.md) and `docs/plans/b.md`.";
    const messages = [message("reply", "assistant", content)];

    expect(findConversationMatches(messages, "plans/")).toHaveLength(2);
    const seen = new Map([["reply", { content, count: 1 }]]);
    expect(findConversationMatches(messages, "plans/", seen)).toEqual([
      { messageId: "reply", occurrence: 0 },
    ]);
  });

  test("a visible count stops applying once the message content changes", () => {
    const messages = [message("reply", "assistant", "plans/ plans/")];
    const stale = new Map([["reply", { content: "plans/", count: 1 }]]);
    expect(findConversationMatches(messages, "plans/", stale)).toHaveLength(2);
  });

  test("steps on from a match that is no longer counted", () => {
    const messages = [
      message("first", "user", "x"),
      message("second", "assistant", "x"),
      message("third", "assistant", "x"),
    ];
    // "second" turned out to show no match on screen.
    const matches = [
      { messageId: "first", occurrence: 0 },
      { messageId: "third", occurrence: 0 },
    ];
    const gone = { messageId: "second", occurrence: 0 };

    expect(stepConversationMatch(matches, messages, gone, 1)).toEqual(matches[1]);
    expect(stepConversationMatch(matches, messages, gone, -1)).toEqual(matches[0]);
    expect(stepConversationMatch(matches, messages, matches[1], 1)).toEqual(matches[0]);
    expect(stepConversationMatch(matches, messages, matches[0], -1)).toEqual(matches[1]);
    expect(stepConversationMatch([], messages, gone, 1)).toBeUndefined();
  });
});
