import { TransportDisconnectedError, type ConnectionStatus } from '@client-core/ws-transport'
import { bootstrapRuntimeTabs } from './session-bootstrap'
import type { SessionSidebarStore } from './session-sidebar.store.svelte'
import type { WorkspaceContext } from './workspace.context.svelte'

/** Ignore expected connection gaps while still surfacing unrelated read failures. */
export function logConnectionReadError(operation: string, error: unknown): void {
  if (error instanceof TransportDisconnectedError) return
  console.error(`${operation} failed`, error)
}

/** Refresh the renderer's system-theme state from the active transport. */
export function refreshTheme(setSystemTheme: (isDark: boolean) => void): void {
  window.solus
    .getTheme()
    .then(({ isDark }: { isDark: boolean }) => setSystemTheme(isDark))
    .catch((error) => logConnectionReadError('getTheme', error))
}

/** Attach persisted runtime state, then refresh the session sidebar. */
export function initializeRuntime(
  session: WorkspaceContext,
  sidebarStore: SessionSidebarStore,
): void {
  session
    .initStaticInfo()
    .then(async () => {
      await bootstrapRuntimeTabs(session)
      void sidebarStore.loadPinnedSessions()
    })
    .catch((error) => logConnectionReadError('runtime initialization', error))
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
