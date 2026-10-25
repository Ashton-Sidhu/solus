import { afterPaint } from '../../lib/after-paint'
import { sessionListStore } from '../workspace/session-list.store.svelte'
import { TransportDisconnectedError } from '@solus/client-core/ws-transport'
import type { HostReadiness } from '@solus/client-core/host-readiness'
import { bootstrapRuntimeTabs, prioritizeTabHydration } from '../workspace/session-bootstrap'
import type { SessionSidebarStore } from '../workspace/session-sidebar.store.svelte'
import type { WorkspaceContext } from '../workspace/workspace.context.svelte'
import { serverConnections } from '@solus/client-core/server-connections'
import { onDirectoryAnswered } from '@solus/client-core/server-registry'
import { reconcileMachineReferences, savedHostsAreAuthoritative } from '../workspace/machine-references'
import { projectsStore } from '../projects/projects.store.svelte'
import { hasSessionStarted } from '../../lib/sessionUtils'
import type { RunLocation, Session } from '@solus/contracts/types'
import { sendOutbox } from '@solus/client-core/send-outbox'
import { startActivityLeaseHeartbeat } from '@solus/client-core/activity-lease'
import { startHostStallToasts } from '../connections/host-stall-toasts'

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
  void afterPaint().then(() => session.lifecycle.readRunOnAgents())
    .catch((error) => logConnectionReadError('agent list initialization', error))

  void bootstrapRuntimeTabs(session)
    .then(() => {
      void sidebarStore.loadPinnedSessions()
      void sessionListStore.load()
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
      unstartedRuns: () => session.unstartedSourceIds().flatMap((sourceId) => {
        const run = session.runFor(sourceId)
        return run ? [{ run, moveTo: (next: RunLocation) => session.moveRun(sourceId, next) }] : []
      }),
      startedSessions: () => session.tabOrder
        .map((tabId) => session.sessionFor(tabId))
        .filter((tabSession): tabSession is Session => !!tabSession && hasSessionStarted(tabSession)),
      get defaultRunConfig() { return session.defaultRunConfig },
      projects: projectsStore,
    },
    (serverId) => serverConnections.presenceOf(serverId),
    () => serverConnections.runOnHostId() !== null,
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
    void sessionListStore.load()
  })

  // The durable send outbox drains when a host's supervisor reports live:
  // queued work survives a dead host and delivers on the next session.
  const stopReadiness = serverConnections.onReadinessChange((serverId, readiness) => {
    if (readiness !== 'ready') return
    void sendOutbox.drain(serverId, (record) => session.dispatch.redeliverOutboxPrompt(serverId, record))
    // A window that booted with no machine (the account origin) reads the
    // agents once one connects; a no-op while the Run on host is unchanged.
    void session.lifecycle.readRunOnAgents()
      .catch((error) => logConnectionReadError('agent list initialization', error))
    // A draft's checkout read while this host was away could not answer.
    session.drafts.rereadStartTargets(serverId)
    // Work left on a gone machine while there was nowhere to move it moves now.
    reconcileGoneMachines(session)
    // A shown conversation whose transcript read failed while its host was away
    // reads again now (docs/plans/host-readiness.md); a loaded one is left as it is.
    session.loadShownConversations()
  })

  // A host that dropped because it froze says so when it comes back.
  const stopStallToasts = startHostStallToasts()

  // Hosts skip watch-fired freshness work while no client is foregrounded.
  startActivityLeaseHeartbeat()
  return () => {
    stopDirectory()
    stopConnections()
    stopReadiness()
    stopStallToasts()
  }
}

/** Detect reconnect edges after the first ready state has been observed. */
export function createReconnectDetector(
  initialReadiness: HostReadiness,
): (readiness: HostReadiness) => boolean {
  let previousReadiness = initialReadiness
  let hasObservedReady = initialReadiness === 'ready'

  return (readiness) => {
    const reconnected =
      readiness === 'ready' && previousReadiness !== 'ready' && hasObservedReady
    previousReadiness = readiness
    if (readiness === 'ready') hasObservedReady = true
    return reconnected
  }
}
