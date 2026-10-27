import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import type { RecordScope } from '../admission/principal'
import { scopeClause } from '../data/scope'
import type { WorkType } from '@solus/contracts/types'
import type { Db } from './database'
import { sanitizeFtsQuery } from './fts'
import { works } from '../data/works/schema'
import { searchMirroredSessions } from './mirrored-session-search'
import type { SessionSearchReason, SessionSearchTarget } from '@solus/contracts/session-search'

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
  metadata?: ReadonlyMap<string, string>
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
  target: SessionSearchTarget
}

/** One page of matching sessions, best first: for each, up to three messages
 *  to cut passages from, best first. A session that matched by its name alone has none. */
export interface SessionMatchPage {
  sessions: Array<{ sessionId: string; rank: number; reason: SessionSearchReason; passages: SessionMatchPassage[] }>
  total: number
}

export interface SearchIndex {
  searchWorks(db: Db, request: WorkSearchQuery): Promise<WorkSearchRow[]>
  searchSessions(db: Db, request: SessionMatchQuery): Promise<SessionMatchPage>
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
  searchSessions: searchMirroredSessions,
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
  searchSessions: searchMirroredSessions,
}

export function searchIndexFor(engine: Db['engine']): SearchIndex {
  return engine === 'postgres' ? tsvectorSearchIndex : fts5SearchIndex
}
