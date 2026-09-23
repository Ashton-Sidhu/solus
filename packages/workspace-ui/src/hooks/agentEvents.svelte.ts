import { onDestroy } from 'svelte'
import type { WorkspaceContext } from '../contexts'
import type { SessionTitleChangedEvent } from '@solus/contracts/types'
import { resyncRuntime } from '../contexts/workspace/session-bootstrap'
import { serverConnections, type ManagedConnection } from '@solus/client-core/server-connections'
import { subscribeAllHosts } from '@solus/client-core/host-events'

/** Bind the session stream on every host that already exists and every host
 * added later. Kept outside the Svelte lifecycle wrapper so host routing can be
 * verified without mounting the application. */
export function bindAgentEventSubscriptions(session: WorkspaceContext): () => void {
  const isOwnHost = (serverId: string, sessionId: string): boolean => {
    const sessionServerId = session.sessions.byId[sessionId]?.run.serverId
    return !!sessionServerId && serverConnections.resolveId(sessionServerId) === serverId
  }

  const unsubEvent = subscribeAllHosts('session.eventReceived', (serverId, { sessionId, event }) => {
    if (isOwnHost(serverId, sessionId)) session.eventReducer.apply(sessionId, event)
  })
  const unsubError = subscribeAllHosts('session.errorReceived', (serverId, { sessionId, error }) => {
    if (isOwnHost(serverId, sessionId)) session.eventReducer.handleError(sessionId, error)
  })
  const unsubSessionTitle = subscribeAllHosts('session.titleChanged', (serverId, event: SessionTitleChangedEvent) => {
    session.metadata.applySessionTitleChanged(serverId, event)
  })
  // Read state is the host's, so this arrives for a read that happened on
  // another device as readily as for one made here. Applying it unconditionally
  // is what keeps the desktop, the web client and the phone in agreement.
  const unsubReadState = subscribeAllHosts('session.readStateChanged', (serverId, { sessionId, viewedAt }) => {
    if (isOwnHost(serverId, sessionId)) session.metadata.applySessionReadState(sessionId, viewedAt)
  })

  return () => {
    unsubEvent()
    unsubError()
    unsubSessionTitle()
    unsubReadState()
  }
}

/**
 * Bridges ControlPlane IPC events into the session context. Call from App.svelte's top-level script,
 * not inside $effect — the unsubscribes are tied to the component's lifetime.
 *
 * The host delivers buffered response segments or paced paragraphs, according
 * to its response-streaming setting. The client applies each delivery once.
 */
export function setupAgentEvents(session: WorkspaceContext): void {
  const unsubscribeEvents = bindAgentEventSubscriptions(session)
  const resetUnsubscribes = new Map<string, () => void>()

  const bindReset = (connection: ManagedConnection) => {
    resetUnsubscribes.get(connection.serverId)?.()
    const unsubReset = connection.transport.onReset(() => {
      void resyncRuntime(session, connection.serverId)
    })
    resetUnsubscribes.set(connection.serverId, unsubReset)
  }

  for (const serverId of serverConnections.connectedServerIds()) {
    const connection = serverConnections.connectionFor(serverId)
    if (connection) bindReset(connection)
  }
  const unsubConnectionCreated = serverConnections.onConnectionCreated(bindReset)

  onDestroy(() => {
    unsubscribeEvents()
    unsubConnectionCreated()
    for (const unsubscribe of resetUnsubscribes.values()) unsubscribe()
    resetUnsubscribes.clear()
  })
}
