import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getDiffStats,
  initSessionBase,
  prepareTurnSnapshot,
  snapshotTurn,
} from '@solus/server/git/session-snapshots'

const repos: string[] = []

afterEach(() => {
  for (const repo of repos) rmSync(repo, { recursive: true, force: true })
  repos.length = 0
})

function git(cwd: string, args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`)
  return result.stdout.trim()
}

function createRepo() {
  const cwd = mkdtempSync(join(tmpdir(), 'solus-turn-diff-'))
  repos.push(cwd)
  git(cwd, ['init'])
  git(cwd, ['config', 'user.email', 'test@example.com'])
  git(cwd, ['config', 'user.name', 'Test'])
  writeFileSync(join(cwd, 'tracked.txt'), 'first\n')
  git(cwd, ['add', '.'])
  git(cwd, ['commit', '-m', 'base'])
  return { cwd, baseSha: git(cwd, ['rev-parse', 'HEAD']) }
}

describe('turn diff stats', () => {
  test('exclude edits that were already present when the turn started', async () => {
    const { cwd, baseSha } = createRepo()
    await initSessionBase(cwd, 'session-1', baseSha)
    writeFileSync(join(cwd, 'tracked.txt'), 'first\npre-existing\n')
    await prepareTurnSnapshot(cwd, cwd, 'session-1')

    writeFileSync(join(cwd, 'tracked.txt'), 'first\npre-existing\nthis turn\n')
    const result = await snapshotTurn(cwd, cwd, 'session-1', {
      sessionChangedFiles: ['tracked.txt'],
      turnChangedFiles: ['tracked.txt'],
    })

    expect(result?.snapshot).toMatchObject({ filesChanged: 1, additions: 1, deletions: 0 })
    expect(await getDiffStats(cwd, cwd, { kind: 'turn', index: 0 }, 'session-1', [])).toEqual([
      { path: 'tracked.txt', additions: 1, deletions: 0, status: 'M' },
    ])
  })
})
