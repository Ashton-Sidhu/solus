import { CheckpointRef, MessageId, RunId } from "@t3tools/contracts";
import type { ThreadCheckpointSummary } from "@t3tools/client-runtime/state/thread-checkpoints";
import type { TurnSnapshot } from "@solus/contracts/git-types";
import type { ConversationStore } from "@solus-mobile/features/conversation/conversation-store";

/** Join a checkout snapshot to the final reply in its prompt-to-prompt window. */
export function conversationCheckpoints(
  order: readonly string[],
  readItem: ConversationStore["item"],
  snapshots: readonly TurnSnapshot[] | null | undefined,
  latestOnly: boolean,
  isWorking: boolean,
): ReadonlyMap<string, ThreadCheckpointSummary> | undefined {
  if (!snapshots?.length || (latestOnly && isWorking)) return;
  const checkpoints = new Map<string, ThreadCheckpointSummary>();
  let snapshotIndex = snapshots.length - 1;
  let assistantId: string | undefined;
  let nextPromptAt = Infinity;
  for (let index = order.length - 1; index >= 0 && snapshotIndex >= 0; index--) {
    const item = readItem(order[index]!);
    if (item?.kind === "assistant" && !assistantId && !item.streaming) {
      assistantId = item.id;
      continue;
    }
    if (item?.kind !== "user" || (item.waitsForTurn && item.delivery !== "sent")) continue;
    const promptAt = item.timestamp;
    if (promptAt === undefined) {
      assistantId = undefined;
      continue;
    }
    while (snapshotIndex >= 0 && snapshots[snapshotIndex]!.timestamp >= nextPromptAt) snapshotIndex--;
    const snapshot = snapshots[snapshotIndex];
    const live = nextPromptAt === Infinity && isWorking;
    if (!live && snapshot && snapshot.timestamp >= promptAt && snapshot.filesChanged > 0 && assistantId) {
      checkpoints.set(assistantId, {
        runId: RunId.make(item.id),
        checkpointTurnCount: snapshot.index + 1,
        checkpointRef: CheckpointRef.make(snapshot.sha),
        status: "ready",
        files: [],
        filesTotal: {
          count: snapshot.filesChanged,
          additions: snapshot.additions,
          deletions: snapshot.deletions,
        },
        assistantMessageId: MessageId.make(assistantId),
        completedAt: new Date(snapshot.timestamp).toISOString(),
      });
    }
    if (latestOnly) break;
    assistantId = undefined;
    nextPromptAt = promptAt;
  }
  return checkpoints;
}
