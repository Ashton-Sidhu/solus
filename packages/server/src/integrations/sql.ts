import type { SQLInputValue } from 'node:sqlite'
import type { SQL } from 'drizzle-orm'
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core'
import type { ZodType } from 'zod'
import { getDb } from '../db'

/** One statement on the host tables of the MCP owners: MCP tasks, resource watches, and saved server facts. */

const dialect = new SQLiteSyncDialect()

function prepared(query: SQL) {
  const { sql: text, params } = dialect.sqlToQuery(query)
  // SAFETY: the stores' templates bind only strings, numbers, and null, which SQLite accepts.
  return { statement: getDb().prepare(text), params: params as SQLInputValue[] }
}

/** Runs one statement and answers how many rows it changed. */
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
