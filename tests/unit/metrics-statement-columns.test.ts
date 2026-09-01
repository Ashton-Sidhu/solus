import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database, type SQLQueryBindings } from 'bun:sqlite'

/**
 * The app runs on node:sqlite, whose `columns()` is a native method that
 * rejects a detached receiver — a statement read as `const read =
 * statement.columns; read()` throws `TypeError: Illegal invocation` and every
 * Insights answer fails. bun:sqlite, which stands in for node:sqlite in every
 * other unit test, has no `columns` at all and so can never see that.
 *
 * This stand-in has one: node's shape, node's receiver check.
 */

interface NodeShapedStatement {
  all(...params: SQLQueryBindings[]): unknown[]
  get(...params: SQLQueryBindings[]): unknown
  run(...params: SQLQueryBindings[]): unknown
  columns(): Array<{ name: string | null; column: string | null }>
}

interface ReadOnlyOpenOptions {
  readOnly?: true
  readonly?: true
}

class NodeShapedDatabase {
  private readonly db: Database

  constructor(path: string, options?: ReadOnlyOpenOptions) {
    // node:sqlite spells the flag `readOnly`; bun rejects that spelling with a
    // TypeError, and the production code falls back to bun's. Keep both real.
    if (options?.readOnly) throw new TypeError('unknown option readOnly')
    this.db = new Database(path, options?.readonly ? { readonly: true } : undefined)
  }

  exec(sql: string): void {
    this.db.exec(sql)
  }

  close(): void {
    this.db.close()
  }

  prepare(sql: string): NodeShapedStatement {
    const statement = this.db.prepare(sql)
    const shaped: NodeShapedStatement = {
      all: (...params) => statement.all(...params),
      get: (...params) => statement.get(...params),
      run: (...params) => statement.run(...params),
      columns(this: NodeShapedStatement | undefined) {
        if (this !== shaped) throw new TypeError('Illegal invocation')
        return statement.columnNames.map((name) => ({ name, column: null }))
      },
    }
    return shaped
  }
}

mock.module('node:sqlite', () => ({ DatabaseSync: NodeShapedDatabase }))

type MetricsDbModule = typeof import('@solus/server/observability/metrics-db')
type SqlGuardModule = typeof import('@solus/server/observability/sql-guard')

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
let metricsDb: MetricsDbModule
let sqlGuard: SqlGuardModule

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-metrics-columns-'))
  process.env.SOLUS_DATA_DIR = dataDir
  metricsDb = await import('@solus/server/observability/metrics-db')
  sqlGuard = await import('@solus/server/observability/sql-guard')
  metricsDb.closeMetricsDb()
})

afterAll(() => {
  metricsDb.closeMetricsDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

test('a result names its columns on a binding whose columns() checks its receiver', () => {
  const result = sqlGuard.runGuardedSql('SELECT model, COUNT(*) AS turns FROM turns GROUP BY model')
  expect(result.columns).toEqual([{ name: 'model', type: 'string' }, { name: 'turns' }])
})

test('validation names its columns on the same binding', () => {
  expect(sqlGuard.validateMetricsSql('SELECT model, COUNT(*) AS turns FROM turns GROUP BY model'))
    .toEqual({ ok: true, columns: ['model', 'turns'] })
})
