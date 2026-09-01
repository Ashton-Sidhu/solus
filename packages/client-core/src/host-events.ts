import type { HostEventMap, HostEventName } from '@solus/contracts/host-events'
import { serverConnections } from './server-connections'

/** Subscribe once to this topic on every current and future connection. */
export function subscribeAllHosts<K extends HostEventName>(
  topic: K,
  handler: (serverId: string, payload: HostEventMap[K]) => void,
): () => void {
  const subscriptions = new Map<string, () => void>()

  const subscribe = (serverId: string): void => {
    subscriptions.get(serverId)?.()
    subscriptions.set(
      serverId,
      serverConnections.eventsFor(serverId).subscribe(topic, (payload) => {
        handler(serverId, payload)
      }),
    )
  }

  for (const serverId of serverConnections.connectedServerIds()) subscribe(serverId)
  const stopWatchingConnections = serverConnections.onConnectionCreated((connection) => {
    subscribe(connection.serverId)
  })

  return () => {
    stopWatchingConnections()
    for (const unsubscribe of subscriptions.values()) unsubscribe()
    subscriptions.clear()
  }
}
