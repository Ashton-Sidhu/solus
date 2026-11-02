import type { MetricsQuerySpec, SavedMetricsQuery } from '@solus/contracts/observability-types'
import { getDb } from '../../db'

// Saved Insights queries live in solus.db (durable user config, exempt from
// metrics.db rollover). Each row records which form owns it — QuerySpec or SQL
// text — and never both, and the person who saved it, `createdBy` (their user
// key, as `ownerKeyOf` answers it). A person lists, re-saves, and deletes their
// own queries only (plans/029 P8).

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
    // SAFETY: `spec` is written only by `saveMetricsQuery`, which stores a
    // `MetricsQuerySpec`; an unparseable column falls back below.
    return JSON.parse(raw) as MetricsQuerySpec
  } catch {
    return undefined
  }
}

function toSavedQuery(row: SavedQueryRow): SavedMetricsQuery {
  const form = row.form === 'sql' ? 'sql' : 'spec'
  const query: SavedMetricsQuery = {
    id: row.id,
    name: row.name,
    form,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
  if (form === 'spec') query.spec = parseSpec(row.spec)
  if (form === 'sql' && row.sql !== null) query.sql = row.sql
  return query
}

/** The queries `createdBy` saved, newest change first. */
export function listSavedMetricsQueries(createdBy: string): SavedMetricsQuery[] {
  const rawRows: unknown = getDb().prepare(`
    SELECT id, name, form, spec, sql, created_at, updated_at
    FROM saved_metrics_queries
    WHERE created_by = ?
    ORDER BY updated_at DESC
  `).all(createdBy)
  // SAFETY: the SELECT names exactly the columns `SavedQueryRow` declares.
  const rows = rawRows as SavedQueryRow[]
  return rows.map(toSavedQuery)
}

/** Insert or update; the original createdAt survives a re-save. A query id
 *  another person saved is theirs: a save under it is refused, not taken over. */
export function saveMetricsQuery(createdBy: string, query: SavedMetricsQuery): SavedMetricsQuery[] {
  if (!query.id.trim()) throw new Error('A saved query needs an id.')
  if (!query.name.trim()) throw new Error('A saved query needs a name.')
  if (query.form === 'spec' && !query.spec) throw new Error('A spec-form saved query needs a spec.')
  if (query.form === 'sql' && !query.sql?.trim()) throw new Error('A sql-form saved query needs SQL text.')

  const rawExisting: unknown = getDb()
    .prepare('SELECT created_by FROM saved_metrics_queries WHERE id = ?')
    .get(query.id)
  // SAFETY: the SELECT names one column, so a matched row carries only `created_by`.
  const existing = rawExisting as { created_by: string } | undefined
  if (existing && existing.created_by !== createdBy) throw new Error('This saved query belongs to someone else.')
  const now = Date.now()
  getDb().prepare(`
    INSERT INTO saved_metrics_queries (id, created_by, name, form, spec, sql, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET
      name = excluded.name, form = excluded.form, spec = excluded.spec, sql = excluded.sql,
      updated_at = excluded.updated_at
  `).run(
    query.id,
    createdBy,
    query.name,
    query.form,
    query.form === 'spec' ? JSON.stringify(query.spec) : null,
    query.form === 'sql' ? query.sql ?? null : null,
    query.createdAt ?? now,
    now,
  )
  return listSavedMetricsQueries(createdBy)
}

/** Idempotent, so two surfaces deleting the same query both succeed. */
export function deleteSavedMetricsQuery(createdBy: string, id: string): SavedMetricsQuery[] {
  getDb().prepare('DELETE FROM saved_metrics_queries WHERE created_by = ? AND id = ?').run(createdBy, id)
  return listSavedMetricsQueries(createdBy)
}
