import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from './helpers/bun-sqlite'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
type Principal = import('@solus/server/admission/principal').Principal
import { resetTestDatabase } from './helpers/test-db'
import { actAsHostForTests } from '@solus/server/execution/seats/acting-identity'
import { installTestIdentities } from './helpers/acting-identities'

mock.module('node:sqlite', () => ({ DatabaseSync }))

// docs/plans/simplify-auth-and-sync.md §4.5: the Solus API applies a host's batch in
// sequence order, in the host's organization, in one transaction with one cursor
// for the (host, person). A permanent failure skips and names its item; a transient
// one stops the batch, and the host sends it and the rest again.

let intake: typeof import('@solus/server/sync/runner-intake')
let principalModule: typeof import('@solus/server/admission/principal')
let TaskModule: typeof import('@solus/server/data/tasks/task')
let taskStore: typeof import('@solus/server/data/tasks/task-store')
let works: typeof import('@solus/server/data/works/works')
let records: typeof import('@solus/server/data/sessions/session-records')
let dbModule: typeof import('@solus/server/db')
let shareManager: typeof import('@solus/server/sharing/share-manager')
let database: typeof import('@solus/server/db/database')
let shares: import('@solus/server/sharing/share-manager').ShareManager

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-runner-intake-'))
  process.env.SOLUS_DATA_DIR = dataDir
  intake = await import('@solus/server/sync/runner-intake')
  principalModule = await import('@solus/server/admission/principal')
  TaskModule = await import('@solus/server/data/tasks/task')
  taskStore = await import('@solus/server/data/tasks/task-store')
  works = await import('@solus/server/data/works/works')
  records = await import('@solus/server/data/sessions/session-records')
  dbModule = await import('@solus/server/db')
  shareManager = await import('@solus/server/sharing/share-manager')
  database = await import('@solus/server/db/database')
  shares = new shareManager.ShareManager({ db: database.getDatabase() })
  ;(await import('@solus/server/data/works/work-applier')).registerWorkOutboxApplier()
})

