import { isSessionBusyStatus, isSteerableStatus, type SessionStatus } from "@solus/contracts/types";
import {
  resolveComposerDispatchMode,
  type ActiveTurnComposerAction,
} from "@t3tools/client-runtime/state/composer-dispatch";
import type { FollowUpBehavior } from "../lib/followUpBehavior";

export function hostComposerDelivery(
  status: SessionStatus,
  followUpBehavior: FollowUpBehavior,
  action?: ActiveTurnComposerAction,
): "queue" | "steer" | undefined {
  const selectedAction = action ?? followUpBehavior;
  const mode = resolveComposerDispatchMode({
    running: isSessionBusyStatus(status),
    canSteer: isSteerableStatus(status),
    alternateModifier: false,
    activeTurnDefault: selectedAction === "restart" ? "queue" : selectedAction,
  });
  return mode === "auto" ? undefined : mode === "steer" ? "steer" : "queue";
}
