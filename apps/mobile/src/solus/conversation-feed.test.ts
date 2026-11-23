import { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { messageImageGallery } from "../features/threads/messageImageGallery";
import { deriveThreadFeedPresentation } from "../lib/threadActivity";
import { expect, it, vi } from "vite-plus/test";
import {
  TranscriptModel,
  type TranscriptItem,
} from "@solus-mobile/features/conversation/lib/transcript-model";
import { conversationFeed as createFeed } from "./conversation-feed";

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
    { item: (id) => byId.get(id), subscribeFeedItems: () => () => {} },
    items.map((i) => i.id),
    "session",
    render,
  );
  expect(feed.get().map((row) => row.id)).toEqual(["p", "old", "t", "new", "reply", "image"]);
  const answer = feed.get().find((row) => row.id === "reply");
  expect(answer).toMatchObject({
    type: "message",
    message: { role: "assistant", sourceThreadId: "previous-provider-session" },
  });
  for (const row of feed.get()) if (row.type === "conversation-card") row.render();
  expect(render.mock.calls).toEqual([
    ["old", true],
    ["new", false],
    ["image", false],
  ]);
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
  const off = feed.subscribe(notify);
  expect(feed.get()).toBe(initial);
  items.set("a", { ...item, text: "finished" });
  items.set("b", { ...item, id: "b", text: "another reply" });
  for (const listener of listeners) listener(["a", "b"]);
  expect(notify).toHaveBeenCalledTimes(1);
  expect(feed.get()[0]).toMatchObject({ type: "message", message: { text: "finished" } });
  expect(feed.get()[1]).toMatchObject({ type: "message", message: { text: "another reply" } });
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
    { kind: "image", name: "Camera", mimeType: "image/jpeg", resource: { path: "/uploads/saved" } },
  ]);
  expect(resolve).not.toHaveBeenCalled();
  const saved = gallery[1];
  if (!saved || !("resource" in saved)) throw new Error("Missing host photo");
  await saved.resolveUrl?.(true);
  expect(resolve.mock.calls).toEqual([["/uploads/saved", true]]);
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
