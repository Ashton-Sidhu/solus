import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { ChangedFileStat } from '../../src/shared/git-types'
import {
  filterFiles,
  orderedSelection,
  splitPath,
} from '../../src/renderer/components/project-panel/commit-composer/lib/commit-composer'
import { changedFileTotals } from '../../src/renderer/lib/diff-stats'

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
  test('returns selected files in the list\'s own order', () => {
    const selected = new Set(['c.txt', 'a.txt'])
    expect(orderedSelection(files, selected).map((file) => file.path)).toEqual(['a.txt', 'c.txt'])
  })

  test('drops a selected path the file list no longer contains', () => {
    const selected = new Set(['a.txt', 'stale.txt'])
    expect(orderedSelection(files, selected).map((file) => file.path)).toEqual(['a.txt'])
  })

  test('returns an empty array when nothing is selected', () => {
    expect(orderedSelection(files, new Set())).toEqual([])
  })
})

const nestedFiles: ChangedFileStat[] = [
  { path: 'src/main/git/git-init.ts', additions: 4, deletions: 0, status: 'M' },
  { path: 'src/renderer/lib/git-actions.svelte.ts', additions: 1, deletions: 1, status: 'M' },
  { path: 'tests/unit/git-init.test.ts', additions: 9, deletions: 0, status: 'A' },
]

describe('filterFiles', () => {
  test('matches anywhere in the path, ignoring case', () => {
    expect(filterFiles(nestedFiles, 'GIT-INIT').map((file) => file.path)).toEqual([
      'src/main/git/git-init.ts',
      'tests/unit/git-init.test.ts',
    ])
  })

  test('narrows on every term rather than widening', () => {
    expect(filterFiles(nestedFiles, 'git tests').map((file) => file.path)).toEqual([
      'tests/unit/git-init.test.ts',
    ])
  })

  test('an empty or blank query keeps the whole list', () => {
    expect(filterFiles(nestedFiles, '')).toEqual(nestedFiles)
    expect(filterFiles(nestedFiles, '   ')).toEqual(nestedFiles)
  })
})

describe('splitPath', () => {
  test('separates the folders from the file name so the name can stay legible', () => {
    expect(splitPath('src/main/git/git-init.ts')).toEqual({ folders: 'src/main/git/', name: 'git-init.ts' })
  })

  test('a bare file name has no folders', () => {
    expect(splitPath('README.md')).toEqual({ folders: '', name: 'README.md' })
  })
})

describe('changedFileTotals', () => {
  test('sums additions and deletions across files', () => {
    expect(changedFileTotals(files)).toEqual({ additions: 5, deletions: 6 })
  })

  test('is zero for an empty file list', () => {
    expect(changedFileTotals([])).toEqual({ additions: 0, deletions: 0 })
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

  // A filter is a view, not a scope change: "Select all" that reached past the
  // visible rows would commit files the user cannot see, and "None" that did so
  // would silently drop them.
  test('select all and none act only on what the filter shows', async () => {
    const api = { diffStats: async () => nestedFiles } as any
    const state = new CommitComposerState()
    await state.load(api, {} as any)

    state.query = 'tests'
    expect(state.visibleFiles.map((file) => file.path)).toEqual(['tests/unit/git-init.test.ts'])

    state.selectNone()
    expect(state.selectedPaths).toEqual([
      'src/main/git/git-init.ts',
      'src/renderer/lib/git-actions.svelte.ts',
    ])
    expect(state.visibleSelectedCount).toBe(0)

    state.query = 'renderer'
    state.selectNone()
    state.query = 'tests'
    state.selectAll()
    expect(state.selectedPaths).toEqual([
      'src/main/git/git-init.ts',
      'tests/unit/git-init.test.ts',
    ])
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
