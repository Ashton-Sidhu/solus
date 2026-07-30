import type { ChangedFileStat } from '../../../shared/git-types'
import type { WorkspaceContext } from '../../contexts/workspace/workspace.context.svelte'

/**
 * Per-file add/remove counts for what a session has changed so far.
 *
 * The transcript's diff summary needs numbers `sessionChangedFiles` doesn't
 * carry, so they come from `diffStats`. Cached per tab and refreshed only when
 * the changed-file set actually moves — a settled turn re-broadcasts the same
 * paths several times, and each refetch shells out to git.
 */
class DiffSummaryStore {
  private stats = $state<Record<string, ChangedFileStat[]>>({})
  private fetchedKey: Record<string, string> = {}
  private inFlight = new Set<string>()

  statsFor(tabId: string): ChangedFileStat[] {
    return this.stats[tabId] ?? []
  }

  /** Call with the tab's current changed-file list; refetches only on a change. */
  refresh(session: WorkspaceContext, tabId: string, changedFiles: string[]): void {
    const key = changedFiles.join('\n')
    if (!key) {
      if (this.stats[tabId]) delete this.stats[tabId]
      delete this.fetchedKey[tabId]
      return
    }
    if (this.fetchedKey[tabId] === key || this.inFlight.has(tabId)) return
    this.inFlight.add(tabId)
    void session
      .apiFor(tabId)
      .diffStats(session.ctxFor(tabId), { scope: { kind: 'session' } })
      .then((stats) => {
        this.fetchedKey[tabId] = key
        this.stats[tabId] = stats
      })
      .catch(() => {
        /* best-effort: the summary falls back to paths with no counts */
      })
      .finally(() => this.inFlight.delete(tabId))
  }

  disposeTab(tabId: string): void {
    delete this.stats[tabId]
    delete this.fetchedKey[tabId]
  }
}

export const diffSummaryStore = new DiffSummaryStore()
