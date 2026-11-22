import { expect, test } from 'bun:test'
import type { AgentUsageLimits } from '@solus/contracts/types'
import { asHostApi } from '@solus/client-core/host-api'
import { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import { HostFacts } from '@solus/client-core/host-facts'
import { usageByProvider } from '@solus/workspace-ui/components/project-panel/lib/usage-meters'

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

test('meters hold one usage watch per host; the client sends no poll', async () => {
  // WHY: each visible meter asked its host for usage every minute, only to
  // keep the host's own poll awake, while `usage.limitsChanged` already
  // pushed every change. One watch per host keeps the host reading until the
  // last meter goes, and a reconnect that lost the watch asks for it again.
  const calls: string[] = []
  const facts = new HostFacts('host-a', {
    api: asHostApi({
      usageWatch: async () => { calls.push('watch'); return [] },
      usageUnwatch: async () => { calls.push('unwatch') },
      usageLimits: async () => { calls.push('read'); return [] },
    }),
    events: new HostEventSubscriber(),
  })
  const first = facts.watchUsage()
  const second = facts.watchUsage()
  await facts.when('usage')
  expect(calls).toEqual(['watch'])

  facts.sessionChanged('recovered')
  await facts.when('usage')
  expect(calls).toEqual(['watch', 'watch'])

  first()
  expect(calls).toEqual(['watch', 'watch'])
  second()
  second()
  expect(calls).toEqual(['watch', 'watch', 'unwatch'])
})

test('a host without the usage watch is read as before', async () => {
  const calls: string[] = []
  const facts = new HostFacts('old-host', {
    api: asHostApi({
      usageWatch: async () => { throw new Error('SolusServer: no handler for "usageWatch"') },
      usageUnwatch: async () => {},
      usageLimits: async () => { calls.push('read'); return [] },
    }),
    events: new HostEventSubscriber(),
  })
  const release = facts.watchUsage()
  await facts.when('usage')
  expect(facts.get('usage').state).toBe('ready')
  expect(calls).toEqual(['read'])
  release()
  facts.dispose()
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
