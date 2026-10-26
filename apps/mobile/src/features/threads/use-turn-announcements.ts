import { useEffect, useRef } from "react";
import { AccessibilityInfo } from "react-native";
import { TurnAnnouncer, turnPhaseFor } from "@solus/client-core/turn-announcement";
import type { SessionStatus } from "@solus/contracts/types";

/**
 * Speak a turn starting, waiting, and ending in the open conversation, the
 * same phases the web live region announces. Opening a conversation is silent.
 */
export function useTurnAnnouncements(conversationId: string, status: SessionStatus, awaitingApproval: boolean): void {
  const announcer = useRef<TurnAnnouncer | null>(null);
  useEffect(() => {
    announcer.current ??= new TurnAnnouncer();
    const spoken = announcer.current.observe(conversationId, turnPhaseFor(status, awaitingApproval));
    if (spoken) AccessibilityInfo.announceForAccessibility(spoken);
  }, [conversationId, status, awaitingApproval]);
}
