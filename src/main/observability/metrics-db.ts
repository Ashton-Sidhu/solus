import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { solusDir } from '../platform/paths'
import { runMetricsMigrations } from './migrations'

let metricsDb: DatabaseSync | null = null

export function getMetricsDb(): DatabaseSync {
  if (metricsDb) return metricsDb

  const dataDir = solusDir()
  mkdirSync(dataDir, { recursive: true })

  const openedDb = new DatabaseSync(join(dataDir, 'metrics.db'))
  try {
    openedDb.exec('PRAGMA journal_mode = WAL')
    openedDb.exec('PRAGMA foreign_keys = ON')
    openedDb.exec('PRAGMA busy_timeout = 5000')
    openedDb.exec('PRAGMA synchronous = NORMAL')
    openedDb.exec('PRAGMA auto_vacuum = INCREMENTAL')
    runMetricsMigrations(openedDb)
  } catch (error) {
    openedDb.close()
    throw error
  }

  metricsDb = openedDb
  return metricsDb
}

export function closeMetricsDb(): void {
  if (!metricsDb) return
  const openedDb = metricsDb
  metricsDb = null
  openedDb.close()
}
