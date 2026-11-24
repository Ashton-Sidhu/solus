import type { PendingPermission } from "@solus-mobile/features/conversation/lib/pending-requests";
import type { ConversationStore } from "@solus-mobile/features/conversation/conversation-store";
import {
  sendApprovalFeedback,
  type ApprovalResponder,
  type ThreadPendingApproval,
} from "@t3tools/client-runtime/state/thread-requests";
import { RuntimeRequestId, type ProviderApprovalDecision } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";
import { Alert } from "react-native";

const decisionByOptionId = new Map<string, ProviderApprovalDecision>([
  ["allow", "accept"],
  ["accept", "accept"],
  ["allow-session", "acceptForSession"],
  ["acceptForSession", "acceptForSession"],
  ["acceptAlways", "acceptAlways"],
  ["deny", "decline"],
  ["decline", "decline"],
]);

function approvalRequest(permission: PendingPermission): Omit<ThreadPendingApproval, "createdAt"> {
  return {
    requestId: RuntimeRequestId.make(permission.questionId),
    requestKind: "permission",
    appName: permission.toolName,
    ...(permission.description === null ? {} : { detail: permission.description }),
    ...(permission.guestTurn ? { reason: "Guest turn · Ask mode" } : {}),
    responseCapability: permission.expired ? "not_resumable" : "live",
    supportsFeedback: permission.supportsFeedback === true &&
      permission.options.some((option) => option.kind === "deny"),
  };
}

/** Use T3 decisions only when every button can round-trip to a unique host option. */
export function hostApprovalCard(permission: PendingPermission) {
  const optionIds = new Map<ProviderApprovalDecision, string>();
  const options = [];
  for (const option of permission.options) {
    const decision = decisionByOptionId.get(option.id);
    if (!decision || optionIds.has(decision)) return null;
    optionIds.set(decision, option.id);
    options.push({ decision, label: option.label });
  }
  const approval = approvalRequest(permission);
  if (
    approval.supportsFeedback &&
    optionIds.get("decline") !== permission.options.find((option) => option.kind === "deny")?.id
  ) return null;
  return { approval: { ...approval, options }, optionIds };
}

export function sendHostApprovalFeedback(
  permission: PendingPermission,
  text: string,
  respond: (requestId: string, optionId: string, feedback?: string) => Promise<boolean>,
): Promise<boolean> {
  const deny = permission.options.find((option) => option.kind === "deny");
  if (!deny) return Promise.resolve(false);
  return sendApprovalFeedback(
    approvalRequest(permission),
    text,
    hostApprovalResponder(new Map([["decline", deny.id]]), respond),
  );
}

export function hostApprovalResponder(
  options: ReadonlyMap<ProviderApprovalDecision, string>,
  respond: (requestId: string, optionId: string, feedback?: string) => Promise<boolean>,
): ApprovalResponder {
  return async (requestId, decision, feedback) => {
    const optionId = options.get(decision);
    if (optionId === undefined || !(await respond(requestId, optionId, feedback))) return undefined;
    return AsyncResult.success(undefined);
  };
}

/** The card and the composer share a response claim for the current session store. */
export function useHostApprovalResponses(store: ConversationStore) {
  const pending = useRef<{ store: ConversationStore; requestId: string } | null>(null);
  const [responding, setResponding] = useState<typeof pending.current>(null);
  const respondToPermission = async (requestId: string, optionId: string, feedback?: string) => {
    if (pending.current?.store === store || !store.controller.mayApprove) return false;
    const permission = store.metaSnapshotOf().permissions.find((item) => item.questionId === requestId);
    if (
      !permission || permission.expired ||
      !permission.options.some((option) => option.id === optionId)
    ) return false;
    const response = { store, requestId };
    pending.current = response;
    setResponding(response);
    try {
      return await store.controller.answerPermission(requestId, optionId, feedback);
    } catch {
      if (pending.current === response)
        Alert.alert("Could not send response", "Check the host connection and try again.");
      return false;
    } finally {
      if (pending.current === response) {
        pending.current = null;
        setResponding(null);
      }
    }
  };
  return {
    respondToPermission,
    respondingPermissionId: responding?.store === store ? responding.requestId : null,
  };
}
