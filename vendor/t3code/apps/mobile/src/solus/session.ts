import { presentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  RunId,
  type RuntimeMode,
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
) {
  const id = ThreadId.make(record.sessionId);
  const instanceId = ProviderInstanceId.make(
    record.provider === "claude-code" ? "claudeAgent" : record.provider,
  );
  const busy = record.status === "running";
  const runId = busy ? RunId.make(record.sessionId) : null;
  return presentThreadShell(EnvironmentId.make(hostId), {
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
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  });
}
