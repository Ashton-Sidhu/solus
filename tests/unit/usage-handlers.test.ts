import { describe, expect, test } from 'bun:test'
import type { AgentUsageLimits } from '@solus/contracts/types'
import { registerUsageHandlers } from '@solus/server/server/handlers/usage-handlers'
import { SolusServer } from '@solus/server/server/server'

describe('usage handlers', () => {
  test('one shared refresh emits one limits event for concurrent callers', async () => {
    // WHY: Editor and Pill can ask at the same time. Joining the same backend
    // refresh must not echo one identical host event per caller.
    const server = new SolusServer()
    let finishRead: ((limits: AgentUsageLimits) => void) | undefined
    const read = new Promise<AgentUsageLimits>((resolve) => { finishRead = resolve })
    const broadcasts: AgentUsageLimits[][] = []

    registerUsageHandlers(server, {
      controlPlane: {
        usageCapableAgents: () => ['claude-code'],
        readUsageLimits: () => read,
      } as never,
      events: {
        broadcast: (_type: string, payload: { snapshots: AgentUsageLimits[] }) => {
          broadcasts.push(payload.snapshots)
          return 1
        },
      } as never,
    })

    const first = server.handle('usageLimits', [])
    const second = server.handle('usageLimits', [])
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
      } as never,
      events: { broadcast: () => 1 } as never,
    })

    const snapshots = await server.handle('usageLimits', [])

    expect(snapshots).toEqual([
      { provider: 'claude-code', fiveHour: null, weekly: null, planType: null, fetchedAt: 0, stale: true },
    ])
  })
})
