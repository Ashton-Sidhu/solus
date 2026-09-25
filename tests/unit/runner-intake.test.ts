import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { OutboxOp } from '@solus/contracts/outbox-types'
type Principal = import('@solus/server/server/principal').Principal
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// docs/plans/cloud-service-model.md §16: the workspace service applies a runner's
// ops in sequence order, in the runner's organization, through the same appliers
// a host uses; its per-stream cursor is what makes a redelivery harmless.

let intake: typeof import('@solus/server/server/runner-intake')
let principalModule: typeof import('@solus/server/server/principal')
let TaskModule: typeof import('@solus/server/tasks/task')
let taskStore: typeof import('@solus/server/tasks/task-store')
let works: typeof import('@solus/server/folio/works')
let records: typeof import('@solus/server/sessions/session-records')
let dbModule: typeof import('@solus/server/db')
let shareManager: typeof import('@solus/server/sharing/share-manager')
let database: typeof import('@solus/server/db/database')
let shares: import('@solus/server/sharing/share-manager').ShareManager

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-runner-intake-'))
  process.env.SOLUS_DATA_DIR = dataDir
  intake = await import('@solus/server/server/runner-intake')
  principalModule = await import('@solus/server/server/principal')
  TaskModule = await import('@solus/server/tasks/task')
  taskStore = await import('@solus/server/tasks/task-store')
  works = await import('@solus/server/folio/works')
  records = await import('@solus/server/sessions/session-records')
  dbModule = await import('@solus/server/db')
  shareManager = await import('@solus/server/sharing/share-manager')
  database = await import('@solus/server/db/database')
  shares = new shareManager.ShareManager({ db: database.getDatabase() })
  ;(await import('@solus/server/tasks/task-applier')).registerTaskOutboxApplier()
  ;(await import('@solus/server/folio/work-applier')).registerWorkOutboxApplier()
})

afterAll(async () => {
  await resetTestDatabase()
  dbModule.closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

const runner = () => principalModule.runnerPrincipalFor({ hostId: 'runner-1', organizationId: 'org1', expiresAt: Date.now() + 600_000 })

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
    expect(await shares.ownerOf('org1', { kind: 'task', id: 'task-a' })).toBe('host-owner')

    // The runner lost the ack and sends the same batch again.
    expect(await intake.applyRunnerOutbox(runner(), batch, shares)).toEqual({ lastSeq: 3, failed: [] })
    expect((await TaskModule.Task.byId('org1', 'task-a').then((t) => t.details())).comments).toHaveLength(1)
  })

  test('a permanent failure is skipped and named; a transient one holds the cursor', async () => {
    // WHY: a comment on a task that is gone can never apply, and must not dam the
    // stream behind it; an applier that merely failed this time gets another try.
    const gone = op('tasks', 'task-missing', 'comment', { body: 'lost', author: 'agent' })
    const fine = op('tasks', 'task-a', 'comment', { body: 'second', author: 'agent' })
    const skew = op('works', 'work-a', 'from-the-future', {})
    const after = op('tasks', 'task-a', 'comment', { body: 'third', author: 'agent' })
    const answer = await intake.applyRunnerOutbox(runner(), { hostId: 'runner-1', ops: [{ seq: 4, op: gone }, { seq: 5, op: fine }, { seq: 6, op: skew }, { seq: 7, op: after }] })
    expect(answer.lastSeq).toBe(5)
    expect(answer.failed.map((failure) => [failure.seq, failure.permanent])).toEqual([[4, true], [6, false]])
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
    const other = principalModule.runnerPrincipalFor({ hostId: 'runner-2', organizationId: 'org1', expiresAt: Date.now() + 600_000 })
    expect(await intake.applyRunnerSessionRecords(other, { hostId: 'runner-2', reports: [{ seq: 1, record: { sessionId: 's2', provider: 'codex', projectPath: '-repo', lastActivityAt: 1 } }] })).toEqual({ lastSeq: 1 })
    expect((await records.listSessionRecords('org1')).map((record) => record.sessionId).sort()).toEqual(['s1', 's2'])
    expect(await taskStore.listTasks('local')).toMatchObject({ tasks: [] })
  })
})
