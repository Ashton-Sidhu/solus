import { presentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  RunId,
  RuntimeRequestId,
  type RuntimeMode,
  type ThreadPullRequestLink,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import {
  sessionRecordStatusOf,
  type PermissionMode,
  type SessionRecord,
  type SessionStatus,
} from "@solus/contracts/types";

export type SessionRow = Pick<
  SessionRecord,
  | "sessionId"
  | "provider"
  | "projectPath"
  | "model"
  | "title"
  | "customTitle"
  | "createdAt"
  | "lastActivityAt"
  | "branch"
  | "cwd"
  | "isWorktree"
  | "view"
  | "state"
  | "pullRequests"
  | "hasPendingQuestion"
  | "execution"
  | "status"
> & { projectRoot?: string | null; startedBy?: SessionRecord['startedBy'] };

interface SessionActivity {
  pullRequests?: readonly ThreadPullRequestLink[] | undefined;
  liveStatus?: SessionStatus | undefined;
  since?: number | undefined;
  viewedAt?: number | null;
  pendingQuestion?: boolean | undefined;
  projectPath?: string | undefined;
}

export function toRuntimeMode(mode: PermissionMode): RuntimeMode {
  if (mode === "accept-edits") return "auto-accept-edits";
  return mode === "auto" || mode === "full-access" ? mode : "approval-required";
}

export function toThreadShell(
  hostId: string,
  record: SessionRow,
  mode: PermissionMode = "supervised",
  view = record.view,
  state = record.state,
  pinnedAt?: number,
  activity?: SessionActivity,
) {
  return presentThreadShell(
    EnvironmentId.make(hostId),
    sessionShell(record, mode, view, state, pinnedAt, activity),
  );
}

export function sessionShell(
  record: SessionRow,
  mode: PermissionMode = "supervised",
  view = record.view,
  state = record.state,
  pinnedAt?: number,
  activity?: SessionActivity,
): OrchestrationV2ThreadShell {
  const settledAt = view?.settledAt ?? state?.settledAt;
  const id = ThreadId.make(record.sessionId);
  const fork = record.startedBy?.kind === "person" ? record.startedBy.fork : undefined;
  const sourceThreadId = fork ? ThreadId.make(fork.sourceSessionId) : null;
  const instanceId = ProviderInstanceId.make(
    record.provider === "claude-code" ? "claudeAgent" : record.provider,
  );
  const live = activity?.liveStatus;
  const status = live === undefined ? record.status : sessionRecordStatusOf(live);
  const failed = live === "failed" || live === "dead" || live === "rate_limited";
  const busy = status === "running" && !failed;
  const runId = busy || failed || live === "completed" || live === "background" ? RunId.make(record.sessionId) : null;
  const since = activity?.since == null ? null : DateTime.makeUnsafe(activity.since);
  const question = live === undefined ? record.hasPendingQuestion : activity?.pendingQuestion;
  const requestKind =
    live === "awaiting_plan"
      ? "permission"
      : live === "awaiting_input" || question
        ? "user_input"
        : null;
  return {
    id,
    projectId: ProjectId.make(
      activity?.projectPath || record.projectRoot || record.projectPath || "~",
    ),
    title: record.customTitle || record.title || "New session",
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: record.model || "auto" },
    runtimeMode: toRuntimeMode(mode),
    interactionMode: "default",
    ...(activity?.pullRequests && { pullRequests: activity.pullRequests }),
    branch: record.branch,
    worktreePath: record.isWorktree ? record.cwd : null,
    activeProviderThreadId: null,
    lineage: sourceThreadId
      ? { rootThreadId: sourceThreadId, parentThreadId: sourceThreadId, relationshipToParent: "fork" }
      : { rootThreadId: id, parentThreadId: null, relationshipToParent: null },
    forkedFrom: fork && sourceThreadId
      ? { type: "run", threadId: sourceThreadId, runId: RunId.make(fork.pointId) }
      : null,
    createdBy: "user",
    creationSource: "mobile",
    latestRunId: runId,
    activeRunId: busy ? runId : null,
    activityRunStartedAt: busy ? since : null,
    ...(live === "completed" || live === "background" || failed
      ? { latestRunCompletedAt: since ?? DateTime.makeUnsafe(record.lastActivityAt) }
      : {}),
    lastErrorClass: live === "rate_limited" ? "usage_limit" : null,
    status: failed ? "failed" : live === "completed" ? "completed" : status,
    pendingRuntimeRequest:
      requestKind === null
        ? null
        : {
            id: RuntimeRequestId.make(record.sessionId),
            kind: requestKind,
            createdAt: since ?? DateTime.makeUnsafe(record.lastActivityAt),
            blocking: live === "awaiting_plan" || live === "awaiting_input",
          },
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: DateTime.makeUnsafe(record.createdAt),
    updatedAt: DateTime.makeUnsafe(record.lastActivityAt),
    archivedAt: view?.archivedAt == null ? null : DateTime.makeUnsafe(view.archivedAt),
    settledOverride: settledAt == null ? null : "settled",
    settledAt: settledAt == null ? null : DateTime.makeUnsafe(settledAt),
    snoozedUntil: view?.snoozedUntil == null ? null : DateTime.makeUnsafe(view.snoozedUntil),
    pinnedAt: pinnedAt == null ? null : DateTime.makeUnsafe(pinnedAt),
    lastVisitedAt: activity?.viewedAt == null ? null : DateTime.makeUnsafe(activity.viewedAt),
    autoSettleDisabledAt: state?.autoSettleDisabledAt == null ? null : DateTime.makeUnsafe(state.autoSettleDisabledAt),
    activeOrderKey: view?.activeOrderKey ?? null,
    pinOrderKey: view?.pinOrderKey ?? null,
    deletedAt: null,
  };
}
