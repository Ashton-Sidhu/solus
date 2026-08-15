import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { ChangedFileStat } from '../../src/shared/git-types'
import { diffTotals, orderedSelection } from '../../src/renderer/components/project-panel/commit-composer/lib/commit-composer'

const previousState = (globalThis as unknown as { $state?: unknown }).$state
let CommitComposerState: typeof import(
  '../../src/renderer/components/project-panel/commit-composer/lib/commit-composer.svelte'
).CommitComposerState

beforeAll(async () => {
  ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
  ;({ CommitComposerState } = await import(
    '../../src/renderer/components/project-panel/commit-composer/lib/commit-composer.svelte'
  ))
})

afterAll(() => {
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

const files: ChangedFileStat[] = [
  { path: 'a.txt', additions: 3, deletions: 1, status: 'M' },
  { path: 'b.txt', additions: 0, deletions: 5, status: 'D' },
  { path: 'c.txt', additions: 2, deletions: 0, status: 'A' },
]

describe('orderedSelection', () => {
  test('returns selected paths in the file list\'s own order', () => {
    const selected = new Set(['c.txt', 'a.txt'])
    expect(orderedSelection(files, selected)).toEqual(['a.txt', 'c.txt'])
  })

  test('drops a selected path the file list no longer contains', () => {
    const selected = new Set(['a.txt', 'stale.txt'])
    expect(orderedSelection(files, selected)).toEqual(['a.txt'])
  })

  test('returns an empty array when nothing is selected', () => {
    expect(orderedSelection(files, new Set())).toEqual([])
  })
})

describe('diffTotals', () => {
  test('sums additions and deletions across files', () => {
    expect(diffTotals(files)).toEqual({ additions: 5, deletions: 6 })
  })

  test('is zero for an empty file list', () => {
    expect(diffTotals([])).toEqual({ additions: 0, deletions: 0 })
  })
})

describe('CommitComposerState', () => {
  test('selects every loaded file by default and tracks selection totals', async () => {
    const api = { diffStats: async () => files } as any
    const state = new CommitComposerState()

    await state.load(api, {} as any)

    expect(state.loading).toBe(false)
    expect(state.loadError).toBeNull()
    expect(state.selectedPaths).toEqual(['a.txt', 'b.txt', 'c.txt'])
    expect(state.canSubmit).toBe(true)

    state.toggle('b.txt')
    expect(state.selectedPaths).toEqual(['a.txt', 'c.txt'])

    state.selectNone()
    expect(state.selectedPaths).toEqual([])
    expect(state.canSubmit).toBe(false)

    state.selectAll()
    expect(state.selectedPaths).toEqual(['a.txt', 'b.txt', 'c.txt'])
  })

  test('surfaces a load failure instead of leaving a stale file list', async () => {
    const api = { diffStats: async () => { throw new Error('diffStats unavailable') } } as any
    const state = new CommitComposerState()

    await state.load(api, {} as any)

    expect(state.loading).toBe(false)
    expect(state.loadError).toBe('diffStats unavailable')
    expect(state.files).toEqual([])
    expect(state.canSubmit).toBe(false)
  })
})