afterAll(async () => {
  await resetTestDatabase()
  dbModule.closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

const runner = () => principalModule.runnerPrincipalFor({ hostId: 'runner-1', organizationId: 'org1', ownerUserId: 'alice', expiresAt: Date.now() + 600_000 })

// The helpers under test start processes; with no caller, they act as the host (plans/019).
actAsHostForTests()

// Members act from homes of their own, as on a booted server (plans/019).
installTestIdentities()

describe('runner intake', () => {
  const deliver = (items: Array<{ seq: number; kind: 'session' | 'transcript' | 'shares'; payload: unknown }>, from = runner(), with_ = shares) =>
    intake.applyRunnerDelivery(from, { hostId: from.hostId, items }, { shares: with_ })
  const line = (position: number) => ({ sessionId: 's0', position, message: { role: 'user', content: `line ${position}` } })
  const transcriptRows = async () => z.array(z.object({ position: z.number() })).parse(
    await database.getDatabase().all(sql`SELECT position FROM session_transcripts WHERE organization_id = 'org1' AND session_id = 's0' ORDER BY position`),
  ).map((row) => row.position)

  test('one batch of every kind lands in the host\'s organization in order; a redelivery applies nothing twice', async () => {
    const items = [
      { seq: 3, kind: 'transcript' as const, payload: line(1) },
      { seq: 1, kind: 'session' as const, payload: { sessionId: 's0', provider: 'claude-code', projectPath: '-repo', lastActivityAt: 5 } },
      { seq: 2, kind: 'transcript' as const, payload: line(0) },
    ]
    expect(await deliver(items)).toEqual({ lastSeq: 3, failed: [] })
    expect(await transcriptRows()).toEqual([0, 1])
    expect(await records.getSessionRecord('org1', 's0')).toMatchObject({ runnerHostId: 'runner-1', publication: 'published', ownerKey: 'alice' })
    // Nothing of it is in the host's own organization.
    expect(await records.getSessionRecord('local', 's0')).toBeNull()

    // The host lost the answer and sends the same batch again.
    expect(await deliver(items)).toEqual({ lastSeq: 3, failed: [] })
    expect(await transcriptRows()).toEqual([0, 1])
  })

  test('a permanent failure is skipped and named while the rest land; a transient one stops the batch until it is sent again', async () => {
    // WHY: one bad item must not hold back a host's queue, and an item that may
    // apply later must not be skipped.
    class BusyOnce extends shareManager.ShareManager {
      busy = true
      override async applyMirroredRows(...args: Parameters<import('@solus/server/sharing/share-manager').ShareManager['applyMirroredRows']>): Promise<void> {
        if (this.busy) { this.busy = false; throw new Error('database busy') }
        return super.applyMirroredRows(...args)
      }
    }
    const flaky = new BusyOnce({ db: database.getDatabase() })
    const sharesItem = { seq: 6, kind: 'shares' as const, payload: { resource: { kind: 'session', id: 's0' }, rows: [] } }
    const answer = await deliver([
      { seq: 4, kind: 'transcript', payload: { sessionId: 's0' } },
      { seq: 5, kind: 'transcript', payload: line(2) },
      sharesItem,
      { seq: 7, kind: 'transcript', payload: line(3) },
    ], runner(), flaky)
    expect(answer.lastSeq).toBe(5)
    expect(answer.failed.map((failure) => failure.seq)).toEqual([4])
    expect(await transcriptRows()).toEqual([0, 1, 2])
    // The host sends from seq 6 again, and it lands.
    expect(await deliver([sharesItem, { seq: 7, kind: 'transcript', payload: line(3) }], runner(), flaky)).toEqual({ lastSeq: 7, failed: [] })
    expect(await transcriptRows()).toEqual([0, 1, 2, 3])
  })

  test('session facts are stamped with the host and skipped at or below the cursor; each host has its own cursor', async () => {
    const answer = await deliver([
      { seq: 8, kind: 'session', payload: { sessionId: 's1', provider: 'claude-code', projectPath: '-repo', title: 'First', runnerHostId: 'liar', lastActivityAt: 10 } },
      { seq: 9, kind: 'session', payload: { sessionId: 's1', provider: 'claude-code', projectPath: '-repo', status: 'running', lastActivityAt: 20 } },
    ])
    expect(answer).toEqual({ lastSeq: 9, failed: [] })
    expect(await records.getSessionRecord('org1', 's1')).toMatchObject({ title: 'First', status: 'running', runnerHostId: 'runner-1', lastActivityAt: 20 })
    // Older facts that arrive again change nothing.
    await deliver([{ seq: 8, kind: 'session', payload: { sessionId: 's1', provider: 'claude-code', projectPath: '-repo', title: 'Stale', lastActivityAt: 10 } }])
    expect((await records.getSessionRecord('org1', 's1'))?.title).toBe('First')
    // Another host of the same organization has its own cursor.
    const other = principalModule.runnerPrincipalFor({ hostId: 'runner-2', organizationId: 'org1', ownerUserId: 'alice', expiresAt: Date.now() + 600_000 })
    expect(await deliver([{ seq: 1, kind: 'session', payload: { sessionId: 's2', provider: 'codex', projectPath: '-repo', lastActivityAt: 1 } }], other)).toEqual({ lastSeq: 1, failed: [] })
    expect((await records.listSessionRecords('org1')).map((record) => record.sessionId).sort()).toEqual(['s0', 's1', 's2'])
    expect(await taskStore.listTasks('local')).toMatchObject({ tasks: [] })
  })

  test('an uploaded work is linked to its session task, and the same upload again does not duplicate the link', async () => {
    // The upload replaced the runner's work delivery (docs/plans/cloud-sharing.md); it keeps its task link.
    const { SolusServer } = await import('@solus/server/transport/server')
    const { registerCloudUploadHandlers } = await import('@solus/server/transport/solus-api/cloud-uploads')
    const apiMode = await import('@solus/server/host/api-mode')
    await taskStore.createTask('org1', { title: 'From the API', projectKey: '/repo', body: '', priority: null, dueDate: null, status: 'todo', source: 'agent', originSessionId: null }, { id: 'task-a', now: 1 }, undefined, 'alice')
    const task = await TaskModule.Task.byId('org1', 'task-a')
    await task.linkSession('thread-1')
    const work = await works.createWork('local', 'Published', 'doc', '# Published', '', 'thread-1', 'claude-code', '/repo')
    const transfer = await works.exportWorkForCloud('local', work.id)
    // This fixture uses one database to represent the service; delete the
    // source row after taking its snapshot to model a different host. (A real
    // host keeps the row with its location, on its own database.)
    const { Work } = await import('@solus/server/data/works/work')
    await (await Work.byId('local', work.id)).delete()
    const alice: Principal = { kind: 'org-member', hostKind: 'cloud', organizationId: 'org1', organizationRole: 'member', userId: 'alice', teamIds: [], displayName: 'Alice', deviceId: 'alice', deviceLabel: 'Cloud', expiresAt: Date.now() + 60_000 }
    const service = new SolusServer()
    registerCloudUploadHandlers(service, { shares })
    const previous = process.env.SOLUS_API
    process.env.SOLUS_API = '1'
    apiMode.resetApiModeForTests()
    try {
      const receipt = await service.handle('workUpload', [transfer], { clientId: 'alice', principal: alice })
      expect(receipt).toEqual({ workId: work.id, organizationId: 'org1' })
      expect(await service.handle('workUpload', [transfer], { clientId: 'alice', principal: alice })).toEqual(receipt)
    } finally {
      if (previous === undefined) delete process.env.SOLUS_API
      else process.env.SOLUS_API = previous
      apiMode.resetApiModeForTests()
    }
    const links = (await task.details()).links.filter((link) => link.targetKey === work.id)
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({ kind: 'work', title: 'Published', originSessionId: 'thread-1' })
    expect((await shares.homeOf({ kind: 'work', id: work.id }))?.ownerKey).toBe('alice')
  })

})
