import { serverConnections } from '@solus/client-core/server-connections'
import type { HostFacts } from '@solus/client-core/host-facts'
import { unshownHostStallNotice } from '@solus/client-core/host-stall-notice'
import { toasts } from '../../lib/toasts'
import { serversStore } from './servers.store.svelte'

/**
 * Tells the user why a host dropped: when a host reports a recent freeze in its
 * server info, desktop and web show one toast for each stall
 * (docs/mobile-connections.md). The server info reloads after each reconnect.
 */
export function startHostStallToasts(): () => void {
  const shownKeys = new Set<string>()
  const watched = new WeakSet<HostFacts>()
  const stops: Array<() => void> = []

  const watch = (facts: HostFacts): void => {
    if (watched.has(facts) || facts.presence === 'gone') return
    watched.add(facts)
    stops.push(facts.subscribe((key) => {
      if (key !== 'serverInfo') return
      const stall = facts.value('serverInfo')?.recentEventLoopStall
      if (!stall) return
      const label = serversStore.servers.find((row) => row.id === facts.serverId)?.label ?? 'The host'
      const notice = unshownHostStallNotice(shownKeys, facts.serverId, label, stall)
      if (notice) toasts.info(notice.title, { description: notice.description, duration: 10_000, closeButton: true })
    }))
    // A host nobody reads the server info of must still say why it dropped.
    facts.ensure('serverInfo')
  }

  for (const serverId of serverConnections.connectedServerIds()) {
    const facts = serverConnections.connectionFor(serverId)?.facts
    if (facts) watch(facts)
  }
  const stopCreated = serverConnections.onConnectionCreated((connection) => watch(connection.facts))
  return () => {
    stopCreated()
    for (const stop of stops) stop()
  }
}
