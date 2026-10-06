import { serverConnections, type ServerConnections } from '../server-connections'
import type { NotificationSourceLink } from './hub-client'
import type { NotificationSource } from './sources'

/**
 * A source read through the client's existing connections (plans/015 §4): the
 * hub opens no socket of its own. A host in the catalog is already held. An
 * organization's service is retained for as long as the hub reads it, so that
 * selecting another organization in the window does not close it.
 */
export function serverNotificationLink(source: NotificationSource, connections: ServerConnections = serverConnections): NotificationSourceLink {
  const { serverId } = source
  if (source.kind === 'organization') connections.retain(serverId)
  // The initial read can already be queued on the first connection. Only a
  // later acceptance is a reconnect that requires another snapshot.
  let hasConnected = connections.statusFor(serverId) === 'connected'
  return {
    api: connections.apiFor(serverId),
    onChanged: (listener) => connections.eventsFor(serverId).subscribe('notifications.changed', () => listener()),
    onReconnected: (listener) => connections.onStatusChange((changedServerId, status) => {
      if (changedServerId !== serverId || status !== 'connected') return
      listener(!hasConnected)
      hasConnected = true
    }),
    release: () => {
      if (source.kind === 'organization') connections.unretain(serverId)
      connections.release(serverId)
    },
  }
}
