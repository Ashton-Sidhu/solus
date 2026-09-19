import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// docs/plans/cloud-service-model.md §4: a prompt sent to a cloud session while
// its runner is away waits on the service; the runner claims it under the
// session's lease, and settles it by the epoch it claimed it under.

type QueueModule = typeof import('@solus/server/sessions/prompt-queue')
type RecordsModule = typeof import('@solus/server/sessions/session-records')
type DbModule = typeof import('@solus/server/db')

let dataDir: string
let queue: QueueModule
let records: RecordsModule
let db: DbModule
let leaseTtl: number
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-prompt-queue-'))
  process.env.SOLUS_DATA_DIR = dataDir
  queue = await import('@solus/server/sessions/prompt-queue')
  records = await import('@solus/server/sessions/session-records')
  db = await import('@solus/server/db')
  leaseTtl = (await import('@solus/server/server/uplink/runner-protocol')).RUNNER_LEASE_TTL_MS
})

afterEach(async () => {
  await resetTestDatabase()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `solus.db${suffix}`), { force: true })
})

afterAll(() => {
  db.closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

const ORG = 'org1'
const T0 = 1_700_000_000_000

async function sessionHeldBy(hostId: string, sessionId = 's1'): Promise<void> {
  await records.upsertSessionRecord(ORG, { sessionId, provider: 'claude-code', projectPath: '-repo', runnerHostId: hostId, lastActivityAt: T0 })
}

const alice = { authorUserId: 'alice', authorDisplayName: 'Alice' }

describe('prompt queue', () => {
  test('a prompt waits in created order, for one organization; only its author or an administrator withdraws it, and only while it waits', async () => {
    await sessionHeldBy('runner-1')
    const first = await queue.enqueuePrompt(ORG, { sessionId: 's1', ...alice, text: 'first' }, T0)
    const second = await queue.enqueuePrompt(ORG, { sessionId: 's1', authorUserId: 'bob', authorDisplayName: null, text: 'second' }, T0 + 1)
    expect((await queue.listQueue(ORG, 's1')).map((prompt) => [prompt.queueId, prompt.state])).toEqual([[first.queueId, 'waiting'], [second.queueId, 'waiting']])
    expect(await queue.listQueue('org2', 's1')).toEqual([])

    // WHY: a colleague must not silently drop what someone else asked the agent to do.
    await expect(queue.cancelPrompt(ORG, second.queueId, 'alice', false)).rejects.toThrow(/author or a host administrator/)
    expect((await queue.cancelPrompt(ORG, second.queueId, 'carol', true))?.state).toBe('cancelled')
    expect((await queue.cancelPrompt(ORG, first.queueId, 'alice', false))?.state).toBe('cancelled')
    // Gone, cancelled, or already claimed: nothing to withdraw.
    expect(await queue.cancelPrompt(ORG, first.queueId, 'alice', false)).toBeNull()
    expect(await queue.cancelPrompt(ORG, 'missing', 'alice', true)).toBeNull()
    const third = await queue.enqueuePrompt(ORG, { sessionId: 's1', ...alice, text: 'third' }, T0 + 2)
    expect(await queue.claimForRunner(ORG, 'runner-1', 10, T0 + 3)).toHaveLength(1)
    expect(await queue.cancelPrompt(ORG, third.queueId, 'alice', true)).toBeNull()
    expect((await queue.listQueue(ORG, 's1')).map((prompt) => prompt.state)).toEqual(['cancelled', 'cancelled', 'claimed'])
  })

  test('a claim takes the lease and marks the prompts claimed; only the runner the record names claims, and only up to the limit', async () => {
    await sessionHeldBy('runner-1', 's1')
    await sessionHeldBy('runner-2', 's2')
    await queue.enqueuePrompt(ORG, { sessionId: 's1', ...alice, text: 'a' }, T0)
    await queue.enqueuePrompt(ORG, { sessionId: 's2', ...alice, text: 'b' }, T0 + 1)
    await queue.enqueuePrompt(ORG, { sessionId: 's1', authorUserId: 'bob', authorDisplayName: null, text: 'c' }, T0 + 2)

    const claimed = await queue.claimForRunner(ORG, 'runner-1', 1, T0 + 10)
    expect(claimed).toEqual([{ queueId: expect.any(String), sessionId: 's1', epoch: 1, text: 'a', author: { userId: 'alice', displayName: 'Alice' }, createdAt: T0 }])
    const rest = await queue.claimForRunner(ORG, 'runner-1', 10, T0 + 11)
    expect(rest.map((prompt) => [prompt.text, prompt.epoch, prompt.author])).toEqual([['c', 1, { userId: 'bob' }]])
    expect((await queue.listQueue(ORG, 's1')).map((prompt) => [prompt.state, prompt.claimedByHostId])).toEqual([['claimed', 'runner-1'], ['claimed', 'runner-1']])
    // Another organization's runner of the same id sees nothing.
    expect(await queue.claimForRunner('org2', 'runner-1', 10, T0 + 12)).toEqual([])
    // The other session is its own runner's.
    expect((await queue.listQueue(ORG, 's2'))[0]?.state).toBe('waiting')
    expect((await queue.claimForRunner(ORG, 'runner-2', 10, T0 + 13)).map((prompt) => prompt.text)).toEqual(['b'])
  })

  test('a live lease keeps another runner out; after it expires the other runner takes the session at the next epoch, and the stale epoch cannot settle', async () => {
    // WHY: a session record can move between runners (a re-link, a restore);
    // two runners must never both run the same queued prompt, and a runner that
    // lost the session must not overwrite the new holder's word on it.
    await sessionHeldBy('runner-1')
    const first = await queue.enqueuePrompt(ORG, { sessionId: 's1', ...alice, text: 'one' }, T0)
    const [claimedByOne] = await queue.claimForRunner(ORG, 'runner-1', 10, T0 + 1)
    expect(claimedByOne?.epoch).toBe(1)
    expect(await queue.settleForRunner(ORG, 'runner-1', first.queueId, 1, 'dispatched', undefined, T0 + 2)).toEqual({ settled: true, sessionId: 's1' })

    const second = await queue.enqueuePrompt(ORG, { sessionId: 's1', ...alice, text: 'two' }, T0 + 3)
    // The record now names runner-2, but runner-1's lease is live: runner-2 waits.
    await sessionHeldBy('runner-2')
    expect(await queue.claimForRunner(ORG, 'runner-2', 10, T0 + 4)).toEqual([])
    expect((await queue.listQueue(ORG, 's1'))[1]?.state).toBe('waiting')
    // Past the lease, runner-2 takes the session at epoch 2.
    const [claimedByTwo] = await queue.claimForRunner(ORG, 'runner-2', 10, T0 + 1 + leaseTtl)
    expect(claimedByTwo).toMatchObject({ queueId: second.queueId, epoch: 2 })
    // runner-1 settling under its old epoch is refused; runner-2 under epoch 2 is not.
    expect(await queue.settleForRunner(ORG, 'runner-1', second.queueId, 1, 'dispatched')).toEqual({ settled: false })
    expect(await queue.settleForRunner(ORG, 'runner-2', second.queueId, 1, 'dispatched')).toEqual({ settled: false })
    expect(await queue.settleForRunner(ORG, 'runner-2', second.queueId, 2, 'failed', 'no seat', T0 + 5 + leaseTtl)).toEqual({ settled: true, sessionId: 's1' })
    expect((await queue.listQueue(ORG, 's1'))[1]).toMatchObject({ state: 'failed', error: 'no seat', settledAt: T0 + 5 + leaseTtl })
    // Settling twice changes nothing.
    expect(await queue.settleForRunner(ORG, 'runner-2', second.queueId, 2, 'dispatched')).toEqual({ settled: false })
  })

  test('the same runner renews its lease and keeps its epoch; a claim its lease outlived goes back to waiting for the next claim', async () => {
    // WHY: a runner that claimed and then died must not leave the prompt stuck in
    // `claimed` forever; the next runner to ask (itself, restarted, or another)
    // gets it again.
    await sessionHeldBy('runner-1')
    const prompt = await queue.enqueuePrompt(ORG, { sessionId: 's1', ...alice, text: 'stuck' }, T0)
    expect((await queue.claimForRunner(ORG, 'runner-1', 10, T0 + 1))[0]?.epoch).toBe(1)
    // A renewal within the lease returns nothing new and keeps the claim as it is.
    await queue.enqueuePrompt(ORG, { sessionId: 's1', ...alice, text: 'next' }, T0 + 2)
    const renewed = await queue.claimForRunner(ORG, 'runner-1', 10, T0 + leaseTtl - 1)
    expect(renewed.map((entry) => [entry.text, entry.epoch])).toEqual([['next', 1]])
    expect((await queue.listQueue(ORG, 's1')).map((entry) => entry.state)).toEqual(['claimed', 'claimed'])

    // The renewal moved the lease's expiry; well past it, nothing was settled.
    const later = T0 + leaseTtl - 1 + leaseTtl + 1
    const reclaimed = await queue.claimForRunner(ORG, 'runner-1', 10, later)
    expect(reclaimed.map((entry) => [entry.queueId === prompt.queueId, entry.text, entry.epoch])).toEqual([[true, 'stuck', 1], [false, 'next', 1]])
    expect((await queue.listQueue(ORG, 's1')).map((entry) => entry.claimedByHostId)).toEqual(['runner-1', 'runner-1'])
  })
})
