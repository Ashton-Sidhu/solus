import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import type { RecordScope } from '../admission/principal'
import { scopeClause } from '../data/scope'
import type { WorkType } from '@solus/contracts/types'
import type { Db } from './database'
import { sanitizeFtsQuery } from './fts'
import { works } from '../data/works/schema'

/**
 * Full-text search over works, one implementation per engine
 * (docs/plans/cloud-service-model.md). The domain asks one question and reads
 * one row shape; how the index is kept is the engine's business:
 *
 * - SQLite: the `works_fts` FTS5 table, kept in step by triggers on `works`.
 *   `works_fts_rows` gives each work a stable integer rowid, so a trigger
 *   finds a work's FTS row by key instead of scanning the index.
 * - Postgres: a stored `tsvector` column on `works`, generated from the title
 *   (weight A) and content (weight B), under a GIN index.
 */

export interface WorkSearchQuery {
  scope: RecordScope
  query: string
  type?: WorkType
  limit: number
}

export const workSearchRowSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  type: z.string().nullable(),
  cwd: z.string().nullable(),
  updated_at: z.number(),
  snippet: z.string().nullable(),
})

export type WorkSearchRow = z.infer<typeof workSearchRowSchema>

/**
 * The sessions of the workspace service that match a query
 * (docs/plans/unified-search.md): every word in the session's name (its
 * custom or generated title) or branch,
 * or in any message the person or the agent wrote — not tool calls and their
 * output. One page at a time.
 */
export interface SessionMatchQuery {
  /** The query's words, as `queryWords` reads them. */
  words: string[]
  /** Match names and branches only; read no message. */
  namesOnly: boolean
  /** Which records the caller may read, over `session_records` (scope, visibility, filters). */
  records: SQL
  limit: number
  offset: number
}

/** One message to cut a passage from. */
export interface SessionMatchPassage {
  position: number
  timestamp: number | null
  content: string
}

/** One page of matching sessions, best first: for each, up to three messages
 *  to cut passages from, best first. A session that matched by its name alone has none. */
export interface SessionMatchPage {
  sessions: Array<{ sessionId: string; passages: SessionMatchPassage[] }>
  total: number
}

const sessionMatchRowSchema = z.object({ session_id: z.string(), total: z.coerce.number() })
const passageRowSchema = z.object({
  session_id: z.string(),
  position: z.coerce.number(),
  timestamp: z.coerce.number().nullable(),
  content: z.string().nullable(),
})
const PASSAGES_PER_SESSION = 3

export interface SearchIndex {
  /** Matching works, best match first; empty for a blank query. */
  searchWorks(db: Db, request: WorkSearchQuery): Promise<WorkSearchRow[]>
  /** The sessions that match, one page, best first; empty for no words. */
  searchSessions(db: Db, request: SessionMatchQuery): Promise<SessionMatchPage>
}

/** How one engine reads the mirrored transcripts and tests a word. */
interface WordTests {
  inMessage(word: string): SQL
  inName(word: string): SQL
  /** Only what the person and the agent wrote. */
  written: SQL
  /** A message's text and timestamp, from its JSON. */
  content: SQL
  timestamp: SQL
}

/**
 * The session match both engines share. Each word is found per session in one
 * grouped pass over the transcripts; a session is kept when each word is in a
 * message or in its name. A name that holds every word ranks first, then a
 * message that holds every word, then how many messages hold the words, then
 * recency. Passages are read for the page only: the newest messages with every
 * word, then the newest with any.
 */
