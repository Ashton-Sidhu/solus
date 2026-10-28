import { expect, test } from 'bun:test'
import { encodePathAsFolder, isSolusWorktreePath, worktreeProjectRoot } from '@solus/contracts/types'

// WHY: a Windows host names its paths with `\`. With `/` markers alone, a
// worktree there was not a worktree: its sessions grouped under their own
// folder instead of the project.

test('a Windows worktree path is a worktree of its project', () => {
  const worktree = 'C:\\code\\solus\\.git\\solus\\worktrees\\fix-login'
  expect(isSolusWorktreePath(worktree)).toBe(true)
  expect(worktreeProjectRoot(worktree)).toBe('C:\\code\\solus')
  expect(isSolusWorktreePath('C:\\code\\solus')).toBe(false)
})

test('a Windows path encodes as Claude Code names its project folder', () => {
  expect(encodePathAsFolder('C:\\Users\\me\\repo')).toBe('C--Users-me-repo')
  // Encoding twice changes nothing, so an encoded folder name is safe to pass again.
  expect(encodePathAsFolder('C--Users-me-repo')).toBe('C--Users-me-repo')
})
