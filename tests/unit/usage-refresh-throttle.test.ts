import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { asHostApi } from '@solus/client-core/host-api'
import { serverConnections } from '@solus/client-core/server-connections'
import type { SettingsContext } from '@solus/workspace-ui/contexts/app/settings.context.svelte'

const runes = globalThis as unknown as { $state?: unknown; $derived?: unknown }
const previousRunes = { state: runes.$state, derived: runes.$derived }

afterEach(() => {
  mock.restore()
  runes.$state = previousRunes.state
  runes.$derived = previousRunes.derived
})

test('project panels becoming active share one usage read per minute', async () => {
  // WHY: every mounted project panel asks for usage when its tab becomes
  // active, and the `usage.limitsChanged` topic already pushes changes. A tab
  // switch must not cost a host round trip; the host only needs to hear from a
  // client inside its 15-minute idle window. A failed read must not hold the
  // next one back.
  runes.$state = <T>(value: T) => value
  runes.$derived = <T>(value: T) => value
  let reads = 0
  let failNext = false
  spyOn(serverConnections, 'defaultServerId').mockReturnValue('host-a')
  spyOn(serverConnections, 'apiFor').mockReturnValue(asHostApi({
    usageLimits: async () => {
      reads++
      if (failNext) {
        failNext = false
        throw new Error('offline')
      }
      return []
    },
  }))
  const { AgentContext } = await import('@solus/workspace-ui/contexts/app/agent.context.svelte')
  const agent = new AgentContext({ activeAgent: 'claude-code' } as SettingsContext)

  await agent.refreshUsage(0)
  await agent.refreshUsage(30_000)
  await agent.refreshUsage(60_000)
  expect(reads).toBe(2)

  failNext = true
  await expect(agent.refreshUsage(120_000)).rejects.toThrow('offline')
  await agent.refreshUsage(120_001)
  expect(reads).toBe(4)
})
