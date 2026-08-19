import type { ChangedFileStat, DiffScope } from '@solus/contracts/git-types'
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

  statsFor(sessionId: string, scope: DiffSummaryScope): ChangedFileStat[] {
    return this.stats[sessionId]?.[scopeKey(scope)] ?? []
  }

  /** Keyed by the conversation whose changes these are. Two views of one session
   *  are looking at the same diff, so they share one cache entry and one fetch. */
  refresh(
    session: WorkspaceContext,
    sessionId: string,
    scope: DiffSummaryScope,
    changedFiles?: string[],
  ): void {
    const tabId = session.tabIdForSession(sessionId)
    if (!tabId) return
    const summaryKey = scopeKey(scope)
    const cacheKey = `${sessionId}\n${summaryKey}`
    const revision = scope.kind === 'session' ? (changedFiles?.join('\n') ?? '') : summaryKey
    if (scope.kind === 'turn') {
      for (const key of Object.keys(this.stats[sessionId] ?? {})) {
        if (key.startsWith('turn:') && key !== summaryKey) delete this.stats[sessionId][key]
      }
      const prefix = `${sessionId}\nturn:`
      for (const key of Object.keys(this.fetchedKey)) {
        if (key.startsWith(prefix) && key !== cacheKey) delete this.fetchedKey[key]
      }
    }
    if (!revision) {
      if (this.stats[sessionId]?.[summaryKey]) delete this.stats[sessionId][summaryKey]
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
        this.stats[sessionId] ??= {}
        this.stats[sessionId][summaryKey] = stats
      })
      .catch(() => {
        /* best-effort: session summaries fall back to paths with no counts */
      })
      .finally(() => this.inFlight.delete(cacheKey))
  }
}

export const diffSummaryStore = new DiffSummaryStore()
