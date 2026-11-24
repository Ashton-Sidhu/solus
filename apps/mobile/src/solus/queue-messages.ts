import { CommandId, MessageId, RunId, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import type { QueueAttachment, SessionQueueMutation } from "@solus/contracts/session-queue";
import type { QueuedPromptSnapshot } from "@solus/contracts/types";
import type { ConversationStore } from "@solus-mobile/features/conversation/conversation-store";
import { restoreAttachmentOnlyBootstrapPrompt } from "@t3tools/shared/composerContextReferences";
import { Atom } from "effect/reactivity";
import { scopedThreadKey } from "../lib/scopedEntities";
import { beginQueuedRunEdit, getQueuedRunEdit, type QueuedRunEdit } from "../state/queued-run-edit";
import { queueChatAttachment } from "./upload-images";

function hostQueueAttachments(entry: QueuedPromptSnapshot): readonly QueueAttachment[] {
  return (
    entry.attachments ?? [
      ...(entry.imageRefs ?? []).map((r, i) => ({
        ...r,
        id: String(i),
        type: "image" as const,
        name: r.name ?? "Image",
      })),
      ...(entry.images ?? []).map((r, i) => ({
        ...r,
        id: "inline-" + i,
        type: "image" as const,
        name: "Image",
      })),
    ]
  );
}

export function hostQueueMessage(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  entry: QueuedPromptSnapshot,
  resolvePath: (path: string, refresh?: boolean) => Promise<string>,
) {
  return {
    environmentId,
    threadId,
    commandId: CommandId.make(entry.queueId),
    messageId: MessageId.make(entry.clientPromptId ?? entry.queueId),
    text: entry.text,
    createdAt: new Date(entry.enqueuedAt).toISOString(),
    attachments: [],
    hostQueue: {
      queueId: entry.queueId,
      revision: entry.revision ?? 0,
      attachments: hostQueueAttachments(entry).map((attachment) =>
        queueChatAttachment(attachment, resolvePath),
      ),
    },
  };
}

const hostQueuedRuns = Atom.family((store: ConversationStore) =>
  Atom.make((get) => {
    const read = () =>
      store.metaSnapshotOf().queue.entries.map((entry) => ({
        id: RunId.make(entry.queueId),
        status: "queued",
      }));
    get.addFinalizer(store.meta.subscribe(() => get.setSelf(read())));
    return read();
  }),
);

export function beginHostQueuedRunEdit(
  store: ConversationStore,
  target: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId },
  queueId: string,
  resolvePath: (path: string, refresh?: boolean) => Promise<string>,
): boolean {
  const { environmentId, threadId } = target;
  if (
    !store.controller.mayDrive ||
    store.controller.hostId !== environmentId ||
    store.controller.run.sessionId !== threadId
  ) return false;
  const meta = store.metaSnapshotOf();
  if (meta.questions.some((question) => !question.expired)) return false;
  const entry = meta.queue.entries.find((item) => item.queueId === queueId);
  if (!entry || entry.kind === "provider_switch") return false;
  const threadKey = scopedThreadKey(environmentId, threadId);
  if (getQueuedRunEdit(threadKey)?.runId === queueId) return false;
  const message = hostQueueMessage(environmentId, threadId, entry, resolvePath);
  beginQueuedRunEdit(
    threadKey,
    {
      runId: RunId.make(queueId),
      messageId: message.messageId,
      originalText: message.text,
      hostRevision: message.hostQueue.revision,
      existingAttachments: message.hostQueue.attachments,
    },
    hostQueuedRuns(store),
  );
  return true;
}

/** Solus keeps the original host files and sends the revision that the composer opened. */
export function hostQueuedEditMutation(
  edit: QueuedRunEdit,
  entry: QueuedPromptSnapshot,
  prompt: string,
  uploads: readonly QueueAttachment[],
): Extract<SessionQueueMutation, { kind: "edit" }> {
  const mutation = {
    kind: "edit" as const,
    queueId: edit.runId,
    revision: edit.hostRevision ?? 0,
    text: restoreAttachmentOnlyBootstrapPrompt(
      prompt,
      edit.existingAttachments.length + uploads.length > 0,
    ),
  };
  if (!edit.removedExistingAttachment && uploads.length === 0) return mutation;
  const keptIds = new Set(edit.existingAttachments.map((attachment) => attachment.id));
  const attachments = [
    ...hostQueueAttachments(entry).filter((attachment) => keptIds.has(attachment.id)),
    ...uploads,
  ];
  return {
    ...mutation,
    attachments,
    attachmentContext: attachments
      .filter((attachment) => attachment.type !== "image")
      .map((attachment) => attachment.context ?? `[Attached file: ${attachment.hostPath}]`)
      .join("\n"),
    imageRefs: attachments.flatMap((attachment) =>
      attachment.type === "image" && attachment.hostPath && !attachment.dataUrl
        ? [{ hostPath: attachment.hostPath, name: attachment.name, mimeType: attachment.mimeType || "image/png" }]
        : [],
    ),
    images: attachments.flatMap((attachment) =>
      attachment.type === "image" && attachment.dataUrl
        ? [{ dataUrl: attachment.dataUrl, mimeType: attachment.mimeType || "image/png" }]
        : [],
    ),
  };
}
