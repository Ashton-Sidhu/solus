import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { OutboxOp } from '@solus/contracts/outbox-types'
type Principal = import('@solus/server/admission/principal').Principal
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// docs/plans/cloud-service-model.md §16: the workspace service applies a runner's
// ops in sequence order, in the runner's organization, through the same appliers
// a host uses; its per-stream cursor is what makes a redelivery harmless.

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
  ;(await import('@solus/server/data/tasks/task-applier')).registerTaskOutboxApplier()
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

let opCounter = 0
function op(domain: OutboxOp['domain'], resourceId: string, name: string, payload: unknown): OutboxOp {
  opCounter += 1
  return { id: `op-${String(opCounter).padStart(4, '0')}`, domain, resourceId, name, payload, sessionId: 'thread-1', recordedAt: opCounter, state: 'pending' }
}

describe('runner intake', () => {
  test('ops land in the runner\'s organization in order; a redelivery applies nothing twice', async () => {
    const create = op('tasks', 'task-a', 'create', {
      title: 'From the runner', projectKey: '/repo', body: 'body', priority: 'high', labels: ['x'], dueDate: null, status: 'todo', originSessionId: 'thread-1', createdAt: 1_700_000_000_000,
    })
    const comment = op('tasks', 'task-a', 'comment', { body: 'first', author: 'agent' })
    const work = op('works', 'work-a', 'create', { title: 'Doc', docType: 'doc', content: '# Doc', originSessionId: 'thread-1', linkToSessionTask: true })
    const batch = { hostId: 'runner-1', ops: [{ seq: 3, op: work }, { seq: 1, op: create }, { seq: 2, op: comment }] }

    expect(await intake.applyRunnerOutbox(runner(), batch, shares)).toEqual({ lastSeq: 3, failed: [] })
    const task = await TaskModule.Task.byId('org1', 'task-a')
    expect(task).toMatchObject({ id: 'task-a', title: 'From the runner', priority: 'high', status: 'todo', createdAt: 1_700_000_000_000 })
    expect((await task.details()).comments.map((row) => row.body)).toEqual(['first'])
    expect((await works.loadWork('org1', 'work-a'))?.title).toBe('Doc')
    // Nothing of it is in the host's own organization.
    await expect(TaskModule.Task.byId('local', 'task-a')).rejects.toThrow()
    expect(await works.loadWork('local', 'work-a')).toBeNull()

    // What landed is the organization's: a member of it opens both, a member of another does not.
    const colleague: Principal = { kind: 'org-member', userId: 'bob', organizationId: 'org1', organizationRole: 'member', teamIds: [], hostKind: 'cloud', displayName: 'Bob', deviceId: 'd', expiresAt: 0, deviceLabel: 'Solus cloud' }
    expect(await shares.roleFor(colleague, { kind: 'task', id: 'task-a' })).toBe('editor')
    expect(await shares.roleFor(colleague, { kind: 'work', id: 'work-a' })).toBe('editor')
    expect(await shares.roleFor({ ...colleague, organizationId: 'org2' }, { kind: 'task', id: 'task-a' })).toBe('none')
    // Owned by the person whose delegated token delivered it: a runner always acts for one.
    expect(await shares.ownerOf({ kind: 'task', id: 'task-a' })).toBe('alice')

    // The runner lost the ack and sends the same batch again.
    expect(await intake.applyRunnerOutbox(runner(), batch, shares)).toEqual({ lastSeq: 3, failed: [] })
    expect((await TaskModule.Task.byId('org1', 'task-a').then((t) => t.details())).comments).toHaveLength(1)
  })

  test('a lost permanent-failure response is repeated; a received failure lets later ops proceed', async () => {
    // WHY: advancing past a rejected item would turn a lost response into a
    // success on retry, letting publication delete a task with missing comments.
    const gone = op('tasks', 'task-missing', 'comment', { body: 'lost', author: 'agent' })
    const fine = op('tasks', 'task-a', 'comment', { body: 'second', author: 'agent' })
    const skew = op('works', 'work-a', 'from-the-future', {})
    const after = op('tasks', 'task-a', 'comment', { body: 'third', author: 'agent' })
    const answer = await intake.applyRunnerOutbox(runner(), { hostId: 'runner-1', ops: [{ seq: 4, op: gone }, { seq: 5, op: fine }, { seq: 6, op: skew }, { seq: 7, op: after }] })
    expect(answer.lastSeq).toBe(3)
    expect(answer.failed.map((failure) => [failure.seq, failure.permanent])).toEqual([[4, true]])
    // The response was lost: the same failure must still be visible on retry.
    expect(await intake.applyRunnerOutbox(runner(), { hostId: 'runner-1', ops: [{ seq: 4, op: gone }, { seq: 5, op: fine }] })).toEqual(answer)
    // The runner has now recorded the permanent failure and skips that item.
    const continued = await intake.applyRunnerOutbox(runner(), { hostId: 'runner-1', ops: [{ seq: 5, op: fine }, { seq: 6, op: skew }, { seq: 7, op: after }] })
    expect(continued.lastSeq).toBe(5)
    expect(continued.failed.map((failure) => [failure.seq, failure.permanent])).toEqual([[6, false]])
    const comments = (await TaskModule.Task.byId('org1', 'task-a').then((t) => t.details())).comments.map((row) => row.body)
    expect(comments).toEqual(['first', 'second'])
    // A link op after the skew is applied once the runner sends from seq 6 again with a verb this build knows.
    const link = op('tasks', 'task-a', 'link', { kind: 'work', targetScope: '', targetKey: 'work-a', title: 'Doc', originSessionId: 'thread-1' })
    const retry = await intake.applyRunnerOutbox(runner(), { hostId: 'runner-1', ops: [{ seq: 6, op: link }, { seq: 7, op: after }] })
    expect(retry).toEqual({ lastSeq: 7, failed: [] })
    const details = await TaskModule.Task.byId('org1', 'task-a').then((t) => t.details())
    expect(details.comments.map((row) => row.body)).toEqual(['first', 'second', 'third'])
    expect(details.links.map((row) => row.targetKey)).toEqual(['work-a'])
  })

  test('session records are stamped with the runner and skipped at or below the cursor', async () => {
    const answer = await intake.applyRunnerSessionRecords(runner(), {
      hostId: 'runner-1',
      reports: [
        { seq: 1, record: { sessionId: 's1', provider: 'claude-code', projectPath: '-repo', title: 'First', runnerHostId: 'liar', lastActivityAt: 10 } },
        { seq: 2, record: { sessionId: 's1', provider: 'claude-code', projectPath: '-repo', status: 'running', lastActivityAt: 20 } },
      ],
    })
    expect(answer).toEqual({ lastSeq: 2 })
    expect(await records.getSessionRecord('org1', 's1')).toMatchObject({ title: 'First', status: 'running', runnerHostId: 'runner-1', lastActivityAt: 20 })
    expect(await records.getSessionRecord('local', 's1')).toBeNull()
    // An older report that arrives again changes nothing.
    await intake.applyRunnerSessionRecords(runner(), { hostId: 'runner-1', reports: [{ seq: 1, record: { sessionId: 's1', provider: 'claude-code', projectPath: '-repo', title: 'Stale', lastActivityAt: 10 } }] })
    expect((await records.getSessionRecord('org1', 's1'))?.title).toBe('First')
    // A different runner of the same organization has its own cursor.
    const other = principalModule.runnerPrincipalFor({ hostId: 'runner-2', organizationId: 'org1', ownerUserId: 'alice', expiresAt: Date.now() + 600_000 })
    expect(await intake.applyRunnerSessionRecords(other, { hostId: 'runner-2', reports: [{ seq: 1, record: { sessionId: 's2', provider: 'codex', projectPath: '-repo', lastActivityAt: 1 } }] })).toEqual({ lastSeq: 1 })
    expect((await records.listSessionRecords('org1')).map((record) => record.sessionId).sort()).toEqual(['s1', 's2'])
    expect(await taskStore.listTasks('local')).toMatchObject({ tasks: [] })
  })

  test('work publication links the imported work to its session task and retry does not duplicate the link', async () => {
    const task = await TaskModule.Task.byId('org1', 'task-a')
    await task.linkSession('thread-1')
    const work = await works.createWork('local', 'Published', 'doc', '# Published', '', 'thread-1', 'claude-code', '/repo')
    const request = { hostId: 'runner-1', actorUserId: 'alice', transfer: await works.exportWorkForCloud('local', work.id) }
    // This fixture uses one database to represent the service; remove the
    // source fixture after taking its snapshot to model a different host.
    await works.removePushedWork('local', work.id, request.transfer.fingerprint)
    const receipt = await intake.applyRunnerWork(runner(), request, shares)
    expect(receipt).toEqual({ workId: work.id, organizationId: 'org1' })
    expect(await intake.applyRunnerWork(runner(), request, shares)).toEqual(receipt)
    const links = (await task.details()).links.filter((link) => link.targetKey === work.id)
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({ kind: 'work', title: 'Published', originSessionId: 'thread-1' })
    expect(await shares.ownerOf({ kind: 'work', id: work.id })).toBe('alice')
  })

})
