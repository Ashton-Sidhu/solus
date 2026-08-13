import type { MetricsQueryResult, MetricsSqlValidation, MetricsValue } from '../../shared/observability-types'
import { getReadOnlyMetricsDb } from './metrics-db'

// ─── Guarded read-only SQL executor ───
//
// User- and agent-authored SQL runs on the dedicated read-only metrics.db
// connection. On top of that connection this module enforces: exactly one
// statement, beginning with SELECT or WITH; no ATTACH or PRAGMA tokens; and an
// injected hard row cap. metrics.db holds telemetry only, which is what makes
// arbitrary read-only SQL a safe exposure.

/** Hard ceiling on rows returned to a client from one query. */
export const SQL_ROW_CAP = 10_000

const FORBIDDEN_TOKENS = new Set(['attach', 'pragma'])

interface SqlScan {
  error: string | null
  /** Index of the single trailing `;`, when present, to strip before wrapping. */
  terminatorIndex: number | null
}

function scanSql(sql: string): SqlScan {
  let firstToken: string | null = null
  let terminatorIndex: number | null = null
  let index = 0

  const contentAfterTerminator = (): SqlScan =>
    ({ error: 'Only one SQL statement is allowed.', terminatorIndex })

  while (index < sql.length) {
    const char = sql[index]

    if (char === '-' && sql[index + 1] === '-') {
      const end = sql.indexOf('\n', index)
      index = end === -1 ? sql.length : end + 1
      continue
    }
    if (char === '/' && sql[index + 1] === '*') {
      const end = sql.indexOf('*/', index + 2)
      if (end === -1) return { error: 'Unterminated block comment.', terminatorIndex }
      index = end + 2
      continue
    }
    if (/\s/.test(char)) {
      index++
      continue
    }
    if (terminatorIndex !== null) return contentAfterTerminator()

    if (char === "'" || char === '"' || char === '`') {
      let end = index + 1
      while (end < sql.length) {
        if (sql[end] === char) {
          if (sql[end + 1] === char) { end += 2; continue } // doubled-quote escape
          break
        }
        end++
      }
      if (end >= sql.length) return { error: 'Unterminated string literal.', terminatorIndex }
      index = end + 1
      continue
    }
    if (char === '[') {
      const end = sql.indexOf(']', index + 1)
      if (end === -1) return { error: 'Unterminated identifier.', terminatorIndex }
      index = end + 1
      continue
    }
    if (char === ';') {
      terminatorIndex = index
      index++
      continue
    }
    if (/[A-Za-z_]/.test(char)) {
      let end = index + 1
      while (end < sql.length && /[A-Za-z0-9_]/.test(sql[end])) end++
      const token = sql.slice(index, end).toLowerCase()
      if (firstToken === null) {
        firstToken = token
        if (token !== 'select' && token !== 'with') {
          return { error: 'Only SELECT and WITH statements are allowed.', terminatorIndex }
        }
      }
      if (FORBIDDEN_TOKENS.has(token)) {
        return { error: `${token.toUpperCase()} is not allowed.`, terminatorIndex }
      }
      index = end
      continue
    }
    index++
  }

  if (firstToken === null) return { error: 'Empty SQL statement.', terminatorIndex }
  return { error: null, terminatorIndex }
}

/** The guard violation for this SQL text, or null when it may run. */
export function sqlGuardError(sql: string): string | null {
  return scanSql(sql).error
}

interface PreparedColumns {
  columns?: () => Array<{ name?: string | null; column?: string | null }>
  columnNames?: string[]
}

function statementColumns(statement: PreparedColumns): string[] {
  if (typeof statement.columns === 'function') {
    return statement.columns().map((column) => column.name ?? column.column ?? '')
  }
  return statement.columnNames ?? []
}

/** What one SQLite cell can hold, before narrowing to the wire contract. */
type SqliteCell = string | number | bigint | boolean | Uint8Array | null
type SqliteRow = Record<string, SqliteCell>

function cellValue(value: SqliteCell): MetricsValue {
  if (value === null || typeof value === 'string' || typeof value === 'number') return value
  if (typeof value === 'boolean') return value
  return String(value)
}

function toResult(columns: string[], rows: SqliteRow[]): MetricsQueryResult {
  return {
    columns,
    rows: rows.map((row) => columns.map((column) => cellValue(row[column] ?? null))),
  }
}

/** Runs trusted, compiler-produced SQL on the read-only connection. */
export function runCompiledSql(sql: string, params: Array<string | number>): MetricsQueryResult {
  const statement = getReadOnlyMetricsDb().prepare(sql)
  const rows = statement.all(...params) as SqliteRow[]
  return toResult(statementColumns(statement), rows)
}

/** Runs user- or agent-authored SQL through the guard, with the row cap injected. */
export function runGuardedSql(sql: string, rowCap = SQL_ROW_CAP): MetricsQueryResult {
  const scan = scanSql(sql)
  if (scan.error) throw new Error(scan.error)
  const body = scan.terminatorIndex === null
    ? sql
    : `${sql.slice(0, scan.terminatorIndex)} ${sql.slice(scan.terminatorIndex + 1)}`
  return runCompiledSql(`SELECT * FROM (\n${body}\n) LIMIT ${rowCap}`, [])
}

function errorOffset(error: unknown): number | undefined {
  const candidate = (error as { sqliteErrorOffset?: unknown; offset?: unknown })
  if (typeof candidate.sqliteErrorOffset === 'number' && candidate.sqliteErrorOffset >= 0) {
    return candidate.sqliteErrorOffset
  }
  if (typeof candidate.offset === 'number' && candidate.offset >= 0) return candidate.offset
  return undefined
}

/** prepare()-only validation: guard violations, the SQLite error (with offset
 *  when the binding exposes it), or the result column names. Never executes. */
export function validateMetricsSql(sql: string): MetricsSqlValidation {
  const guardViolation = sqlGuardError(sql)
  if (guardViolation) return { ok: false, error: guardViolation, guardViolation: true }
  try {
    const statement = getReadOnlyMetricsDb().prepare(sql)
    return { ok: true, columns: statementColumns(statement) }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      offset: errorOffset(error),
    }
  }
}
