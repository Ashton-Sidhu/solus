import { CommandId, MessageId, RunId, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import type { QueuedPromptSnapshot } from "@solus/contracts/types";
import type { ConversationStore } from "@solus-mobile/features/conversation/conversation-store";
import { Atom } from "effect/reactivity";
import { queueChatAttachment } from "./upload-images";

export function hostQueueAttachments(entry: QueuedPromptSnapshot) {
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

export function hostQueuedRuns(store: ConversationStore) {
  return Atom.make((get) => {
    const read = () =>
      store.metaSnapshotOf().queue.entries.map((entry) => ({
        id: RunId.make(entry.queueId),
        status: "queued",
      }));
    get.addFinalizer(store.meta.subscribe(() => get.setSelf(read())));
    return read();
  });
}
