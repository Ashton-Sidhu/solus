import { describe, expect, test } from 'bun:test'
import { asHostApi } from '@solus/client-core/host-api'
import { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import { HostFacts, type HostFactKey } from '@solus/client-core/host-facts'
import { keepEqual } from '@solus/client-core/keep-equal'
import type { AgentUsageLimits, StartInfo } from '@solus/contracts/types'

// docs/plans/host-model.md §3.2: an answer equal to the fact held keeps the
// held value and wakes no reader. Desktop and web read each fact through its
// own Svelte subscriber; native reads `serverInfo` for every connection row,
// so an equal answer that notifies re-renders all of them for nothing.

function usage(provider: AgentUsageLimits['provider'], usedPercent: number): AgentUsageLimits {
  return { provider, fiveHour: { usedPercent, resetsAt: null, resetsLabel: null }, weekly: null, planType: null, fetchedAt: 1, stale: false }
}

function machine(version: string): StartInfo {
  return { version, projectPath: '/p', homePath: '/h', agents: [] }
}

interface Fixture {
  usage: AgentUsageLimits[]
  machine: StartInfo
  fail: boolean
}

function makeFacts(clock = { now: 0 }) {
  const fixture: Fixture = { usage: [usage('claude-code', 1), usage('codex', 2)], machine: machine('1.0'), fail: false }
  const calls = { usage: 0, machine: 0 }
  const events = new HostEventSubscriber()
  const api = asHostApi({
    serverGetCapabilities: async () => ({ voiceModel: true }),
    // A new array of new objects on every read, as a host sends it.
    usageLimits: async () => {
      calls.usage += 1
      if (fixture.fail) throw new Error('offline')
      return structuredClone(fixture.usage)
    },
    start: async () => { calls.machine += 1; return structuredClone(fixture.machine) },
  })
  const facts = new HostFacts('host-a', { api, events }, () => clock.now)
  const heard: HostFactKey[] = []
  facts.subscribe((key) => heard.push(key))
  return { facts, fixture, calls, heard, events }
}

describe('HostFacts keeps equal answers', () => {
  test('an equal refresh keeps the ready fact and its value, wakes no reader, and still counts as a fresh read', async () => {
    const clock = { now: 0 }
    const { facts, calls, heard } = makeFacts(clock)
    await facts.refresh('usage')
    const before = facts.get('usage')
    clock.now = 50_000
    await facts.refresh('usage')
    expect(calls.usage).toBe(2)
    expect(facts.get('usage')).toBe(before)
    expect(heard).toEqual(['usage'])
    // The equal read moved the read time: a reader with a max age does not read again.
    clock.now = 100_000
    await facts.refresh('usage', { maxAgeMs: 60_000 })
    expect(calls.usage).toBe(2)
  })

  test('a changed answer reaches readers with the new value', async () => {
    const { facts, fixture, heard } = makeFacts()
    await facts.refresh('usage')
    const before = facts.get('usage')
    fixture.usage = [usage('claude-code', 1), usage('codex', 3)]
    await facts.refresh('usage')
    expect(heard).toEqual(['usage', 'usage'])
    expect(facts.get('usage')).not.toBe(before)
    expect(facts.value('usage')![1]).toEqual(usage('codex', 3))
  })

  test('a fresh server session reads every asked fact again; equal answers stay quiet, a changed one is heard', async () => {
    const { facts, fixture, calls, heard } = makeFacts()
    await facts.when('capabilities')
    await facts.when('usage')
    await facts.when('machine')
    const usageBefore = facts.get('usage')
    heard.length = 0
    fixture.machine = machine('2.0')
    facts.sessionChanged('fresh')
    await facts.when('usage')
    await facts.when('machine')
    expect(calls).toEqual({ usage: 2, machine: 2 })
    expect(facts.get('usage')).toBe(usageBefore)
    expect(heard).toEqual(['machine'])
    expect(facts.value('machine')?.version).toBe('2.0')
  })

  test('a recovered session reads nothing that is ready', async () => {
    const { facts, calls } = makeFacts()
    await facts.when('usage')
    facts.sessionChanged('recovered')
    await Promise.resolve()
    expect(calls.usage).toBe(1)
  })

  test('a drop still clears capabilities, and the equal answer after it is heard again', async () => {
    const { facts, heard } = makeFacts()
    const before = await facts.when('capabilities')
    heard.length = 0
    facts.sessionChanged('lost')
    expect(facts.get('capabilities')).toEqual({ state: 'loading' })
    expect(heard).toEqual(['capabilities', 'serverInfo'])
    facts.sessionChanged('fresh')
    expect(await facts.when('capabilities')).toEqual(before)
    expect(heard.filter((key) => key === 'capabilities')).toHaveLength(2)
  })

  test('an error after a ready fact is heard, and so is the equal answer that ends it', async () => {
    const { facts, fixture, heard } = makeFacts()
    await facts.refresh('usage')
    fixture.fail = true
    await facts.refresh('usage')
    expect(facts.get('usage')).toEqual({ state: 'error', message: 'offline' })
    fixture.fail = false
    await facts.refresh('usage')
    expect(facts.get('usage').state).toBe('ready')
    expect(heard).toEqual(['usage', 'usage', 'usage'])
  })

  test('an equal pushed answer stays quiet', async () => {
    const { facts, events, heard } = makeFacts()
    await facts.refresh('usage')
    const before = facts.get('usage')
    events.receive({ type: 'usage.limitsChanged', payload: { snapshots: [usage('claude-code', 1), usage('codex', 2)] }, occurredAt: 1 })
    expect(facts.get('usage')).toBe(before)
    expect(heard).toEqual(['usage'])
  })
})

describe('keepEqual', () => {
  test('an equal value keeps the held one; any change, added key, or longer list is new', () => {
    const held: { a?: number; b?: number; list: number[] } = { a: 1, list: [1, 2] }
    expect(keepEqual(structuredClone(held), held)).toBe(held)
    const changed = { a: 2, list: [1, 2] }
    expect(keepEqual(changed, held)).toBe(changed)
    expect(keepEqual({ a: 1, list: [1, 2], b: 2 }, held)).not.toBe(held)
    expect(keepEqual({ list: [1, 2] }, held)).not.toBe(held)
    expect(keepEqual({ a: 1, list: [1, 2, 3] }, held)).not.toBe(held)
  })
})
