import { describe, expect, test } from 'bun:test'

import { PrMirror } from '../../packages/workspace-ui/src/contexts/prs/pr-mirror'

/** A load that stays pending until the test releases it, counting its callers. */
function deferredLoad(): { load: () => Promise<string>; calls: () => number; resolve: (value: string) => void } {
  let calls = 0
  let release: (value: string) => void = () => {}
  const pending = new Promise<string>((resolvePending) => {
    release = resolvePending
  })
  return {
    load: () => {
      calls += 1
      return pending
    },
    calls: () => calls,
    resolve: (value) => release(value),
  }
}

describe('PrMirror in-flight coalescing', () => {
  // The sidebar's PR poll forces a read for every task row against the same few
  // branches. If `force` refused to join a flight, ~95 rows asking about `main`
  // cost ~95 prList round trips per poll instead of one.
  test('forced readers of one key share a single round trip', async () => {
    const mirror = new PrMirror<string>()
    const source = deferredLoad()

    const readers = Array.from({ length: 20 }, () => mirror.read('all::::main::1', true, source.load))
    source.resolve('page')

    expect(await Promise.all(readers)).toEqual(Array(20).fill('page'))
    expect(source.calls()).toBe(1)
  })

  test('an unforced reader joins a forced flight', async () => {
    const mirror = new PrMirror<string>()
    const source = deferredLoad()

    const forced = mirror.read('key', true, source.load)
    const unforced = mirror.read('key', false, source.load)
    source.resolve('page')

    expect(await forced).toBe('page')
    expect(await unforced).toBe('page')
    expect(source.calls()).toBe(1)
  })

  // `force` exists so a caller can see past what the client already believes.
  // A flight that began before the force may predate the change it is looking
  // for, so joining it would answer the wrong question.
  test('a forced reader does not join an unforced flight', async () => {
    const mirror = new PrMirror<string>()
    const stale = deferredLoad()
    const fresh = deferredLoad()

    const unforced = mirror.read('key', false, stale.load)
    const forced = mirror.read('key', true, fresh.load)
    stale.resolve('stale')
    fresh.resolve('fresh')

    expect(await unforced).toBe('stale')
    expect(await forced).toBe('fresh')
    expect(stale.calls()).toBe(1)
    expect(fresh.calls()).toBe(1)
  })

  test('force still bypasses a stored fresh value', async () => {
    const mirror = new PrMirror<string>()
    mirror.seed('key', 'cached')

    let calls = 0
    const value = await mirror.read('key', true, async () => {
      calls += 1
      return 'reread'
    })

    expect(value).toBe('reread')
    expect(calls).toBe(1)
  })

  test('a settled flight is not joined by the next reader', async () => {
    const mirror = new PrMirror<string>()
    let calls = 0
    const load = async (): Promise<string> => {
      calls += 1
      return `page${calls}`
    }

    expect(await mirror.read('key', true, load)).toBe('page1')
    expect(await mirror.read('key', true, load)).toBe('page2')
    expect(calls).toBe(2)
  })

  test('a rejected forced flight leaves the stored value intact', async () => {
    const mirror = new PrMirror<string>()
    mirror.seed('key', 'cached')

    await expect(mirror.read('key', true, () => Promise.reject(new Error('host unreachable')))).rejects.toThrow(
      'host unreachable',
    )
    expect(mirror.fresh('key')).toBe('cached')
  })
})
