import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { buildGitWatchTargets } from '@solus/server/git/git-watcher'

describe('GitWatcher targets', () => {
  test('watches a linked worktree HEAD and index outside the common git directory', () => {
    const targets = buildGitWatchTargets({
      commonDir: '/repo/.git',
      headPath: '/repo/.git/worktrees/feature/HEAD',
      indexPath: '/repo/.git/worktrees/feature/index',
    })

    const worktreeTarget = targets.find((target) => target.directory === '/repo/.git/worktrees/feature')
    expect(worktreeTarget?.recursive).toBe(false)
    expect([...worktreeTarget!.names!].sort()).toEqual(['HEAD', 'index'])

    // The refs folder is joined with the host's separator.
    const refsTarget = targets.find((target) => target.directory === join('/repo/.git', 'refs', 'heads'))
    expect(refsTarget).toEqual({
      directory: join('/repo/.git', 'refs', 'heads'),
      recursive: true,
      names: null,
    })
  })

  test('coalesces main-checkout HEAD, index, and packed refs onto one stable directory watch', () => {
    const targets = buildGitWatchTargets({
      commonDir: '/repo/.git',
      headPath: '/repo/.git/HEAD',
      indexPath: '/repo/.git/index',
    })

    const gitDirTarget = targets.find((target) => target.directory === '/repo/.git')
    expect([...gitDirTarget!.names!].sort()).toEqual(['HEAD', 'index', 'packed-refs'])
  })
})
