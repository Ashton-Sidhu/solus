import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { ChangedFileStat, DiffScope } from '../../src/shared/git-types'
import { buildDiffSummaryTree } from '../../src/renderer/components/conversation/lib/diff-summary-tree'

const previousState = (globalThis as unknown as { $state?: unknown }).$state
let DiffSummaryStore: typeof import('../../src/renderer/components/conversation/diff-summary.store.svelte').DiffSummaryStore

beforeAll(async () => {
  ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
  ;({ DiffSummaryStore } = await import(
    '../../src/renderer/components/conversation/diff-summary.store.svelte'
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
