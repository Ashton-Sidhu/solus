import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { solusDir } from '../platform/paths'
import { resolveEngine } from './engine'
import { runMigrations } from './migrations'
import { runSqliteSchemaMigrations } from './sqlite-migrations'

/**
 * The host's SQLite file: the legacy hand-written tables and, on the SQLite
 * engine, the generated tables of every ported domain share this one
 * connection. Ported domains reach it through `getDatabase()` in
 * `./database`; unported ones still call `getDb()` and `withTx()` directly.
 */
let db: DatabaseSync | null = null
let transactionOpen = false

export function getDb(): DatabaseSync {
  if (db) return db

  const dataDir = solusDir()
  mkdirSync(dataDir, { recursive: true })

  const openedDb = new DatabaseSync(join(dataDir, 'solus.db'))
  try {
    openedDb.exec('PRAGMA journal_mode = WAL')
    openedDb.exec('PRAGMA foreign_keys = ON')
    openedDb.exec('PRAGMA busy_timeout = 5000')
    openedDb.exec('PRAGMA synchronous = NORMAL')
    runMigrations(openedDb)
    // The generated tables live in this file only when it is the engine.
    if (resolveEngine().kind === 'sqlite') runSqliteSchemaMigrations(openedDb)
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
  transactionOpen = false
  openedDb.close()
}

/**
 * One SQLite transaction on the shared connection. A call made while another
 * transaction is open — a nested `withTx`, or a synchronous write inside an
 * async `Db.transaction` — joins it: the connection can hold only one, and
 * the outer caller decides its fate.
 */
export function withTx<T>(fn: () => T): T {
  if (transactionOpen) return fn()
  const openedDb = getDb()
  openedDb.exec('BEGIN IMMEDIATE')
  transactionOpen = true
  try {
    const result = fn()
    openedDb.exec('COMMIT')
    return result
  } catch (error) {
    openedDb.exec('ROLLBACK')
    throw error
  } finally {
    transactionOpen = false
  }
}

let transactionQueue: Promise<unknown> = Promise.resolve()

/**
 * The async form `Db.transaction` uses on SQLite. Transactions are queued so
 * two async bodies never interleave their `BEGIN`s on the one connection;
 * a statement issued outside any transaction while one is open simply runs
 * inside it, as it always did on a single connection.
 */
export function withAsyncTx<T>(fn: () => Promise<T>): Promise<T> {
  const run = transactionQueue.then(async () => {
    if (transactionOpen) return fn()
    const openedDb = getDb()
    openedDb.exec('BEGIN IMMEDIATE')
    transactionOpen = true
    try {
      const result = await fn()
      openedDb.exec('COMMIT')
      return result
    } catch (error) {
      openedDb.exec('ROLLBACK')
      throw error
    } finally {
      transactionOpen = false
    }
  })
  transactionQueue = run.catch(() => undefined)
  return run
}
