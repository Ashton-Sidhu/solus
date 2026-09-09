import { describe, expect, test } from 'bun:test'
import type { GitState } from '@solus/contracts/types'
import { mergeConflictDraft } from '@solus/workspace-ui/components/project-panel/lib/merge-conflict-draft'

function status(overrides: Partial<GitState['uncommittedChanges']> = {}): GitState {
  return {
    repoRoot: '/repo',
    headSha: 'abc123',
    branch: 'feature/conflict',
    targetBranch: 'main',
    upstreamRef: 'origin/feature/conflict',
    aheadCount: 0,
    behindCount: 0,
    targetAheadCount: 0,
    uncommittedChanges: {
      files: [],
      hasMoreFiles: false,
      insertions: 0,
      deletions: 0,
      mergeInProgress: false,
      ...overrides,
    },
  }
}

describe('merge conflict draft', () => {
  test('does not create a prompt when the latest Git state has no conflicts', () => {
    // WHY: the conflict row can be stale by the time the user clicks it. That
    // click must not open a composer for work that no longer exists.
    expect(mergeConflictDraft(status())).toBeNull()
  })

  test('names only files that the latest Git state still marks as conflicted', () => {
    const prompt = mergeConflictDraft(status({
      files: [
        { path: 'src/conflicted.ts', conflicted: true },
        { path: 'src/changed.ts', conflicted: false },
      ],
    }))

    expect(prompt).toContain('Resolve the merge conflicts on branch feature/conflict.')
    expect(prompt).toContain('- src/conflicted.ts')
    expect(prompt).not.toContain('src/changed.ts')
  })

  test('does not treat a merge with all conflicts fixed as an unresolved conflict', () => {
    expect(mergeConflictDraft(status({ mergeInProgress: true }))).toBeNull()
  })
})
