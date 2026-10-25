import { afterEach, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { spawnSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

mock.module('node:sqlite', () => ({ DatabaseSync }))
const { beginTurnCheckpoint, endTurnCheckpoint } = await import('@solus/server/git/turn-checkpoints')
const { listTurnSnapshots } = await import('@solus/server/git/session-snapshots')
const { actAsHostForTests } = await import('@solus/server/execution/seats/acting-identity')

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs.length = 0
})

function git(cwd: string, args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`)
}

function createRepo() {
  const cwd = mkdtempSync(join(tmpdir(), 'solus-turn-checkpoints-'))
  dirs.push(cwd)
  git(cwd, ['init'])
  git(cwd, ['config', 'user.email', 'test@example.com'])
  git(cwd, ['config', 'user.name', 'Test'])
  writeFileSync(join(cwd, 'tracked.txt'), 'first\n')
  git(cwd, ['add', '.'])
  git(cwd, ['commit', '-m', 'base'])
  return cwd
}

// The helpers under test start processes; with no caller, they act as the host (plans/019).
actAsHostForTests()

describe('turn checkpoints', () => {
  // WHY: both backends hand a turn's start and end to this one owner. In the
  // main checkout an agent that edited only through the shell got an empty turn
  // and no "files changed" card; the owner reads the checkout, not a tool list.
  test('a turn in the main checkout records the edits it made through the shell', async () => {
    const cwd = createRepo()
    const target = { sessionId: 'solus-session', workTree: cwd }

    await beginTurnCheckpoint(target)
    writeFileSync(join(cwd, 'tracked.txt'), 'first\nfrom a sed -i\n')
    writeFileSync(join(cwd, 'from-shell.txt'), 'written by a Bash heredoc\n')
    const changedPaths = await endTurnCheckpoint(target, { partial: false, userMessagePreview: 'edit' })

    expect(changedPaths?.sort()).toEqual(['from-shell.txt', 'tracked.txt'])
    const turns = await listTurnSnapshots(cwd, 'solus-session')
    expect(turns.map((turn) => [turn.index, turn.filesChanged])).toEqual([[0, 2]])
  })

  test('a folder outside git records nothing and does not throw', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'solus-turn-checkpoints-plain-'))
    dirs.push(cwd)
    const target = { sessionId: 'solus-session', workTree: cwd }

    await beginTurnCheckpoint(target)
    expect(await endTurnCheckpoint(target, { partial: false, userMessagePreview: '' })).toBeNull()
  })
})
