import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { syncWithOrigin } from '../../src/main/git/worktree-manager'

let roots: string[] = []

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`)
  return result.stdout.trim()
}

function createDivergedRepo(): { local: string } {
  const root = mkdtempSync(join(tmpdir(), 'solus-worktree-sync-'))
  roots.push(root)
  const origin = join(root, 'origin.git')
  const local = join(root, 'local')
  const peer = join(root, 'peer')

  mkdirSync(origin)
  git(origin, ['init', '--bare', '--initial-branch=main'])
  git(root, ['clone', origin, local])
  git(local, ['config', 'user.email', 'test@solus.local'])
  git(local, ['config', 'user.name', 'Solus Test'])
  git(local, ['config', 'pull.rebase', 'false'])
  git(local, ['config', 'core.editor', 'false'])
  writeFileSync(join(local, 'base.txt'), 'base\n')
  git(local, ['add', 'base.txt'])
  git(local, ['commit', '-m', 'base'])
  git(local, ['push', '-u', 'origin', 'main'])

  git(root, ['clone', origin, peer])
  git(peer, ['config', 'user.email', 'test@solus.local'])
  git(peer, ['config', 'user.name', 'Solus Test'])
  writeFileSync(join(peer, 'remote.txt'), 'remote\n')
  git(peer, ['add', 'remote.txt'])
  git(peer, ['commit', '-m', 'remote change'])
  git(peer, ['push'])

  writeFileSync(join(local, 'local.txt'), 'local\n')
  git(local, ['add', 'local.txt'])
  git(local, ['commit', '-m', 'local change'])
  return { local }
}

describe('syncWithOrigin', () => {
  test('accepts the default merge message instead of opening an editor', async () => {
    for (const usesWorktreePath of [false, true]) {
      const { local } = createDivergedRepo()
      const result = await syncWithOrigin(
        {
          branch: 'main',
          targetBranch: 'main',
          worktreePath: usesWorktreePath ? local : undefined,
        },
        local,
      )

      expect(result).toEqual({ success: true, outcome: 'synced' })
      expect(git(local, ['rev-list', '--parents', '-n', '1', 'HEAD']).split(' ')).toHaveLength(3)
    }
  })
})
