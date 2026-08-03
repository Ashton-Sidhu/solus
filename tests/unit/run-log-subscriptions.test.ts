import { describe, expect, test } from 'bun:test'
import { RunLogSubscriptions } from '../../src/main/run/run-log-subscriptions'

describe('RunLogSubscriptions', () => {
  test('returns concrete client ids watching one run', () => {
    const subscriptions = new RunLogSubscriptions()
    subscriptions.retain('client-a', '/repo', 'dev')
    subscriptions.retain('client-b', '/repo', 'dev')
    subscriptions.retain('client-c', '/repo', 'test')

    expect(subscriptions.clientIdsWatching('/repo', 'dev')).toEqual(['client-a', 'client-b'])
    expect(subscriptions.clientIdsWatching('/repo', 'test')).toEqual(['client-c'])
  })

  test('retention is idempotent and release is scoped to one run', () => {
    const subscriptions = new RunLogSubscriptions()
    subscriptions.retain('client-a', '/repo', 'dev')
    subscriptions.retain('client-a', '/repo', 'dev')
    subscriptions.retain('client-a', '/repo', 'test')

    expect(subscriptions.clientIdsWatching('/repo', 'dev')).toEqual(['client-a'])
    subscriptions.release('client-a', '/repo', 'dev')

    expect(subscriptions.clientIdsWatching('/repo', 'dev')).toEqual([])
    expect(subscriptions.clientIdsWatching('/repo', 'test')).toEqual(['client-a'])
  })

  test('releases every interest after a client expires', () => {
    const subscriptions = new RunLogSubscriptions()
    subscriptions.retain('client-a', '/repo-a', 'dev')
    subscriptions.retain('client-a', '/repo-b', 'dev')
    subscriptions.retain('client-b', '/repo-a', 'dev')

    subscriptions.releaseClient('client-a')

    expect(subscriptions.clientIdsWatching('/repo-a', 'dev')).toEqual(['client-b'])
    expect(subscriptions.clientIdsWatching('/repo-b', 'dev')).toEqual([])
  })
})
