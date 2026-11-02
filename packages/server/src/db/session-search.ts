import { z } from 'zod'
import { SNIPPET_HIT_CLOSE, SNIPPET_HIT_OPEN } from '@solus/contracts/search-snippet'
import type { SessionSearchResult } from '@solus/contracts/types'
import { SearchQuery } from '@solus/contracts/search-query'
import { rankSessions, type RankedSession, type SessionCandidate } from '@solus/contracts/session-search'
import { rowToSession, SESSION_ROW_SPAN, sessionRowSchema } from './session-indexer'
import { getDb } from '.'
import { sessionIdOfThread } from '../data/sessions/session-lineage'

/** How a session search is narrowed and paged. */
export interface SessionSearchOptions {
  /** Applied before scoring and paging, after the caller checks record visibility. */
  sessionIds?: ReadonlySet<string>
  /** Session id → when it was last read on any client, a sign of use. */
  viewedAt?: ReadonlyMap<string, number>
  /** The clock use is scored against. Now by default. */
  now?: number
  providers?: string[]
  /** Only messages by one side of the conversation (the agent tool's filter). */
  role?: 'user' | 'assistant'
  /** Inclusive bounds on a message's timestamp (ms), for the agent tool. */
  sinceTs?: number
  untilTs?: number
  /** Omit to search every project; set to scope to one git-root and all its worktrees. */
  projectRoot?: string
  /** Only chats, the sessions with no project. */
  chats?: boolean
  /** Only sessions last active at or after this instant (ms). */
  activeSince?: number
  /** Match names and metadata only; read no message. */
  namesOnly?: boolean
  /** More words a session is known by, keyed by its session id: its pull requests. */
  metadata?: ReadonlyMap<string, string>
  /** One page of the answer: at most `limit` sessions after `offset`. */
  limit?: number
  offset?: number
}

/** One page of the sessions that match, best first, and how many match in all. */
export interface SessionSearchPage {
  results: SessionSearchResult[]
  total: number
}

const nameRowSchema = z.object({
  session_id: z.string(),
  number: z.number().nullable(),
  custom_title: z.string().nullable(),
  branch: z.string().nullable(),
  last_timestamp: z.number().nullable(),
})
const passageRowSchema = z.object({ id: z.number(), session_id: z.string(), uuid: z.string().nullable(), role: z.string(), ts: z.number().nullable(), text: z.string() })

/** A session's hits for one query word: how many of its messages hold it,
 *  and the ids of the newest few, newest first. */
interface WordHits {
  count: number
  newest: number[]
}
const PASSAGES_PER_SESSION = 3

/** Bound the passage work and response size of one page. */
const MAX_PAGE = 50

/** Words as one FTS5 phrase of their tokens, the last a prefix. */
function phraseTerm(words: readonly string[]): string {
  const phrase = `"${words.join(' ').replaceAll('"', '""')}"`
  return /^\d+$/.test(words.at(-1) ?? '') ? phrase : `${phrase}*`
}

/** Per session number, the hits of one FTS5 query over the messages in scope. */
function messageHits(db: ReturnType<typeof getDb>, term: string, options: SessionSearchOptions): Map<number, WordHits> {
  const filters: string[] = []
  const params: Array<string | number> = [term]
  if (options.role) { filters.push('m.role = ?'); params.push(options.role) }
  if (options.sinceTs !== undefined) { filters.push('m.ts >= ?'); params.push(options.sinceTs) }
  if (options.untilTs !== undefined) { filters.push('m.ts <= ?'); params.push(options.untilTs) }
  // The session is read from the row id. Only a message filter joins the row.
  const rows = filters.length
    ? db.prepare(`
        SELECT session_fts.rowid AS id FROM session_fts
        JOIN session_messages m ON m.id = session_fts.rowid
        WHERE session_fts MATCH ? AND ${filters.join(' AND ')}
      `).all(...params)
    : db.prepare('SELECT rowid AS id FROM session_fts WHERE session_fts MATCH ?').all(term)
  const hits = new Map<number, WordHits>()
  for (const row of rows) {
    // A common word answers with most of the index, so its rows are read
    // without a schema: a parse of every row was a third of the search. An
    // FTS5 row id is an integer by construction.
    const id = Number(row.id)
    const number = Math.floor(id / SESSION_ROW_SPAN)
    const held = hits.get(number)
    if (!held) {
      hits.set(number, { count: 1, newest: [id] })
      continue
    }
    held.count += 1
    const { newest } = held
    if (newest.length < PASSAGES_PER_SESSION || id > newest.at(-1)!) {
      newest.push(id)
      newest.sort((a, b) => b - a)
      if (newest.length > PASSAGES_PER_SESSION) newest.pop()
    }
  }
  return hits
}

