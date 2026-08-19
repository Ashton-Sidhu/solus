import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

type SpanTableModule = typeof import('@solus/server/observability/span-table')
type MetricsDbModule = typeof import('@solus/server/observability/metrics-db')
type SqlGuardModule = typeof import('@solus/server/observability/sql-guard')
type RegistriesModule = typeof import('@solus/server/observability/registries')

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
let spanTable: SpanTableModule
let metricsDb: MetricsDbModule
let sqlGuard: SqlGuardModule
let registries: RegistriesModule

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-metrics-guard-'))
  process.env.SOLUS_DATA_DIR = dataDir
  spanTable = await import('@solus/server/observability/span-table')
  metricsDb = await import('@solus/server/observability/metrics-db')
  sqlGuard = await import('@solus/server/observability/sql-guard')
  registries = await import('@solus/server/observability/registries')
  metricsDb.closeMetricsDb()

  for (let index = 0; index < 10; index++) {
    spanTable.writeSpan({
      spanId: `span-${index}`, traceId: `span-${index}`, kind: registries.SPAN_KINDS.turn, name: 'turn',
      service: registries.SPAN_SERVICES.sessions, startedAt: index, endedAt: index + 1, status: 'ok',
    })
  }
})

afterAll(() => {
  metricsDb.closeMetricsDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

describe.serial('guarded SQL executor', () => {
  test('runs SELECT and WITH statements, tolerating comments and a trailing semicolon', () => {
    expect(sqlGuard.runGuardedSql('SELECT COUNT(*) AS n FROM spans;').rows).toEqual([[10]])
    expect(sqlGuard.runGuardedSql(`
      -- one comment
      WITH t AS (SELECT duration_ms FROM turns)
      SELECT COUNT(*) AS n FROM t /* another */
    `).rows).toEqual([[10]])
  })

  test('a semicolon inside a string literal is not a statement boundary', () => {
    expect(sqlGuard.runGuardedSql("SELECT ';' AS s").rows).toEqual([[';']])
  })

  test('rejects multiple statements', () => {
    expect(() => sqlGuard.runGuardedSql('SELECT 1; SELECT 2')).toThrow('Only one SQL statement')
    expect(() => sqlGuard.runGuardedSql("SELECT 1; DELETE FROM spans")).toThrow('Only one SQL statement')
  })

  test('rejects statements that are not SELECT or WITH', () => {
    for (const sql of [
      "UPDATE spans SET status = 'ok'",
      'DELETE FROM spans',
      "INSERT INTO spans (span_id) VALUES ('x')",
      'DROP TABLE spans',
      'VACUUM',
      "ATTACH DATABASE '/tmp/x.db' AS other",
      'PRAGMA user_version = 9',
    ]) {
      expect(() => sqlGuard.runGuardedSql(sql)).toThrow()
    }
  })

  test('rejects ATTACH and PRAGMA tokens anywhere outside strings', () => {
    expect(sqlGuard.sqlGuardError('SELECT 1 PRAGMA')).toContain('PRAGMA')
    expect(sqlGuard.sqlGuardError("SELECT 'pragma attach' AS s")).toBeNull()
    // Table-valued functions merely containing the word remain fine.
    expect(sqlGuard.sqlGuardError("SELECT * FROM pragma_table_info('spans')")).toBeNull()
  })

  test('rejects empty SQL', () => {
    expect(() => sqlGuard.runGuardedSql('   -- nothing\n')).toThrow('Empty SQL statement')
  })

  test('injects the hard row cap', () => {
    const result = sqlGuard.runGuardedSql('SELECT span_id FROM spans ORDER BY started_at', 3)
    expect(result.rows).toHaveLength(3)
    expect(result.rows[0]).toEqual(['span-0'])
  })

  test('the read-only connection refuses writes even for trusted SQL', () => {
    expect(() => sqlGuard.runCompiledSql('DELETE FROM spans', [])).toThrow()
    expect((metricsDb.getMetricsDb().prepare('SELECT COUNT(*) AS n FROM spans').get() as { n: number }).n).toBe(10)
  })
})

describe.serial('declared grain (sourceView)', () => {
  test('a statement over one registered view declares that grain on the result', () => {
    expect(sqlGuard.runGuardedSql('SELECT trace_id, started_at FROM turns').sourceView).toBe('turns')
    expect(sqlGuard.declaredSourceView('select started_at, duration_ms from events')).toBe('events')
  })

  test('an aliased or self-joined view is still one view', () => {
    expect(sqlGuard.declaredSourceView('SELECT t.started_at FROM turns t')).toBe('turns')
    expect(sqlGuard.declaredSourceView('SELECT a.trace_id FROM turns a JOIN turns b ON a.trace_id = b.trace_id')).toBe('turns')
  })

  test('raw spans, two views, and a CTE source all declare nothing', () => {
    expect(sqlGuard.runGuardedSql('SELECT COUNT(*) AS n FROM spans').sourceView).toBeUndefined()
    expect(sqlGuard.declaredSourceView('SELECT * FROM turns JOIN events ON 1 = 1')).toBeUndefined()
    // Conservative: the CTE name is a second "table", so nothing is declared.
    expect(sqlGuard.declaredSourceView('WITH recent AS (SELECT * FROM turns) SELECT * FROM recent')).toBeUndefined()
  })

  test('a derived table over one view keeps that view as the grain — the client column check backstops a subquery that aggregated it away', () => {
    expect(sqlGuard.declaredSourceView('SELECT * FROM (SELECT * FROM turns)')).toBe('turns')
  })
})

describe.serial('metricsValidateSql', () => {
  test('flags guard violations before touching SQLite', () => {
    const result = sqlGuard.validateMetricsSql('DELETE FROM spans')
    expect(result).toMatchObject({ ok: false, guardViolation: true })
  })

  test('returns the SQLite error for broken SQL', () => {
    const result = sqlGuard.validateMetricsSql('SELECT missing_column FROM spans')
    if (result.ok) throw new Error('expected a validation failure')
    expect(result.error).toContain('missing_column')
    expect(result.guardViolation).toBeUndefined()
  })

  test('returns result column names on success without executing', () => {
    const result = sqlGuard.validateMetricsSql('SELECT model, COUNT(*) AS turns FROM turns GROUP BY model')
    expect(result).toEqual({ ok: true, columns: ['model', 'turns'] })
  })
})
