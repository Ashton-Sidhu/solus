import { describe, expect, test } from 'bun:test'
import { TEST_HANDLER_CTX } from './helpers/handler-ctx'
import type { AgentUsageLimits } from '@solus/contracts/types'
import { HOST_LOGIN_SEAT, type Seat } from '@solus/contracts/seats'
import type { HandlerCtx } from '@solus/server/transport/server'
import { registerUsageHandlers } from '@solus/server/transport/handlers/usage-handlers'
import { SolusServer } from '@solus/server/transport/server'
import { UsageLimitsStore } from '@solus/server/usage/usage-store'

const BOB_SEAT: Seat = { kind: 'user', userId: { kind: 'account', accountId: 'bob' } }

describe('usage handlers', () => {
  test('one shared refresh emits one limits event for concurrent callers', async () => {
    // WHY: Multiple clients can ask at the same time. Joining the same backend
    // refresh must not echo one identical host event per caller.
    const server = new SolusServer()
    let finishRead: ((limits: AgentUsageLimits) => void) | undefined
    const read = new Promise<AgentUsageLimits>((resolve) => { finishRead = resolve })
    const broadcasts: AgentUsageLimits[][] = []

    registerUsageHandlers(server, {
      sessionRuntime: {
        history: {
          usageCapableAgents: () => ['claude-code'],
          readUsageLimits: () => read,
        },
        usageLimits: new UsageLimitsStore(),
      } as never,
      events: {
        broadcast: (_type: string, payload: { snapshots: AgentUsageLimits[] }) => {
          broadcasts.push(payload.snapshots)
          return 1
        },
      } as never,
    })

    const first = server.handle('usageLimits', [], TEST_HANDLER_CTX)
    const second = server.handle('usageLimits', [], TEST_HANDLER_CTX)
    finishRead?.({ provider: 'claude-code', stale: false })

    await Promise.all([first, second])

    expect(broadcasts).toHaveLength(1)
    expect(broadcasts[0]).toEqual([{ provider: 'claude-code', stale: false }])
  })

  test('a first read that fails still reports the provider, marked stale', async () => {
    // WHY: Claude's quota comes from an account endpoint that answers empty or
    // rate-limited under load. Booting inside such a window left nothing
    // cached, and the panel dropped Claude entirely — reading as "no quota"
    // rather than "could not read". The row has to survive with no numbers.
    const server = new SolusServer()

    registerUsageHandlers(server, {
      sessionRuntime: {
        history: {
          usageCapableAgents: () => ['claude-code'],
          readUsageLimits: async () => null,
        },
        usageLimits: new UsageLimitsStore(),
      } as never,
      events: { broadcast: () => 1 } as never,
    })

    const snapshots = await server.handle('usageLimits', [], TEST_HANDLER_CTX)

    expect(snapshots).toEqual([
      { provider: 'claude-code', fiveHour: null, weekly: null, planType: null, fetchedAt: 0, stale: true },
    ])
  })

  test('a member reads their own seat\'s quota and hears only about it; the host login goes to the owner\'s clients', async () => {
    // WHY (Step 2 plan §3.5): one member's limit must never show on, or block,
    // another member's meter. The host's numbers are the owner's business.
    const server = new SolusServer()
    const reads: Array<string | undefined> = []
    const published: Array<[string[], AgentUsageLimits[]]> = []
    const bobSeat = { seat: BOB_SEAT, provider: 'claude-code' as const, home: '/seats/claude/bob' }
    registerUsageHandlers(server, {
      sessionRuntime: {
        history: {
          usageCapableAgents: () => ['claude-code'],
          readUsageLimits: async (_agentId: string, seat?: { home: string }) => {
            reads.push(seat?.home)
            return { provider: 'claude-code', fiveHour: null, weekly: null, planType: null, fetchedAt: 1, stale: false, seat: seat?.home }
          },
        },
        usageLimits: new UsageLimitsStore(),
      } as never,
      events: {
        publish: (clientIds: string[], _type: string, payload: { snapshots: AgentUsageLimits[] }) => { published.push([clientIds, payload.snapshots]); return clientIds.length },
        broadcast: () => { throw new Error('nothing is broadcast once seats exist') },
      } as never,
      seats: {
        connectedSeat: (seat: Seat) => (seat.kind === 'user' ? bobSeat : null),
        status: () => ({ provider: 'claude-code', state: 'connected', usageCapable: true }),
        onChanged: () => () => {},
      } as never,
      clientsForSeat: (seat) => (seat.kind === 'user' ? ['ws:bob'] : ['ws:owner']),
    })
    const bob: HandlerCtx = { clientId: 'ws:bob', principal: { kind: 'org-member', userId: 'bob', organizationId: 'o', organizationRole: 'member', teamIds: [], hostKind: 'managed', displayName: 'Bob', deviceId: 'd', expiresAt: 0, deviceLabel: 'Solus cloud' } }

    const bobSnapshots = await server.handle('usageLimits', [], bob)
    expect(bobSnapshots).toMatchObject([{ provider: 'claude-code', seat: '/seats/claude/bob' }])
    const ownerSnapshots = await server.handle('usageLimits', [], TEST_HANDLER_CTX)
    expect(ownerSnapshots).toMatchObject([{ provider: 'claude-code', seat: undefined }])
    expect(reads).toEqual(['/seats/claude/bob', undefined])
    expect(published.map(([clientIds]) => clientIds)).toEqual([['ws:bob'], ['ws:owner']])
    // A second ask inside the window is served from the member's cache: no new subprocess.
    await server.handle('usageLimits', [], bob)
    expect(reads).toEqual(['/seats/claude/bob', undefined])
  })

  test('the host login is read without the login probe', async () => {
    // WHY: `status()` labels the host login connected or not by running
    // `claude auth status` synchronously on the main thread — ~200 ms during
    // which every other request, the first transcript page included, waits.
    // The usage meter needs only "usage-capable", which the host login always is.
    const server = new SolusServer()
    let statusReads = 0
    registerUsageHandlers(server, {
      sessionRuntime: {
        history: {
          usageCapableAgents: () => ['claude-code'],
          readUsageLimits: async () => ({ provider: 'claude-code', stale: false }),
        },
        usageLimits: new UsageLimitsStore(),
      } as never,
      events: { publish: () => 1, broadcast: () => 1 } as never,
      seats: {
        connectedSeat: () => ({ seat: HOST_LOGIN_SEAT, provider: 'claude-code', home: '/home' }),
        status: () => { statusReads += 1; return { provider: 'claude-code', state: 'connected', usageCapable: true } },
        onChanged: () => () => {},
      } as never,
    })

    await server.handle('usageLimits', [], TEST_HANDLER_CTX)

    expect(statusReads).toBe(0)
  })

  test('a member who asked before connecting sees their quota as soon as the seat connects', async () => {
    // WHY: the first ask cached "no seats" for the member; a seat change must
    // drop that answer and publish the real one, not wait out the window.
    const server = new SolusServer()
    let connected = false
    let seatListener: ((event: { seat: Seat; provider: 'claude-code'; state: 'connected' | 'none' }) => void) | undefined
    const published: AgentUsageLimits[][] = []
    registerUsageHandlers(server, {
      sessionRuntime: {
        history: {
          usageCapableAgents: () => ['claude-code'],
          readUsageLimits: async () => ({ provider: 'claude-code', fiveHour: null, weekly: null, planType: null, fetchedAt: 1, stale: false }),
        },
        usageLimits: new UsageLimitsStore(),
      } as never,
      events: {
        publish: (_clientIds: string[], _type: string, payload: { snapshots: AgentUsageLimits[] }) => { published.push(payload.snapshots); return 1 },
        broadcast: () => 0,
      } as never,
      seats: {
        connectedSeat: () => (connected ? { seat: BOB_SEAT, provider: 'claude-code', home: '/seats/claude/bob' } : null),
        status: () => ({ provider: 'claude-code', state: connected ? 'connected' : 'none', usageCapable: connected }),
        onChanged: (listener: typeof seatListener) => { seatListener = listener; return () => {} },
      } as never,
      clientsForSeat: () => ['ws:bob'],
    })
    const bob: HandlerCtx = { clientId: 'ws:bob', principal: { kind: 'org-member', userId: 'bob', organizationId: 'o', organizationRole: 'member', teamIds: [], hostKind: 'managed', displayName: 'Bob', deviceId: 'd', expiresAt: 0, deviceLabel: 'Solus cloud' } }

    expect(await server.handle('usageLimits', [], bob)).toEqual([])
    connected = true
    seatListener?.({ seat: BOB_SEAT, provider: 'claude-code', state: 'connected' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(published.at(-1)).toMatchObject([{ provider: 'claude-code' }])
    expect(await server.handle('usageLimits', [], bob)).toMatchObject([{ provider: 'claude-code' }])
  })
})
