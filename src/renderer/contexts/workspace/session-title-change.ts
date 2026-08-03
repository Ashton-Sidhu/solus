import type { Session, SessionTitleChangedEvent, Tab } from '../../../shared/types'

interface SessionTitleWorkspace {
  tabs: Record<string, Tab>
  sessions: Record<string, Session>
}

/** Apply a host-authoritative session name to every open tab for that session. */
export function applySessionTitleChange(
  workspace: SessionTitleWorkspace,
  serverId: string,
  event: SessionTitleChangedEvent,
): string[] {
  const changedTabIds: string[] = []
  for (const [tabId, tab] of Object.entries(workspace.tabs)) {
    const session = workspace.sessions[tab.sessionId]
    if (session?.serverId !== serverId || session.agentSessionId !== event.sessionId) continue
    tab.title = event.title ?? 'New Tab'
    tab.titleCustom = event.title !== null
    changedTabIds.push(tabId)
  }
  return changedTabIds
}
