import { TransportDisconnectedError, type ConnectionStatus } from '@solus/client-core/ws-transport'
import { bootstrapRuntimeTabs } from '../workspace/session-bootstrap'
import type { SessionSidebarStore } from '../workspace/session-sidebar.store.svelte'
import type { WorkspaceContext } from '../workspace/workspace.context.svelte'
import { serverConnections } from '@solus/client-core/server-connections'
import { sendOutbox } from '@solus/client-core/send-outbox'
import { startActivityLeaseHeartbeat } from '@solus/client-core/activity-lease'

/** Ignore expected connection gaps while still surfacing unrelated read failures. */
export function logConnectionReadError(operation: string, error: Parameters<typeof String>[0]): void {
  if (error instanceof TransportDisconnectedError) return
  console.error(`${operation} failed`, error)
}

/** Refresh theme from the client device. Theme is client state, not host state. */
export function refreshTheme(setSystemTheme: (isDark: boolean) => void): void {
  setSystemTheme(window.matchMedia('(prefers-color-scheme: dark)').matches)
}

/** Refresh host metadata and persisted conversations independently. Transcript
 * restore must not wait for the broader start() payload: a slow or failed host
 * metadata read must not leave a materialized session looking empty. */
export function initializeRuntime(
  session: WorkspaceContext,
  sidebarStore: SessionSidebarStore,
): void {
  void session.initStaticInfo()
    .catch((error) => logConnectionReadError('static info initialization', error))

  void bootstrapRuntimeTabs(session)
    .then(() => {
      void sidebarStore.loadPinnedSessions()
    })
    .catch((error) => logConnectionReadError('session runtime initialization', error))

  // Pins federate across hosts, so a host that connects after boot has to
  // contribute its own rows too — not only the hosts present at bootstrap.
  serverConnections.onConnectionCreated(() => {
    void sidebarStore.loadPinnedSessions()
  })

  // The durable send outbox drains when a host's supervisor reports live:
  // queued work survives a dead host and delivers on the next session.
  serverConnections.onPhaseChange((serverId, phase) => {
    if (phase !== 'connected') return
    void sendOutbox.drain(serverId, (record) => session.redeliverOutboxPrompt(serverId, record))
  })

  // Hosts skip watch-fired freshness work while no client is foregrounded.
  startActivityLeaseHeartbeat()
}

/** Detect reconnect edges after the first connected state has been observed. */
export function createReconnectDetector(
  initialStatus: ConnectionStatus,
): (status: ConnectionStatus) => boolean {
  let previousStatus = initialStatus
  let hasObservedConnected = initialStatus === 'connected'

  return (status) => {
    const reconnected =
      status === 'connected' && previousStatus !== 'connected' && hasObservedConnected
    previousStatus = status
    if (status === 'connected') hasObservedConnected = true
    return reconnected
  }
}
