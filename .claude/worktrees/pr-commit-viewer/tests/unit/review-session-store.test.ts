import { afterEach, describe, expect, test } from 'bun:test'

const previousState = (globalThis as unknown as { $state?: unknown }).$state

afterEach(() => {
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

describe('ReviewSessionStore effort totals', () => {
  test('reflects effort that becomes known after the session starts', async () => {
    ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
    const { ReviewSessionStore } = await import(
      '../../src/renderer/components/review-mode/review-session.store.svelte'
    )
    const minutes = new Map<number, number>()
    const store = new ReviewSessionStore()

    store.start({
      items: [{ number: 101 }],
      stackGraph: null,
      minutesFor: (prNumber) => minutes.get(prNumber),
      poster: { async post() {} },
      visibilitySource: null,
    })

    expect(store.totalMinutes).toBeNull()

    minutes.set(101, 7)

    expect(store.totalMinutes).toBe(7)
    store.detach()
  })
})
