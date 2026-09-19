import type { WorkspaceContext } from '../workspace/workspace.context.svelte'
import { sessionTitle } from '../../lib/sessionUtils'
import { sharesStore, type ShareDialogTarget } from './shares.store.svelte'

/** The session the palette or the shortcut shares: the active tab's, once it has one and its host can share. */
export function activeSessionShareTarget(session: Pick<WorkspaceContext, 'activeTabId' | 'sessionFor' | 'serverIdFor'>): ShareDialogTarget | null {
  const tabId = session.activeTabId
  if (!tabId) return null
  const current = session.sessionFor(tabId)
  if (!current?.id) return null
  const serverId = session.serverIdFor(tabId)
  if (!sharesStore.canShareFrom(serverId)) return null
  return { serverId, resource: { kind: 'session', id: current.id }, title: sessionTitle(current) }
}
