import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { Message } from "@solus/contracts/types";
import {
  conversationFindTopInset,
  findConversationMatches,
  isSearchableConversationMessage,
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

describe("breadcrumb room", () => {
  const read = (path: string) =>
    readFileSync(join(import.meta.dir, "../..", path), "utf8");

  test("reserves room only where a shell says it painted the band", () => {
    // WHY: `isEditorMode` is unconditionally true on web, so the transcript used
    // to reserve 58px under a band the mobile shell never renders — dead space
    // above the first message. The room now follows `bandAbove`.
    expect(
      read(
        "packages/workspace-ui/src/components/conversation/ConversationView.svelte",
      ),
    ).toContain("bandAbove && isEditorMode && isVisible && !forceVisible");
  });

  test("gates the mobile band and its reserved room on one decision", () => {
    // WHY: two independent mobile checks drift. Painting the band without the
    // room slides the first message under it; the room without the band is the
    // gap this replaced. `isMobile` decides both or neither.
    const webLayout = read("apps/client/src/components/WebLayout.svelte");
    expect(webLayout).toContain("session.activeTabId && !isMobile");
    expect(webLayout).toContain("bandAbove={!isMobile}");
  });
});
