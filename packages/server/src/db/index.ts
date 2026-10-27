import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { searchText, searchableMessageText } from '@solus/contracts/session-search'
import { z } from 'zod'
import { solusDir } from '../platform/paths'
import { resolveEngine } from './engine'
import { runMigrations } from './migrations'
import { runSqliteSchemaMigrations } from './sqlite-migrations'
import { assertTestDatabase } from './test-safety'

/**
 * The host's SQLite file: the legacy hand-written tables and, on the SQLite
 * engine, the generated tables of every ported domain share this one
 * connection. Ported domains reach it through `getDatabase()` in
 * `./database`; unported ones still call `getDb()` and `withTx()` directly.
 */
let db: DatabaseSync | null = null
let transactionOpen = false

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

  const dataDir = solusDir()
  assertTestDatabase({ kind: 'sqlite', path: join(dataDir, 'solus.db') })
  mkdirSync(dataDir, { recursive: true })

  const openedDb = new DatabaseSync(join(dataDir, 'solus.db'))
  try {
    openedDb.exec('PRAGMA journal_mode = WAL')
    openedDb.exec('PRAGMA foreign_keys = ON')
    openedDb.exec('PRAGMA busy_timeout = 5000')
    openedDb.exec('PRAGMA synchronous = NORMAL')
    runMigrations(openedDb)
    // Rebuild only the derived index. Original messages and identities stay intact.
    if (!openedDb.prepare("SELECT 1 FROM kv WHERE key = 'session-search-normalized-v1'").get()) {
      openedDb.exec('BEGIN IMMEDIATE')
      try {
        openedDb.exec("DROP TABLE session_fts; CREATE VIRTUAL TABLE session_fts USING fts5(text, content='', contentless_delete=1, tokenize='unicode61')")
        const insert = openedDb.prepare('INSERT INTO session_fts(rowid, text) VALUES (?, ?)')
        let after = -1
        for (;;) {
          const rows = openedDb.prepare('SELECT id, text FROM session_messages WHERE id > ? ORDER BY id LIMIT 300').all(after)
          if (!rows.length) break
          for (const row of rows) { insert.run(Number(row.id), searchText(String(row.text ?? ''))); after = Number(row.id) }
        }
        openedDb.exec("INSERT INTO kv(key, value) VALUES ('session-search-normalized-v1', '1')")
        openedDb.exec('COMMIT')
      } catch (error) { openedDb.exec('ROLLBACK'); throw error }
    }
    // The generated tables live in this file only when it is the engine.
    if (resolveEngine().kind === 'sqlite') {
      runSqliteSchemaMigrations(openedDb)
      const messageSchema = z.object({ content: z.string().optional(), role: z.string().optional(), toolName: z.string().optional(), parentToolUseId: z.string().optional() }).nullable()
      for (;;) {
        const rows = openedDb.prepare("SELECT rowid, message FROM session_transcripts WHERE search_text = '' LIMIT 300").all()
        if (!rows.length) break
        openedDb.exec('BEGIN IMMEDIATE')
        try {
          for (const row of rows) openedDb.prepare('UPDATE session_transcripts SET search_text = ? WHERE rowid = ?').run(searchableMessageText(messageSchema.parse(JSON.parse(String(row.message)))) || ' ', Number(row.rowid))
          openedDb.exec('COMMIT')
        } catch (error) { openedDb.exec('ROLLBACK'); throw error }
      }
    }
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
