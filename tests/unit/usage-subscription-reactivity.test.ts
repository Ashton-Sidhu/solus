import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { effect_root, get, set, state, untrack, user_effect } from 'svelte/internal/client'

test('usage cache writes do not restart a panel subscription, and hiding it releases the clock and the watch', async () => {
  const source = readFileSync(new URL('../../packages/workspace-ui/src/components/project-panel/UsageMeters.svelte', import.meta.url), 'utf8')
  const effect = source.slice(source.indexOf('  $effect('), source.indexOf('  const barTone'))
  const install = new Function('scope', `with (scope) { ${effect} }`)
  const active = state(true)
  const cache = state(0)
  let watches = 0
  let held = 0
  let subscriptions = 0
  const scope = {
    $effect: user_effect, untrack,
    get active() { return get(active) },
    host: { watchUsage: () => { get(cache); watches++; held++; return () => { held-- } } },
    now: 0,
    messageTimestampClock: { subscribe(update: (now: number) => void) {
      subscriptions++
      update(100)
      return () => { subscriptions-- }
    } },
  }
  const stop = effect_root(() => install(scope))
  try {
    await Promise.resolve()
    expect(watches).toBe(1)
    expect(subscriptions).toBe(1)
    set(cache, 1)
    await Promise.resolve()
    expect(watches).toBe(1)
    set(active, false)
    await Promise.resolve()
    expect(subscriptions).toBe(0)
    expect(held).toBe(0)
    set(active, true)
    await Promise.resolve()
    expect(watches).toBe(2)
    expect(subscriptions).toBe(1)
  } finally { stop() }
  expect(subscriptions).toBe(0)
  expect(held).toBe(0)
})
