import { serverConnections } from '@solus/client-core/server-connections'
import { toasts } from '../../lib/toasts'
import { memberByKey } from '../../components/users/lib/organization-people'
import { sessionListStore } from '../workspace/session-list.store.svelte'
import { unopenableSessionNotice } from '../workspace/shared-sessions'
import { sharesStore } from './shares.store.svelte'

/**
 * Say why a session this client knew as shared did not open
 * (docs/plans/shared-with-you.md §4.5): its owner's computer is offline, or the
 * reader has no access any more. Answers false for a session this client never
 * knew as shared; the caller then keeps its own message.
 */
export function noticeUnopenableSession(serverId: string, sessionId: string): boolean {
  const facts = sessionListStore.shareFacts(sessionId)
  if (!facts) return false
  const { message, description } = unopenableSessionNotice({
    isHostConnected: serverConnections.connectedServerIds().includes(serverId),
    ownerName: memberByKey(sharesStore.directory, facts.share.ownerKey)?.displayName ?? null,
    title: facts.title,
  })
  toasts.info(message, description ? { description } : undefined)
  return true
}
