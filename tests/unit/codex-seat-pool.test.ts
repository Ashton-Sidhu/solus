import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { CodexAppServerClient } from '@solus/server/execution/agents/codex/codex-agent'
import type { TurnSeat } from '@solus/server/execution/seats/seat-manager'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

let CodexBackend: typeof import('@solus/server/execution/agents/codex/codex-backend')['CodexBackend']

beforeAll(async () => {
  ;({ CodexBackend } = await import('@solus/server/execution/agents/codex/codex-backend'))
})

// Step 2 plan §3.3 step 5 (proof B, 2026-08-30): one Codex app-server is one login,
// so a member's seat gets its own process keyed by member, reused across their
// turns, and the pool is capped.

type Pool = Map<string, { client: CodexAppServerClient; activeRuns: number; gitRevision: string | null }>

/** A member's seat with a Git identity at `revision`; `held` counts the credential holds still open. */
function seatWithIdentity(revision: string, held: { count: number }): TurnSeat {
  return {
    seat: { kind: 'user', userId: { kind: 'account', accountId: 'bob' } },
    provider: 'codex',
    home: '/seats/codex/bob',
    git: {
      revision,
      env: {} as NonNullable<TurnSeat['git']>['env'],
      hold: () => {
        held.count += 1
        return () => { held.count -= 1 }
      },
    },
  }
}

function backendWithPool() {
  const backend = new CodexBackend()
  const clientFor = (seat?: TurnSeat) =>
    Reflect.apply(Reflect.get(backend, 'clientFor') as (seat?: unknown) => CodexAppServerClient, backend, [seat])
  const pool = Reflect.get(backend, 'seatClients') as Pool
  return { backend, clientFor, pool }
}

describe('the Codex app-server pool', () => {
  test('no seat is the host\'s own server; a seat is its own process, reused for the same member', () => {
    const { backend, clientFor, pool } = backendWithPool()
    const host = clientFor()
    expect(host.codexHome).toBeUndefined()
    const bob = clientFor({ seat: { kind: 'user', userId: { kind: 'account', accountId: 'bob' } }, provider: 'codex', home: '/seats/codex/bob' })
    expect(bob).not.toBe(host)
    expect(bob.codexHome).toBe('/seats/codex/bob')
    expect(clientFor({ seat: { kind: 'user', userId: { kind: 'account', accountId: 'bob' } }, provider: 'codex', home: '/seats/codex/bob' })).toBe(bob)
    expect(clientFor({ seat: { kind: 'user', userId: { kind: 'account', accountId: 'cara' } }, provider: 'codex', home: '/seats/codex/cara' })).not.toBe(bob)
    expect(pool.size).toBe(2)
    backend.shutdown()
    expect(pool.size).toBe(0)
  })

  test('the ninth seat evicts an idle one; with every server busy it is refused', () => {
    const { backend, clientFor, pool } = backendWithPool()
    for (let i = 0; i < 8; i++) clientFor({ seat: { kind: 'user', userId: { kind: 'account', accountId: `u${i}` } }, provider: 'codex', home: `/seats/codex/u${i}` })
    expect(pool.size).toBe(8)
    clientFor({ seat: { kind: 'user', userId: { kind: 'account', accountId: 'u8' } }, provider: 'codex', home: '/seats/codex/u8' })
    expect(pool.size).toBe(8)
    expect(pool.has('u0')).toBe(false)
    for (const entry of pool.values()) entry.activeRuns = 1
    expect(() => clientFor({ seat: { kind: 'user', userId: { kind: 'account', accountId: 'u9' } }, provider: 'codex', home: '/seats/codex/u9' })).toThrow(/Too many Codex seats/)
    backend.shutdown()
  })

  test('a changed Git identity replaces an idle server and refuses a busy one', () => {
    // WHY: an app-server's Git environment is fixed at start, so reusing it after
    // the member's account changes would commit as the old account.
    const { backend, clientFor, pool } = backendWithPool()
    const held = { count: 0 }
    const first = clientFor(seatWithIdentity('work', held))
    expect(held.count).toBe(1)
    expect(clientFor(seatWithIdentity('work', held))).toBe(first)
    expect(held.count).toBe(1)

    pool.get('bob')!.activeRuns = 1
    expect(() => clientFor(seatWithIdentity('personal', held))).toThrow(/GitHub account changed/)
    expect(pool.get('bob')!.client).toBe(first)

    pool.get('bob')!.activeRuns = 0
    const second = clientFor(seatWithIdentity('personal', held))
    expect(second).not.toBe(first)
    expect(pool.get('bob')!.gitRevision).toBe('personal')
    // The old server let its credential go; the new one holds its own.
    expect(held.count).toBe(1)
    backend.shutdown()
    expect(held.count).toBe(0)
  })

  test('a seat\'s usage is read from its own server', async () => {
    const { backend, pool } = backendWithPool()
    const methods: Array<[string | undefined, string]> = []
    const fakeClient = (home: string | undefined) => ({
      codexHome: home,
      request: async (method: string) => {
        methods.push([home, method])
        return { account: { type: 'apiKey' } }
      },
    })
    Reflect.set(backend, 'client', fakeClient(undefined))
    pool.set('bob', { client: fakeClient('/seats/codex/bob') as unknown as CodexAppServerClient, activeRuns: 0, gitRevision: null })
    await backend.readUsageLimits({ seat: { kind: 'user', userId: { kind: 'account', accountId: 'bob' } }, provider: 'codex', home: '/seats/codex/bob' })
    await backend.readUsageLimits()
    expect(methods).toEqual([['/seats/codex/bob', 'account/read'], [undefined, 'account/read']])
  })
})
