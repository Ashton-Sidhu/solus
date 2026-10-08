import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { Integration, IntegrationConnectionChangedEvent } from '@solus/contracts/integration-types'
import type { IntegrationClient, IntegrationSecrets, IntegrationToken } from '@solus/server/integrations/connection-store'
import { resetTestDatabase } from '../helpers/test-db'
import { startFakeServers, type FakeServers } from './fake-servers'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

const { IntegrationOAuth } = await import('@solus/server/integrations/oauth')
const { IntegrationConnections } = await import('@solus/server/integrations/connections')
const { IntegrationConnectionStore } = await import('@solus/server/integrations/connection-store')
const { dataDir } = await import('@solus/server/platform/paths')
const db = await import('@solus/server/db')

/**
 * What the gateway reads for a call (docs/plans/mcp-integrations.md §4.1): the
 * Authorization header of one person's connection, null without one, and a
 * pasted key kept only after the server accepted it.
 */

const ALICE = 'account:alice'

let fake: FakeServers

function memorySecrets(): IntegrationSecrets {
  const tokens = new Map<string, IntegrationToken>()
  const clients = new Map<string, IntegrationClient>()
  const key = (id: string, user: string | null) => `${id}/${user ?? 'host'}`
  return {
    token: (id, user) => tokens.get(key(id, user)) ?? null,
    saveToken: (id, user, token) => { tokens.set(key(id, user), token) },
    removeToken: (id, user) => { tokens.delete(key(id, user)) },
    client: (id) => clients.get(id) ?? null,
    saveClient: (id, client) => { clients.set(id, client) },
    removeClient: (id) => { clients.delete(id) },
  }
}

function record(id: string, auth: Integration['auth']): Integration {
  return { id, organizationId: 'local', kind: 'mcp', slug: id, name: id, url: fake.mcpUrl, auth, createdBy: null, createdAt: '2026-10-08T00:00:00Z', updatedAt: '2026-10-08T00:00:00Z' }
}

function setup(integrations: Integration[]) {
  const secrets = memorySecrets()
  const store = new IntegrationConnectionStore()
  const changed: Array<{ user: string | null; event: IntegrationConnectionChangedEvent }> = []
  const events = { connectionChanged: (user: string | null, event: IntegrationConnectionChangedEvent) => { changed.push({ user, event }) }, authFinished: () => {} }
  const lookup = { get: (id: string) => integrations.find((each) => each.id === id) ?? null }
  const oauth = new IntegrationOAuth({ connections: store, integrations: lookup, secrets, events })
  return { secrets, store, changed, connections: new IntegrationConnections({ store, integrations: lookup, secrets, oauth, events }) }
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
})