/**
 * The sessions that match a query, one page at a time
 * (docs/plans/unified-search.md).
 *
 * A session matches when every word of the query starts a word of its name,
 * its metadata or any of its messages — not necessarily one message. The
 * session a message belongs to is read from its row id, so a common word costs
 * one pass over its postings and no join. Names rank before messages. Phrase
 * evidence ranks before words in one message, then words spread across messages.
 * Counts saturate within each tier. Recency breaks ties.
 */
export function searchSessionIndex(text: string, options: SessionSearchOptions = {}): SessionSearchPage {
  const query = new SearchQuery(text)
  if (query.isEmpty) return { results: [], total: 0 }
  const limit = Math.min(MAX_PAGE, Math.max(1, Math.trunc(options.limit ?? MAX_PAGE)))
  const offset = Math.max(0, Math.trunc(options.offset ?? 0))
  const db = getDb()
  // Resolve lineage once per candidate, including misses. A later pass must
  // not issue a second database query for every unbound provider thread.
  const candidates: IndexedCandidate[] = sessionsInScope(db, options).flatMap(row => {
    const sessionId = sessionIdOfThread(row.session_id)
    if (options.sessionIds && !options.sessionIds.has(sessionId)) return []
    return [{ row, sessionId, title: row.custom_title, branch: row.branch, pullRequest: options.metadata?.get(sessionId), lastActivity: row.last_timestamp ?? 0, viewedAt: options.viewedAt?.get(sessionId) }]
  })
  const hits = queryHits(db, query, options)
  const has = (map: Map<number, WordHits> | null, number: number | null) => number !== null && !!map?.has(number)
  // A session that changed provider has a row per thread; it is one hit, its best thread's.
  const matched = rankSessions(query, candidates, options.namesOnly ? null : {
    counts: ({ row }) => hits.perWord.map(wordHits => row.number === null ? 0 : wordHits.get(row.number)?.count ?? 0),
    together: ({ row }) => has(hits.together, row.number),
    phrase: ({ row }) => has(hits.phrase, row.number),
  }, options.now ?? Date.now())
  const page = matched.slice(offset, offset + limit).map((session) => ({ ...session, passageIds: passageIdsOf(session.candidate.row.number, hits) }))
  return { results: pageResults(db, page, query), total: matched.length }
}

/** One indexed thread of a session, as the shared ranking reads it. */
interface IndexedCandidate extends SessionCandidate { row: z.infer<typeof nameRowSchema> }

/** The sessions the scope and filters keep, with what they are called. */
function sessionsInScope(db: ReturnType<typeof getDb>, options: SessionSearchOptions): z.infer<typeof nameRowSchema>[] {
  const scope: string[] = []
  const params: Array<string | number> = []
  if (options.projectRoot) { scope.push('s.project_root = ?'); params.push(options.projectRoot) }
  if (options.chats) scope.push("s.place = 'chat'")
  const providers = options.providers?.map((provider) => provider === 'claude-code' ? 'claude' : provider)
  if (providers?.length) { scope.push(`s.provider IN (${providers.map(() => '?').join(', ')})`); params.push(...providers) }
  if (options.activeSince !== undefined) { scope.push('s.last_timestamp >= ?'); params.push(options.activeSince) }
  return nameRowSchema.array().parse(db.prepare(`
    SELECT s.session_id, k.number, s.custom_title, s.branch, s.last_timestamp
    FROM transcript_index s LEFT JOIN session_keys k ON k.session_id = s.session_id
    ${scope.length ? `WHERE ${scope.join(' AND ')}` : ''}
  `).all(...params))
}

