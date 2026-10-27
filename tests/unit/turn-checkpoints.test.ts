import { afterEach, describe, expect, mock, setSystemTime, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { spawnSync } from 'child_process'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

mock.module('node:sqlite', () => ({ DatabaseSync }))
const { beginTurnCheckpoint, endTurnCheckpoint } = await import('@solus/server/git/turn-checkpoints')
const { getDiffStats, listTurnSnapshots } = await import('@solus/server/git/session-snapshots')
const { turnActivity } = await import('@solus/server/git/turn-activity')
const { actAsHostForTests } = await import('@solus/server/execution/seats/acting-identity')

const dirs: string[] = []
afterEach(() => {
  setSystemTime()
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

  // WHY: two sessions in the main checkout with overlapping turns. Each turn's
  // snapshots hold both sessions' edits; a write inside another session's tool
  // call, and inside none of this session's, is that session's work. Before,
  // a UI turn showed the other session's database migration as its own.
  test('a turn leaves out what another session wrote during it', async () => {
    const cwd = createRepo()
    const ui = { sessionId: 'ui-session', workTree: cwd }
    const db = { sessionId: 'db-session', workTree: cwd }
    const start = Date.parse('2026-10-26T14:50:00Z')
    const at = (ms: number) => setSystemTime(new Date(start + ms))
    const writeAt = (path: string, text: string, ms: number) => {
      writeFileSync(join(cwd, path), text)
      utimesSync(join(cwd, path), (start + ms) / 1000, (start + ms) / 1000)
    }

    at(0)
    await beginTurnCheckpoint(ui)
    await beginTurnCheckpoint(db)
    at(1_000)
    turnActivity.observe('db-session', { type: 'tool_call', toolName: 'Bash', toolId: 'db-tool', index: 0 })
    writeAt('migration.sql', 'create table search;\n', 1_500)
    at(2_000)
    turnActivity.observe('db-session', { type: 'tool_result', toolUseId: 'db-tool', content: '' })
    at(5_000)
    turnActivity.observe('ui-session', { type: 'tool_call', toolName: 'Edit', toolId: 'ui-tool', index: 0 })
    writeAt('tracked.txt', 'first\nshimmer\n', 5_500)
    at(6_000)
    turnActivity.observe('ui-session', { type: 'tool_call_complete', index: 0, toolId: 'ui-tool', outcome: { status: 'completed' } })
    // Written by a person: no session's tool call ran, so the turn keeps it.
    writeAt('by-hand.txt', 'a note\n', 6_500)

    // The live session diff leaves the other session's file out during the turn.
    at(7_000)
    expect((await getDiffStats(cwd, cwd, { kind: 'session' }, 'ui-session')).map((file) => file.path).sort())
      .toEqual(['by-hand.txt', 'tracked.txt'])

    expect((await endTurnCheckpoint(ui, { partial: false, userMessagePreview: 'shimmer' }))?.sort())
      .toEqual(['by-hand.txt', 'tracked.txt'])
    const uiTurn = (await listTurnSnapshots(cwd, 'ui-session'))[0]
    expect((await getDiffStats(cwd, cwd, { kind: 'turn', index: uiTurn.index }, 'ui-session')).map((file) => file.path).sort())
      .toEqual(['by-hand.txt', 'tracked.txt'])

    // The other session's turn ends later and still leaves out the UI edit.
    at(9_000)
    expect((await endTurnCheckpoint(db, { partial: false, userMessagePreview: 'search' }))?.sort())
      .toEqual(['by-hand.txt', 'migration.sql'])
  })
})
