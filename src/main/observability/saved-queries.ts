import type { MetricsQuerySpec, SavedMetricsQuery } from '../../shared/observability-types'
import { getDb } from '../db'

// Saved Insights queries live in solus.db (durable user config, exempt from
// metrics.db rollover). Each row records which form owns it — QuerySpec or SQL
// text — and never both.

interface SavedQueryRow {
  id: string
  name: string
  form: string
  spec: string | null
  sql: string | null
  created_at: number
  updated_at: number
}

function parseSpec(raw: string | null): MetricsQuerySpec | undefined {
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as MetricsQuerySpec
  } catch {
    return undefined
  }
}

function toSavedQuery(row: SavedQueryRow): SavedMetricsQuery {
  const form = row.form === 'sql' ? 'sql' : 'spec'
  return {
    id: row.id,
    name: row.name,
    form,
    ...(form === 'spec' ? { spec: parseSpec(row.spec) } : {}),
    ...(form === 'sql' && row.sql !== null ? { sql: row.sql } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function listSavedMetricsQueries(): SavedMetricsQuery[] {
  const rows = getDb().prepare(`
    SELECT id, name, form, spec, sql, created_at, updated_at
    FROM saved_metrics_queries
    ORDER BY updated_at DESC
  `).all() as unknown as SavedQueryRow[]
  return rows.map(toSavedQuery)
}

/** Insert or update; the original createdAt survives a re-save. */
export function saveMetricsQuery(query: SavedMetricsQuery): SavedMetricsQuery[] {
  if (!query.id.trim()) throw new Error('A saved query needs an id.')
  if (!query.name.trim()) throw new Error('A saved query needs a name.')
  if (query.form === 'spec' && !query.spec) throw new Error('A spec-form saved query needs a spec.')
  if (query.form === 'sql' && !query.sql?.trim()) throw new Error('A sql-form saved query needs SQL text.')

  const existing = getDb().prepare('SELECT created_at FROM saved_metrics_queries WHERE id = ?')
    .get(query.id) as { created_at: number } | undefined
  const now = Date.now()
  getDb().prepare(`
    INSERT OR REPLACE INTO saved_metrics_queries (id, name, form, spec, sql, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    query.id,
    query.name,
    query.form,
    query.form === 'spec' ? JSON.stringify(query.spec) : null,
    query.form === 'sql' ? query.sql ?? null : null,
    existing?.created_at ?? query.createdAt ?? now,
    now,
  )
  return listSavedMetricsQueries()
}

/** Idempotent, so two surfaces deleting the same query both succeed. */
export function deleteSavedMetricsQuery(id: string): SavedMetricsQuery[] {
  getDb().prepare('DELETE FROM saved_metrics_queries WHERE id = ?').run(id)
  return listSavedMetricsQueries()
}
