import { describe, expect, test } from 'bun:test'
import type { GitCheckout } from '@solus/contracts/types'
import { worktreeDividerName } from '@solus/workspace-ui/components/conversation/lib/worktree-divider'

const worktreePath = '/repo/.git/solus/worktrees/solus-879239e6'
const checkout: GitCheckout = {
  repoRoot: '/repo',
  worktreePath,
  branch: 'match-pr-list-item-sizing',
  targetBranch: 'main',
}

describe('worktree divider names', () => {
  test('follows generated and later manual renames for the same checkout', () => {
    const message = { worktreeMovedTo: 'solus/879239e6', worktreeMovedToPath: worktreePath }
    expect(worktreeDividerName(message, checkout)).toBe('match-pr-list-item-sizing')
    expect(worktreeDividerName(message, { ...checkout, branch: 'another-name' })).toBe('another-name')
    expect(worktreeDividerName(message, { ...checkout, branch: 'solus/another-name' })).toBe('another-name')
  })

  test('repairs an older divider from its original managed worktree slug', () => {
    expect(worktreeDividerName({ worktreeMovedTo: 'solus/879239e6' }, checkout))
      .toBe('match-pr-list-item-sizing')
  })

  test('preserves history when viewing a different checkout or missing Git state', () => {
    const message = { worktreeMovedTo: 'old-name', worktreeMovedToPath: '/other/checkout' }
    expect(worktreeDividerName(message, checkout)).toBe('old-name')
    expect(worktreeDividerName(message, null)).toBe('old-name')
    expect(worktreeDividerName({ worktreeMovedTo: 'unrelated' }, checkout)).toBe('unrelated')
  })

  test('shows detached state without retaining the old branch name', () => {
    expect(worktreeDividerName(
      { worktreeMovedTo: 'solus/879239e6', worktreeMovedToPath: worktreePath },
      { ...checkout, branch: null, detachedHeadSha: 'abc123' },
    )).toBe('abc123')
  })
})
