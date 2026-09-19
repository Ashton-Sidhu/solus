import { getDatabase } from '../db/database'
import { searchIndexFor } from '../db/search-index'
import { createLogger } from '../logger'
import type { WorkType } from '@solus/contracts/types'

const log = createLogger('folio', 'work-search.ts')

/** Content search over an organization's works, answered by the engine's
 *  search index (`db/search-index.ts`). */

export type { WorkType }

export interface WorkSearchHit {
  id: string
  title: string
  type: WorkType
  cwd: string
  updatedAt: string
  snippet: string
}

function workType(value: string | null | undefined): WorkType {
  return value === 'slides' || value === 'diagram' || value === 'artifact' ? value : 'doc'
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Relevance-ordered hits, capped at `limit`. A failed read is an empty answer, logged. */
export async function searchWorks(
  organizationId: string,
  query: string,
  opts: { type?: WorkType; limit: number },
): Promise<WorkSearchHit[]> {
  const db = getDatabase()
  try {
    const rows = await searchIndexFor(db.engine).searchWorks(db, {
      organizationId,
      query,
      type: opts.type,
      limit: opts.limit,
    })
    return rows.map((row) => ({
      id: row.id,
      title: row.title ?? '',
      type: workType(row.type),
      cwd: row.cwd ?? '~',
      updatedAt: new Date(row.updated_at).toISOString(),
      snippet: oneLine(row.snippet ?? ''),
    }))
  } catch (err: any) {
    log.error('work_search_failed', { error: err instanceof Error ? err.message : String(err) })
    return []
  }
}
