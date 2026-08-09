import { onDestroy } from 'svelte'
import type { WorkspaceContext } from '../contexts'
import type { NormalizedEvent, SessionTitleChangedEvent } from '../../shared/types'
import { resyncRuntime } from '../contexts/workspace/session-bootstrap'
import { serverConnections, type ManagedConnection } from '@client-core/server-connections'

/**
 * Bridges ControlPlane IPC events into the session context. Call from App.svelte's top-level script,
 * not inside $effect — the unsubscribes are tied to the component's lifetime.
 *
 * `text_chunk` volume is already tamed upstream: ControlPlane coalesces chunks into
 * ~300ms batches before broadcasting, so no renderer-side batching is needed here.
 */
export function setupAgentEvents(session: WorkspaceContext): void {
  const connectionUnsubscribes = new Map<string, () => void>()

  const bindConnection = (connection: ManagedConnection) => {
    /**
     * The renderer holds one connection per host and each subscribes to this
     * topic independently, so an event must be matched against the session's own
     * host before it is applied. Ids are uuids and a session never moves between
     * hosts, so this should never fire — it is the one thing standing between a
     * host-routing bug and events landing in the wrong conversation.
     */
    const isOwnHost = (sessionId: string): boolean =>
      session.sessions[sessionId]?.run.serverId === connection.serverId

    connectionUnsubscribes.get(connection.serverId)?.()
    const unsubEvent = connection.events.subscribe('session.eventReceived', ({ sessionId, event }) => {
      if (isOwnHost(sessionId)) session.handleNormalizedEvent(sessionId, event)
    })
    const unsubError = connection.events.subscribe('session.errorReceived', ({ sessionId, error }) => {
      if (isOwnHost(sessionId)) session.handleError(sessionId, error)
    })
    const unsubSessionTitle = connection.events.subscribe('session.titleChanged', (event: SessionTitleChangedEvent) => {
      session.applySessionTitleChanged(connection.serverId, event)
    })
    const unsubReset = connection.transport.onReset(() => {
      void resyncRuntime(session, connection.serverId)
    })
    connectionUnsubscribes.set(connection.serverId, () => {
      unsubEvent()
      unsubError()
      unsubSessionTitle()
      unsubReset()
    })
  }

  const primary = serverConnections.connectionFor()
  if (primary) bindConnection(primary)
  const unsubConnectionCreated = serverConnections.onConnectionCreated(bindConnection)

  onDestroy(() => {
    unsubConnectionCreated()
    for (const unsubscribe of connectionUnsubscribes.values()) unsubscribe()
    connectionUnsubscribes.clear()
  })
}
