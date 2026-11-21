import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from './helpers/bun-sqlite'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync }))

// docs/plans/portable-sessions-cloud.md, "The mirror for readers": the mirror
// holds the code changes of each ended turn, so a reader with no host online
// reads a turn diff from the same store as the rows. The host sends the patch
// of a turn where the session's rows go, the Solus API keeps it by turn, and a
// patch over the limit keeps only its counts.

let turnDiffMirror: typeof import('@solus/server/sync/mirror/turn-diff-mirror')
let protocol: typeof import('@solus/server/sync/runner-protocol')
let queue: typeof import('@solus/server/sync/delivery-queue')
let intake: typeof import('@solus/server/sync/runner-intake')
let turnDiffs: typeof import('@solus/server/data/sessions/turn-diffs')
let records: typeof import('@solus/server/data/sessions/session-records')
let principalModule: typeof import('@solus/server/admission/principal')
let checkpoints: typeof import('@solus/server/git/turn-checkpoints')
let snapshots: typeof import('@solus/server/git/session-snapshots')
let hostUser: typeof import('@solus/server/host/host-user')
let settings: typeof import('@solus/server/host/settings')
let dbModule: typeof import('@solus/server/db')

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
let checkout: string

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`)
  return result.stdout.trim()
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-turn-diff-mirror-'))
  process.env.SOLUS_DATA_DIR = dataDir
  turnDiffMirror = await import('@solus/server/sync/mirror/turn-diff-mirror')
  protocol = await import('@solus/server/sync/runner-protocol')
  queue = await import('@solus/server/sync/delivery-queue')
  intake = await import('@solus/server/sync/runner-intake')
  turnDiffs = await import('@solus/server/data/sessions/turn-diffs')
  records = await import('@solus/server/data/sessions/session-records')
  principalModule = await import('@solus/server/admission/principal')
  checkpoints = await import('@solus/server/git/turn-checkpoints')
  snapshots = await import('@solus/server/git/session-snapshots')
  hostUser = await import('@solus/server/host/host-user')
  settings = await import('@solus/server/host/settings')
  dbModule = await import('@solus/server/db')
  // The producer starts Git in the project; with no caller, it acts as the host (plans/019).
  ;(await import('@solus/server/execution/seats/acting-identity')).actAsHostForTests()
  hostUser.useHostUser({ localId: 'mac-1', account: { accountId: 'acct-ashton' } })
  checkout = mkdtempSync(join(tmpdir(), 'solus-turn-diff-checkout-'))
  git(checkout, ['init', '--initial-branch=main'])
  git(checkout, ['config', 'user.email', 'test@example.com'])
  git(checkout, ['config', 'user.name', 'Test'])
  writeFileSync(join(checkout, 'tracked.txt'), 'first\n')
  git(checkout, ['add', '.'])
  git(checkout, ['commit', '-m', 'base'])
})

afterAll(async () => {
  hostUser.useHostUser(null)
  await resetTestDatabase()
  dbModule.closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(checkout, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

const PERSONAL = { organizationId: 'person:acct-ashton', actorUserId: 'acct-ashton' }

/** One turn of `sessionId` in the checkout that writes `file`; answers the ended turn as its turn commit records it. */
async function endedTurn(sessionId: string, turnIndex: number, file: string, content: string) {
  const target = { sessionId, workTree: checkout }
  await checkpoints.beginTurnCheckpoint(target)
  writeFileSync(join(checkout, file), content)
  await checkpoints.endTurnCheckpoint(target, { partial: false, userMessagePreview: `turn ${turnIndex}` })
  const all = await snapshots.listTurnSnapshots(checkout, sessionId)
  return { sessionId, turnIndex, endedAt: 1_000 + turnIndex, repoRoot: checkout, snapshots: all.slice(-1) }
}

function drain(destination = PERSONAL) {
  const items = queue.listDelivery(destination, 100)
  if (items.length) queue.ackDelivery(destination, items.at(-1)!.seq, [])
  return items
}

const runner = (organizationId: string, ownerUserId: string) => principalModule.runnerPrincipalFor({ hostId: 'runner-1', organizationId, ownerUserId, expiresAt: Date.now() + 600_000 })

describe('turn diff mirror', () => {
  test('the diff of an ended turn goes where the rows of its session go, and the Solus API answers it by turn', async () => {
    await records.upsertOwnSessionRecord({ sessionId: 'mine', provider: 'claude-code', projectPath: '-repo', lastActivityAt: 1 })
    await turnDiffMirror.mirrorTurnDiff(await endedTurn('mine', 0, 'turn-0.txt', 'written in turn 0\n'))
    const [item] = drain()
    expect(item).toMatchObject({ kind: 'turn-diff', payload: { sessionId: 'mine', turnIndex: 0, endedAt: 1_000, filesChanged: 1, additions: 1, deletions: 0 } })
    const payload = protocol.turnDiffMirrorPayloadSchema.parse(item!.payload)
    expect(payload.patch).toContain('turn-0.txt')
    expect(payload.patch).toContain('+written in turn 0')

    // The Solus API keeps it in the scope of the delivery; a redelivery changes nothing.
    const answer = await intake.applyRunnerDelivery(runner('person:acct-ashton', 'acct-ashton'), { hostId: 'runner-1', items: [item!, item!] })
    expect(answer.failed).toEqual([])
    expect(await turnDiffs.readTurnDiff('person:acct-ashton', 'mine', 0)).toEqual({ status: 'available', patch: payload.patch! })
    // WHY: a turn's patch can hold code. Another person's scope, and an organization's, read nothing of it.
    expect(await turnDiffs.readTurnDiff('person:acct-other', 'mine', 0)).toEqual({ status: 'not-available' })
    expect(await turnDiffs.readTurnDiff('org1', 'mine', 0)).toEqual({ status: 'not-available' })
    expect(await turnDiffs.readTurnDiff('person:acct-ashton', 'mine', 1)).toEqual({ status: 'not-available' })
  })

  test('a patch over the limit sends its counts only, and a reader gets too-large', async () => {
    // WHY: the old repository limit was 2 MiB with `too-large`. The reader must still
    // learn what the turn changed, and that the diff is on a machine.
    await records.upsertOwnSessionRecord({ sessionId: 'big', provider: 'claude-code', projectPath: '-repo', lastActivityAt: 1 })
    const line = `${'x'.repeat(98)}\n`
    const turn = await endedTurn('big', 0, 'big.txt', line.repeat(Math.ceil((protocol.TURN_DIFF_PATCH_BYTES + 1) / line.length)))
    await turnDiffMirror.mirrorTurnDiff(turn)
    const [item] = drain()
    const payload = protocol.turnDiffMirrorPayloadSchema.parse(item!.payload)
    expect(payload.patch).toBeNull()
    expect(payload.filesChanged).toBe(1)
    expect(payload.additions).toBeGreaterThan(20_000)
    await intake.applyRunnerDelivery(runner('person:acct-ashton', 'acct-ashton'), { hostId: 'runner-1', items: [{ ...item!, seq: item!.seq + 100 }] })
    expect(await turnDiffs.readTurnDiff('person:acct-ashton', 'big', 0)).toEqual({ status: 'too-large', filesChanged: 1, additions: payload.additions, deletions: 0 })
    // The intake holds the same limit: a host cannot store a larger patch.
    const oversized = { seq: item!.seq + 200, kind: 'turn-diff', payload: { ...payload, patch: 'x'.repeat(protocol.TURN_DIFF_PATCH_BYTES + 1) } }
    const refused = await intake.applyRunnerDelivery(runner('person:acct-ashton', 'acct-ashton'), { hostId: 'runner-1', items: [oversized] })
    expect(refused.failed.map((failure) => failure.seq)).toEqual([oversized.seq])
  })

  test('with cloud sync off a personal turn sends nothing; a turn that changed no file sends nothing', async () => {
    await records.upsertOwnSessionRecord({ sessionId: 'quiet', provider: 'claude-code', projectPath: '-repo', lastActivityAt: 1 })
    const turn = await endedTurn('quiet', 0, 'quiet.txt', 'kept on this machine\n')
    settings.setHostConfig({ sessionCloudSync: false })
    try {
      await turnDiffMirror.mirrorTurnDiff(turn)
      expect(queue.deliveryDestinations()).toEqual([])
    } finally {
      settings.setHostConfig({ sessionCloudSync: true })
    }
    const [snapshot] = turn.snapshots
    await turnDiffMirror.mirrorTurnDiff({ ...turn, snapshots: [{ ...snapshot!, toTreeSha: snapshot!.fromTreeSha }] })
    expect(queue.deliveryDestinations()).toEqual([])
  })

  test('a history page names the turn diffs that ended in its time', async () => {
    // WHY: a page from the mirror has rows of many turns and no turn index. The reader
    // joins a diff to its turn by time, as it joins a host's checkpoints.
    const deliver = (turnIndex: number, endedAt: number) => intake.applyRunnerDelivery(runner('org1', 'alice'), { hostId: 'runner-1', items: [
      { seq: 500 + turnIndex, kind: 'turn-diff', payload: { sessionId: 'paged', turnIndex, endedAt, filesChanged: 1, additions: 1, deletions: 0, patch: `patch ${turnIndex}` } },
    ] })
    await deliver(0, 150)
    await deliver(1, 250)
    await deliver(2, 350)
    expect(await turnDiffs.turnDiffsEndedIn('org1', 'paged', { from: 200 })).toEqual([{ turnIndex: 1, endedAt: 250 }, { turnIndex: 2, endedAt: 350 }])
    expect(await turnDiffs.turnDiffsEndedIn('org1', 'paged', { from: 100, until: 250 })).toEqual([{ turnIndex: 0, endedAt: 150 }])
    expect(await turnDiffs.turnDiffsEndedIn('org2', 'paged', { from: 0 })).toEqual([])
  })

  test('a batch stops at its byte budget, and one item over the budget still goes alone', () => {
    // WHY: many turns can end while the Solus API is away. Their patches must not
    // become one request of hundreds of megabytes.
    const destination = { organizationId: 'org-batch', actorUserId: 'bob' }
    const patch = 'p'.repeat(1_000)
    queue.appendDelivery(destination, 'turn-diff', [0, 1, 2].map((turnIndex) => ({ key: `batch:${turnIndex}`, payload: { sessionId: 'batch', turnIndex, endedAt: 1, filesChanged: 1, additions: 1, deletions: 0, patch } })))
    expect(queue.listDelivery(destination, 100)).toHaveLength(3)
    expect(queue.listDelivery(destination, 100, 2_500)).toHaveLength(2)
    expect(queue.listDelivery(destination, 100, 10)).toHaveLength(1)
    queue.dropQueuedFor(destination)
  })
})
