import { afterEach, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { spawnSync } from 'child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

mock.module('node:sqlite', () => ({ DatabaseSync }))
const { beginTurnCheckpoint, endTurnCheckpoint } = await import('@solus/server/git/turn-checkpoints')
const { getSessionBaseSha, listTurnSnapshots } = await import('@solus/server/git/session-snapshots')
const { bundleRef, writeTurnCodeBundle, writeTurnDiffPatch } = await import('@solus/server/git/session-code-bundle')
const { actAsHostForTests } = await import('@solus/server/execution/seats/acting-identity')

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs.length = 0
})

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`)
  return result.stdout.trim()
}

function tryGit(cwd: string, args: string[]): boolean {
  return spawnSync('git', args, { cwd, encoding: 'utf8' }).status === 0
}

function tempDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `solus-code-bundle-${name}-`))
  dirs.push(dir)
  return dir
}

/** An origin with one pushed commit, and host A's clone of it. */
function createProject() {
  const origin = tempDir('origin')
  git(origin, ['init', '--bare', '--initial-branch=main'])
  const hostA = tempDir('a')
  git(hostA, ['clone', origin, '.'])
  git(hostA, ['config', 'user.email', 'test@example.com'])
  git(hostA, ['config', 'user.name', 'Test'])
  writeFileSync(join(hostA, 'tracked.txt'), 'first\n')
  git(hostA, ['add', '.'])
  git(hostA, ['commit', '-m', 'base'])
  git(hostA, ['push', 'origin', 'HEAD:main'])
  return { origin, hostA }
}

function cloneOf(origin: string, name: string): string {
  const dir = tempDir(name)
  git(dir, ['clone', origin, '.'])
  return dir
}

const SESSION = 'bundle-session'
const fetchSpec = `refs/solus/sessions/${SESSION}/bundle/*:refs/solus/sessions/${SESSION}/bundle/*`

// The helpers under test start processes; with no caller, they act as the host (plans/019).
actAsHostForTests()

describe('session code bundle', () => {
  // WHY: another host must get the exact trees of a turn, or its session diff
  // differs. The history must come from origin: a bundle that carried `.git`
  // would be as large as the project.
  test('a second clone gets the same turn trees and the unpushed commit, and the bundle holds no history', async () => {
    const { origin, hostA } = createProject()
    writeFileSync(join(hostA, 'tracked.txt'), 'first\nlocal commit\n')
    git(hostA, ['commit', '-am', 'not pushed'])
    const target = { sessionId: SESSION, workTree: hostA }

    await beginTurnCheckpoint(target)
    writeFileSync(join(hostA, 'tracked.txt'), 'first\nlocal commit\nuncommitted\n')
    writeFileSync(join(hostA, 'untracked.txt'), 'new\n')
    await endTurnCheckpoint(target, { partial: false, userMessagePreview: 'edit' })

    const [snapshot] = await listTurnSnapshots(hostA, SESSION)
    const bundleFile = join(tempDir('out'), 'turn.bundle')
    const bundle = await writeTurnCodeBundle(hostA, {
      sessionId: SESSION, snapshots: [snapshot], previousCommit: getSessionBaseSha(hostA, SESSION)!, headSha: git(hostA, ['rev-parse', 'HEAD']), carried: [],
    }, bundleFile)
    expect(bundle.kind).toBe('written')

    const hostB = cloneOf(origin, 'b')
    git(hostB, ['fetch', bundleFile, fetchSpec])
    expect(git(hostB, ['rev-parse', `${bundleRef(SESSION, '0/to')}^{tree}`])).toBe(snapshot.toTreeSha)
    expect(git(hostB, ['rev-parse', bundleRef(SESSION, 'head')])).toBe(git(hostA, ['rev-parse', 'HEAD']))

    const noHistory = tempDir('empty')
    git(noHistory, ['init'])
    expect(tryGit(noHistory, ['fetch', bundleFile, fetchSpec])).toBe(false)
    // The bundle refs are transport names only; the project keeps none.
    expect(git(hostA, ['for-each-ref', `refs/solus/sessions/${SESSION}/bundle`])).toBe('')
  })

  // WHY: a person can edit between two turns. The next turn then starts from a
  // tree that no turn-end commit holds, and its diff needs that exact tree.
  test('a turn that starts from edits made between turns carries its start tree as a commit', async () => {
    const { origin, hostA } = createProject()
    const target = { sessionId: SESSION, workTree: hostA }
    await beginTurnCheckpoint(target)
    writeFileSync(join(hostA, 'one.txt'), 'turn one\n')
    await endTurnCheckpoint(target, { partial: false, userMessagePreview: 'one' })
    writeFileSync(join(hostA, 'by-hand.txt'), 'a person wrote this between turns\n')
    await beginTurnCheckpoint(target)
    writeFileSync(join(hostA, 'two.txt'), 'turn two\n')
    await endTurnCheckpoint(target, { partial: false, userMessagePreview: 'two' })

    const [first, second] = await listTurnSnapshots(hostA, SESSION)
    const out = tempDir('out')
    const firstBundle = await writeTurnCodeBundle(hostA, {
      sessionId: SESSION, snapshots: [first], previousCommit: getSessionBaseSha(hostA, SESSION)!, headSha: null, carried: [],
    }, join(out, '0.bundle'))
    const secondBundle = await writeTurnCodeBundle(hostA, {
      sessionId: SESSION, snapshots: [second], previousCommit: first.sha, headSha: null, carried: [first.sha],
    }, join(out, '1.bundle'))
    expect([firstBundle.kind, secondBundle.kind]).toEqual(['written', 'written'])

    const hostB = cloneOf(origin, 'b')
    // The second bundle holds only what the first did not carry.
    expect(tryGit(hostB, ['fetch', join(out, '1.bundle'), fetchSpec])).toBe(false)
    git(hostB, ['fetch', join(out, '0.bundle'), fetchSpec])
    git(hostB, ['fetch', join(out, '1.bundle'), fetchSpec])
    expect(git(hostB, ['rev-parse', `${bundleRef(SESSION, '1/from')}^{tree}`])).toBe(second.fromTreeSha)
    expect(git(hostB, ['rev-parse', `${bundleRef(SESSION, '1/to')}^{tree}`])).toBe(second.toTreeSha)
  })

  // WHY: a turn that changed no file and has a pushed branch has nothing to
  // carry. Writing a bundle for it would fail in Git and stop the turn commit.
  test('a turn with nothing that origin lacks writes no bundle', async () => {
    const { hostA } = createProject()
    const head = git(hostA, ['rev-parse', 'HEAD'])
    const file = join(tempDir('out'), 'turn.bundle')
    expect(await writeTurnCodeBundle(hostA, { sessionId: SESSION, snapshots: [], previousCommit: head, headSha: head, carried: [] }, file)).toEqual({ kind: 'empty' })
    expect(existsSync(file)).toBe(false)
  })

  // WHY: a reader with no checkout shows the turn from this patch, so it must
  // hold the turn range and nothing else.
  test('the turn patch is the diff from the turn start to the turn end', async () => {
    const { hostA } = createProject()
    const target = { sessionId: SESSION, workTree: hostA }
    await beginTurnCheckpoint(target)
    writeFileSync(join(hostA, 'tracked.txt'), 'first\nsecond\n')
    await endTurnCheckpoint(target, { partial: false, userMessagePreview: 'edit' })
    const [snapshot] = await listTurnSnapshots(hostA, SESSION)
    const file = join(tempDir('out'), 'turn.patch')

    expect(await writeTurnDiffPatch(hostA, snapshot.fromTreeSha, snapshot.toTreeSha, file)).toBe(true)
    git(hostA, ['checkout', '--', 'tracked.txt'])
    git(hostA, ['apply', file])
    expect(git(hostA, ['diff', '--name-only'])).toBe('tracked.txt')
    expect(await writeTurnDiffPatch(hostA, snapshot.toTreeSha, snapshot.toTreeSha, file)).toBe(false)
  })
})
