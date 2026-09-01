import type { MetricsQueryResult, MetricsResultColumn, MetricsSqlValidation, MetricsValue } from '@solus/contracts/observability-types'
import { declaredColumnType, registeredViewNames } from './field-registry'
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
  /** Bare identifiers that immediately follow FROM or JOIN — the statement's
   *  table references, CTE names included. */
  tables: string[]
}

function scanSql(sql: string): SqlScan {
  let firstToken: string | null = null
  let terminatorIndex: number | null = null
  const tables: string[] = []
  let captureTable = false
  let index = 0

  const failed = (error: string): SqlScan => ({ error, terminatorIndex, tables })
  const contentAfterTerminator = (): SqlScan => failed('Only one SQL statement is allowed.')

  while (index < sql.length) {
    const char = sql[index]

    if (char === '-' && sql[index + 1] === '-') {
      const end = sql.indexOf('\n', index)
      index = end === -1 ? sql.length : end + 1
      continue
    }
    if (char === '/' && sql[index + 1] === '*') {
      const end = sql.indexOf('*/', index + 2)
      if (end === -1) return failed('Unterminated block comment.')
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
      if (end >= sql.length) return failed('Unterminated string literal.')
      captureTable = false
      index = end + 1
      continue
    }
    if (char === '[') {
      const end = sql.indexOf(']', index + 1)
      if (end === -1) return failed('Unterminated identifier.')
      captureTable = false
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
          return failed('Only SELECT and WITH statements are allowed.')
        }
      }
      if (FORBIDDEN_TOKENS.has(token)) {
        return failed(`${token.toUpperCase()} is not allowed.`)
      }
      if (captureTable) tables.push(token)
      captureTable = token === 'from' || token === 'join'
      index = end
      continue
    }
    // Any punctuation — `(` opening a subquery, a `.` qualifier — means the
    // next identifier is not a plain table reference.
    captureTable = false
    index++
  }

  if (firstToken === null) return failed('Empty SQL statement.')
  return { error: null, terminatorIndex, tables }
}

/** The guard violation for this SQL text, or null when it may run. */
export function sqlGuardError(sql: string): string | null {
  return scanSql(sql).error
}

/**
 * The declared grain of one guarded statement: the registered view it reads,
 * when that is unambiguous. A statement whose FROM/JOIN references resolve to
 * anything other than exactly one registered view — two views, raw `spans`, a
 * CTE name — declares nothing, and the client falls back to a plain rendering.
 */
export function declaredSourceView(sql: string): string | undefined {
  const scan = scanSql(sql)
  if (scan.error) return undefined
  const referenced = new Set(scan.tables)
  if (referenced.size !== 1) return undefined
  const [table] = referenced
  return registeredViewNames().has(table) ? table : undefined
}

interface PreparedColumns {
  columns?: () => Array<{ name?: string | null; column?: string | null }>
  columnNames?: string[]
}

/** `columns()` is a native method with a receiver check: node:sqlite throws
 *  `Illegal invocation` when it is detached from its statement, which fails
 *  every query the page asks. bun:sqlite — the unit-test stand-in — exposes no
 *  `columns` at all and answers from `columnNames` instead. */
function statementColumns(statement: PreparedColumns): string[] {
  const declared = statement.columns?.().map((column) => column.name ?? column.column ?? '')
  return declared ?? statement.columnNames ?? []
}

/** What one SQLite cell can hold, before narrowing to the wire contract. */
type SqliteCell = string | number | bigint | boolean | Uint8Array | null
type SqliteRow = Record<string, SqliteCell>

/** A `bigint` exceeds the wire contract and a blob is not a value the grid can
 *  read, so both print as text; every other cell crosses unchanged. */
function cellValue(value: SqliteCell): MetricsValue {
  if (value === null || value === true || value === false) return value
  const tag = Object.prototype.toString.call(value)
  if (tag !== '[object String]' && tag !== '[object Number]') return String(value)
  // SAFETY: the tag check above accepted only strings and numbers, both of which
  // `MetricsValue` carries unchanged.
  return value as MetricsValue
}

/** Result columns, carrying the registry's declared type for every column the
 *  source view declares. A column the query aliased or computed has no
 *  declaration and is reported untyped. */
function toResult(names: string[], rows: SqliteRow[], sourceView: string | undefined): MetricsQueryResult {
  const columns: MetricsResultColumn[] = names.map((name) => {
    const type = declaredColumnType(sourceView, name)
    return type === undefined ? { name } : { name, type }
  })
  const result: MetricsQueryResult = {
    columns,
    rows: rows.map((row) => names.map((name) => cellValue(row[name] ?? null))),
  }
  if (sourceView !== undefined) result.sourceView = sourceView
  return result
}

/** Runs trusted, compiler-produced SQL on the read-only connection. The
 *  compiler states the view it read, which is what types the result. */
export function runCompiledSql(
  sql: string,
  params: Array<string | number>,
  sourceView?: string,
): MetricsQueryResult {
  const statement = getReadOnlyMetricsDb().prepare(sql)
  // SAFETY: the read-only connection is opened in object-row mode, so each row is a
  // column-keyed record of SQLite storage values.
  const rows = statement.all(...params) as SqliteRow[]
  return toResult(statementColumns(statement), rows, sourceView)
}

/** Runs user- or agent-authored SQL through the guard, with the row cap injected. */
export function runGuardedSql(sql: string, rowCap = SQL_ROW_CAP): MetricsQueryResult {
  const scan = scanSql(sql)
  if (scan.error) throw new Error(scan.error)
  const body = scan.terminatorIndex === null
    ? sql
    : `${sql.slice(0, scan.terminatorIndex)} ${sql.slice(scan.terminatorIndex + 1)}`
  return runCompiledSql(`SELECT * FROM (\n${body}\n) LIMIT ${rowCap}`, [], declaredSourceView(sql))
}

/** The character offset a SQLite binding reports on a prepare failure. Bun and
 *  better-sqlite3 spell it differently, and neither always sets it. */
interface SqliteErrorOffset {
  sqliteErrorOffset?: number
  offset?: number
}

function errorOffset(cause: unknown): number | undefined {
  // SAFETY: only the two optional numeric offsets are read, and each is range-checked
  // below, so any thrown value satisfies this shape.
  const candidate = cause as SqliteErrorOffset
  const offset = candidate.sqliteErrorOffset ?? candidate.offset
  return offset !== undefined && Number.isInteger(offset) && offset >= 0 ? offset : undefined
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
