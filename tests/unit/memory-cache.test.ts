import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { MemoryCache } from '../../src/shared/cache'

afterEach(() => setSystemTime())

describe('MemoryCache retention', () => {
  test('prunes expired entries when new values are written', () => {
    setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const cache = new MemoryCache<string, string>({ ttlMs: 1_000 })
    cache.set('stale-project', 'old')

    setSystemTime(new Date('2026-01-01T00:00:02Z'))
    cache.set('active-project', 'new')

    expect(cache.keys({ includeStale: true })).toEqual(['active-project'])
  })

  test('evicts the least recently used entry at its configured cap', () => {
    const cache = new MemoryCache<string, number>({ maxEntries: 2 })
    cache.set('first', 1)
    cache.set('second', 2)
    expect(cache.get('first')).toBe(1)
    cache.set('third', 3)

    expect(cache.get('second')).toBeUndefined()
    expect(cache.keys()).toEqual(['first', 'third'])
  })
})
