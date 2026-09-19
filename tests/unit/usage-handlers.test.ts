import { describe, expect, test } from 'bun:test'
import { TEST_HANDLER_CTX } from './helpers/handler-ctx'
import type { AgentUsageLimits } from '@solus/contracts/types'
import type { HandlerCtx } from '@solus/server/server/server'
import { registerUsageHandlers } from '@solus/server/server/handlers/usage-handlers'
import { SolusServer } from '@solus/server/server/server'
import { UsageLimitsStore } from '@solus/server/usage/usage-store'

describe('usage handlers', () => {
  test('one shared refresh emits one limits event for concurrent callers', async () => {
    // WHY: Multiple clients can ask at the same time. Joining the same backend
    // refresh must not echo one identical host event per caller.
    const server = new SolusServer()
    let finishRead: ((limits: AgentUsageLimits) => void) | undefined
    const read = new Promise<AgentUsageLimits>((resolve) => { finishRead = resolve })
    const broadcasts: AgentUsageLimits[][] = []

    registerUsageHandlers(server, {
      controlPlane: {
        usageCapableAgents: () => ['claude-code'],
        readUsageLimits: () => read,
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
      controlPlane: {
        usageCapableAgents: () => ['claude-code'],
        readUsageLimits: async () => null,
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
    const bobSeat = { userId: 'bob', provider: 'claude-code' as const, home: '/seats/claude/bob' }
    registerUsageHandlers(server, {
      controlPlane: {
        usageCapableAgents: () => ['claude-code'],
        readUsageLimits: async (_agentId: string, seat?: { userId: string }) => {
          reads.push(seat?.userId)
          return { provider: 'claude-code', fiveHour: null, weekly: null, planType: null, fetchedAt: 1, stale: false, seat: seat?.userId }
        },
        usageLimits: new UsageLimitsStore(),
      } as never,
      events: {
        publish: (clientIds: string[], _type: string, payload: { snapshots: AgentUsageLimits[] }) => { published.push([clientIds, payload.snapshots]); return clientIds.length },
        broadcast: () => { throw new Error('nothing is broadcast once seats exist') },
      } as never,
      seats: {
        connectedSeat: (userId: string) => (userId === 'bob' ? bobSeat : null),
        status: () => ({ provider: 'claude-code', state: 'connected', usageCapable: true }),
        onChanged: () => () => {},
      } as never,
      clientsForSeatUser: (seatUserId) => (seatUserId === 'bob' ? ['ws:bob'] : ['ws:owner']),
    })
    const bob: HandlerCtx = { clientId: 'ws:bob', principal: { kind: 'org-member', userId: 'bob', organizationId: 'o', organizationRole: 'member', teamIds: [], hostKind: 'managed', displayName: 'Bob', deviceId: 'd', expiresAt: 0, deviceLabel: 'Solus cloud' } }

    const bobSnapshots = await server.handle('usageLimits', [], bob)
    expect(bobSnapshots).toMatchObject([{ provider: 'claude-code', seat: 'bob' }])
    const ownerSnapshots = await server.handle('usageLimits', [], TEST_HANDLER_CTX)
    expect(ownerSnapshots).toMatchObject([{ provider: 'claude-code', seat: undefined }])
    expect(reads).toEqual(['bob', undefined])
    expect(published.map(([clientIds]) => clientIds)).toEqual([['ws:bob'], ['ws:owner']])
    // A second ask inside the window is served from the member's cache: no new subprocess.
    await server.handle('usageLimits', [], bob)
    expect(reads).toEqual(['bob', undefined])
  })

  test('the host login is read without the login probe', async () => {
    // WHY: `status()` labels the host login connected or not by running
    // `claude auth status` synchronously on the main thread — ~200 ms during
    // which every other request, the first transcript page included, waits.
    // The usage meter needs only "usage-capable", which the host login always is.
    const server = new SolusServer()
    let statusReads = 0
    registerUsageHandlers(server, {
      controlPlane: {
        usageCapableAgents: () => ['claude-code'],
        readUsageLimits: async () => ({ provider: 'claude-code', stale: false }),
        usageLimits: new UsageLimitsStore(),
      } as never,
      events: { publish: () => 1, broadcast: () => 1 } as never,
      seats: {
        connectedSeat: () => ({ userId: 'owner', provider: 'claude-code', home: '/home', isHostLogin: true }),
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
    let seatListener: ((event: { userId: string; provider: 'claude-code'; state: 'connected' | 'none' }) => void) | undefined
    const published: AgentUsageLimits[][] = []
    registerUsageHandlers(server, {
      controlPlane: {
        usageCapableAgents: () => ['claude-code'],
        readUsageLimits: async () => ({ provider: 'claude-code', fiveHour: null, weekly: null, planType: null, fetchedAt: 1, stale: false }),
        usageLimits: new UsageLimitsStore(),
      } as never,
      events: {
        publish: (_clientIds: string[], _type: string, payload: { snapshots: AgentUsageLimits[] }) => { published.push(payload.snapshots); return 1 },
        broadcast: () => 0,
      } as never,
      seats: {
        connectedSeat: () => (connected ? { userId: 'bob', provider: 'claude-code', home: '/seats/claude/bob' } : null),
        status: () => ({ provider: 'claude-code', state: connected ? 'connected' : 'none', usageCapable: connected }),
        onChanged: (listener: typeof seatListener) => { seatListener = listener; return () => {} },
      } as never,
      clientsForSeatUser: () => ['ws:bob'],
    })
    const bob: HandlerCtx = { clientId: 'ws:bob', principal: { kind: 'org-member', userId: 'bob', organizationId: 'o', organizationRole: 'member', teamIds: [], hostKind: 'managed', displayName: 'Bob', deviceId: 'd', expiresAt: 0, deviceLabel: 'Solus cloud' } }

    expect(await server.handle('usageLimits', [], bob)).toEqual([])
    connected = true
    seatListener?.({ userId: 'bob', provider: 'claude-code', state: 'connected' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(published.at(-1)).toMatchObject([{ provider: 'claude-code' }])
    expect(await server.handle('usageLimits', [], bob)).toMatchObject([{ provider: 'claude-code' }])
  })
})
