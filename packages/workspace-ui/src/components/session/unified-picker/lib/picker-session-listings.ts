import type { Task } from '@solus/contracts/task-types'
import type { SessionMeta, SessionSearchHit, SessionSearchResult } from '@solus/contracts/types'
import { snippetWindow } from '@solus/contracts/search-snippet'
import type { SidebarSessionChild } from '../../../../contexts/workspace/session-sidebar.store.svelte'
import { isDone } from '../../../tasks/lib/tasks-list-view'
import { activeSince, keepsHost, type PickerFilters } from './picker-filters'
import { activityScore, compareRelevance, nameScore, type Relevance } from './picker-relevance'
import { matchesEveryWord, type PickerSort } from './picker-search'
import type { ConversationHit } from './picker-rows'

/**
 * The picker's session listings (docs/plans/unified-search.md): the sessions a
 * query names and the hosts found, merged into one listing per session with
 * its best evidence, and the sessions no task claims that an empty query lists.
 */

export interface TaskSession {
  task: Task
  session: SidebarSessionChild
}

/** The task a session belongs to, and whether that task is in scope. */
export interface SessionOwner extends TaskSession {
  inScope: boolean
}

/** One listing of the Sessions section, before it is given its row index. A
 *  name hit is the better claim on relevance — it is the session's title — so
 *  the listing keeps its tier even once a content hit takes the row. */
export type SessionListing =
  | {
      kind: 'session'
      task: Task
      session: SidebarSessionChild
      hit?: ConversationHit
      additionalMatches?: ConversationHit[]
      hitServerId?: string
      ts: number
      relevance: Relevance
      /** The host's rank for the session. Lower is better. */
      rank?: number
    }
  | { kind: 'conversation'; meta: SessionMeta; hit?: ConversationHit; additionalMatches?: ConversationHit[]; hitServerId?: string; ts: number; relevance: Relevance; rank?: number }

/** A host's passage as a row's evidence. None for a session found by its name. */
function conversationHit(result: SessionSearchHit): ConversationHit | undefined {
  if (!result.snippet) return undefined
  return {
    messageId: result.messageId,
    snippet: snippetWindow(result.snippet),
    ts: result.ts,
    rank: result.rank,
  }
}

/** Name hits by how well the name answers, then words found by the index's
 *  score, then the date; or the date alone. */
export function compareListings(sort: PickerSort) {
  return (a: SessionListing, b: SessionListing): number => {
    if (sort === 'relevance') {
      if (a.relevance.tier !== b.relevance.tier || a.relevance.tier === 'name') {
        const byRelevance = compareRelevance(a.relevance, b.relevance)
        if (byRelevance) return byRelevance
      }
      const rankA = a.rank ?? Number.POSITIVE_INFINITY
      const rankB = b.rank ?? Number.POSITIVE_INFINITY
      if (rankA !== rankB) return rankA - rankB
    }
    return b.ts - a.ts
  }
}

/** Provider session IDs survive host copies; a draft is local to its host. */
export function sessionIdentity(session: { serverId?: string | null; sessionId?: string | null; tabId?: string | null }): string {
  return session.sessionId ? `session:${session.sessionId}` : JSON.stringify([session.serverId ?? '', `tab:${session.tabId}`])
}

/** Merge all evidence without changing the session's title or listing it twice. */
export function matchedSessions(
  nameHits: readonly TaskSession[],
  conversations: readonly SessionSearchResult[],
  ownerBySessionId: ReadonlyMap<string, SessionOwner>,
  sort: PickerSort,
  words: readonly string[],
  now: number,
): SessionListing[] {
  const byKey = new Map<string, SessionListing>()
  for (const { task, session } of nameHits) {
    const key = sessionIdentity(session)
    const ts = session.lastActivityAt || task.updatedAt
    const score = nameScore(session.label, words) + activityScore(ts, now, isDone(task))
    if (!byKey.has(key)) byKey.set(key, { kind: 'session', task, session, ts: session.lastActivityAt, relevance: { tier: 'name', score } })
  }
  for (const result of conversations) {
    const key = sessionIdentity(result.session)
    const owner = ownerBySessionId.get(key)
    if (owner && !owner.inScope) continue
    let listing = byKey.get(key)
    if (!listing) {
      if (owner) {
        const ts = owner.session.lastActivityAt
        listing = { kind: 'session', task: owner.task, session: owner.session, ts, relevance: { tier: 'evidence', score: activityScore(ts || owner.task.updatedAt, now, isDone(owner.task)) } }
      } else {
        // A session no task claims is still called something. When the words
        // are in its title, it is a name hit. The opening message its row
        // shows when it has no title is what was said, not a name.
        const ts = Date.parse(result.session.lastTimestamp) || result.ts
        const title = result.session.customTitle ?? ''
        const relevance: Relevance = matchesEveryWord(title, words)
          ? { tier: 'name', score: nameScore(title, words) + activityScore(ts, now) }
          : { tier: 'evidence', score: activityScore(ts, now) }
        listing = { kind: 'conversation', meta: result.session, hit: conversationHit(result), ts, relevance }
      }
      byKey.set(key, listing)
    }
    mergeSessionPassages(listing, result, owner?.session.serverId ?? '')
  }
  return [...byKey.values()].sort(compareListings(sort))
}

/** Keep only one host's message IDs, and choose the best bounded passages. */
function mergeSessionPassages(listing: SessionListing, result: SessionSearchResult, preferredHost: string): void {
  const hitServerId = result.session.serverId ?? ''
  // Message row IDs belong to one host's index. Prefer the linked host;
  // otherwise choose a stable source and never mix copied message IDs.
  const changesSource = listing.hitServerId !== undefined && listing.hitServerId !== hitServerId
  if (changesSource) {
    if (listing.hitServerId === preferredHost) return
    if (hitServerId !== preferredHost && listing.hitServerId! < hitServerId) return
  }
  listing.rank = Math.min(listing.rank ?? Number.POSITIVE_INFINITY, result.rank)
  const hits = new Map<number, ConversationHit>()
  for (const hit of [...(changesSource ? [] : [listing.hit, ...(listing.additionalMatches ?? [])]), conversationHit(result), ...(result.additionalMatches ?? []).map(conversationHit)]) {
    if (hit) hits.set(hit.messageId, hit)
  }
  const ordered = [...hits.values()].sort((a, b) => a.rank - b.rank || b.ts - a.ts || a.messageId - b.messageId)
  listing.hitServerId = hitServerId
  if (listing.kind === 'conversation') listing.meta = result.session
  listing.hit = ordered[0]
  listing.additionalMatches = ordered.slice(1, 3)
}

/** The sessions no task claims that the filters keep, as listings dated by their last activity. */
export function unclaimedSessions(
  recent: readonly SessionMeta[],
  ownerBySessionId: ReadonlyMap<string, SessionOwner>,
  filters: PickerFilters,
  now: number,
): SessionListing[] {
  const since = activeSince(filters, now)
  return recent.flatMap((meta): SessionListing[] => {
    const ts = Date.parse(meta.lastTimestamp) || 0
    if (ownerBySessionId.has(sessionIdentity(meta))) return []
    if (since !== undefined && ts < since) return []
    if (filters.agent !== 'any' && meta.provider !== filters.agent) return []
    if (!keepsHost(meta.serverId, filters)) return []
    return [{ kind: 'conversation', meta, ts, relevance: { tier: 'evidence', score: 0 } }]
  })
}
