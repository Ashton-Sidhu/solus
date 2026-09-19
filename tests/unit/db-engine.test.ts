import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { resolveEngine } from '@solus/server/db/engine'
import { solusDir } from '@solus/server/platform/paths'

// docs/plans/cloud-service-model.md: a host needs no configuration to run SQLite;
// the cloud names its Postgres once. `SOLUS_DB` is the explicit word and wins.

describe('resolveEngine', () => {
  test('no environment is SQLite in the data directory', () => {
    expect(resolveEngine({})).toEqual({ kind: 'sqlite', path: join(solusDir(), 'solus.db') })
  })

  test('DATABASE_URL alone means Postgres', () => {
    expect(resolveEngine({ DATABASE_URL: 'postgres://solus@db/solus' }))
      .toEqual({ kind: 'postgres', url: 'postgres://solus@db/solus' })
  })

  test('SOLUS_DB wins over DATABASE_URL', () => {
    expect(resolveEngine({ SOLUS_DB: 'sqlite', DATABASE_URL: 'postgres://solus@db/solus' }).kind).toBe('sqlite')
    expect(resolveEngine({ SOLUS_DB: 'postgres', DATABASE_URL: 'postgres://solus@db/solus' }).kind).toBe('postgres')
  })

  test('Postgres without a URL, or an unknown engine, is refused at boot', () => {
    expect(() => resolveEngine({ SOLUS_DB: 'postgres' })).toThrow(/DATABASE_URL/)
    expect(() => resolveEngine({ SOLUS_DB: 'mysql' })).toThrow(/sqlite.*postgres/)
  })
})
