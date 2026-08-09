import type { Session, SessionTitleChangedEvent } from '../../../shared/types'

interface SessionTitleWorkspace {
  sessions: Record<string, Session>
}

/**
 * Apply a host-authoritative name to the session it belongs to.
 *
 * One write, not a fan-out: the name is the session's, so every tab watching it
 * shows the new one. Returns the sessions that changed so the caller can mark
 * their naming round trip finished.
 */
export function applySessionTitleChange(
  workspace: SessionTitleWorkspace,
  serverId: string,
  event: SessionTitleChangedEvent,
): string[] {
  const changed: string[] = []
  for (const [sessionId, session] of Object.entries(workspace.sessions)) {
    if (session.run.serverId !== serverId || session.agentSessionId !== event.sessionId) continue
    session.title = event.title ?? 'New Tab'
    session.titleCustom = event.title !== null
    changed.push(sessionId)
  }
  return changed
}
