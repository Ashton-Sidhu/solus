import { WORKTREE_SETUP_STAGE_ORDER, type ThreadId, type WorktreeSetupStage } from "@t3tools/contracts";
import { mayWorkLocallyDuringSetup, worktreeSetupCardId } from "@solus/contracts/setup-card";
import type { StatusCardState } from "@solus/contracts/types";
import type { ConversationStore } from "@solus-mobile/features/conversation/conversation-store";
import { RequestActionButton } from "@solus-mobile/features/threads/RequestActionButton";
import { AppText } from "../components/ui/AppText";
import type { WorktreeSetupCardProps } from "../features/threads/worktree-setup-card";

export function sessionWorktreeSetup(
  store: ConversationStore, threadId: ThreadId, card: StatusCardState, observedAt: number, mayDrive: boolean,
): WorktreeSetupCardProps | null {
  const rowId = "setup:" + worktreeSetupCardId(threadId);
  const stages: WorktreeSetupStage[] = [];
  for (const step of card.steps) {
    const id = WORKTREE_SETUP_STAGE_ORDER.find(id => id === step.id);
    if (!id) continue;
    stages.push({
      id, status: step.status === "active" ? "running" : step.status === "error" ? "failed" : step.status,
      startedAt: step.startedAt == null ? null : new Date(step.startedAt).toISOString(),
      endedAt: step.endedAt == null ? null : new Date(step.endedAt).toISOString(),
      percent: step.percent ?? null, detail: step.detail ?? null, tail: [],
    });
  }
  const turnStarted = stages.some(stage => stage.id === "agent" && stage.status === "done");
  if (turnStarted && card.status === "done" && !stages.some(stage => stage.status === "failed")) return null;
  const starts = card.steps.flatMap(step => step.startedAt ?? []);
  const ends = card.steps.flatMap(step => step.endedAt ?? []);
  const canRetry = mayDrive && card.status === "error" && card.recovery === "worktree";
  return {
    snapshot: {
      threadId, phase: card.status === "active" ? "running" : card.status === "done" ? "done" : "failed",
      startedAt: new Date(starts.length ? Math.min(...starts) : observedAt).toISOString(),
      endedAt: card.status !== "active" && ends.length ? new Date(Math.max(...ends)).toISOString() : null,
      branch: null, baseRef: card.worktreeBaseBranch ?? null, worktreePath: null, setupScript: null,
      stages, error: card.status === "error" ? card.steps.find(step => step.status === "error")?.detail ?? card.title : null,
      sequence: 0,
    },
    turnStarted,
    onCancel: mayDrive ? () => void store.controller.stop() : null,
    onWorkLocally: mayDrive && mayWorkLocallyDuringSetup(card)
      ? () => void store.controller.recoverWorktreeSetup(rowId, true) : null,
    extraDetails: <HostSetupDetails card={card} canRetry={canRetry} store={store} rowId={rowId} />,
  };
}

function HostSetupDetails({ card, canRetry, store, rowId }: {
  card: StatusCardState;
  canRetry: boolean;
  store: ConversationStore;
  rowId: string;
}) {
  return (
    <>
      {card.steps.map(step => {
        const lines = (step.substeps ?? []).map(sub => [sub.label, sub.status, sub.detail].filter(Boolean).join(" · "));
        if (!WORKTREE_SETUP_STAGE_ORDER.some(id => id === step.id)) {
          lines.unshift([step.label, step.status, step.detail].filter(Boolean).join(" · "));
        }
        return lines.length ? (
          <AppText key={step.id} className="text-xs text-foreground-secondary">{lines.join("\n")}</AppText>
        ) : null;
      })}
      {card.output?.length ? <AppText selectable className="font-mono text-xs">{card.output.join("\n")}</AppText> : null}
      {canRetry && <>
        <RequestActionButton label="Retry setup" onPress={() => void store.controller.recoverWorktreeSetup(rowId, false)} />
        <RequestActionButton label="Work locally" onPress={() => void store.controller.recoverWorktreeSetup(rowId, true)} />
      </>}
    </>
  );
}
