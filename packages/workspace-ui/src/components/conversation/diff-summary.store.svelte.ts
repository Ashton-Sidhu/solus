import { DIFF_STATS_BATCH_LIMIT, type ChangedFileStat, type DiffScope } from '@solus/contracts/git-types'
import type { WorkspaceContext } from '../../contexts/workspace/workspace.context.svelte'

export type DiffSummaryScope = Extract<DiffScope, { kind: 'session' | 'turn' }>

function scopeKey(scope: DiffSummaryScope): string {
  return scope.kind === 'session' ? 'session' : `turn:${scope.index}`
}

/** One summary a card asked for, waiting for the end of the tick. */
interface QueuedSummary {
  sessionId: string
  summaryKey: string
  cacheKey: string
  revision: string
  scope: DiffSummaryScope
}

/**
 * Per-file add/remove counts for a session or one of its turns.
 *
 * Counts live in git, so they come from `diffStats`. Session summaries refresh
 * when their changed-file set moves; immutable turn summaries fetch once and
 * stay, because every settled turn in the transcript keeps its own card. The
 * cards of a conversation mount together: the summaries asked in one tick go
 * to the host as one `diffStatsBatch`.
 */
export class DiffSummaryStore {
  private stats = $state<Record<string, Record<string, ChangedFileStat[]>>>({})
  private fetchedKey: Record<string, string> = {}
  private inFlight = new Set<string>()
  /** By tab: the summaries asked this tick. */
  private readonly queued = new Map<string, QueuedSummary[]>()

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
    if (!revision) {
      if (this.stats[sessionId]?.[summaryKey]) delete this.stats[sessionId][summaryKey]
      delete this.fetchedKey[cacheKey]
      return
    }
    if (this.fetchedKey[cacheKey] === revision || this.inFlight.has(cacheKey)) return
    this.inFlight.add(cacheKey)
    const queue = this.queued.get(tabId)
    const summary = { sessionId, summaryKey, cacheKey, revision, scope }
    if (queue) {
      queue.push(summary)
      return
    }
    this.queued.set(tabId, [summary])
    queueMicrotask(() => this.flush(session, tabId))
  }

  private flush(session: WorkspaceContext, tabId: string): void {
    const queue = this.queued.get(tabId) ?? []
    this.queued.delete(tabId)
    const api = session.apiFor(tabId)
    const ctx = session.ctxFor(tabId)
    for (let start = 0; start < queue.length; start += DIFF_STATS_BATCH_LIMIT) {
      const chunk = queue.slice(start, start + DIFF_STATS_BATCH_LIMIT)
      const one = (summary: QueuedSummary) => api.diffStats(ctx, { scope: summary.scope }).then((stats) => this.keep(summary, stats))
      const read = chunk.length === 1
        ? one(chunk[0]!)
        : api.diffStatsBatch(ctx, chunk.map(({ scope }) => ({ scope })))
          .then((answers) => chunk.forEach((summary, index) => this.keep(summary, answers[index] ?? [])))
          // A host older than `diffStatsBatch` answers each card on its own.
          .catch(() => Promise.allSettled(chunk.map(one)))
      void read
        .catch(() => {
          /* best-effort: session summaries fall back to paths with no counts */
        })
        .finally(() => { for (const { cacheKey } of chunk) this.inFlight.delete(cacheKey) })
    }
  }

  private keep(summary: QueuedSummary, stats: ChangedFileStat[]): void {
    this.fetchedKey[summary.cacheKey] = summary.revision
    this.stats[summary.sessionId] ??= {}
    this.stats[summary.sessionId]![summary.summaryKey] = stats
  }
}

export const diffSummaryStore = new DiffSummaryStore()
