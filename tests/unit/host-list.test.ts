import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HostListing } from '@solus/contracts/host-list'
import type { Principal } from '@solus/server/admission/principal'
import { DatabaseSync } from './helpers/bun-sqlite'
import { memberPrincipal } from './helpers/actors'

mock.module('node:sqlite', () => ({ DatabaseSync }))

// plans/031 D7: while the owner is signed out, the host they run beside keeps the
// hosts they connected to themselves. The list is the owner's alone, and holds no
// credential: each client keeps its own token.

const OWNER: Principal = { kind: 'owner', via: 'local', expiresAt: null, deviceId: null, deviceLabel: 'Mac' }
const ADMIN = memberPrincipal('adam', 'Adam', { organizationRole: 'owner', hostKind: 'managed' })

const listing = (id: string, lastConnected: number): HostListing => ({
  id, label: `Host ${id}`, installationId: id, lastConnected,
  routes: [{ url: `http://${id}.local:3020`, kind: 'lan', source: 'pairing', seenAt: 1 }],
})

describe('the host list', () => {
  let dataDir: string
  const previousDataDir = process.env.SOLUS_DATA_DIR
  let server: InstanceType<typeof import('@solus/server/transport/server')['SolusServer']>
  const events: string[] = []
  let closeDb: () => void

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'solus-host-list-'))
    process.env.SOLUS_DATA_DIR = dataDir
    const { SolusServer } = await import('@solus/server/transport/server')
    const { registerHostListHandlers } = await import('@solus/server/transport/handlers/host-list-handlers')
    ;({ closeDb } = await import('@solus/server/db'))
    server = new SolusServer()
    registerHostListHandlers(server, { broadcast: (topic) => events.push(topic) })
  })

  afterAll(() => {
    closeDb()
    rmSync(dataDir, { recursive: true, force: true })
    if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
    else process.env.SOLUS_DATA_DIR = previousDataDir
  })

  const call = (method: 'hostListRead' | 'hostListPut' | 'hostListRemove', args: unknown[], principal: Principal = OWNER) =>
    server.handle(method, args as never, { clientId: 'c1', principal })

  test('the owner adds, replaces, reads, and removes hosts, newest connection first, and each change is announced', async () => {
    await call('hostListPut', [listing('a', 10)])
    await call('hostListPut', [listing('b', 20)])
    await call('hostListPut', [{ ...listing('a', 30), label: 'Studio', hasUserLabel: true }])
    expect(((await call('hostListRead', [])) as HostListing[]).map((host) => [host.id, host.label])).toEqual([['a', 'Studio'], ['b', 'Host b']])

    await call('hostListRemove', ['b'])
    // Removing a host the list does not hold changes nothing and announces nothing.
    await call('hostListRemove', ['b'])
    expect(((await call('hostListRead', [])) as HostListing[]).map((host) => host.id)).toEqual(['a'])
    expect(events).toEqual(['host.listChanged', 'host.listChanged', 'host.listChanged', 'host.listChanged'])
  })

  test('a listing that carries a token is refused, and the list holds none', async () => {
    // WHY: the list is synced and shown; a token is the client's own (D7, Q6).
    await expect(call('hostListPut', [{ ...listing('c', 1), sessionToken: 'secret' }])).rejects.toThrow()
    expect(JSON.stringify(await call('hostListRead', []))).not.toContain('secret')
  })

  test('an organization owner who administers the machine does not read the owner\'s list', async () => {
    await expect(call('hostListRead', [], ADMIN)).rejects.toThrow()
    await expect(call('hostListPut', [listing('d', 1)], ADMIN)).rejects.toThrow()
  })
})
