import type { ChangedFileStat, DiffScope } from '../../../shared/git-types'
import type { WorkspaceContext } from '../../contexts/workspace/workspace.context.svelte'

export type DiffSummaryScope = Extract<DiffScope, { kind: 'session' | 'turn' }>

function scopeKey(scope: DiffSummaryScope): string {
  return scope.kind === 'session' ? 'session' : `turn:${scope.index}`
}

/**
 * Per-file add/remove counts for a session or one of its turns.
 *
 * Counts live in git, so they come from `diffStats`. Session summaries refresh
 * when their changed-file set moves; immutable turn summaries fetch once.
 */
export class DiffSummaryStore {
  private stats = $state<Record<string, Record<string, ChangedFileStat[]>>>({})
  private fetchedKey: Record<string, string> = {}
  private inFlight = new Set<string>()

  statsFor(tabId: string, scope: DiffSummaryScope): ChangedFileStat[] {
    return this.stats[tabId]?.[scopeKey(scope)] ?? []
  }

  refresh(
    session: WorkspaceContext,
    tabId: string,
    scope: DiffSummaryScope,
    changedFiles?: string[],
  ): void {
    const summaryKey = scopeKey(scope)
    const cacheKey = `${tabId}\n${summaryKey}`
    const revision = scope.kind === 'session' ? (changedFiles?.join('\n') ?? '') : summaryKey
    if (scope.kind === 'turn') {
      for (const key of Object.keys(this.stats[tabId] ?? {})) {
        if (key.startsWith('turn:') && key !== summaryKey) delete this.stats[tabId][key]
      }
      const prefix = `${tabId}\nturn:`
      for (const key of Object.keys(this.fetchedKey)) {
        if (key.startsWith(prefix) && key !== cacheKey) delete this.fetchedKey[key]
      }
    }
    if (!revision) {
      if (this.stats[tabId]?.[summaryKey]) delete this.stats[tabId][summaryKey]
      delete this.fetchedKey[cacheKey]
      return
    }
    if (this.fetchedKey[cacheKey] === revision || this.inFlight.has(cacheKey)) return
    this.inFlight.add(cacheKey)
    void session
      .apiFor(tabId)
      .diffStats(session.ctxFor(tabId), { scope })
      .then((stats) => {
        this.fetchedKey[cacheKey] = revision
        this.stats[tabId] ??= {}
        this.stats[tabId][summaryKey] = stats
      })
      .catch(() => {
        /* best-effort: session summaries fall back to paths with no counts */
      })
      .finally(() => this.inFlight.delete(cacheKey))
  }

  disposeTab(tabId: string): void {
    delete this.stats[tabId]
    const prefix = `${tabId}\n`
    for (const key of Object.keys(this.fetchedKey)) {
      if (key.startsWith(prefix)) delete this.fetchedKey[key]
    }
  }
}

export const diffSummaryStore = new DiffSummaryStore()
