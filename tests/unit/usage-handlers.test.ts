import { describe, expect, test } from 'bun:test'
import type { AgentUsageLimits } from '../../src/shared/types'
import { registerUsageHandlers } from '../../src/main/server/handlers/usage-handlers'
import { SolusServer } from '../../src/main/server/server'

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
})
