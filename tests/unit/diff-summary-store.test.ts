import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { ChangedFileStat, DiffScope } from '@solus/contracts/git-types'
import { buildDiffSummaryTree, diffCountLine } from '@solus/workspace-ui/components/conversation/lib/diff-summary-tree'

const previousState = (globalThis as unknown as { $state?: unknown }).$state
let DiffSummaryStore: typeof import('@solus/workspace-ui/components/conversation/diff-summary.store.svelte').DiffSummaryStore

beforeAll(async () => {
  ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
  ;({ DiffSummaryStore } = await import(
    '@solus/workspace-ui/components/conversation/diff-summary.store.svelte'
  ))
})

afterAll(() => {
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

describe('DiffSummaryStore', () => {
  test('loads a closing summary from its turn scope instead of the cumulative session scope', async () => {
    const requests: DiffScope[] = []
    const turnStats: ChangedFileStat[] = [
      { path: 'src/turn-only.ts', additions: 3, deletions: 1, status: 'M' },
    ]
    const workspace = {
      apiFor: () => ({
        diffStats: async (_ctx: unknown, request: { scope: DiffScope }) => {
          requests.push(request.scope)
          return turnStats
        },
      }),
      ctxFor: () => ({}),
      // The resolver: the summary is the session's, fetched through its tab.
      tabIdForSession: () => 'tab-1',
    } as never
    const store = new DiffSummaryStore()
    const scope = { kind: 'turn', index: 2 } as const

    store.refresh(workspace, 'session-1', scope)
    await Promise.resolve()
    await Promise.resolve()

    expect(requests).toEqual([scope])
    expect(store.statsFor('session-1', scope)).toEqual(turnStats)
    expect(store.statsFor('session-1', { kind: 'session' })).toEqual([])
  })

  test('the turn cards that mount together read their stats in one call, and an older host is asked per card', async () => {
    // WHY: each turn card of a conversation asked for its own turn's stats as
    // it mounted, two or three calls in the same millisecond on every open.
    const calls: string[] = []
    let batchSupported = true
    const stats = (index: number): ChangedFileStat[] => [{ path: `turn-${index}.ts`, additions: index, deletions: 0, status: 'M' }]
    const indexOf = (scope: DiffScope) => scope.kind === 'turn' ? scope.index : -1
    const workspace = {
      apiFor: () => ({
        diffStats: async (_ctx: unknown, request: { scope: DiffScope }) => {
          calls.push(`one:${indexOf(request.scope)}`)
          return stats(indexOf(request.scope))
        },
        diffStatsBatch: async (_ctx: unknown, requests: Array<{ scope: DiffScope }>) => {
          if (!batchSupported) throw new Error('SolusServer: no handler for "diffStatsBatch"')
          calls.push(`batch:${requests.map(({ scope }) => indexOf(scope)).join(',')}`)
          return requests.map(({ scope }) => stats(indexOf(scope)))
        },
      }),
      ctxFor: () => ({}),
      tabIdForSession: () => 'tab-1',
    } as never
    const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve() }

    const store = new DiffSummaryStore()
    for (const index of [0, 2, 6]) store.refresh(workspace, 'session-1', { kind: 'turn', index })
    await settle()
    expect(calls).toEqual(['batch:0,2,6'])
    expect(store.statsFor('session-1', { kind: 'turn', index: 6 })).toEqual(stats(6))

    calls.length = 0
    batchSupported = false
    const older = new DiffSummaryStore()
    for (const index of [1, 3]) older.refresh(workspace, 'session-2', { kind: 'turn', index })
    await settle()
    expect(calls).toEqual(['one:1', 'one:3'])
    expect(older.statsFor('session-2', { kind: 'turn', index: 3 })).toEqual(stats(3))
  })

  test("a closed turn card counts from its snapshot's totals, and from the files once read", () => {
    // WHY: opening a conversation read every visible turn's per-file stats only
    // to draw closed count lines that the turn snapshot already holds.
    const totals = { files: 3, additions: 12, deletions: 4 }
    expect(diffCountLine(buildDiffSummaryTree(undefined, []), totals)).toEqual({ ...totals, folders: 0 })
    const read = buildDiffSummaryTree(undefined, [
      { path: 'src/a.ts', additions: 10, deletions: 4, status: 'M' },
      { path: 'docs/b.md', additions: 2, deletions: 0, status: 'A' },
    ])
    expect(diffCountLine(read, totals)).toEqual({ files: 2, folders: read.folderCount, additions: 12, deletions: 4 })
  })

  test('uses git stats as the changed-file list for a turn summary', () => {
    const stats: ChangedFileStat[] = [
      { path: 'src/turn-only.ts', additions: 3, deletions: 1, status: 'M' },
    ]

    const tree = buildDiffSummaryTree(undefined, stats)

    expect(tree.total).toBe(1)
    expect(tree.root.folders[0]?.files[0]?.path).toBe('src/turn-only.ts')
    expect(tree.additions).toBe(3)
    expect(tree.deletions).toBe(1)
  })
})
