import { afterAll, afterEach, describe, expect, jest, test } from 'bun:test'
import type { PaneEntry } from '@solus/workspace-ui/contexts/workspace/routing/location'
import { SvelteRunes } from './helpers/svelte-runes'

// WHY: a companion pane mounts its surface only once it is settled. A pane
// that opens again while it still animates out must settle again, or its
// shell shows with no surface in it.

const runes = new SvelteRunes()
afterAll(() => runes.dispose())

const panesModule = runes.source('companion-panes', 'packages/workspace-ui/src/components/layout/lib/companion-panes.svelte.ts', {
  'svelte/reactivity': SvelteRunes.file('node_modules/svelte/src/reactivity/index-client.js'),
})
const { CompanionPanes, COMPANION_CONTENT_DELAY_MS, COMPANION_EXIT_MS } = await import(panesModule) as {
  CompanionPanes: new (reduceMotion: () => boolean) => {
    ids: string[]
    settled: Set<string>
    sync(live: readonly PaneEntry[]): void
    isClosing(paneId: string): boolean
  }
  COMPANION_CONTENT_DELAY_MS: number
  COMPANION_EXIT_MS: number
}

const pane = { id: 'pane-1', surfaces: [], activeSurfaceIndex: 0 } as unknown as PaneEntry

afterEach(() => {
  jest.useRealTimers()
})

describe('companion panes', () => {
  test('a pane opened again while it closes settles again', () => {
    jest.useFakeTimers()
    const panes = new CompanionPanes(() => false)
    panes.sync([pane])
    jest.advanceTimersByTime(COMPANION_CONTENT_DELAY_MS)
    expect(panes.settled.has(pane.id)).toBe(true)

    panes.sync([])
    expect(panes.isClosing(pane.id)).toBe(true)
    expect(panes.settled.has(pane.id)).toBe(false)

    panes.sync([pane])
    jest.advanceTimersByTime(Math.max(COMPANION_CONTENT_DELAY_MS, COMPANION_EXIT_MS))
    expect(panes.isClosing(pane.id)).toBe(false)
    expect(panes.ids).toEqual([pane.id])
    expect(panes.settled.has(pane.id)).toBe(true)
  })
})