async function matchSessions(db: Db, request: SessionMatchQuery, tests: WordTests): Promise<SessionMatchPage> {
  const { words } = request
  if (words.length === 0) return { sessions: [], total: 0 }
  const names = words.map((word) => tests.inName(word))
  let rows: z.infer<typeof sessionMatchRowSchema>[]
  if (request.namesOnly) {
    rows = sessionMatchRowSchema.array().parse(await db.all(sql`
      SELECT session_records.session_id, COUNT(*) OVER () AS total
      FROM session_records
      WHERE ${request.records} AND ${sql.join(names, sql` AND `)}
      ORDER BY session_records.last_activity_at DESC, session_records.session_id
      LIMIT ${request.limit} OFFSET ${request.offset}
    `))
    return { sessions: rows.map((row) => ({ sessionId: row.session_id, passages: [] })), total: rows[0]?.total ?? 0 }
  }
  const grouped = (match: SQL) => sql`
    SELECT t.session_id, t.organization_id, COUNT(*) AS c
    FROM session_transcripts t
    WHERE ${match} AND ${tests.written}
    GROUP BY t.session_id, t.organization_id`
  const joined = (name: string) => sql`LEFT JOIN ${sql.raw(name)} ON ${sql.raw(name)}.session_id = session_records.session_id AND ${sql.raw(name)}.organization_id = session_records.organization_id`
  const every = sql.join(words.map((word) => tests.inMessage(word)), sql` AND `)
  const ctes = words.map((word, index) => sql`${sql.raw(`w${index}`)} AS (${grouped(tests.inMessage(word))})`)
  const joins = words.map((_, index) => joined(`w${index}`))
  if (words.length > 1) {
    ctes.push(sql`together AS (${grouped(every)})`)
    joins.push(joined('together'))
  }
  const together = words.length > 1 ? sql`CASE WHEN together.session_id IS NULL THEN 0 ELSE 1 END DESC, ` : sql``
  const counts = sql.join(words.map((_, index) => sql`COALESCE(${sql.raw(`w${index}`)}.c, 0)`), sql` + `)
  const kept = words.map((_, index) => sql`(${sql.raw(`w${index}`)}.session_id IS NOT NULL OR ${names[index]!})`)
  rows = sessionMatchRowSchema.array().parse(await db.all(sql`
    WITH ${sql.join(ctes, sql`, `)}
    SELECT session_records.session_id, COUNT(*) OVER () AS total
    FROM session_records
    ${sql.join(joins, sql` `)}
    WHERE ${request.records} AND ${sql.join(kept, sql` AND `)}
    ORDER BY CASE WHEN ${sql.join(names, sql` AND `)} THEN 1 ELSE 0 END DESC, ${together}${counts} DESC,
      session_records.last_activity_at DESC, session_records.session_id
    LIMIT ${request.limit} OFFSET ${request.offset}
  `))
  if (!rows.length) return { sessions: [], total: 0 }
  const any = sql.join(words.map((word) => tests.inMessage(word)), sql` OR `)
  const passages = passageRowSchema.array().parse(await db.all(sql`
    SELECT best.session_id, best.position, best.sent_at AS timestamp, best.content FROM (
      SELECT t.session_id, t.position, ${tests.timestamp} AS sent_at, ${tests.content} AS content,
        ROW_NUMBER() OVER (PARTITION BY t.session_id ORDER BY CASE WHEN ${every} THEN 1 ELSE 0 END DESC, t.position DESC) AS n
      FROM session_transcripts t
      JOIN session_records ON session_records.session_id = t.session_id AND session_records.organization_id = t.organization_id
      WHERE t.session_id IN (${sql.join(rows.map((row) => sql`${row.session_id}`), sql`, `)})
        AND ${request.records} AND ${tests.written} AND (${any})
    ) best
    WHERE best.n <= ${PASSAGES_PER_SESSION}
    ORDER BY best.session_id, best.n
  `))
  const bySession = new Map<string, SessionMatchPassage[]>()
  for (const row of passages) {
    const held = bySession.get(row.session_id) ?? []
    held.push({ position: row.position, timestamp: row.timestamp, content: row.content ?? '' })
    bySession.set(row.session_id, held)
  }
  return {
    sessions: rows.map((row) => ({ sessionId: row.session_id, passages: bySession.get(row.session_id) ?? [] })),
    total: rows[0]!.total,
  }
}

/** A word's letters and digits, the only parts an engine's syntax cannot misread. */
function wordParts(word: string): string[] {
  return word.match(/[\p{L}\p{N}_]+/gu) ?? []
}

function typeFilter(type: WorkType | undefined): SQL {
  return type ? sql`AND works.type = ${type}` : sql``
}

