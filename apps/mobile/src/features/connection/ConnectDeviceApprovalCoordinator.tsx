import { msg } from "gt-react-native";
import { EnvironmentId } from "@t3tools/contracts";
import { useListened } from "@solus-mobile/app/app-context";
import type { OpenPairApproval } from "@solus-mobile/features/settings/pair-approvals";
import { useEffect } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { m } from "../../i18n/messages";
import { rootNavigationRef } from "../../lib/rootNavigation";
import { solus } from "../../solus/runtime";
import { openSettings } from "../settings/settings-navigation";
import {
  type ConnectDeviceApprovalPrompt,
  createApprovalPromptQueue,
  pairApprovalPrompts,
} from "./connectDeviceApproval";

/**
 * Asks to approve machines that wait to pair with a host this phone may decide
 * for (`host.local.reach`; docs/plans/add-machine-card.md). The requests come
 * from `solus.pairApprovals`; T3's prompt queue shows them one at a time.
 */
export function ConnectDeviceApprovalCoordinator() {
  const open = useListened(solus.pairApprovals.changes, () => solus.pairApprovals.open);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a new approval request opens a native alert
  useEffect(() => offerPrompts(open), [open]);
  return null;
}

/** "gone": the request expired or was answered elsewhere before this answer arrived. */
type ApprovalAnswer = "done" | "failed" | "gone";

interface QueuedApprovalPrompt extends ConnectDeviceApprovalPrompt {
  readonly hostId: string;
  readonly approve: () => Promise<ApprovalAnswer>;
  readonly deny: () => Promise<ApprovalAnswer>;
}

const isOpen = (prompt: QueuedApprovalPrompt) =>
  solus.pairApprovals.approvalsOf(prompt.hostId).some((request) => request.requestId === prompt.requestId);

// One queue for every host: a second Android alert would replace an unanswered first one.
const approvalPrompts = createApprovalPromptQueue<QueuedApprovalPrompt>((prompt, answer) => {
  const respond = (action: () => Promise<ApprovalAnswer>, failure: string) => () =>
    void action().then((outcome) => {
      // A request that is no longer open cannot be retried; let the next prompt show.
      if (outcome === "done" || !isOpen(prompt)) return answer("done");
      if (outcome === "gone") {
        return Dialog.alert(
          m(msg("Request no longer waiting")),
          m(msg("It expired or was answered elsewhere.")),
          [{ text: m(msg("OK")), onPress: () => answer("done") }],
          { onDismiss: () => answer("done") },
        );
      }
      const retryIfOpen = () => answer(isOpen(prompt) ? "retry" : "done");
      Dialog.alert(
        failure,
        m(msg("The request is still waiting. Try again.")),
        [{ text: m(msg("OK")), onPress: retryIfOpen }],
        // Another dialog took the screen; offer the request again on the next update.
        { onDismiss: () => answer("later") },
      );
    });
  Dialog.alert(
    prompt.title,
    prompt.message,
    [
      {
        text: m(msg("Deny")),
        onPress: respond(prompt.deny, m(msg("Could not deny the machine"))),
      },
      {
        // The host's page lists its open requests, so the alert does not come back.
        text: m(msg("Review")),
        onPress: () => {
          answer("done");
          if (rootNavigationRef.isReady())
            openSettings(rootNavigationRef, "SettingsEnvironmentDetail", {
              environmentId: EnvironmentId.make(prompt.hostId),
            });
        },
      },
      {
        text: m(msg("Approve")),
        onPress: respond(prompt.approve, m(msg("Could not approve the machine"))),
      },
    ],
    // Another dialog took the screen; offer the request again on the next update.
    { cancelable: false, onDismiss: () => answer("later") },
  );
});

const decide = (hostId: string, requestId: string, decision: "approve" | "deny") => () =>
  solus.pairApprovals.decide(hostId, requestId, decision).then(
    (done): ApprovalAnswer => (done ? "done" : "gone"),
    (): ApprovalAnswer => "failed",
  );

function offerPrompts(open: readonly OpenPairApproval[]) {
  const openIds = new Set(open.map(({ hostId, request }) => `${hostId}:${request.requestId}`));
  // A request that closed, or a host that went away, holds up no other prompt.
  approvalPrompts.drop((prompt) => !openIds.has(prompt.pairingLinkId));
  const hostIds = new Set(open.map(({ hostId }) => hostId));
  const now = Date.now();
  for (const hostId of hostIds) {
    const prompts = pairApprovalPrompts({
      hostId,
      hostLabel: solus.registry.host(hostId)?.label ?? hostId,
      approvals: open.filter((entry) => entry.hostId === hostId).map((entry) => entry.request),
      shownIds: approvalPrompts.known,
      now,
    });
    approvalPrompts.offer(
      prompts.map((prompt) => ({
        ...prompt,
        hostId,
        approve: decide(hostId, prompt.requestId, "approve"),
        deny: decide(hostId, prompt.requestId, "deny"),
      })),
    );
  }
}
