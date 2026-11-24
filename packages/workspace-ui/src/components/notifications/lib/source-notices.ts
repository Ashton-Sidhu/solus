import type { HubSourceState } from "@solus/client-core/notifications/hub-client";
import { sourceStatusNote } from "@solus/client-core/notifications/presentation";

/**
 * One source problem, said once per visit as an info toast. A saved host that is
 * off is a normal state, not a failure of what the reader did.
 */
export interface SourceNotice {
  /** Changes when the problem changes, so a new problem is said again. */
  key: string;
  message: string;
  description: string;
}

/** The problems of the sources that could not give their notifications. A source that is still loading has none yet. */
export function sourceNotices(states: readonly HubSourceState[], conflicts: readonly string[]): SourceNotice[] {
  const notices: SourceNotice[] = [];
  for (const state of states) {
    const note = sourceStatusNote(state);
    if (!note || state.status === "loading") continue;
    notices.push({ key: `source:${state.source.sourceId}:${state.status}`, message: state.source.label, description: note });
  }
  for (const organizationId of conflicts) {
    notices.push({
      key: `conflict:${organizationId}`,
      message: `Organization ${organizationId} is listed by two accounts`,
      description: "Its notifications are not shown until only one account lists it.",
    });
  }
  return notices;
}
