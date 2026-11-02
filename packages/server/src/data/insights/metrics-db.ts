import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { solusDir } from '../../platform/paths'
import { cacheStatements } from '../../db'
import { runSqliteSchemaMigrations } from '../../db/sqlite-migrations'
import { createMetricsViews } from './field-registry'
import { storeTurnMeasures } from './turn-measures'

let metricsDb: DatabaseSync | null = null
let readOnlyMetricsDb: DatabaseSync | null = null
let abandonedTurnsClosed = false

/**
 * Closes turn rows a previous run of this host left open, and answers how many.
 * A turn's row is open only while the process that started it runs, so before
 * this process writes its first span every open row belongs to a turn the host
 * stopped under. Left open, Insights would list it as running for ever. It ends
 * where its last recorded child ended, is marked interrupted, and gets its
 * measures as a turn that ended normally does.
 */
export function closeAbandonedTurns(db: DatabaseSync): number {
  const lastChildEnd = `MAX(started_at, COALESCE((
    SELECT MAX(child.ended_at) FROM spans AS child
    WHERE child.trace_id = spans.trace_id AND child.span_id != spans.span_id
  ), started_at))`
  const rawRows: unknown = db.prepare(`
    UPDATE spans SET
      status = 'interrupted',
      ended_at = ${lastChildEnd},
      duration_ms = ${lastChildEnd} - started_at
    WHERE kind = 'turn' AND ended_at IS NULL
    RETURNING trace_id
  `).all()
  // SAFETY: RETURNING names the one column.
  const closed = rawRows as Array<{ trace_id: string }>
  for (const { trace_id } of closed) storeTurnMeasures(db, trace_id)
  return closed.length
}

export function metricsDbPath(): string {
  return join(solusDir(), 'metrics.db')
}

/** node:sqlite spells the read-only open flag `readOnly`; bun:sqlite, which
 *  stands in for it under unit tests, reads `readonly` and rejects the other. */
interface ReadOnlyOpenOptions {
  readOnly?: true
  readonly?: true
}

function openReadOnly(path: string): DatabaseSync {
  try {
    return new DatabaseSync(path, { readOnly: true })
  } catch (error) {
    // bun:sqlite (standing in for node:sqlite under unit tests) spells the
    // open flag `readonly` and rejects the node spelling.
    if (error instanceof TypeError) {
      const openOptions: ReadOnlyOpenOptions = {}
      openOptions.readonly = true
      return new DatabaseSync(path, openOptions)
    }
    throw error
  }
}

export function getMetricsDb(): DatabaseSync {
  if (metricsDb) return metricsDb

  mkdirSync(solusDir(), { recursive: true })

  const openedDb = new DatabaseSync(metricsDbPath())
  try {
    // First: auto_vacuum takes effect only before the file's first page is
    // written, and switching to WAL writes it.
    openedDb.exec('PRAGMA auto_vacuum = INCREMENTAL')
    openedDb.exec('PRAGMA journal_mode = WAL')
    openedDb.exec('PRAGMA foreign_keys = ON')
    openedDb.exec('PRAGMA busy_timeout = 5000')
    openedDb.exec('PRAGMA synchronous = NORMAL')
    runSqliteSchemaMigrations(openedDb, 'metrics', 'metrics.db')
    createMetricsViews(openedDb)
    // Once per process: a reopen later in the same process would find this
    // process's own running turns open, and they are not abandoned.
    if (!abandonedTurnsClosed) {
      abandonedTurnsClosed = true
      closeAbandonedTurns(openedDb)
    }
    cacheStatements(openedDb)
  } catch (error) {
    openedDb.close()
    throw error
  }

  metricsDb = openedDb
  return metricsDb
}

/**
 * Dedicated read-only connection for user- and agent-authored SQL. `query_only`
 * makes the read-only promise hold at the connection level even where the open
 * flag is not honored; the short busy timeout bounds lock waits from the write
 * connection.
 */
export function getReadOnlyMetricsDb(): DatabaseSync {
  if (readOnlyMetricsDb) return readOnlyMetricsDb

  getMetricsDb() // the file, schema, and views must exist before a read-only open

  const openedDb = openReadOnly(metricsDbPath())
  try {
    openedDb.exec('PRAGMA query_only = 1')
    openedDb.exec('PRAGMA busy_timeout = 2000')
  } catch (error) {
    openedDb.close()
    throw error
  }

  readOnlyMetricsDb = openedDb
  return readOnlyMetricsDb
}

export function closeMetricsDb(): void {
  if (readOnlyMetricsDb) {
    const openedDb = readOnlyMetricsDb
    readOnlyMetricsDb = null
    openedDb.close()
  }
  if (!metricsDb) return
  const openedDb = metricsDb
  metricsDb = null
  openedDb.close()
}
