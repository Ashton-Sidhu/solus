import { getProjectionArrayReplacementIndex } from "@t3tools/client-runtime/state/orchestration-v2-projection";
import { v2ThreadShell } from "../../packages/client-runtime/src/state/orchestrationV2TestFixtures";
import { UNMEASURED_REPLY_HEIGHT } from "@solus/contracts/session-history";
import { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { messageImageGallery } from "../features/threads/messageImageGallery";
import { deriveThreadFeedPresentation } from "../lib/threadActivity";
import { expect, it, vi } from "vite-plus/test";
import {
  TranscriptModel,
  type TranscriptItem,
} from "@solus-mobile/features/conversation/lib/transcript-model";
import { conversationFeed as createFeed, hostFeedWork } from "./conversation-feed";

function conversationFeed(
  store: Parameters<typeof createFeed>[0],
  order: readonly string[],
  id: string,
  render: Parameters<typeof createFeed>[2],
) {
  return createFeed(
    store,
    id,
    render,
    async (path) => path,
    async (key) => key,
  )(order);
}

it("opens host turn items with the same text, call details and fork target as legacy history", () => {
  const model = TranscriptModel.fromHistory("session", { before: null, messages: [
    { role: "user", content: "", timestamp: 1, messageId: "u", turnItem: {
      type: "user_message", text: "check it", createdBy: "user", creationSource: "provider", inputIntent: "turn_start",
    } },
    { role: "tool", content: "", timestamp: 2, messageId: "r", toolId: "call", toolName: "Read",
      turnItem: { type: "dynamic_tool", toolName: "Read", input: { path: "file" } } },
    { role: "assistant", content: "", timestamp: 3, messageId: "a", forkPointId: "fork-target",
      turnItem: { type: "assistant_message", text: "finished", streaming: false } },
  ] });
  const feed = conversationFeed({ item: key => model.items.get(key), subscribeFeedItems: () => () => {} },
    model.order, "session", () => null);
  const projection = feed.projection({ ...v2ThreadShell, id: ThreadId.make("session") });
  expect(projection.messages.map(message => message.text)).toEqual(["check it", "finished"]);
  expect(projection.turnItems[1]).toMatchObject({ type: "dynamic_tool", input: { path: "file" } });
  expect(feed.get().at(-1)).toMatchObject({ message: { hostForkPointId: "fork-target" } });
});

it("keeps host cards in transcript order and shows each saved artifact version as T3's render row", () => {
  const items: TranscriptItem[] = [
    {
      kind: "user",
      id: "p",
      text: "look",
      attachments: [{ kind: "host-image", key: "i", name: "photo", hostPath: "/host/photo" }],
      delivery: "sent",
      error: null,
    },
    { kind: "artifact", id: "old", workId: "work", title: "Graph", contentVersion: 1 },
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
    { kind: "artifact", id: "new", workId: "work", title: "Graph", contentVersion: 2, layout: { height: 480, heights: [[375, 480]] } },
    { kind: "assistant", id: "reply", sourceSessionId: "previous-provider-session", text: "done" },
    { kind: "image", id: "image", path: "/host/photo" },
  ];
  const byId = new Map(items.map((item) => [item.id, item]));
  const render = vi.fn(() => null);
  const feed = conversationFeed(
    { item: (id) => byId.get(id), subscribeFeedItems: () => () => {} },
    items.map((i) => i.id),
    "session",
    render,
  );
  const rows = feed.get();
  expect(rows.map((row) => row.type === "html-render" ? "render" : row.id)).toEqual(["p", "render", "t", "render", "reply", "image"]);
  expect(rows.find((row) => row.id === "reply")).toMatchObject({
    type: "message",
    message: { role: "assistant", sourceThreadId: "previous-provider-session" },
  });
  // WHY: T3's feed builder reads a finished `html_render` call, as it does
  // upstream. Each version is its own row, sized by the host's measurement.
  expect(rows.filter((row) => row.type === "html-render").map((row) => row.type === "html-render" && row.render)).toEqual([
    { attachmentId: "artifact:work:1", title: "Graph", height: UNMEASURED_REPLY_HEIGHT },
    { attachmentId: "artifact:work:2", title: "Graph", height: 480, heights: [[375, 480]] },
  ]);
  for (const row of rows) if (row.type === "conversation-card") row.render();
  expect(render.mock.calls).toEqual([["image"]]);
});
it("updates streaming text without subscribing the entire feed to tool progress", () => {
  const item: TranscriptItem = { kind: "assistant", id: "a", text: "start" };
  const items = new Map<string, TranscriptItem>([
    ["a", item],
    ["b", { ...item, id: "b" }],
  ]);
  const listeners = new Set<(keys: readonly string[]) => void>();
  const feed = conversationFeed(
    {
      item: (id) => items.get(id),
      subscribeFeedItems: (notify) => {
        listeners.add(notify);
        return () => {
          listeners.delete(notify);
        };
      },
    },
    ["a", "b"],
    "session",
    () => null,
  );
  const notify = vi.fn();
  const initial = feed.get();
  const shell = { ...v2ThreadShell, id: ThreadId.make("session") };
  const initialMessages = feed.projection(shell).messages;
  const off = feed.subscribe(notify);
  expect(feed.get()).toBe(initial);
  items.set("a", { ...item, text: "finished", streaming: true });
  items.set("b", { ...item, id: "b", text: "another reply" });
  for (const listener of listeners) listener(["a", "b"]);
  expect(notify).toHaveBeenCalledTimes(1);
  expect(feed.get()[0]).toMatchObject({ type: "message", message: { text: "finished" } });
  expect(feed.get()[1]).toMatchObject({ type: "message", message: { text: "another reply" } });
  expect(feed.projection(shell).messages.map(message => message.text)).toEqual(["finished", "another reply"]);
  expect(feed.projection(shell).messages.map(message => message.streaming)).toEqual([true, false]);
  expect(initialMessages.map(message => message.text)).toEqual(["start", "start"]);
  expect(feed.projection(shell).visibleTurnItems.map(row => row.item)).toEqual(feed.projection(shell).turnItems);
  const beforeDelta = feed.projection(shell);
  items.set("b", { ...item, id: "b", text: "another reply continues", streaming: true });
  for (const listener of listeners) listener(["b"]);
  const afterDelta = feed.projection(shell);
  expect(afterDelta.messages[1]?.text).toBe("another reply continues");
  expect(getProjectionArrayReplacementIndex(beforeDelta.turnItems, afterDelta.turnItems)).toBe(1);
  off();
  expect(listeners.size).toBe(0);
});

it("renders background command notices from live and saved turns with their command result", () => {
  const text = "A background command finished after your turn ended (exit 0): bun test\n\nOutput (last part):\n# 4 passed\n* End";
  const live = new TranscriptModel("session");
  live.apply({ type: "user_message", text, via: "background-command" });
  live.apply({ type: "assistant_message", text: "All tests passed." });
  const saved = TranscriptModel.fromHistory("session", {
    messages: [
      { role: "user", messageId: "wake", timestamp: 1, content: text },
      { role: "assistant", messageId: "reply", timestamp: 2, content: "All tests passed." },
    ],
    before: null,
  });
  for (const model of [live, saved]) {
    const feed = conversationFeed(
      { item: (key) => model.items.get(key), subscribeFeedItems: () => () => {} },
      model.order,
      "session",
      () => null,
    ).get();
    expect(feed).toMatchObject([
      { message: { backgroundCommand: { command: "bun test", exitCode: 0, output: "# 4 passed\n* End" } } },
      { message: { role: "assistant", text: "All tests passed." } },
    ]);
  }
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
    {
      ...tool,
      id: "screenshot",
      toolId: "screenshot",
      toolName: "device_screenshot",
      images: [{ assetId: `${"a".repeat(64)}.png`, mimeType: "image/png" }],
    },
    { ...tool, id: "app", toolId: "app", toolName: "mcp__solus__calendar__agenda" },
    { kind: "assistant", id: "answer", text: "Done." },
    { ...prompt, id: "two" },
    { ...tool, id: "run", toolId: "run", status: "running" },
  ];
  const byId = new Map(items.map((item) => [item.id, item]));
  const feed = conversationFeed(
    { item: (id) => byId.get(id), subscribeFeedItems: () => () => {} },
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
    "work-toggle:work-group:local:session:read",
    "screenshot",
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

it("shows workspace image reads inside the turn fold while keeping tool output in its card", () => {
  const read: Extract<TranscriptItem, { kind: "tool" }> = {
    kind: "tool",
    id: "read",
    toolId: "read",
    toolName: "view_image",
    input: '{"path":"docs/screen.png"}',
    status: "completed",
    errorHead: null,
    childCount: 0,
    subagent: null,
    report: null,
  };
  const images = [{ assetId: `${"a".repeat(64)}.png`, mimeType: "image/png" }];
  const items: TranscriptItem[] = [
    { kind: "user", id: "prompt", delivery: "sent", attachments: [], text: "Look", error: null },
    read,
    { ...read, id: "rich", toolId: "rich", toolName: "Read", input: '{"file_path":"/repo/rich.png"}', images },
    { ...read, id: "shot", toolId: "shot", toolName: "device_screenshot", images },
    { kind: "assistant", id: "reply", text: "Done" },
  ];
  const byId = new Map(items.map((item) => [item.id, item]));
  const feed = conversationFeed(
    { item: (id) => byId.get(id), subscribeFeedItems: () => () => {} },
    items.map((item) => item.id),
    "session",
    () => null,
  ).get();
  const collapsed = deriveThreadFeedPresentation(feed, null, new Set());
  expect(collapsed.map((row) => row.id)).toEqual(["prompt", "run-fold:runless:prompt", "reply"]);
  const expanded = deriveThreadFeedPresentation(
    feed, null, new Set([RunId.make("runless:prompt")]),
  );
  expect(expanded.filter((row) => row.type === "viewed-images").map((row) => row.paths)).toEqual([
    ["docs/screen.png"],
    ["/repo/rich.png"],
  ]);
  expect(expanded.filter((row) => row.type === "conversation-card").map((row) => row.id)).toEqual(["rich", "shot"]);
});

it("keeps the arrival time of live messages across streaming updates and leaves unknown history times blank", () => {
  const time = vi.spyOn(Date, "now");
  try {
    const start = Date.UTC(2026, 10, 20, 14);
    time.mockReturnValue(start);
    const model = new TranscriptModel("session");
    model.addOptimisticUser("prompt", "hello");
    time.mockReturnValue(start + 1000);
    model.apply({ type: "text_chunk", text: "first" });
    time.mockReturnValue(start + 2000);
    model.apply({ type: "text_chunk", text: " second" });
    model.items.set("legacy", { kind: "assistant", id: "legacy", text: "older", timestamp: 0 });
    model.items.set("saved", {
      kind: "assistant",
      id: "saved",
      text: "saved",
      timestamp: start - 60000,
    });
    const feed = conversationFeed(
      { item: (key) => model.items.get(key), subscribeFeedItems: () => () => {} },
      [...model.order, "legacy", "saved"],
      "session",
      () => null,
    );
    expect(feed.get().map((row) => row.createdAt)).toEqual([
      new Date(start).toISOString(),
      new Date(start + 1000).toISOString(),
      "",
      new Date(start - 60000).toISOString(),
    ]);
  } finally {
    time.mockRestore();
  }
});

it("reuses existing T3 entries when a new message arrives or an older page opens", () => {
  const items = new Map<string, TranscriptItem>(
    ["one", "two", "three"].map((id) => [id, { id, kind: "assistant", text: id }]),
  );
  const project = createFeed(
    { item: (key) => items.get(key), subscribeFeedItems: () => () => {} },
    "session",
    () => null,
    async (path) => path,
    async (key) => key,
  );
  const initial = project(["two"]).get()[0];
  expect(project(["two", "three"]).get()[0]).toBe(initial);
  expect(project(["one", "two", "three"]).get()[1]).toBe(initial);
});

it("groups a saved run of shell calls and reads only the command the user opens", async () => {
  const model = TranscriptModel.fromHistory("session", {
    messages: [
      { role: "user", messageId: "prompt", content: "Inspect the project", timestamp: 1 },
      ...Array.from({ length: 12 }, (_, i) => ({
        role: "tool" as const,
        toolName: "exec_command",
        toolId: "call-" + i,
        toolInputKey: "input-" + i,
        content: "",
        timestamp: i + 2,
      })),
    ],
    before: null,
  });
  const read = vi.fn(async (_key: string) => JSON.stringify({ cmd: "pwd" }));
  const feed = createFeed(
    { item: (key) => model.items.get(key), subscribeFeedItems: () => () => {} },
    "session",
    () => null,
    async (path) => path,
    read,
  )(model.order).get();
  expect(feed.map((row) => row.type)).toEqual(["message", "activity-group"]);
  const group = feed[1];
  if (group?.type !== "activity-group") throw new Error("Missing command group");
  expect(group.activities).toHaveLength(12);
  expect(read).not.toHaveBeenCalled();
  const command = group.activities[5]!;
  expect(await command.loadHostDetail?.()).toMatchObject({
    type: "command_execution",
    input: "pwd",
  });
  await command.loadHostDetail?.();
  expect(read.mock.calls).toEqual([["input-5"]]);
});

it("restores an image-only message as one gallery and resolves the host photo on demand", async () => {
  const model = TranscriptModel.fromHistory("session", {
    messages: [
      {
        role: "user",
        messageId: "photos",
        content: "",
        timestamp: 1,
        imageAttachments: [{ mimeType: "image/png", dataUrl: "data:image/png;base64,AA" }],
        imageAttachmentRefs: [
          { mimeType: "image/jpeg", hostPath: "/uploads/saved", name: "Camera" },
        ],
      },
    ],
    before: null,
  });
  const resolve = vi.fn(async () => "https://host.test/signed-photo");
  const rows = createFeed(
    { item: (key) => model.items.get(key), subscribeFeedItems: () => () => {} },
    "session",
    () => null,
    resolve,
    async (key) => key,
  )(model.order).get();
  expect(rows).toHaveLength(1);
  const row = rows[0];
  if (row?.type !== "message") throw new Error("Missing image-only message");
  const gallery = messageImageGallery(row.message, {
    environmentId: EnvironmentId.make("host"),
    threadId: ThreadId.make("session"),
    workspaceRoot: null,
  });
  expect(gallery).toMatchObject([
    { kind: "image", uri: "data:image/png;base64,AA" },
    { kind: "image", name: "Camera", resource: { mimeType: "image/jpeg", _tag: "attachment", attachmentId: "upload:session//uploads/saved" } },
  ]);
  expect(resolve).not.toHaveBeenCalled();
  const saved = gallery[1];
  if (!saved || !("resource" in saved)) throw new Error("Missing host photo");
  expect(saved).not.toHaveProperty("resolveUrl");
});

it("keeps the working timer off the previous turn while the next prompt belongs to the pending feed", () => {
  const model = new TranscriptModel("session");
  model.addOptimisticUser("old", "Earlier question");
  model.apply({ type: "assistant_message", text: "Finished" });
  const read = (pending: boolean) => {
    const feed = conversationFeed(
      { item: (id) => model.items.get(id), subscribeFeedItems: () => () => {} },
      model.order, "session", () => null,
    ).get();
    const work = hostFeedWork(feed, true, pending);
    return deriveThreadFeedPresentation(feed, null, new Set(), new Set(), work.activeWorkStartedAt, work.runlessWorkActive)
      .filter((row) => row.type === "run-fold" && row.workingSince).map((row) => row.id);
  };
  expect(read(true)).toEqual([]);
  model.addOptimisticUser("next", "Next question");
  expect(read(false)).toEqual(["run-fold:runless:next"]);
});

it("keeps streaming the first answer while a follow-up waits in the queue", () => {
  const model = new TranscriptModel("session");
  const read = () =>
    conversationFeed(
      { item: (id) => model.items.get(id), subscribeFeedItems: () => () => {} },
      model.order,
      "session",
      () => null,
    ).get();
  model.addOptimisticUser("first", "Start");
  model.setStatus("running");
  model.apply({ type: "text_chunk", text: "First " });
  const reply = model.order[1]!;
  model.addOptimisticUser("next", "Follow up", "sending", [], true);
  expect(read().map((row) => row.id)).toEqual(["first", reply]);
  model.markDelivery("next", "queued");
  model.apply({ type: "text_chunk", text: "answer" });
  expect(read()[1]).toMatchObject({
    id: reply,
    message: { text: "First answer", streaming: true },
  });
  model.apply({ type: "assistant_message", text: "First answer" });
  expect(read()[1]).toMatchObject({ id: reply, message: { streaming: false } });
  model.apply({ type: "user_message", text: "Edited follow-up", clientPromptId: "next" });
  expect(read().map((row) => row.id)).toEqual(["first", reply, "next"]);
  expect(read()[2]).toMatchObject({ message: { text: "Edited follow-up" } });
});

it("keeps a sent video in the T3 message player and signs its host URL only for preview or playback", async () => {
  const { isUploadVideo, messageAttachments, composerUploadMedia, queueChatAttachment } = await import("./upload-images");
  const { splitAttachedFiles } = await import("@solus-mobile/features/conversation/lib/message-attachments");
  const { files } = splitAttachedFiles("[Attached file: /host/clip.MOV]\n\nLook");
  const sign = vi.fn(async (_path: string, refresh?: boolean) => refresh ? "fresh-url" : "poster-url");
  const projected = messageAttachments("session",files, sign)[0]!;
  expect(isUploadVideo(projected)).toBe(true);
  expect(sign).not.toHaveBeenCalled();
  if (!isUploadVideo(projected) || !("resolveUrl" in projected.videoPreview)) throw new Error("missing host video");
  expect(await projected.videoPreview.resolveUrl()).toBe("poster-url");
  expect(await projected.videoPreview.resolveUrl(true)).toBe("fresh-url");
  expect(sign.mock.calls).toEqual([["/host/clip.MOV", undefined], ["/host/clip.MOV", true]]);

  const clip = { id: "clip", name: "recording", size: 100, mimeType: "video/quicktime", hostPath: "/host/video" };
  expect(isUploadVideo(queueChatAttachment({ ...clip, type: "file" }, sign))).toBe(true);
  expect(isUploadVideo(queueChatAttachment({ ...clip, type: "file", name: "paper.pdf", mimeType: "application/pdf" }, sign))).toBe(false);
  const draft = { ...clip, kind: "file" as const, localUri: "file:///picked.mov", dataUrl: null };
  expect(composerUploadMedia("session",[draft], [], [])).toMatchObject([{ type: "file", fileUri: draft.localUri, id: "clip" }]);

  const item: TranscriptItem = { kind: "user", id: "u", text: "Look", attachments: files, delivery: "sent", error: null };
  const feed = conversationFeed({ item: () => item, subscribeFeedItems: () => () => {} }, ["u"], "session", () => null);
  expect(feed.get()).toMatchObject([{ type: "message", message: { attachments: [{ type: "file", name: "clip.MOV" }] } }]);
});

it("keeps a sent document in the T3 message and opens the upload from its original session", async () => {
  const { splitAttachedFiles } = await import("@solus-mobile/features/conversation/lib/message-attachments");
  const { files } = splitAttachedFiles("[Attached file: /uploads/notes.md]\n\nRead this");
  const item: TranscriptItem = { kind: "user", id: "document", text: "Read this", attachments: files, sourceSessionId: "source", delivery: "sent", error: null };
  const rows = conversationFeed({ item: () => item, subscribeFeedItems: () => () => {} }, [item.id], "current", () => null).get();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ type: "message", message: { attachments: [{type:"file", id:"upload:source//uploads/notes.md", name:"notes.md"}] } });
});

it("opens a converted HEIC as an image in a queued or sent message", async () => {
  const { isUploadImage, queueChatAttachment } = await import("./upload-images");
  const { splitAttachedFiles } = await import("@solus-mobile/features/conversation/lib/message-attachments");
  const hostPath = "/uploads/c6bc17110d37cdfa0afa6ded-photo.jpg";
  const sign = vi.fn(async () => "https://host/signed");
  const queued = queueChatAttachment({ id: "attachment", type: "file", name: "photo.heic", mimeType: "image/heic", hostPath }, sign);
  expect(queued).toMatchObject({ type: "image", name: "photo.jpg", mimeType: "image/jpeg" });
  expect(isUploadImage(queued)).toBe(true);
  if (!isUploadImage(queued) || !("path" in queued.preview)) throw new Error("Missing image preview");
  expect(sign).not.toHaveBeenCalled();
  expect(await queued.preview.resolveUrl()).toBe("https://host/signed");
  expect(sign).toHaveBeenCalledWith(hostPath, undefined);

  const { text, files } = splitAttachedFiles(`[Attached file: ${hostPath}]\n\nLook`);
  const item: TranscriptItem = { kind: "user", id: "photo", text, attachments: files, delivery: "sent", error: null };
  const feed = conversationFeed({ item: () => item, subscribeFeedItems: () => () => {} }, [item.id], "s", () => null);
  expect(feed.get()).toMatchObject([
    { type: "message", message: { attachments: [{ type: "image", name: "photo.jpg", id: "upload:s/" + hostPath }] } },
  ]);
});

it("shows the upstream fork marker between inherited history and the new conversation", () => {
  const model = TranscriptModel.fromHistory("fork", {
    before: null,
    messages: [
      { messageId: "old", role: "assistant", content: "Source reply", timestamp: 1, forkPointId: "source-turn", sourceSessionId: "source" },
      {
        role: "system", content: "", timestamp: 2,
        activity: { kind: "forked", id: "marker", subject: { kind: "session", id: "fork" }, sourceSessionId: "source", at: 2, by: { kind: "system" } },
      },
      { messageId: "new", role: "user", content: "Try another path", timestamp: 3 },
    ],
  });
  const feed = conversationFeed(
    { item: (id) => model.items.get(id), subscribeFeedItems: () => () => {} },
    model.order,
    "fork",
    () => null,
  ).get();

  expect(feed[0]).toMatchObject({ type: "message", message: { hostForkPointId: "source-turn" } });
  expect(feed[1]).toMatchObject({
    type: "activity-group",
    activities: [{ projectedItem: { visibility: "synthetic", item: { type: "fork", title: "Forked from conversation" } } }],
  });
  expect(feed[2]).toMatchObject({ type: "message", message: { text: "Try another path" } });
});

it("enables a response checkpoint as soon as its live turn finishes", () => {
  const model = new TranscriptModel("session");
  model.apply({ type: "text_chunk", text: "Here is the answer." });
  const reply = model.order[0]!;
  expect(model.items.get(reply)).not.toHaveProperty("forkPointId");
  model.apply({
    type: "task_complete",
    sessionId: "provider-thread",
    forkPointId: "completed-turn",
    result: "Here is the answer.",
    costUsd: 0,
    durationMs: 1,
    numTurns: 1,
    usage: {},
  });

  const feed = conversationFeed(
    { item: (id) => model.items.get(id), subscribeFeedItems: () => () => {} },
    model.order,
    "session",
    () => null,
  ).get();
  expect(feed).toHaveLength(1);
  expect(feed[0]).toMatchObject({
    type: "message",
    message: { streaming: false, sourceThreadId: "provider-thread", hostForkPointId: "completed-turn" },
  });
});

it("carries the host's saved render dimensions into the message that the thread screen reads", () => {
  const text = "```html render\n<p>Chart</p>\n```";
  const frame = { start: 0, end: text.length, bodyStart: 15, bodyEnd: 27,
    title: "Chart", height: 323, attachmentId: "frame", heights: [[390, 323] as const] };
  const model = TranscriptModel.fromHistory("saved", {
    before: null,
    messages: [{ role: "assistant", messageId: "reply", content: text, timestamp: 1, replyHtmlLayout: [frame] }],
  });
  const feed = conversationFeed({ item: key => model.items.get(key), subscribeFeedItems: () => () => {} }, model.order, "saved", () => null);
  expect(feed.get()).toMatchObject([{ type: "message", message: { text, replyHtmlLayout: [frame] } }]);
});
