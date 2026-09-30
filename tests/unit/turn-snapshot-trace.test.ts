import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { IpcContext } from '@solus/contracts/types'

// The handlers reach the session's provider thread and checkout through its
// lineage. The lineage table is the host's; here one Solus session owns one
// provider thread working in a temp repository.
let lineageCwd = ''
const { Database } = await import('bun:sqlite')
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
const realLineage = await import('@solus/server/data/sessions/session-lineage')
mock.module('@solus/server/data/sessions/session-lineage', () => ({
  ...realLineage,
  resolveSessionLineageById: (sessionId: string) => sessionId === 'solus-session'
    ? {
        sessionId,
        members: [],
        active: { position: 0, provider: 'claude-code', providerSessionId: 'provider-thread', cwd: lineageCwd, startedAt: 0, endedAt: null },
        lineageToken: '',
      }
    : null,
}))

type Snapshots = typeof import('@solus/server/git/session-snapshots')
type Handler = (args: unknown[]) => unknown
let snapshots: Snapshots
const handlers = new Map<string, Handler>()

beforeAll(async () => {
  snapshots = await import('@solus/server/git/session-snapshots')
  const { registerWorktreeHandlers } = await import('@solus/server/transport/handlers/worktree-handlers')
  registerWorktreeHandlers(
    { register: (name: string, handler: Handler) => handlers.set(name, handler) } as never,
    { sessionRuntime: {}, events: {} } as never,
  )
})

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs.length = 0
})

function git(cwd: string, args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`)
  return result.stdout.trim()
}

function createRepo() {
  const cwd = mkdtempSync(join(tmpdir(), 'solus-turn-trace-'))
  dirs.push(cwd)
  git(cwd, ['init'])
  git(cwd, ['config', 'user.email', 'test@example.com'])
  git(cwd, ['config', 'user.name', 'Test'])
  writeFileSync(join(cwd, 'a.txt'), 'a\n')
  writeFileSync(join(cwd, 'b.txt'), 'b\n')
  git(cwd, ['add', '.'])
  git(cwd, ['commit', '-m', 'base'])
  return { cwd, baseSha: git(cwd, ['rev-parse', 'HEAD']) }
}

/** What a surface with no tab sends: the Solus session id and nothing else. */
function recordOnlyCtx(sessionId: string): IpcContext {
  return {
    session: { sessionId, agentSessionId: null, workingDirectory: '', gitContext: null },
    settings: {},
    statusBar: {},
  } as never
}

/** Three turns, where the middle one never snapshots — the way a turn that
 *  started before its checkout existed, or whose ref went missing, does. */
async function threeTurnsWithAGap(cwd: string, baseSha: string) {
  const { initSessionBase, prepareTurnSnapshot, snapshotTurn } = snapshots
  await initSessionBase(cwd, 'provider-thread', baseSha)

  await prepareTurnSnapshot(cwd, cwd, 'provider-thread')
  writeFileSync(join(cwd, 'a.txt'), 'a\nfirst turn\n')
  await snapshotTurn(cwd, cwd, 'provider-thread', { traceId: 'trace-1', sessionChangedFiles: ['a.txt'] })

  // No turn-start tree: this turn's snapshot is skipped.
  expect(await snapshotTurn(cwd, cwd, 'provider-thread', { traceId: 'trace-2', sessionChangedFiles: ['a.txt'] })).toBeNull()

  await prepareTurnSnapshot(cwd, cwd, 'provider-thread')
  writeFileSync(join(cwd, 'b.txt'), 'b\nthird turn\nand more\n')
  await snapshotTurn(cwd, cwd, 'provider-thread', { traceId: 'trace-3', sessionChangedFiles: ['a.txt', 'b.txt'] })
}

describe('turn snapshots carry their trace', () => {
  // WHY: a snapshot's index counts snapshots, not turns. The third turn here is
  // snapshot 1; opening "turn 3" by position would show the first turn's change.
  // The trace id is the only exact join from an Insights turn to its diff.
  test('the trace id finds the right snapshot when an earlier turn skipped its own', async () => {
    const { cwd, baseSha } = createRepo()
    await threeTurnsWithAGap(cwd, baseSha)

    const turns = await snapshots.listTurnSnapshots(cwd, 'provider-thread')
    expect(turns.map((turn) => [turn.index, turn.traceId])).toEqual([[0, 'trace-1'], [1, 'trace-3']])

    const third = turns.find((turn) => turn.traceId === 'trace-3')!
    expect(await snapshots.getDiffStats(cwd, cwd, { kind: 'turn', index: third.index }, 'provider-thread', [])).toEqual([
      { path: 'b.txt', additions: 2, deletions: 0, status: 'M' },
    ])
  })
})

describe('git diff handlers for a session with no tab', () => {
  // WHY: Insights knows a turn's Solus session, never its provider thread or
  // checkout. The access policy already checks the Solus id, so the host
  // resolving the rest from it is what lets any client — desktop, web, phone,
  // with or without the session open — read a turn's change.
  test('list snapshots and read a turn diff from the Solus session id alone', async () => {
    const { cwd, baseSha } = createRepo()
    lineageCwd = cwd
    await threeTurnsWithAGap(cwd, baseSha)

    const listed = await handlers.get('listTurnSnapshots')!([recordOnlyCtx('solus-session')])
    expect(listed).toEqual(expect.arrayContaining([expect.objectContaining({ traceId: 'trace-3', index: 1 })]))

    const stats = await handlers.get('diffStats')!([recordOnlyCtx('solus-session'), { scope: { kind: 'turn', index: 1 } }])
    expect(stats).toEqual([{ path: 'b.txt', additions: 2, deletions: 0, status: 'M' }])
  })

  test('a session with no lineage reads nothing rather than another checkout', async () => {
    const listed = await handlers.get('listTurnSnapshots')!([recordOnlyCtx('unknown-session')])
    expect(listed).toEqual([])
  })
})
