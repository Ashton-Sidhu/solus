import { beforeAll, describe, expect, test } from 'bun:test'
import type { GitCheckout } from '../../src/shared/types'

let PaneViewStore: typeof import('../../src/renderer/contexts/workspace/pane-view.store.svelte').PaneViewStore

beforeAll(async () => {
  ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
  ;({ PaneViewStore } = await import('../../src/renderer/contexts/workspace/pane-view.store.svelte'))
})

describe('review pane origin', () => {
  test('keeps the checkout that produced the guide', () => {
    const panes = new PaneViewStore()
    const gitContext: GitCheckout = {
      branch: 'solus/fix-review',
      targetBranch: 'main',
      repoRoot: '/repo',
      worktreePath: '/repo/.solus-worktrees/fix-review',
    }

    panes.enterReview('solus__fix-review', 'branch', {
      sourceTabId: 'source-tab',
      workingDirectory: gitContext.worktreePath!,
      gitContext,
    })

    expect(panes.primaryContent).toEqual({
      kind: 'review',
      key: 'solus__fix-review',
      scope: 'branch',
      sourceTabId: 'source-tab',
      workingDirectory: gitContext.worktreePath,
      gitContext,
    })
  })
})
