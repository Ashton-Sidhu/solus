import { INITIAL_HISTORY_TURNS, prefetchSessionHistoryPage } from '@solus/client-core/session-history-page'
import { serverConnections } from '@solus/client-core/server-connections'
import { loadServers } from '@solus/client-core/server-registry'
import { loadPersistedTabs } from './tab-persistence'
import { afterPaint } from '../../lib/after-paint'
import { checkoutPlace, runHost, workingPlace } from './run-location'

let startupTabId: string | undefined
const paintWaiters = new Set<() => void>()

/** Background stores wait for the restored transcript, with recovery for an
 * empty/failed restore or a hidden client that cannot report a paint. */
export async function afterStartupTranscriptPaint(): Promise<void> {
  await afterPaint()
  if (!startupTabId || performance.getEntriesByName('solus.boot.transcript.painted').length) return
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timeout)
      paintWaiters.delete(finish)
      resolve()
    }
    const timeout = setTimeout(finish, 2_000)
    paintWaiters.add(finish)
  })
  await afterPaint()
}

/** This module must stay independent of the workspace/component graph. */
export function prefetchStartupTranscript(): Promise<void> | undefined {
  try {
    const snapshot = loadPersistedTabs()
    const tab = snapshot?.tabs.find((tab) => tab.tabId === snapshot.activeTabId)
    if (!tab?.agentSessionId || !tab.provider || tab.pendingFork || !checkoutPlace(tab).path) return
    const serverId = tab.serverInstallationId
      ? loadServers().find((server) => server.installationId === tab.serverInstallationId)?.id ?? runHost(tab)
      : runHost(tab)
    // A tab on a gone host restores read-only from the mirror (`hydrateTab`).
    if (serverConnections.presenceOf(serverId) === 'gone') return
    const api = serverConnections.apiFor(serverId)
    startupTabId = tab.tabId
    performance.mark('solus.boot.transcript.requested')
    const result = prefetchSessionHistoryPage(api, {
      sessionId: tab.sessionId || tab.agentSessionId,
      projectPath: workingPlace(tab).path,
      provider: tab.provider,
      turnLimit: INITIAL_HISTORY_TURNS,
      deferArtifactHtml: true,
    })
    return result.then(() => { performance.mark('solus.boot.transcript.received') }).catch(() => {})
  } catch {
    // A stale snapshot must never stop boot. Normal restoration owns errors and
    // reconnect retries.
  }
}

export function markStartupTranscriptApplied(tabId: string): void {
  if (tabId !== startupTabId) return
  performance.mark('solus.boot.transcript.applied')
}

/** Called by the visible conversation only after its rows are in the DOM.
 * Two frames include a paint opportunity; this is not a GPU presentation timestamp. */
export function observeStartupTranscriptPaint(tabId: string): (() => void) | undefined {
  if (tabId !== startupTabId || !performance.getEntriesByName('solus.boot.transcript.applied').length
    || performance.getEntriesByName('solus.boot.transcript.painted').length) return
  let frame: number | undefined
  const stop = () => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    document.removeEventListener('visibilitychange', schedule)
  }
  const schedule = () => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    if (document.visibilityState !== 'visible') return
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        if (document.visibilityState !== 'visible') return
        performance.mark('solus.boot.transcript.painted')
        for (const finish of paintWaiters) finish()
        stop()
      })
    })
  }
  document.addEventListener('visibilitychange', schedule)
  schedule()
  return stop
}
