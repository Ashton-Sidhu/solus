import { z } from 'zod'
import { SNIPPET_HIT_CLOSE, SNIPPET_HIT_OPEN } from '@solus/contracts/search-snippet'
import type { SessionSearchResult } from '@solus/contracts/types'
import { markedPassage, queryWords, wordStartIndex } from '@solus/contracts/word-match'
import { rowToSession, SESSION_ROW_SPAN, sessionRowSchema } from './session-indexer'
import { getDb } from '.'
import { sessionIdOfThread } from '../data/sessions/session-lineage'

/** How a session search is narrowed and paged. */
export interface SessionSearchOptions {
  providers?: string[]
  /** Only messages by one side of the conversation (the agent tool's filter). */
  role?: 'user' | 'assistant'
  /** Inclusive bounds on a message's timestamp (ms), for the agent tool. */
  sinceTs?: number
  untilTs?: number
  /** Omit to search every project; set to scope to one git-root and all its worktrees. */
  projectRoot?: string
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
const passageRowSchema = z.object({ id: z.number(), ts: z.number().nullable(), text: z.string() })

/** A session's hits for one query word: how many of its messages hold it,
 *  and the ids of the newest few, newest first. */
interface WordHits {
  count: number
  newest: number[]
}
const PASSAGES_PER_SESSION = 3

/** A name hit outweighs any count of passages. A message that holds every
 *  word adds half the words' weight, and one that holds them as the phrase
 *  typed adds as much again. */
const NAME_BONUS = 100
const NAME_WORD_TF = 2
const TF_SATURATION = 1.2
const TOGETHER_BONUS = 0.5
const PHRASE_BONUS = 1
const MAX_PAGE = 50

/** Words as one FTS5 phrase of their tokens, the last a prefix. */
function phraseTerm(words: readonly string[]): string {
  return `"${words.join(' ').replaceAll('"', '""')}"*`
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
 * one pass over its postings and no join. A name hit ranks first; then a
 * session's score sums each word's weight (rarer words weigh more) times a
 * saturating count of its messages that hold it, with a bonus when one message
 * holds every word; then recency. The passage is the newest message that holds
 * every word, else the newest that holds the rarest.
 */
export function searchSessionIndex(query: string, options: SessionSearchOptions = {}): SessionSearchPage {
  const words = queryWords(query)
  if (!words.length) return { results: [], total: 0 }
  const limit = Math.min(MAX_PAGE, Math.max(1, Math.trunc(options.limit ?? MAX_PAGE)))
  const offset = Math.max(0, Math.trunc(options.offset ?? 0))
  const db = getDb()
  const sessions = sessionsInScope(db, options)
  const hits = queryHits(db, words, options, sessions.length)
  // A session that changed provider has a row per thread; it is one hit, its best thread's.
  const bySession = new Map<string, MatchedSession>()
  for (const row of sessions) {
    const sessionId = sessionIdOfThread(row.session_id)
    const score = sessionScore(row, words, hits, options.metadata?.get(sessionId))
    const held = bySession.get(sessionId)
    if (score !== null && (!held || score > held.score)) bySession.set(sessionId, { row, score })
  }
  const matched = [...bySession.values()]
  matched.sort((a, b) => b.score - a.score || (b.row.last_timestamp ?? 0) - (a.row.last_timestamp ?? 0) || a.row.session_id.localeCompare(b.row.session_id))
  const page = matched.slice(offset, offset + limit).map((session) => ({ ...session, passageIds: passageIdsOf(session.row.number, hits) }))
  return { results: pageResults(db, page, words), total: matched.length }
}

/** The sessions the scope and filters keep, with what they are called. */
function sessionsInScope(db: ReturnType<typeof getDb>, options: SessionSearchOptions): z.infer<typeof nameRowSchema>[] {
  const scope: string[] = []
  const params: Array<string | number> = []
  if (options.projectRoot) { scope.push('s.project_root = ?'); params.push(options.projectRoot) }
  const providers = options.providers?.map((provider) => provider === 'claude-code' ? 'claude' : provider)
  if (providers?.length) { scope.push(`s.provider IN (${providers.map(() => '?').join(', ')})`); params.push(...providers) }
  if (options.activeSince !== undefined) { scope.push('s.last_timestamp >= ?'); params.push(options.activeSince) }
  return nameRowSchema.array().parse(db.prepare(`
    SELECT s.session_id, k.number, s.custom_title, s.branch, s.last_timestamp
    FROM sessions s LEFT JOIN session_keys k ON k.session_id = s.session_id
    ${scope.length ? `WHERE ${scope.join(' AND ')}` : ''}
  `).all(...params))
}

/** Where a query's words are in the messages: each word's hits and weight
 *  (rarer words weigh more), and the messages that hold every word, and the phrase. */
interface QueryHits {
  perWord: Map<number, WordHits>[]
  weights: number[]
  allWeight: number
  together: Map<number, WordHits> | null
  phrase: Map<number, WordHits> | null
}

function queryHits(db: ReturnType<typeof getDb>, words: readonly string[], options: SessionSearchOptions, sessionCount: number): QueryHits {
  if (options.namesOnly) return { perWord: [], weights: [], allWeight: 0, together: null, phrase: null }
  const perWord = words.map((word) => messageHits(db, phraseTerm([word]), options))
  const several = words.length > 1
  const weights = perWord.map((hits) => Math.log(1 + (sessionCount - hits.size + 0.5) / (hits.size + 0.5)))
  return {
    perWord,
    weights,
    allWeight: weights.reduce((sum, weight) => sum + weight, 0),
    together: several ? messageHits(db, words.map((word) => phraseTerm([word])).join(' '), options) : null,
    phrase: several ? messageHits(db, phraseTerm(words), options) : null,
  }
}

/** What a session is called, lower-cased: its title, its branch and its pull
 *  requests. Its opening message stands in for a title on screen, but it is
 *  what was said, and a message hit finds it. */
function nameText(row: z.infer<typeof nameRowSchema>, metadata: string | undefined): string {
  return [row.custom_title, row.branch, metadata].filter(Boolean).join('\n').toLocaleLowerCase()
}

/** The lift of a message that holds every word, and more of one that holds the phrase. */
function togetherBonus(number: number, hits: QueryHits): number {
  return ((hits.together?.has(number) ? TOGETHER_BONUS : 0) + (hits.phrase?.has(number) ? PHRASE_BONUS : 0)) * hits.allWeight
}

/** A session's score, or null when a word is in neither its name nor its messages. */
function sessionScore(row: z.infer<typeof nameRowSchema>, words: readonly string[], hits: QueryHits, metadata: string | undefined): number | null {
  const number = row.number
  const name = nameText(row, metadata)
  let score = 0
  let inEveryName = true
  for (let index = 0; index < words.length; index++) {
    const inName = wordStartIndex(name, words[index]!) >= 0
    const count = number === null ? 0 : hits.perWord[index]?.get(number)?.count ?? 0
    if (!inName && !count) return null
    inEveryName &&= inName
    const tf = count + (inName ? NAME_WORD_TF : 0)
    score += (hits.weights[index] ?? 0) * tf / (tf + TF_SATURATION)
  }
  return score + (inEveryName ? NAME_BONUS : 0) + (number === null ? 0 : togetherBonus(number, hits))
}

/** A session that matched, and its score. */
interface MatchedSession {
  row: z.infer<typeof nameRowSchema>
  score: number
}

/** The messages a session's row shows, best first: the newest with the phrase,
 *  then with every word, then each word's newest, rarest word first. */
function passageIdsOf(number: number | null, hits: QueryHits): number[] {
  if (number === null) return []
  const byRarity = hits.perWord
    .map((wordHits, index) => ({ newest: wordHits.get(number)?.newest ?? [], weight: hits.weights[index]! }))
    .sort((a, b) => b.weight - a.weight)
  return [...new Set([
    ...hits.phrase?.get(number)?.newest ?? [],
    ...hits.together?.get(number)?.newest ?? [],
    ...byRarity.flatMap(({ newest }) => newest),
  ])].slice(0, PASSAGES_PER_SESSION)
}

/** The page as results: each session's row, and its passages cut and marked. */
function pageResults(
  db: ReturnType<typeof getDb>,
  page: ReadonlyArray<MatchedSession & { passageIds: number[] }>,
  words: readonly string[],
): SessionSearchResult[] {
  if (!page.length) return []
  const sessionIds = page.map(({ row }) => row.session_id)
  const rows = new Map(sessionRowSchema.array().parse(db.prepare(`
    SELECT
      session_id, provider, cwd, project_path, is_worktree, slug, first_message, custom_title,
      last_timestamp, size, model, reasoning_effort, project_root, branch, parent_session_id, root_session_id,
      delegation_exchange_id, delegation_depth, delegation_intent, delegation_created_at
    FROM sessions
    WHERE session_id IN (${sessionIds.map(() => '?').join(', ')})
  `).all(...sessionIds)).map((row) => [row.session_id, row]))
  const passageIds = page.flatMap(({ passageIds }) => passageIds)
  const passages = new Map(passageIds.length
    ? passageRowSchema.array().parse(db.prepare(`
        SELECT id, ts, text FROM session_messages WHERE id IN (${passageIds.map(() => '?').join(', ')})
      `).all(...passageIds)).map((row) => [row.id, row])
    : [])
  const results: SessionSearchResult[] = []
  for (const { row, score, passageIds } of page) {
    const session = rows.get(row.session_id)
    if (!session) continue
    const hits = passageIds.flatMap((id) => {
      const passage = passages.get(id)
      return passage ? [{
        snippet: markedPassage(passage.text, words, SNIPPET_HIT_OPEN, SNIPPET_HIT_CLOSE),
        ts: passage.ts ?? 0,
        messageId: passage.id,
        rank: -score,
      }] : []
    })
    // A session found by its name alone has no passage: the row shows its name.
    const [best = { snippet: '', ts: row.last_timestamp ?? 0, messageId: -1, rank: -score }, ...others] = hits
    results.push({ session: rowToSession(session), ...best, additionalMatches: others })
  }
  return results
}
