import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, MessageId, RunId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "@t3tools/shared/composerContextReferences";
import type { PendingPermission } from "@solus-mobile/features/conversation/lib/pending-requests";
import type { ConversationStore } from "@solus-mobile/features/conversation/conversation-store";
import type { QueuedPromptSnapshot } from "@solus/contracts/types";
import type { QueuedRunEdit } from "../state/queued-run-edit";
import { hostApprovalCard, hostApprovalResponder, sendHostApprovalFeedback } from "./approval-requests";
import { hostComposerDelivery } from "./composer-delivery";
import { beginHostQueuedRunEdit, hostQueuedEditMutation } from "./queue-messages";

const queue = vi.hoisted(() => ({
  begin: vi.fn(),
  current: null as QueuedRunEdit | null,
}));
vi.mock("../state/queued-run-edit", () => ({
  beginQueuedRunEdit: queue.begin,
  getQueuedRunEdit: () => queue.current,
}));
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));

it("uses T3's current-turn send decision with the Solus outbox's supported modes", () => {
  expect(hostComposerDelivery("running", "steer")).toBe("steer");
  expect(hostComposerDelivery("running", "steer", "queue")).toBe("queue");
  expect(hostComposerDelivery("running", "queue", "steer")).toBe("steer");
  expect(hostComposerDelivery("connecting", "steer", "steer")).toBe("queue");
  expect(hostComposerDelivery("rate_limited", "steer", "steer")).toBe("queue");
  expect(hostComposerDelivery("idle", "steer", "steer")).toBeUndefined();
});

const target = { environmentId: EnvironmentId.make("host"), threadId: ThreadId.make("thread") };
const queuedPrompt: QueuedPromptSnapshot = {
  queueId: "queue-entry",
  clientPromptId: "prompt",
  text: "Original",
  enqueuedAt: 1,
  reason: "busy",
  revision: 7,
  attachments: [
    { id: "old", type: "file", name: "old.txt", hostPath: "/files/old.txt" },
    { id: "keep", type: "file", name: "keep.txt", hostPath: "/files/keep.txt", context: "Keep this context." },
  ],
};
const edit: QueuedRunEdit = {
  runId: RunId.make(queuedPrompt.queueId),
  messageId: MessageId.make("prompt"),
  originalText: "Original",
  hostRevision: 7,
  existingAttachments: [
    { id: "keep", type: "file", name: "keep.txt", mimeType: "text/plain", sizeBytes: 2 },
  ],
  removedExistingAttachment: true,
};

describe("host queue edits", () => {
  it("opens the shared edit store once with the revision from the selected host", () => {
    queue.begin.mockClear();
    const store = {
      controller: { mayDrive: true, hostId: "host", run: { sessionId: "thread" } },
      metaSnapshotOf: () => ({ queue: { entries: [queuedPrompt] }, questions: [] }),
    } as unknown as ConversationStore;
    const resolvePath = async (path: string) => path;
    expect(beginHostQueuedRunEdit(store, { ...target, threadId: ThreadId.make("other") }, queuedPrompt.queueId, resolvePath)).toBe(false);
    expect(beginHostQueuedRunEdit(store, target, queuedPrompt.queueId, resolvePath)).toBe(true);
    expect(queue.begin.mock.calls[0]?.[1]).toMatchObject({ runId: queuedPrompt.queueId, hostRevision: 7 });
    queue.current = edit;
    try {
      expect(beginHostQueuedRunEdit(store, target, queuedPrompt.queueId, resolvePath)).toBe(false);
      expect(queue.begin).toHaveBeenCalledOnce();
    } finally {
      queue.current = null;
    }
  });

  it("keeps the opened revision and saves attachment-only edits using T3's prompt", () => {
    const mutation = hostQueuedEditMutation(edit, { ...queuedPrompt, revision: 8 }, " ", [
      { id: "new", type: "image", name: "new.png", hostPath: "/media/new.png" },
    ]);
    expect(mutation).toMatchObject({
      kind: "edit",
      revision: 7,
      text: ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
      attachmentContext: "Keep this context.",
      attachments: [{ id: "keep" }, { id: "new" }],
      imageRefs: [{ hostPath: "/media/new.png" }],
    });
  });
});

describe("host approvals", () => {
  const claude: PendingPermission = {
    questionId: "approval",
    toolName: "Run",
    description: null,
    supportsFeedback: true,
    options: [
      { id: "allow", label: "Allow", kind: "allow" },
      { id: "allow-session", label: "Allow for Session", kind: "allow" },
      { id: "deny", label: "Deny", kind: "deny" },
    ],
  };

  it("round-trips T3 decisions to the host and leaves opaque choices to the host card", async () => {
    const projection = hostApprovalCard(claude);
    expect(projection?.approval.options.map((option) => option.decision)).toEqual([
      "accept", "acceptForSession", "decline",
    ]);
    const respond = vi.fn(async () => true);
    const response = hostApprovalResponder(projection!.optionIds, respond);
    await expect(response(RuntimeRequestId.make("approval"), "acceptForSession"))
      .resolves.toMatchObject({ _tag: "Success" });
    expect(respond).toHaveBeenCalledWith("approval", "allow-session", undefined);
    expect(hostApprovalCard({
      ...claude,
      options: [{ id: "acceptWithExecpolicyAmendment", label: "Allow matching commands" }],
    })).toBeNull();
  });

  it("sends feedback to the original deny option only for live requests that accept it", async () => {
    const respond = vi.fn(async () => true);
    await expect(sendHostApprovalFeedback(claude, "  Try a read-only check.  ", respond))
      .resolves.toBe(true);
    expect(respond).toHaveBeenCalledWith("approval", "deny", "Try a read-only check.");
    await expect(sendHostApprovalFeedback({ ...claude, expired: "closed" }, "Later", respond))
      .resolves.toBe(false);
    expect(respond).toHaveBeenCalledOnce();
  });
});
