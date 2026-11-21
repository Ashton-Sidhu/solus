import type { SQLInputValue } from 'node:sqlite'
import type { SQL } from 'drizzle-orm'
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core'
import type { ZodType } from 'zod'
import { getDb } from '.'

/**
 * One `sql` template on a synchronous SQLite connection, so a host store's
 * scope or visibility condition renders through drizzle (`scopeClause`, `visibleTo`).
 */

const dialect = new SQLiteSyncDialect()

/** The template as SQLite text and the values its placeholders bind. */
export function sqliteQuery(query: SQL): { text: string; params: SQLInputValue[] } {
  const { sql: text, params } = dialect.sqlToQuery(query)
  // SAFETY: the stores' templates bind only strings, numbers, and null, which SQLite accepts.
  return { text, params: params as SQLInputValue[] }
}

function prepared(query: SQL) {
  const { text, params } = sqliteQuery(query)
  return { statement: getDb().prepare(text), params }
}

/** Runs one statement on the host connection and answers how many rows it changed. */
export function runSql(query: SQL): number {
  const { statement, params } = prepared(query)
  return Number(statement.run(...params).changes)
}

export function rows<T>(query: SQL, schema: ZodType<T>): T[] {
  const { statement, params } = prepared(query)
  return statement.all(...params).map((found) => schema.parse(found))
}

export function firstRow<T>(query: SQL, schema: ZodType<T>): T | null {
  const { statement, params } = prepared(query)
  const found = statement.get(...params)
  return found ? schema.parse(found) : null
}
