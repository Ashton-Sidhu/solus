import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { Integration, IntegrationConnectionChangedEvent } from '@solus/contracts/integration-types'
import { resetTestDatabase } from '../helpers/test-db'
import { startFakeServers, type FakeServers } from './fake-servers'
import { memoryClients, memorySecretStore } from './memory-secrets'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

const { IntegrationOAuth } = await import('@solus/server/integrations/oauth')
const { IntegrationConnections } = await import('@solus/server/integrations/connections')
const { IntegrationConnectionStore } = await import('@solus/server/integrations/connection-store')
const { Vault } = await import('@solus/server/vault/vault')
const { dataDir } = await import('@solus/server/platform/paths')
const db = await import('@solus/server/db')

/**
 * What the gateway reads for a call (docs/plans/mcp-integrations.md §4.1): the
 * Authorization header of one person's connection, null without one, and a
 * pasted key kept only after the server accepted it.
 */

const ALICE = 'account:alice'

let fake: FakeServers

function record(id: string, auth: Integration['auth']): Integration {
  return { id, organizationId: 'local', ownerKey: 'local:test', kind: 'mcp', slug: id, name: id, url: fake.mcpUrl, auth, createdBy: null, createdAt: '2026-10-08T00:00:00Z', updatedAt: '2026-10-08T00:00:00Z' }
}

function setup(integrations: Integration[]) {
  const store = new IntegrationConnectionStore()
  const secrets = memorySecretStore()
  const vault = new Vault({ secrets })
  const clients = memoryClients()
  const changed: Array<{ user: string | null; event: IntegrationConnectionChangedEvent }> = []
  const events = { connectionChanged: (user: string | null, event: IntegrationConnectionChangedEvent) => { changed.push({ user, event }) }, authFinished: () => {} }
  const lookup = { get: (id: string) => integrations.find((each) => each.id === id) ?? null }
  const oauth = new IntegrationOAuth({ connections: store, integrations: lookup, vault, clients, events })
  return { secrets, store, changed, connections: new IntegrationConnections({ store, integrations: lookup, vault, clients, oauth, events }) }
}

beforeAll(async () => {
  fake = await startFakeServers()
})

afterEach(async () => {
  await resetTestDatabase()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir(), `solus.db${suffix}`), { force: true })
})

afterAll(async () => {
  db.closeDb()
  await fake.close()
})

describe('integration connections', () => {
  test('no connection is null, never an error, for every auth kind', async () => {
    const integrations = [
      record('anon', { kind: 'none' }),
      record('keyed', { kind: 'bearer', scheme: 'bearer' }),
      record('signed', { kind: 'oauth', discover: 'http://127.0.0.1:1/missing', registration: 'dynamic' }),
    ]
    const { connections } = setup(integrations)
    for (const integration of integrations) expect(await connections.authorizationFor(integration.id, ALICE)).toBeNull()
    expect(await connections.authorizationFor('removed', ALICE)).toBeNull()
  })

  test('a pasted key is verified against the server, then sent as Bearer for its person only', async () => {
    fake.accepted.add('Bearer good-key')
    const keyed = record('keyed', { kind: 'bearer', scheme: 'bearer' })
    const { connections, store, changed } = setup([keyed])
    const connection = await connections.submitKey(keyed, ALICE, 'good-key')
    expect(connection).toMatchObject({ status: 'connected', label: 'Fake MCP' })
    expect(fake.mcpAuthorizations.at(-1)).toBe('Bearer good-key')
    expect(await connections.authorizationFor(keyed.id, ALICE)).toBe('Bearer good-key')
    expect(await connections.authorizationFor(keyed.id, null)).toBeNull()
    expect(changed.map((each) => each.user)).toEqual([ALICE])
    // WHY (§4.1 rule 3): the row the clients read never carries the key.
    expect(JSON.stringify(store.list(ALICE))).not.toContain('good-key')
  })

  test('a key the server refuses is not stored', async () => {
    const keyed = record('keyed', { kind: 'bearer', scheme: 'bearer' })
    const { connections, store } = setup([keyed])
    await expect(connections.submitKey(keyed, ALICE, 'bad-key')).rejects.toThrow('The server refused this credential.')
    expect(await connections.authorizationFor(keyed.id, ALICE)).toBeNull()
    expect(store.get(keyed.id, ALICE)).toBeNull()
  })

  test('a basic scheme sends the key as the whole Basic credential', async () => {
    fake.accepted.add('Basic dXNlcjpwYXNz')
    const basic = record('basic', { kind: 'bearer', scheme: 'basic' })
    const { connections } = setup([basic])
    await connections.submitKey(basic, ALICE, 'dXNlcjpwYXNz')
    expect(await connections.authorizationFor(basic.id, ALICE)).toBe('Basic dXNlcjpwYXNz')
  })

  test('a refused credential moves the connection to needs-sign-in and stops sending it', async () => {
    fake.accepted.add('Bearer good-key')
    const keyed = record('keyed', { kind: 'bearer', scheme: 'bearer' })
    const { connections, store, changed } = setup([keyed])
    await connections.submitKey(keyed, ALICE, 'good-key')
    connections.markNeedsSignIn(keyed.id, ALICE, 'The server answered 401.')
    expect(store.get(keyed.id, ALICE)).toMatchObject({ status: 'needs-sign-in', error: 'The server answered 401.' })
    expect(changed.at(-1)).toMatchObject({ user: ALICE, event: { integrationId: keyed.id, connection: { status: 'needs-sign-in' } } })
    expect(await connections.authorizationFor(keyed.id, ALICE)).toBeNull()
  })

  test('a guest has no MCP credentials: nothing is kept for them, and nothing is sent', async () => {
    // WHY (docs/plans/access-model.md D1): a guest's turn runs on the sharer's seat
    // and must never act with a credential, theirs or the sharer's.
    fake.accepted.add('Bearer good-key')
    const keyed = record('keyed', { kind: 'bearer', scheme: 'bearer' })
    const { connections, secrets } = setup([keyed])
    await expect(connections.submitKey(keyed, 'guest:maya', 'good-key')).rejects.toThrow('not a guest')
    expect(secrets.values.size).toBe(0)
    // A token left under a guest key from before is not read either.
    secrets.values.set(`integration-token-keyed-${Buffer.from('guest:maya').toString('base64url')}`, JSON.stringify({ accessToken: 'good-key', tokenType: 'api-key' }))
    expect(await connections.authorizationFor(keyed.id, 'guest:maya')).toBeNull()
  })
})