/** Each required word's message hits, and messages that hold every required word or the phrase. */
interface QueryHits {
  perWord: Map<number, WordHits>[]
  together: Map<number, WordHits> | null
  phrase: Map<number, WordHits> | null
}

function queryHits(db: ReturnType<typeof getDb>, query: SearchQuery, options: SessionSearchOptions): QueryHits {
  if (options.namesOnly) return { perWord: [], together: null, phrase: null }
  // An optional filler word is in nearly every message: reading its postings
  // costs the most and decides nothing. The phrase still holds it.
  const { required, words } = query
  return {
    perWord: required.map((word) => messageHits(db, phraseTerm([word]), options)),
    together: required.length > 1 ? messageHits(db, required.map((word) => phraseTerm([word])).join(' '), options) : null,
    phrase: words.length > 1 ? messageHits(db, phraseTerm(words), options) : null,
  }
}

/** The messages a session's row shows, best first: the newest with the phrase,
 *  then with every word, then each word's newest, rarest word first. */
function passageIdsOf(number: number | null, hits: QueryHits): number[] {
  if (number === null) return []
  const byRarity = hits.perWord
    .map(wordHits => ({ newest: wordHits.get(number)?.newest ?? [], count: wordHits.size }))
    .sort((a, b) => a.count - b.count)
  return [...new Set([
    ...hits.phrase?.get(number)?.newest ?? [],
    ...hits.together?.get(number)?.newest ?? [],
    ...byRarity.flatMap(({ newest }) => newest),
  ])].slice(0, PASSAGES_PER_SESSION)
}

/** The page as results: each session's row, and its passages cut and marked. */
function pageResults(
  db: ReturnType<typeof getDb>,
  page: ReadonlyArray<RankedSession<IndexedCandidate> & { passageIds: number[] }>,
  query: SearchQuery,
): SessionSearchResult[] {
  if (!page.length) return []
  const sessionIds = page.map(({ candidate }) => candidate.row.session_id)
  const rows = new Map(sessionRowSchema.array().parse(db.prepare(`
    SELECT
      session_id, provider, cwd, project_path, is_worktree, slug, first_message, custom_title,
      last_timestamp, size, model, reasoning_effort, project_root, branch, parent_session_id, root_session_id,
      delegation_exchange_id, delegation_depth, delegation_intent, delegation_created_at
    FROM transcript_index
    WHERE session_id IN (${sessionIds.map(() => '?').join(', ')})
  `).all(...sessionIds)).map((row) => [row.session_id, row]))
  const passageIds = page.flatMap(({ passageIds }) => passageIds)
  const passages = new Map(passageIds.length
    ? passageRowSchema.array().parse(db.prepare(`
        SELECT id, session_id, uuid, role, ts, text FROM session_messages WHERE id IN (${passageIds.map(() => '?').join(', ')})
      `).all(...passageIds)).map((row) => [row.id, row])
    : [])
  const results: SessionSearchResult[] = []
  for (const { candidate: { row }, score, name, passageIds } of page) {
    const session = rows.get(row.session_id)
    if (!session) continue
    const hits = passageIds.flatMap((id) => {
      const passage = passages.get(id)
      return passage ? [{
        snippet: query.passage(passage.text, SNIPPET_HIT_OPEN, SNIPPET_HIT_CLOSE),
        ts: passage.ts ?? 0,
        messageId: passage.id,
        rank: -score,
        target: { sourceSessionId: passage.session_id, messageId: passage.uuid, role: passage.role, timestamp: passage.ts ?? 0, text: passage.text.slice(0, 256) },
      }] : []
    })
    // A session found by its name alone has no passage: the row shows its name.
    const [best = { snippet: '', ts: row.last_timestamp ?? 0, messageId: -1, rank: -score }, ...others] = hits
    results.push({ session: rowToSession(session), ...best, reason: name?.reason ?? { field: 'messages', text: '' }, additionalMatches: others })
  }
  return results
}
