import { describe, expect, test } from 'bun:test'
import { asHostApi } from '@solus/client-core/host-api'
import { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import { HostFacts } from '@solus/client-core/host-facts'
import type { AgentUsageLimits, HostCapabilities, StartInfo } from '@solus/contracts/types'

// docs/plans/host-model.md §3.2: one HostFacts per host owns every fact read
// about that host. These tests pin the rules that stopped the 2026-10-08 bugs
// (a fact copied from the wrong host) and the loading contract readers rely on.

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

function usage(provider: string): AgentUsageLimits {
  return { provider } as AgentUsageLimits
}

function machine(version: string): StartInfo {
  return { version, projectPath: '/p', homePath: '/h', agents: [] }
}

function makeFacts(api: Record<string, (...args: never[]) => unknown>, now = () => 0) {
  const events = new HostEventSubscriber()
  const facts = new HostFacts('host-a', { api: asHostApi(api), events }, now)
  return { facts, events }
}

describe('HostFacts', () => {
  test('a fact reads as loading until its host answers, never as a guess', async () => {
    const answer = deferred<StartInfo>()
    const { facts } = makeFacts({ start: () => answer.promise })
    facts.ensure('machine')
    expect(facts.get('machine')).toEqual({ state: 'loading' })
    answer.resolve(machine('1.0'))
    expect((await facts.when('machine')).version).toBe('1.0')
    expect(facts.get('machine')).toEqual({ state: 'ready', value: machine('1.0') })
  })

  test('concurrent readers share one request', async () => {
    let calls = 0
    const { facts } = makeFacts({ start: async () => { calls += 1; return machine('1.0') } })
    await Promise.all([facts.when('machine'), facts.when('machine'), facts.refresh('machine')])
    expect(calls).toBe(1)
  })

  test('a live topic writes only this host\'s fact', () => {
    const { facts, events } = makeFacts({})
    events.receive({ type: 'usage.limitsChanged', payload: { snapshots: [usage('claude-code')] }, occurredAt: 1 })
    expect(facts.value('usage')).toEqual([usage('claude-code')])
  })

  test('an unreadable capability record is empty, which reads as unsupported', async () => {
    const { facts } = makeFacts({ serverGetCapabilities: async () => { throw new Error('Unknown method') } })
    expect(await facts.when('capabilities')).toEqual({})
  })

  test('voice reads as unsupported on a host that does not transcribe, without asking for status', async () => {
    let asked = false
    const { facts } = makeFacts({
      serverGetCapabilities: async (): Promise<HostCapabilities> => ({ voiceModel: false }),
      voiceModelStatus: async () => { asked = true; return { state: 'ready' } },
    })
    facts.ensure('voiceModel')
    await expect(facts.when('voiceModel')).rejects.toThrow('not supported')
    expect(asked).toBe(false)
  })

  test('a dropped connection clears capabilities but keeps the last machine facts', async () => {
    const { facts } = makeFacts({
      serverGetCapabilities: async () => ({ voiceModel: true }),
      start: async () => machine('1.0'),
    })
    await facts.when('capabilities')
    await facts.when('machine')
    facts.sessionChanged('lost')
    expect(facts.get('capabilities')).toEqual({ state: 'loading' })
    expect(facts.value('machine')?.version).toBe('1.0')
  })

  test('a fresh server session reloads every fact a reader asked for', async () => {
    let version = '1.0'
    const { facts } = makeFacts({ serverGetCapabilities: async () => ({}), start: async () => machine(version) })
    await facts.when('machine')
    version = '2.0'
    facts.sessionChanged('fresh')
    expect((await facts.when('machine')).version).toBe('2.0')
  })

  test('an answer from before a session change never overwrites the new session', async () => {
    const stale = deferred<StartInfo>()
    let first = true
    const { facts } = makeFacts({
      serverGetCapabilities: async () => ({}),
      start: () => {
        if (first) { first = false; return stale.promise }
        return Promise.resolve(machine('2.0'))
      },
    })
    facts.ensure('machine')
    facts.sessionChanged('fresh')
    await facts.when('machine')
    stale.resolve(machine('1.0'))
    await stale.promise
    expect(facts.value('machine')?.version).toBe('2.0')
  })

  test('refresh with a max age keeps a recent read', async () => {
    let calls = 0
    let clock = 0
    const { facts } = makeFacts({ usageLimits: async () => { calls += 1; return [] } }, () => clock)
    await facts.refresh('usage', { maxAgeMs: 60_000 })
    clock = 30_000
    await facts.refresh('usage', { maxAgeMs: 60_000 })
    expect(calls).toBe(1)
    clock = 61_000
    await facts.refresh('usage', { maxAgeMs: 60_000 })
    expect(calls).toBe(2)
  })

  test('a waiting reader retries a failed fact once', async () => {
    let calls = 0
    const { facts } = makeFacts({
      start: async () => {
        calls += 1
        if (calls === 1) throw new Error('offline')
        return machine('1.0')
      },
    })
    facts.ensure('machine')
    await Promise.resolve()
    await Promise.resolve()
    expect((await facts.when('machine')).version).toBe('1.0')
  })

  test('listeners hear which fact changed', async () => {
    const { facts } = makeFacts({ start: async () => machine('1.0') })
    const heard: string[] = []
    facts.subscribe((key) => heard.push(key))
    await facts.when('machine')
    expect(heard).toEqual(['machine'])
  })
})
