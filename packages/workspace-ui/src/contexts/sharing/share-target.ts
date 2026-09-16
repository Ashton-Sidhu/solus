import type { WorkspaceContext } from '../workspace/workspace.context.svelte'
import { sessionTitle } from '../../lib/sessionUtils'
import type { ShareDialogTarget } from './shares.store.svelte'

/** The session the palette or the shortcut shares: the active tab's, once it has one. */
export function activeSessionShareTarget(session: Pick<WorkspaceContext, 'activeTabId' | 'sessionFor' | 'serverIdFor'>): ShareDialogTarget | null {
  const tabId = session.activeTabId
  if (!tabId) return null
  const current = session.sessionFor(tabId)
  if (!current?.id) return null
  return { serverId: session.serverIdFor(tabId), resource: { kind: 'session', id: current.id }, title: sessionTitle(current) }
}