const fts5SearchIndex: SearchIndex = {
  async searchWorks(db, request) {
    const ftsQuery = sanitizeFtsQuery(request.query)
    if (!ftsQuery) return []
    // Column -1 lets FTS5 pick the best-matching column for the snippet; the bm25
    // weights (title, content) rank a title hit above a body hit.
    return workSearchRowSchema.array().parse(await db.all(sql`
      SELECT
        works.id, works.title, works.type, works.cwd, works.updated_at,
        snippet(works_fts, -1, '', '', '…', 64) AS snippet,
        bm25(works_fts, 5.0, 1.0) AS rank
      FROM works_fts
      JOIN works_fts_rows ON works_fts_rows.rowid = works_fts.rowid
      JOIN ${works} ON works.id = works_fts_rows.work_id
      WHERE works_fts MATCH ${ftsQuery} AND works.location IS NULL
        AND ${scopeClause(request.scope, sql`works.organization_id`)}
        ${typeFilter(request.type)}
      ORDER BY rank ASC
      LIMIT ${request.limit}
    `))
  },
  // A SQLite workspace service is a small one (a lab, a single machine): the
  // mirrored text is scanned, and a word matches anywhere in it.
  async searchSessions(db, request) {
    const content = sql`COALESCE(json_extract(t.message, '$.content'), '')`
    const name = sql`LOWER(COALESCE(session_records.custom_title, '') || ' ' || COALESCE(session_records.branch, ''))`
    const like = (word: string) => `%${word.replace(/[\\%_]/g, (character) => `\\${character}`)}%`
    return matchSessions(db, request, {
      inMessage: (word) => sql`LOWER(${content}) LIKE ${like(word)} ESCAPE '\\'`,
      inName: (word) => sql`${name} LIKE ${like(word)} ESCAPE '\\'`,
      written: sql`json_extract(t.message, '$.role') IN ('user', 'assistant') AND json_extract(t.message, '$.toolName') IS NULL`,
      content,
      timestamp: sql`CAST(json_extract(t.message, '$.timestamp') AS INTEGER)`,
    })
  },
}

const tsvectorSearchIndex: SearchIndex = {
  async searchWorks(db, request) {
    const query = request.query.trim()
    if (!query) return []
    // `websearch_to_tsquery` takes free text as a person typed it; nothing in
    // it is a syntax error. The headline is cut from the body with no markup,
    // matching the FTS5 snippet the domain formats the same way.
    return workSearchRowSchema.array().parse(await db.all(sql`
      SELECT
        works.id, works.title, works.type, works.cwd, works.updated_at,
        ts_headline('english', COALESCE(works.content, ''), query, 'StartSel=,StopSel=,MaxWords=64,MinWords=24') AS snippet
      FROM ${works}, websearch_to_tsquery('english', ${query}) AS query
      WHERE works.search @@ query AND works.location IS NULL
        AND ${scopeClause(request.scope, sql`works.organization_id`)}
        ${typeFilter(request.type)}
      ORDER BY ts_rank(works.search, query) DESC, works.updated_at DESC
      LIMIT ${request.limit}
    `))
  },
  // Each word is a prefix of a stemmed English word, as the stored `search`
  // column was built. A name matches where the word starts one of its words.
  async searchSessions(db, request) {
    const tsquery = (word: string) => sql`to_tsquery('english', ${wordParts(word).map((part) => `${part}:*`).join(' <-> ')})`
    const name = sql`(' ' || regexp_replace(LOWER(COALESCE(session_records.custom_title, '') || ' ' || COALESCE(session_records.branch, '')), '[^[:alnum:]]+', ' ', 'g'))`
    return matchSessions(db, {
      ...request,
      words: request.words.filter((word) => wordParts(word).length),
    }, {
      inMessage: (word) => sql`t.search @@ ${tsquery(word)}`,
      inName: (word) => sql`${name} LIKE ${`% ${wordParts(word).join(' ').replace(/[\\%_]/g, (character) => `\\${character}`)}%`}`,
      written: sql`t.message::jsonb->>'role' IN ('user', 'assistant') AND t.message::jsonb->>'toolName' IS NULL`,
      content: sql`COALESCE(t.message::jsonb->>'content', '')`,
      timestamp: sql`CAST(t.message::jsonb->>'timestamp' AS BIGINT)`,
    })
  },
}

export function searchIndexFor(engine: Db['engine']): SearchIndex {
  return engine === 'postgres' ? tsvectorSearchIndex : fts5SearchIndex
}
