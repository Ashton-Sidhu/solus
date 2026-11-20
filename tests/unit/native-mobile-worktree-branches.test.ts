import { describe, expect, test } from 'bun:test'
import type { BranchRef } from '@solus/contracts/git-types'
import { branchBadge, defaultWorktreeBase, selectedBranchName, worktreeBaseChoices } from '../../apps/mobile/src/features/threads/lib/worktree-branches'

const branch = (name: string, activeAt: number, extra: Partial<BranchRef> = {}): BranchRef => ({ name, activeAt, remoteOnly: false, isDefault: false, ...extra })

describe('new worktree base branch', () => {
  // WHY: turning on "New worktree" must name a real branch at once, because the
  // host makes a worktree only from a named base. The current checkout is the base when it is available.
  test('a new worktree starts from the current checkout, with defaults for detached or unavailable checkouts', () => {
    const branches = [branch('feature', 9), branch('main', 1, { isDefault: true })]
    expect(defaultWorktreeBase(branches, 'feature')).toBe('feature')
    expect(defaultWorktreeBase(branches, 'missing')).toBe('main')
    expect(defaultWorktreeBase(branches, null)).toBe('main')
    expect(defaultWorktreeBase([branch('feature', 9), branch('main', 1, { isDefault: true })])).toBe('main')
    expect(defaultWorktreeBase([branch('old', 1), branch('remote', 9, { remoteOnly: true }), branch('recent', 5)])).toBe('recent')
    expect(defaultWorktreeBase([branch('remote', 9, { remoteOnly: true })])).toBe('remote')
    expect(defaultWorktreeBase([])).toBeNull()
  })

  test('the picker lists the default branch first, then the newest, and finds by name', () => {
    const branches = [branch('a', 1), branch('main', 0, { isDefault: true }), branch('b', 5)]
    expect(worktreeBaseChoices(branches, '').map((choice) => choice.name)).toEqual(['main', 'b', 'a'])
    expect(worktreeBaseChoices(branches, ' B ').map((choice) => choice.name)).toEqual(['b'])
  })

  test('each row has T3\'s one badge: current, then worktree, then remote, then default', () => {
    // WHY: the badge tells the person what a pick does: nothing (current),
    // move to that worktree, or make a tracking branch. The first that applies wins.
    expect(branchBadge(branch('main', 1, { isDefault: true, current: true }), null)).toBe('CURRENT')
    expect(branchBadge(branch('fix', 1, { isDefault: true, worktreePath: '/work/fix' }), null)).toBe('WORKTREE')
    expect(branchBadge(branch('pr', 1, { remoteOnly: true, isDefault: true, current: false }), null)).toBe('REMOTE')
    expect(branchBadge(branch('main', 1, { isDefault: true, current: false }), null)).toBe('DEFAULT')
    expect(branchBadge(branch('old', 1, { current: false }), 'old')).toBeNull()
  })

  test('the selected row is the picked branch, else the checkout\'s, else the default, as T3', () => {
    const branches = [branch('main', 1, { isDefault: true, current: false }), branch('fix', 2, { current: true })]
    expect(selectedBranchName(branches, 'other')).toBe('other')
    expect(selectedBranchName(branches, null)).toBe('fix')
    expect(selectedBranchName([branch('main', 1, { isDefault: true })], null)).toBe('main')
    expect(selectedBranchName(null, null)).toBeNull()
  })

  test('an older host that marks no current branch gets it from the checkout\'s branch', () => {
    expect(branchBadge(branch('feature', 1), 'feature')).toBe('CURRENT')
    expect(branchBadge(branch('main', 1, { isDefault: true }), 'feature')).toBe('DEFAULT')
  })
})
