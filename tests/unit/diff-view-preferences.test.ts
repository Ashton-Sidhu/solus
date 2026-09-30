import { afterEach, describe, expect, test } from 'bun:test'

// The diff panel and the Insights result read one preference. The stored keys
// are the ones the diff panel always wrote, so a reader's choice made before
// the preference was shared still applies.

const previousStorage = (globalThis as unknown as { localStorage?: Storage }).localStorage
const previousState = (globalThis as unknown as { $state?: unknown }).$state

function installStorage(initial: Record<string, string>): Map<string, string> {
  const values = new Map(Object.entries(initial))
  ;(globalThis as unknown as { localStorage: Pick<Storage, 'getItem' | 'setItem'> }).localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  }
  ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
  return values
}

async function freshPreferences() {
  const module = await import(`@solus/workspace-ui/lib/diff-view-preferences.svelte?${Math.random()}`)
  return module.diffViewPreferences
}

afterEach(() => {
  ;(globalThis as unknown as { localStorage?: Storage }).localStorage = previousStorage
  ;(globalThis as unknown as { $state?: unknown }).$state = previousState
})

describe('diff view preferences', () => {
  test('a choice stored by the diff panel is the starting choice', async () => {
    installStorage({ 'solus-diff-style': 'split', 'solus-diff-token-highlight': 'off' })
    const preferences = await freshPreferences()
    expect(preferences.diffStyle).toBe('split')
    expect(preferences.tokenHighlight).toBe(false)
  })

  test('token highlighting is on unless it was turned off, and a change is stored', async () => {
    const values = installStorage({})
    const preferences = await freshPreferences()
    expect(preferences.diffStyle).toBe('unified')
    expect(preferences.tokenHighlight).toBe(true)

    preferences.setDiffStyle('split')
    preferences.toggleTokenHighlight()

    expect(values.get('solus-diff-style')).toBe('split')
    expect(values.get('solus-diff-token-highlight')).toBe('off')
  })
})
