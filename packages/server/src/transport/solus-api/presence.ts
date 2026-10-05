import type { Principal } from '../../admission/principal'
import { PresenceManager } from '../../presence/presence-manager'
import { publishPresenceRoom, registerPresenceHandlers } from '../handlers/presence-handlers'
import type { HostEventPublisher } from '../events/host-event-publisher'
import type { SolusServer } from '../server'

/** Stored-session rooms need connection/watch state, but no execution runtime. */
export function workspacePresence(server: SolusServer, events: HostEventPublisher) {
  const presence = new PresenceManager()
  const watchers = new Map<string, Set<string>>()
  const publishHost = async (organizationId: string | undefined) => {
    if (organizationId === undefined) return
    await publishPresenceRoom(presence, events, organizationId)
  }
  const publishSession = (sessionId: string) => {
    const clients = [...watchers.get(sessionId) ?? []]
    void events.publishToRoom({ kind: 'session', id: sessionId }, clients, 'session.presenceChanged', presence.sessionSnapshot(sessionId, clients, null))
  }
  registerPresenceHandlers(server, { presence,
    onHostChanged: clientId => { void publishHost(presence.organizationOf(clientId)) }, onSessionChanged: publishSession })
  return {
    watch(clientId: string, sessionId: string): void {
      let clients = watchers.get(sessionId)
      if (!clients) { clients = new Set(); watchers.set(sessionId, clients) }
      clients.add(clientId); publishSession(sessionId)
    },
    unwatch(clientId: string, sessionId: string): void {
      const clients = watchers.get(sessionId)
      clients?.delete(clientId)
      if (!clients?.size) watchers.delete(sessionId)
      publishSession(sessionId)
    },
    connected(clientId: string, principal: Principal): void {
      presence.join(clientId, principal, principal.kind === 'system' ? 'Service' : principal.deviceLabel)
      void publishHost(presence.organizationOf(clientId))
      for (const [sessionId, clients] of watchers) if (clients.has(clientId)) publishSession(sessionId)
    },
    disconnected(clientId: string): void {
      const organization = presence.organizationOf(clientId)
      presence.leave(clientId); void publishHost(organization)
      for (const [sessionId, clients] of watchers) if (clients.has(clientId)) publishSession(sessionId)
    },
    expired(clientId: string): void {
      for (const [sessionId, clients] of watchers) {
        if (!clients.delete(clientId)) continue
        if (!clients.size) watchers.delete(sessionId)
        publishSession(sessionId)
      }
    },
  }
}
