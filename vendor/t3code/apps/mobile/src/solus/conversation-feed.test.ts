import { RunId } from "@t3tools/contracts";
import { deriveThreadFeedPresentation } from "../lib/threadActivity";
import { expect, it, vi } from "vite-plus/test";
import type { TranscriptItem } from "@solus-mobile/features/conversation/lib/transcript-model";
import { conversationFeed } from "./conversation-feed";

it("keeps host cards in transcript order and collapses only older versions of the same work", () => {
  const items: TranscriptItem[] = [
    {
      kind: "user",
      id: "p",
      text: "look",
      attachments: [{ kind: "host-image", key: "i", name: "photo", hostPath: "/host/photo" }],
      delivery: "sent",
      error: null,
    },
    { kind: "artifact", id: "old", workId: "work", title: "Graph", html: "<p>one</p>" },
    {
      kind: "tool",
      id: "t",
      toolId: "call",
      toolName: "Read",
      input: null,
      status: "completed",
      errorHead: null,
      childCount: 0,
      subagent: null,
      report: null,
    },
    { kind: "artifact", id: "new", workId: "work", title: "Graph", html: "", contentVersion: 2 },
    { kind: "assistant", id: "reply", sourceSessionId: "previous-provider-session", text: "done" },
    { kind: "image", id: "image", path: "/host/photo" },
  ];
  const byId = new Map(items.map((item) => [item.id, item]));
  const render = vi.fn(() => null);
  const feed = conversationFeed(
    { item: (id) => byId.get(id), subscribeItem: () => () => {} },
    items.map((i) => i.id),
    "session",
    render,
  );
  expect(feed.get().map((row) => row.id)).toEqual([
    "p",
    "p:attachments",
    "old",
    "t",
    "new",
    "reply",
    "image",
  ]);
  const answer = feed.get().find((row) => row.id === "reply");
  expect(answer).toMatchObject({
    type: "message",
    message: { role: "assistant", sourceThreadId: "previous-provider-session" },
  });
  for (const row of feed.get()) if (row.type === "conversation-card") row.render();
  expect(render.mock.calls).toEqual([
    ["p", false],
    ["old", true],
    ["t", false],
    ["new", false],
    ["image", false],
  ]);
});
it("updates streaming text without subscribing the entire feed to tool progress", () => {
  const item: TranscriptItem = { kind: "assistant", id: "a", text: "start" };
  let text = "start";
  const listeners = new Map<string, () => void>();
  const feed = conversationFeed(
    {
      item: (id) =>
        id === "a" ? { ...item, text } : { kind: "notice", id, text: "running", tone: "info" },
      subscribeItem: (id, notify) => {
        listeners.set(id, notify);
        return () => {
          listeners.delete(id);
        };
      },
    },
    ["a", "n"],
    "session",
    () => null,
  );
  const off = feed.subscribe(() => {});
  expect([...listeners.keys()]).toEqual(["a"]);
  text = "finished";
  listeners.get("a")?.();
  expect(feed.get()[0]).toMatchObject({ type: "message", message: { text: "finished" } });
  off();
  expect(listeners.size).toBe(0);
});

it("folds tool calls under their own prompt, keeps interactive results visible and restores tool details on expansion", () => {
  const tool: Extract<TranscriptItem, { kind: "tool" }> = {
    kind: "tool",
    id: "read",
    toolId: "read",
    toolName: "Read",
    status: "completed",
    input: null,
    errorHead: null,
    childCount: 0,
    subagent: null,
    report: null,
  };
  const prompt: TranscriptItem = {
    kind: "user",
    id: "one",
    delivery: "sent",
    attachments: [],
    text: "First",
    error: null,
  };
  const items: TranscriptItem[] = [
    prompt,
    tool,
    { ...tool, id: "edit", toolId: "edit", toolName: "Edit" },
    { ...tool, id: "app", toolId: "app", toolName: "mcp__solus__calendar__agenda" },
    { kind: "assistant", id: "answer", text: "Done." },
    { ...prompt, id: "two" },
    { ...tool, id: "run", toolId: "run", status: "running" },
  ];
  const byId = new Map(items.map((item) => [item.id, item]));
  const feed = conversationFeed(
    { item: (id) => byId.get(id), subscribeItem: () => () => {} },
    items.map((i) => i.id),
    "session",
    () => null,
  ).get();
  const present = (
    expanded: Set<RunId>,
    visibility: "showAll" | "zen" | "hideSuccessful" = "showAll",
  ) =>
    deriveThreadFeedPresentation(feed, null, expanded, new Set(), null, false, undefined, {
      toolCallVisibility: visibility,
      revealedMessageId: null,
    });
  const collapsed = present(new Set());
  expect(collapsed.map((row) => row.id)).toEqual([
    "one",
    "run-fold:runless:one",
    "app:app",
    "answer",
    "two",
    "run-fold:runless:two",
  ]);
  expect(collapsed.at(-1)).toMatchObject({ type: "run-fold", label: "Working" });
  const expanded = new Set([RunId.make("runless:one")]);
  expect(present(expanded).map((row) => row.id)).toEqual([
    "one",
    "run-fold:runless:one",
    "read",
    "edit",
    "app",
    "app:app",
    "answer",
    "two",
    "run-fold:runless:two",
  ]);
  for (const mode of ["zen", "hideSuccessful"] as const) {
    const ids = present(expanded, mode).map((row) => row.id);
    expect(ids).not.toContain("read");
    expect(ids).toContain("app:app");
  }
});
