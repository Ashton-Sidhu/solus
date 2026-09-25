import { afterPaint } from '../../lib/after-paint'
import { TransportDisconnectedError, type ConnectionStatus } from '@solus/client-core/ws-transport'
import { bootstrapRuntimeTabs, prioritizeTabHydration } from '../workspace/session-bootstrap'
import type { SessionSidebarStore } from '../workspace/session-sidebar.store.svelte'
import type { WorkspaceContext } from '../workspace/workspace.context.svelte'
import { serverConnections } from '@solus/client-core/server-connections'
import { onDirectoryAnswered } from '@solus/client-core/server-registry'
import { reconcileMachineReferences, savedHostsAreAuthoritative } from '../workspace/machine-references'
import { hasSessionStarted } from '../../lib/sessionUtils'
import type { Session } from '@solus/contracts/types'
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
export function refreshRuntime(
  session: WorkspaceContext,
  sidebarStore: SessionSidebarStore,
): void {
  void afterPaint().then(() => session.lifecycle.initStaticInfo())
    .catch((error) => logConnectionReadError('static info initialization', error))

  void bootstrapRuntimeTabs(session)
    .then(() => {
      void sidebarStore.loadPinnedSessions()
    })
    .catch((error) => logConnectionReadError('session runtime initialization', error))

}

/**
 * Clear references to machines that are gone (`reconcileMachineReferences`),
 * only once the saved hosts are authoritative: a directory read succeeded, or
 * this client has no directory to wait for.
 */
function reconcileGoneMachines(session: WorkspaceContext): void {
  if (!savedHostsAreAuthoritative()) return
  reconcileMachineReferences(
    {
      settings: session.settings,
      unstartedRuns: () => session.unstartedRuns(),
      startedSessions: () => session.tabOrder
        .map((tabId) => session.sessionFor(tabId))
        .filter((tabSession): tabSession is Session => !!tabSession && hasSessionStarted(tabSession)),
      get defaultRunConfig() { return session.defaultRunConfig },
    },
    (serverId) => serverConnections.isKnownServer(serverId),
    () => serverConnections.defaultMachineId() !== null,
  )
}

export function initializeRuntime(
  session: WorkspaceContext,
  sidebarStore: SessionSidebarStore,
): () => void {
  refreshRuntime(session, sidebarStore)
  // Restored tabs and drafts may name a machine a previous load saw deleted.
  reconcileGoneMachines(session)
  const stopDirectory = onDirectoryAnswered(() => {
    reconcileGoneMachines(session)
    // A tab on a host that was missing before the directory answered waited;
    // the open one restores now, the rest when they are selected.
    if (session.activeTabId) prioritizeTabHydration(session, session.activeTabId)
  })
  // Pins federate across hosts, so a host that connects after boot has to
  // contribute its own rows too — not only the hosts present at bootstrap.
  const stopConnections = serverConnections.onConnectionCreated(() => {
    void sidebarStore.loadPinnedSessions()
  })

  // The durable send outbox drains when a host's supervisor reports live:
  // queued work survives a dead host and delivers on the next session.
  const stopPhases = serverConnections.onPhaseChange((serverId, phase) => {
    if (phase !== 'connected') return
    void sendOutbox.drain(serverId, (record) => session.dispatch.redeliverOutboxPrompt(serverId, record))
    // A window that booted with no machine (the account origin) reads the
    // machine facts once one connects; a no-op while the default is unchanged.
    void session.lifecycle.initStaticInfo()
      .catch((error) => logConnectionReadError('static info initialization', error))
    // Work left on a gone machine while there was nowhere to move it moves now.
    reconcileGoneMachines(session)
  })

  // Hosts skip watch-fired freshness work while no client is foregrounded.
  startActivityLeaseHeartbeat()
  return () => {
    stopDirectory()
    stopConnections()
    stopPhases()
  }
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
