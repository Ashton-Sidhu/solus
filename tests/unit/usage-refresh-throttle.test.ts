import { expect, test } from 'bun:test'
import type { AgentUsageLimits } from '@solus/contracts/types'
import { asHostApi } from '@solus/client-core/host-api'
import { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import { HostFacts } from '@solus/client-core/host-facts'
import { USAGE_REFRESH_INTERVAL_MS, usageByProvider } from '@solus/workspace-ui/components/project-panel/lib/usage-meters'

function limits(provider: string, usedPercent: number): AgentUsageLimits {
  return {
    provider,
    fiveHour: { usedPercent, resetsAt: null, resetsLabel: null },
    weekly: null,
    planType: null,
    fetchedAt: 1,
    stale: false,
  }
}

test('project panels becoming active share one usage read per host per minute', async () => {
  // WHY: every mounted project panel asks for usage when its tab becomes
  // active, and the `usage.limitsChanged` topic already pushes changes. A tab
  // switch must not cost a host round trip; the host only needs to hear from a
  // client inside its 15-minute idle window. A failed read must not hold the
  // next one back.
  const reads: string[] = []
  let failNext = false
  let clock = 0
  const hostFacts = (serverId: string) => new HostFacts(serverId, {
    api: asHostApi({
      usageLimits: async () => {
        reads.push(serverId)
        if (failNext) {
          failNext = false
          throw new Error('offline')
        }
        return []
      },
    }),
    events: new HostEventSubscriber(),
  }, () => clock)
  const hostA = hostFacts('host-a')
  const hostB = hostFacts('host-b')
  const read = (facts: HostFacts) => facts.refresh('usage', { maxAgeMs: USAGE_REFRESH_INTERVAL_MS })

  await read(hostA)
  clock = 30_000
  await read(hostA)
  // Another host's panel is not held back by host-a's read.
  await read(hostB)
  clock = 60_000
  await read(hostA)
  expect(reads).toEqual(['host-a', 'host-b', 'host-a'])

  failNext = true
  clock = 120_000
  await read(hostA)
  expect(hostA.get('usage').state).toBe('error')
  clock = 120_001
  await read(hostA)
  expect(reads).toEqual(['host-a', 'host-b', 'host-a', 'host-a', 'host-a'])
})

test('a tab reads the quota of its own host, never another host\'s', () => {
  // WHY: quota belongs to a host's agent logins. A remote host with no Claude
  // login and a failing Codex read once replaced this Mac's meters, because
  // every host's snapshot was merged into one record keyed only by provider.
  const localEvents = new HostEventSubscriber()
  const remoteEvents = new HostEventSubscriber()
  const local = new HostFacts('local', { api: asHostApi({}), events: localEvents })
  const remote = new HostFacts('remote', { api: asHostApi({}), events: remoteEvents })
  localEvents.receive({ type: 'usage.limitsChanged', payload: { snapshots: [limits('claude-code', 20), limits('codex', 40)] }, occurredAt: 1 })
  remoteEvents.receive({ type: 'usage.limitsChanged', payload: { snapshots: [{ provider: 'codex', fiveHour: null, weekly: null, planType: null, fetchedAt: 0, stale: true }] }, occurredAt: 1 })

  const localUsage = usageByProvider(local.value('usage') ?? [])
  expect(Object.keys(localUsage).sort()).toEqual(['claude-code', 'codex'])
  expect(localUsage.codex.fiveHour?.usedPercent).toBe(40)
  expect(Object.keys(usageByProvider(remote.value('usage') ?? []))).toEqual(['codex'])

  // A host's snapshot is its whole answer: a provider it no longer reports goes.
  localEvents.receive({ type: 'usage.limitsChanged', payload: { snapshots: [limits('codex', 50)] }, occurredAt: 2 })
  expect(Object.keys(usageByProvider(local.value('usage') ?? []))).toEqual(['codex'])
})
