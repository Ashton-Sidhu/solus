import type { SearchQuery } from '@solus/contracts/search-query'
import { searchActivityScore } from '@solus/contracts/session-search'

/**
 * How well a row answers a query, so the row the reader meant is one of the
 * first few.
 *
 * The query already decided which rows are listed: each holds every word at a
 * token start (`picker-search.ts`). This decides their order. A row is first
 * placed in a tier by where it matched, then ordered in the tier by a score:
 *
 * - `id` — the query is a task's human id. Nothing else can be meant.
 * - `name` — the words are in what the row is called: a task's title, a
 *   session's name. A name is what a person remembers and types.
 * - `evidence` — the words are only in a task's body or in what was said in a
 *   session. The row is relevant, but it is not the thing that was named.
 *
 * A name that is the query beats one that starts with it, which beats one that
 * holds the query as a phrase, which beats one that holds the words apart. A
 * word that is a whole token beats one that only starts a longer token, so
 * "tab" is "Tab strip", not "table". A short name the words fill beats a long
 * one they only touch. Recency and whether the work is still open decide the
 * rest; their weight is too small to overturn a better match.
 */
export type MatchTier = 'id' | 'name' | 'evidence'

export const MATCH_TIER_ORDER = { id: 3, name: 2, evidence: 1 } satisfies Record<MatchTier, number>

/** One row's standing under a query. Higher is better. */
export interface Relevance {
  tier: MatchTier
  score: number
}

/** Names use the same word quality as the host's pre-page ranking. */
export function nameScore(name: string, search: SearchQuery): number {
  return search.matchName(name)?.score ?? 0
}

/** The small lift of recent, open work: halves every two weeks, and a closed
 *  task gives some of it back. */
export function activityScore(lastActiveAt: number, now: number, isClosed = false): number {
  return searchActivityScore(lastActiveAt, now) - (isClosed ? 1 : 0)
}

/** Better first: tier, then score. Ties are left to the caller's own order. */
export function compareRelevance(a: Relevance, b: Relevance): number {
  return MATCH_TIER_ORDER[b.tier] - MATCH_TIER_ORDER[a.tier] || b.score - a.score
}

/** How many rows Top hits lifts above the sections. */
export const TOP_HIT_COUNT = 3

interface Ranked {
  relevance: Relevance
}

/**
 * The best rows of every section, best first, from sections that are each
 * already in that order and given in the order they are listed. A row that
 * `repeats` one already lifted is left in its section: it would spend a place
 * the reader needed. Empty unless a lifted row would otherwise sit below the
 * first few rows — when the list already opens on the best rows, one more
 * heading only moves them down.
 */
export interface TopHits<R> {
  /** The lifted rows, in the order they are listed. */
  order: R[]
  lifted: Set<R>
}

export function topHits<R extends Ranked>(
  sections: readonly (readonly R[])[],
  repeats: (row: R, lifted: readonly R[]) => boolean = () => false,
): TopHits<R> {
  const cursors = sections.map(() => 0)
  const order: R[] = []
  let isBuried = false
  while (order.length < TOP_HIT_COUNT) {
    let best = -1
    for (let index = 0; index < sections.length; index++) {
      const row = sections[index]![cursors[index]!]
      // A tie goes to the earlier section: a task's row resumes its latest session.
      if (row && (best < 0 || compareRelevance(row.relevance, sections[best]![cursors[best]!]!.relevance) < 0)) best = index
    }
    if (best < 0) break
    const row = sections[best]![cursors[best]!]!
    cursors[best]! += 1
    if (repeats(row, order)) continue
    order.push(row)
    // Under the sections it would follow every row of the sections above it.
    // The rows of the first section already lead the list.
    const rowsAbove = sections.slice(0, best).reduce((sum, section) => sum + section.length, 0)
    if (rowsAbove > 0 && rowsAbove + cursors[best]! > TOP_HIT_COUNT) isBuried = true
  }
  return isBuried ? { order, lifted: new Set(order) } : { order: [], lifted: new Set() }
}
