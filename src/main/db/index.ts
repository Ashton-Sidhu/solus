import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { runMigrations } from './migrations'

let db: DatabaseSync | null = null

export function getDb(): DatabaseSync {
  if (db) return db

  const dataDir = process.env.SOLUS_DATA_DIR || join(homedir(), '.solus')
  mkdirSync(dataDir, { recursive: true })

  const openedDb = new DatabaseSync(join(dataDir, 'solus.db'))
  try {
    openedDb.exec('PRAGMA journal_mode = WAL')
    openedDb.exec('PRAGMA foreign_keys = ON')
    openedDb.exec('PRAGMA busy_timeout = 5000')
    openedDb.exec('PRAGMA synchronous = NORMAL')
    runMigrations(openedDb)
  } catch (error) {
    openedDb.close()
    throw error
  }

  db = openedDb
  return db
}

export function closeDb(): void {
  if (!db) return
  const openedDb = db
  db = null
  openedDb.close()
}

export function withTx<T>(fn: () => T): T {
  const openedDb = getDb()
  openedDb.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    openedDb.exec('COMMIT')
    return result
  } catch (error) {
    openedDb.exec('ROLLBACK')
    throw error
  }
}
