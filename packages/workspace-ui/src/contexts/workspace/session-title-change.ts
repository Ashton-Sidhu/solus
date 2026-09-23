import type { Session, SessionTitleChangedEvent } from '@solus/contracts/types'

export interface ChangedSessionTitle {
  sessionId: string
  taskServerId: string
}

/**
 * Apply a host-authoritative name to the session it belongs to.
 *
 * One write, not a fan-out: the name is the session's, so every tab watching it
 * shows the new one. Returns the sessions that changed so the caller can mark
 * their naming round trip finished.
 */
export function applySessionTitleChange(
  sessions: Record<string, Session>,
  serverId: string,
  event: SessionTitleChangedEvent,
): ChangedSessionTitle[] {
  const changed: ChangedSessionTitle[] = []
  for (const [sessionId, session] of Object.entries(sessions)) {
    if (session.forked) continue
    if (session.run.serverId !== serverId || session.agentSessionId !== event.sessionId) continue
    session.title = event.title ?? 'New Tab'
    session.titleCustom = event.title !== null
    changed.push({ sessionId, taskServerId: session.run.taskServerId })
  }
  return changed
}
