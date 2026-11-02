import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { solusDir } from '../platform/paths'
import { runSqliteSchemaMigrations } from './sqlite-migrations'
import { assertTestDatabase } from './test-safety'

/**
 * The host's SQLite file: the host tables (`./host-tables`) and, on the SQLite
 * engine, the generated tables of every ported domain share this one
 * connection. Ported domains reach it through `getDatabase()` in
 * `./database`; unported ones still call `getDb()` and `withTx()` directly.
 */
let db: DatabaseSync | null = null
let transactionOpen = false
/** Set by the host's shutdown. A late writer must fail, not reopen the file. */
let isClosedForShutdown = false

const STATEMENT_CACHE_SIZE = 500

/**
 * Compile each distinct statement once. Every store calls `getDb().prepare(sql)`
 * at the point of use, and SQLite would otherwise parse and plan the same text
 * on every call. A statement holds no state between runs here: nothing iterates
 * one lazily or changes its options, so one compiled statement serves every
 * caller. The oldest entry leaves first once the cache is full.
 */
export function cacheStatements(openedDb: DatabaseSync): void {
  const prepare = openedDb.prepare.bind(openedDb)
  const statements = new Map<string, StatementSync>()
  openedDb.prepare = (sql: string): StatementSync => {
    const cached = statements.get(sql)
    if (cached) return cached
    const statement = prepare(sql)
    if (statements.size >= STATEMENT_CACHE_SIZE) statements.delete(statements.keys().next().value!)
    statements.set(sql, statement)
    return statement
  }
}

export function getDb(): DatabaseSync {
  if (db) return db
  if (isClosedForShutdown) throw new Error('The database is closed because the host shut down')

  const dataDir = solusDir()
  assertTestDatabase({ kind: 'sqlite', path: join(dataDir, 'solus.db') })
  // The data folder holds the database, keys, and transcripts: this user's
  // alone. An older host made it with the default mode, so tighten it too.
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  chmodSync(dataDir, 0o700)

  const openedDb = new DatabaseSync(join(dataDir, 'solus.db'))
  try {
    chmodSync(join(dataDir, 'solus.db'), 0o600)
    openedDb.exec('PRAGMA journal_mode = WAL')
    openedDb.exec('PRAGMA foreign_keys = ON')
    openedDb.exec('PRAGMA busy_timeout = 5000')
    openedDb.exec('PRAGMA synchronous = NORMAL')
    // The whole SQLite baseline, host tables and records alike. On the Postgres
    // engine the record tables here stay empty: records are read through
    // `getDatabase()`, which points at Postgres.
    runSqliteSchemaMigrations(openedDb, 'sqlite', 'solus.db')
    // Without planner statistics SQLite guesses index selectivity. This is the
    // open-time form SQLite recommends for a long-lived connection: check
    // every table (0x10000), analyze one only when its statistics are absent
    // or far out of date (0x2), and bound the work (0x10).
    openedDb.exec('PRAGMA optimize = 0x10012')
    cacheStatements(openedDb)
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

/** Close the file for good: the host is shutting down, and nothing may reopen it. */
export function closeDbForShutdown(): void {
  isClosedForShutdown = true
  closeDb()
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
