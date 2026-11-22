import { presentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  RunId,
  type RuntimeMode,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type { PermissionMode, SessionRecord } from "@solus/contracts/types";

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
  | "status"
>;

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
) {
  return presentThreadShell(
    EnvironmentId.make(hostId),
    sessionShell(record, mode, view, state, pinnedAt),
  );
}

export function sessionShell(
  record: SessionRow,
  mode: PermissionMode = "supervised",
  view = record.view,
  state = record.state,
  pinnedAt?: number,
): OrchestrationV2ThreadShell {
  const settledAt = view?.settledAt ?? state?.settledAt;
  const id = ThreadId.make(record.sessionId);
  const instanceId = ProviderInstanceId.make(
    record.provider === "claude-code" ? "claudeAgent" : record.provider,
  );
  const busy = record.status === "running";
  const runId = busy ? RunId.make(record.sessionId) : null;
  return {
    id,
    projectId: ProjectId.make(record.projectPath || "~"),
    title: record.customTitle || record.title || "New session",
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: record.model || "auto" },
    runtimeMode: toRuntimeMode(mode),
    interactionMode: "default",
    branch: record.branch,
    worktreePath: record.isWorktree ? record.cwd : null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: id, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "mobile",
    latestRunId: runId,
    activeRunId: runId,
    status: busy ? "running" : record.status === "interrupted" ? "interrupted" : "idle",
    pendingRuntimeRequest: null,
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
    lastVisitedAt: null,
    deletedAt: null,
  };
}
