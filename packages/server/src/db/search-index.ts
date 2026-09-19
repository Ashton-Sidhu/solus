import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import type { WorkType } from '@solus/contracts/types'
import type { Db } from './database'
import { sanitizeFtsQuery } from './fts'
import { works } from '../folio/schema'

/**
 * Full-text search over works, one implementation per engine
 * (docs/plans/cloud-service-model.md). The domain asks one question and reads
 * one row shape; how the index is kept is the engine's business:
 *
 * - SQLite: the `works_fts` FTS5 table, keyed by `work_id` and kept in step by
 *   triggers on `works` (both created by the `works_search` migration).
 * - Postgres: a stored `tsvector` column on `works`, generated from the title
 *   (weight A) and content (weight B), under a GIN index.
 */

export interface WorkSearchQuery {
  organizationId: string
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

export interface SearchIndex {
  /** Matching works, best match first; empty for a blank query. */
  searchWorks(db: Db, request: WorkSearchQuery): Promise<WorkSearchRow[]>
}

function typeFilter(type: WorkType | undefined): SQL {
  return type ? sql`AND works.type = ${type}` : sql``
}

const fts5SearchIndex: SearchIndex = {
  async searchWorks(db, request) {
    const ftsQuery = sanitizeFtsQuery(request.query)
    if (!ftsQuery) return []
    // Column -1 lets FTS5 pick the best-matching column for the snippet; the bm25
    // weights (work_id, title, content) rank a title hit above a body hit.
    return workSearchRowSchema.array().parse(await db.all(sql`
      SELECT
        works.id, works.title, works.type, works.cwd, works.updated_at,
        snippet(works_fts, -1, '', '', '…', 64) AS snippet,
        bm25(works_fts, 0.0, 5.0, 1.0) AS rank
      FROM works_fts
      JOIN ${works} ON works.id = works_fts.work_id
      WHERE works_fts MATCH ${ftsQuery}
        AND works.organization_id = ${request.organizationId}
        ${typeFilter(request.type)}
      ORDER BY rank ASC
      LIMIT ${request.limit}
    `))
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
      WHERE works.search @@ query
        AND works.organization_id = ${request.organizationId}
        ${typeFilter(request.type)}
      ORDER BY ts_rank(works.search, query) DESC, works.updated_at DESC
      LIMIT ${request.limit}
    `))
  },
}

export function searchIndexFor(engine: Db['engine']): SearchIndex {
  return engine === 'postgres' ? tsvectorSearchIndex : fts5SearchIndex
}
