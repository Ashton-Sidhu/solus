/** How sessions rank under a query, shared by hosts, workspace services and clients. */
import { searchText, searchTokenMatches, searchTokens, type SearchQuery } from './search-query'

export interface SessionSearchReason { field: 'id' | 'title' | 'branch' | 'pullRequest' | 'messages'; text: string }
/** A provider identity when available, with text and time for histories without one.
 * This reference survives a derived-index rebuild and a copy to another host. */
export interface SessionSearchTarget {
  sourceSessionId: string
  messageId: string | null
  role: string
  timestamp: number
  text: string
}

/** Tool output and provider-child rows do not belong to the searchable conversation. */
export function searchableMessageText(message: { role?: string; content?: string; toolName?: string; parentToolUseId?: string } | null): string {
  return message && (message.role === 'user' || message.role === 'assistant') && !message.toolName && !message.parentToolUseId
    ? searchText(message.content ?? '') : ''
}

export interface SessionSearchSubject { id?: string; title: string | null; branch?: string | null; pullRequest?: string | null }
export interface SessionNameScore { score: number; reason: SessionSearchReason; typo: boolean }

/** Worktree branches all start with the app's prefix, so "solus" would name
 *  every one of them. Only before more text, so typing "solus/" is not empty. */
const WORKTREE_BRANCH_PREFIX = /^solus\/(?=\S)/

/** How well a session's id, title, branch or pull requests name the query. */
export function sessionNameScore(subject: SessionSearchSubject, query: SearchQuery, typos = false): SessionNameScore | null {
  // An exact ID was already checked before a names-only correction pass.
  if (!typos && subject.id && subject.id.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') === query.words.join('')) return { score: 700, reason: { field: 'id', text: subject.id }, typo: false }
  if (!subject.title && !subject.branch && !subject.pullRequest) return null
  let best: SessionNameScore | null = null
  for (const [field, text] of [['title', subject.title], ['branch', subject.branch?.startsWith('solus/') ? subject.branch.replace(WORKTREE_BRANCH_PREFIX, '') : subject.branch], ['pullRequest', subject.pullRequest]] as const) {
    if (!text) continue
    const match = (field === 'pullRequest' && query.pullRequest ? query.pullRequest : query).matchName(text, typos)
    if (!match) continue
    const score = match.typo ? 50 + match.score : (field === 'title' ? 400 : 300) + match.score
    if (!best || score > best.score) best = { score, reason: { field, text }, typo: match.typo }
  }
  return best
}

/** Counts saturate and do not depend on the size of one host's corpus. */
export function sessionEvidenceScore(counts: readonly number[], together: boolean, phrase: boolean): number {
  const frequency = counts.reduce((sum, count) => sum + count / (count + 1.2), 0) / Math.max(1, counts.length)
  return (phrase ? 250 : together ? 200 : 100) + frequency * 10
}

/** Bounded below a match-quality step. The caller uses one clock for all hosts. */
export function searchActivityScore(timestamp: number, now: number): number {
  return 2 * 0.5 ** (Math.max(0, now - timestamp) / (14 * 86_400_000))
}

/** How much recent use lifts a session found by its messages: its last
 *  activity, or the last time a person read it, whichever is later. Up to 6,
 *  below the 50 between message tiers, so use reorders matches of one kind
 *  and never turns a weaker match into a better one. Names do not take it: on
 *  real transcripts it lowered title matches and raised message matches
 *  (docs/plans/session-search-benchmark.md). */
export function searchUseScore(lastActivity: number, now: number, viewedAt = 0): number {
  return 3 * searchActivityScore(Math.max(lastActivity, viewedAt), now)
}

/** A session a search may list, as its store holds it. Several candidates may
 *  share one session id: a session that changed provider has one per thread. */
export interface SessionCandidate {
  sessionId: string
  title: string | null
  branch: string | null
  pullRequest?: string
  lastActivity: number
  viewedAt?: number
}

/** What a store's messages say about a candidate: for each required word of
 *  the query, how many messages hold it; and whether one message holds every
 *  word, or the phrase. */
export interface SessionMessageEvidence<C> {
  counts(candidate: C): readonly number[]
  together(candidate: C): boolean
  phrase(candidate: C): boolean
}

export interface RankedSession<C> { candidate: C; score: number; name: SessionNameScore | null }

/**
 * The sessions that match, best first (docs/plans/unified-search.md). Every
 * store reads its own messages; this is the one rule that orders them.
 *
 * A session matches when every required word is in its name or in any of its
 * messages, not necessarily one message. Names rank before messages; phrase
 * evidence before words in one message, then words spread across messages.
 * Recent use reorders message matches within their tier. A typo is tried on
 * names only when nothing matched. Without `evidence` (names only) no message
 * is read.
 */
export function rankSessions<C extends SessionCandidate>(
  query: SearchQuery,
  candidates: readonly C[],
  evidence: SessionMessageEvidence<C> | null,
  now: number,
): RankedSession<C>[] {
  if (query.isEmpty) return []
  const subject = (candidate: C): SessionSearchSubject => ({ id: candidate.sessionId, title: candidate.title, branch: candidate.branch, pullRequest: candidate.pullRequest })
  const bySession = new Map<string, RankedSession<C>>()
  const keep = (ranked: RankedSession<C>) => {
    const held = bySession.get(ranked.candidate.sessionId)
    if (!held || ranked.score > held.score) bySession.set(ranked.candidate.sessionId, ranked)
  }
  for (const candidate of candidates) {
    const name = sessionNameScore(subject(candidate), query)
    if (name) { keep({ candidate, score: name.score, name }); continue }
    const counts = evidence?.counts(candidate) ?? query.required.map(() => 0)
    const nameTokens = candidate.title || candidate.branch || candidate.pullRequest
      ? searchTokens([candidate.title, candidate.branch, candidate.pullRequest].filter(Boolean).join('\n'))
      : []
    if (query.required.some((word, index) => !counts[index] && !nameTokens.some(token => searchTokenMatches(token.text, word)))) continue
    const score = sessionEvidenceScore(counts, !!evidence?.together(candidate), !!evidence?.phrase(candidate))
      + searchUseScore(candidate.lastActivity, now, candidate.viewedAt)
    keep({ candidate, score, name: null })
  }
  // A typo never displaces a real word match. Names-only correction reads no messages.
  if (bySession.size === 0) for (const candidate of candidates) {
    const name = sessionNameScore(subject(candidate), query, true)
    if (name) keep({ candidate, score: name.score, name })
  }
  return [...bySession.values()].sort((a, b) => b.score - a.score
    || b.candidate.lastActivity - a.candidate.lastActivity
    || a.candidate.sessionId.localeCompare(b.candidate.sessionId))
}

export function searchTargetMatches(target: SessionSearchTarget, message: { messageId?: string; id?: string; role: string; content: string; timestamp?: number; sourceSessionId?: string }): boolean {
  if (message.sourceSessionId && message.sourceSessionId !== target.sourceSessionId) return false
  if (target.messageId && (message.messageId === target.messageId || message.id === target.messageId)) {
    return true
  }
  return message.role === target.role && message.content.startsWith(target.text) && (message.timestamp === undefined || Math.abs(message.timestamp - target.timestamp) < 1000)
}
