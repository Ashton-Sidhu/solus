import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from './helpers/bun-sqlite'
import type { MetricsQuerySpec } from '@solus/contracts/observability-types'

mock.module('node:sqlite', () => ({ DatabaseSync }))

type DbModule = typeof import('@solus/server/db')
type SavedQueriesModule = typeof import('@solus/server/data/insights/saved-queries')

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
let db: DbModule
let savedQueries: SavedQueriesModule

/** Two people on one host, by the user key `ownerKeyOf` gives them. */
const alice = 'account:alice'
const bob = 'account:bob'

const spec: MetricsQuerySpec = {
  filters: [{ field: 'kind', op: 'eq', value: 'turn' }],
  groupBy: [{ field: 'model' }],
  aggregates: [{ fn: 'avg', field: 'duration_ms' }],
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-saved-queries-'))
  process.env.SOLUS_DATA_DIR = dataDir
  db = await import('@solus/server/db')
  savedQueries = await import('@solus/server/data/insights/saved-queries')
  db.closeDb()
})

afterAll(() => {
  db.closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

describe.serial('saved metrics queries', () => {
  test('round-trips a spec-form query', () => {
    const list = savedQueries.saveMetricsQuery(alice, {
      id: 'q-spec', name: 'Turn time by model', form: 'spec', spec, createdAt: 0, updatedAt: 0,
    })
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: 'q-spec', form: 'spec', spec })
    expect(list[0].sql).toBeUndefined()
  })

  test('round-trips a sql-form query without a spec', () => {
    const list = savedQueries.saveMetricsQuery(alice, {
      id: 'q-sql', name: 'Slowest tools', form: 'sql',
      sql: 'SELECT tool, MAX(duration_ms) FROM tool_calls GROUP BY tool',
      createdAt: 0, updatedAt: 0,
    })
    const saved = list.find((query) => query.id === 'q-sql')
    expect(saved).toMatchObject({ form: 'sql', sql: 'SELECT tool, MAX(duration_ms) FROM tool_calls GROUP BY tool' })
    expect(saved?.spec).toBeUndefined()
  })

  test('re-saving keeps the original createdAt and bumps updatedAt', () => {
    const before = savedQueries.listSavedMetricsQueries(alice).find((query) => query.id === 'q-spec')
    const list = savedQueries.saveMetricsQuery(alice, {
      id: 'q-spec', name: 'Renamed', form: 'spec', spec, createdAt: 999_999, updatedAt: 0,
    })
    const after = list.find((query) => query.id === 'q-spec')
    expect(after?.name).toBe('Renamed')
    expect(after?.createdAt).toBe(before!.createdAt)
    expect(after!.updatedAt).toBeGreaterThanOrEqual(before!.updatedAt)
  })

  test('rejects a query missing its owning form content', () => {
    expect(() => savedQueries.saveMetricsQuery(alice, {
      id: 'bad', name: 'x', form: 'spec', createdAt: 0, updatedAt: 0,
    })).toThrow('needs a spec')
    expect(() => savedQueries.saveMetricsQuery(alice, {
      id: 'bad', name: 'x', form: 'sql', sql: '  ', createdAt: 0, updatedAt: 0,
    })).toThrow('needs SQL text')
  })

  test('a saved query is listed, re-saved, and deleted by the person who saved it only', () => {
    // WHY (plans/029 P8): a shared host keeps every member's queries in one
    // table. Bob sees his own; he cannot take over Alice's by re-saving her id,
    // and deleting her id from his list changes nothing of hers.
    savedQueries.saveMetricsQuery(bob, { id: 'q-bob', name: 'Mine', form: 'spec', spec, createdAt: 0, updatedAt: 0 })
    expect(savedQueries.listSavedMetricsQueries(bob).map((query) => query.id)).toEqual(['q-bob'])
    expect(savedQueries.listSavedMetricsQueries(alice).map((query) => query.id).sort()).toEqual(['q-spec', 'q-sql'])
    expect(() => savedQueries.saveMetricsQuery(bob, { id: 'q-spec', name: 'Taken', form: 'spec', spec, createdAt: 0, updatedAt: 0 }))
      .toThrow('belongs to someone else')
    expect(savedQueries.deleteSavedMetricsQuery(bob, 'q-spec').map((query) => query.id)).toEqual(['q-bob'])
    expect(savedQueries.listSavedMetricsQueries(alice).find((query) => query.id === 'q-spec')?.name).toBe('Renamed')
  })

  test('delete is idempotent and returns the remaining list', () => {
    expect(savedQueries.deleteSavedMetricsQuery(alice, 'q-sql').map((query) => query.id)).toEqual(['q-spec'])
    expect(savedQueries.deleteSavedMetricsQuery(alice, 'q-sql').map((query) => query.id)).toEqual(['q-spec'])
  })
})
