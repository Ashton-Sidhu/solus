import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { resetTestDatabase } from '../helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

const { IntegrationConnectionStore } = await import('@solus/server/integrations/connection-store')
const { dataDir } = await import('@solus/server/platform/paths')
const db = await import('@solus/server/db')

/**
 * Connections (docs/plans/mcp-integrations.md §3.3, §4.1): one row per person
 * and integration, the host's owner by their user key like anyone else. The
 * credential is the vault's (tests/unit/vault.test.ts), never in the row.
 */

afterEach(async () => {
  await resetTestDatabase()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir(), `solus.db${suffix}`), { force: true })
})

afterAll(() => {
  db.closeDb()
})

const OWNER = 'local:owner'

describe('integration connection store', () => {
  test('the host owner and a member each have their own row', () => {
    const store = new IntegrationConnectionStore()
    store.upsert('int-1', OWNER, { status: 'connected', label: 'Owner account' })
    store.upsert('int-1', 'account:alice', { status: 'needs-sign-in', error: 'Sign in again.' })
    store.upsert('int-2', 'account:alice', { status: 'connected' })

    expect(store.list(OWNER).map((each) => [each.integrationId, each.status, each.label])).toEqual([['int-1', 'connected', 'Owner account']])
    expect(store.list('account:alice').map((each) => [each.integrationId, each.status])).toEqual([['int-1', 'needs-sign-in'], ['int-2', 'connected']])
    expect(store.list('account:bob')).toEqual([])
    expect(store.get('int-1', 'account:bob')).toBeNull()
  })

  test('an upsert keeps one row and the fields it leaves out', () => {
    const store = new IntegrationConnectionStore()
    store.upsert('int-1', OWNER, { status: 'connected', label: 'Fake', info: { displayName: 'Fake MCP' } })
    // WHY: a refresh failure changes the status only; the identity the person signed in as stays visible.
    const marked = store.upsert('int-1', OWNER, { status: 'needs-sign-in', error: 'Sign in again.' })
    expect(marked).toMatchObject({ status: 'needs-sign-in', label: 'Fake', info: { displayName: 'Fake MCP' }, error: 'Sign in again.' })
    const reconnected = store.upsert('int-1', OWNER, { status: 'connected', error: null })
    expect(reconnected.error).toBeNull()
    expect(store.list(OWNER)).toHaveLength(1)
  })

  test('removeAllFor removes every person and names them', () => {
    const store = new IntegrationConnectionStore()
    store.upsert('int-1', OWNER, { status: 'connected' })
    store.upsert('int-1', 'account:alice', { status: 'connected' })
    store.upsert('int-2', 'account:alice', { status: 'connected' })
    expect(store.removeAllFor('int-1').sort()).toEqual(['account:alice', OWNER].sort())
    expect(store.get('int-1', OWNER)).toBeNull()
    expect(store.get('int-2', 'account:alice')).not.toBeNull()
    expect(store.remove('int-2', 'account:alice')).toBe(true)
    expect(store.remove('int-2', 'account:alice')).toBe(false)
  })

  test('the projection carries no credential', () => {
    const store = new IntegrationConnectionStore()
    const connection = store.upsert('int-1', 'account:alice', { status: 'connected', label: 'Fake' })
    expect(Object.keys(connection).sort()).toEqual(['error', 'info', 'integrationId', 'label', 'source', 'status', 'updatedAt'])
  })
})
