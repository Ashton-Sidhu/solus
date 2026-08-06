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
    connectionUnsubscribes.get(connection.serverId)?.()
    const unsubEvent = connection.events.subscribe('session.eventReceived', ({ tabId, event }: { tabId: string; event: NormalizedEvent }) => {
      if (session.sessionFor(tabId)?.run.serverId !== connection.serverId) return
      session.handleNormalizedEvent(tabId, event)
    })
    const unsubError = connection.events.subscribe('session.errorReceived', ({ tabId, error }) => {
      if (session.sessionFor(tabId)?.run.serverId !== connection.serverId) return
      session.handleError(tabId, error)
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
