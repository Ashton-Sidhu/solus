import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { solusDir } from '../platform/paths'
import { createMetricsViews } from './field-registry'
import { runMetricsMigrations } from './migrations'

let metricsDb: DatabaseSync | null = null
let readOnlyMetricsDb: DatabaseSync | null = null

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
    openedDb.exec('PRAGMA journal_mode = WAL')
    openedDb.exec('PRAGMA foreign_keys = ON')
    openedDb.exec('PRAGMA busy_timeout = 5000')
    openedDb.exec('PRAGMA synchronous = NORMAL')
    openedDb.exec('PRAGMA auto_vacuum = INCREMENTAL')
    runMetricsMigrations(openedDb)
    createMetricsViews(openedDb)
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
