import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { sql } from 'drizzle-orm'
import type { Activity } from '@solus/contracts/activity'
import type { OutboxOp } from '@solus/contracts/outbox-types'
import type { WireSessionLoadMessage } from '@solus/contracts/session-history'
import type { Attribution, User } from '@solus/contracts/user'
import type { WorkspaceRequestContext } from '@solus/server/admission/workspace-credentials'
import type { WorkspaceOperations } from '@solus/server/data/workspace/operations'
import type { RunnerMirrorItem } from '@solus/server/sync/runner-protocol'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// plans/012-user-actor-and-activity.md §5, stage 8: on the Solus API. A runner's
// mirrored session activity lands in the API's own activity record once, however
// often it is delivered; task changes applied from a runner's outbox record theirs
// there once too. The record API answers a record's activity only to a reader who
// may open that record, and "activity naming me" (what the notifications hub reads)
// only to the person it names. The API's session history places activity where a
// host places it. (The host side is in transcript-mirror.test.ts.)

let intake: typeof import('@solus/server/sync/runner-intake')
let principals: typeof import('@solus/server/admission/principal')
let database: typeof import('@solus/server/db/database')
let activityModule: typeof import('@solus/server/data/activity/activity')
let shares: import('@solus/server/sharing/share-manager').ShareManager
let operations: WorkspaceOperations

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-activity-api-'))
  process.env.SOLUS_DATA_DIR = dataDir
  intake = await import('@solus/server/sync/runner-intake')
  principals = await import('@solus/server/admission/principal')
  database = await import('@solus/server/db/database')
  activityModule = await import('@solus/server/data/activity/activity')
  const { ShareManager } = await import('@solus/server/sharing/share-manager')
  shares = new ShareManager({ db: database.getDatabase() })
  operations = (await import('@solus/server/data/workspace/service')).createWorkspaceOperations(shares)
  ;(await import('@solus/server/data/tasks/task-applier')).registerTaskOutboxApplier()
})

afterAll(async () => {
  await resetTestDatabase()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

const member = (userId: string, displayName: string): WorkspaceRequestContext => ({
  principal: { kind: 'org-member', userId, organizationId: 'org1', organizationRole: 'member', teamIds: [], hostKind: 'personal', displayName, deviceId: `${userId}-device`, deviceLabel: 'Browser', expiresAt: Date.now() + 300_000 },
  home: { kind: 'organization', organizationId: 'org1', serviceId: 'api' },
  scopes: ['tasks:read', 'tasks:write', 'works:read', 'works:write', 'sessions:read'],
})
const alice = member('alice', 'Alice')
const bob = member('bob', 'Bob')
const carol = member('carol', 'Carol')
const aliceUser: User = { id: { kind: 'account', accountId: 'alice' }, displayName: 'Alice' }
const byAlice: Attribution = { kind: 'user', user: aliceUser }
const runner = () => principals.runnerPrincipalFor({ hostId: 'runner-1', organizationId: 'org1', ownerUserId: 'alice', expiresAt: Date.now() + 600_000 })
const mention = (userId: string, name: string) => `[@${name}](person://ref?userId=${userId})`

async function activityRows(subjectId: string): Promise<number> {
  const row = await database.getDatabase().get(sql`SELECT COUNT(*) AS count FROM activity WHERE subject_id = ${subjectId}`)
  return Number((row as { count: number }).count)
}

/** A session activity as the runner's transcript mirror queues it. */
function activityItem(seq: number, activity: Activity): RunnerMirrorItem {
  return { seq, domain: 'activity', key: activity.id, payload: { activity } }
}

function transcriptItem(seq: number, position: number, message: WireSessionLoadMessage): RunnerMirrorItem {
  return { seq, domain: 'transcripts', key: `thread-1:${position}`, payload: { sessionId: 'thread-1', position, message } }
}

/** The service's history handlers, called the way its RPC layer calls them. */
async function serviceHistory() {
  const handlers = new Map<string, (args: unknown[], ctx: { principal: WorkspaceRequestContext['principal']; clientId: string }) => Promise<unknown>>()
  const server = { register: (name: string, handler: (args: unknown[], ctx: { principal: WorkspaceRequestContext['principal']; clientId: string }) => Promise<unknown>) => { handlers.set(name, handler) } }
  const { registerSolusApiHandlers } = await import('@solus/server/transport/solus-api/service-handlers')
  const { HostEventPublisher } = await import('@solus/server/transport/events/host-event-publisher')
  const { ClientEventRegistry } = await import('@solus/server/transport/events/client-event-registry')
  const { WorkLiveManager } = await import('@solus/server/work-live/work-live-manager')
  // SAFETY: the handlers only call `register` at registration time.
  registerSolusApiHandlers(server as unknown as import('@solus/server/transport/server').SolusServer, {
    shares, events: new HostEventPublisher(new ClientEventRegistry(() => true)), workLive: new WorkLiveManager({ publish: () => {} }), serviceId: 'api', host: '127.0.0.1', port: () => 0,
    presence: { watch: () => {}, unwatch: () => {} },
  })
  const ctx = { principal: alice.principal, clientId: 'alice-client' }
  return {
    load: async (limit?: number) => (await handlers.get('loadSession')!(['thread-1', undefined, undefined, undefined, limit, undefined], ctx)) as WireSessionLoadMessage[],
    page: async (before?: string) => (await handlers.get('loadSessionPage')!([{ sessionId: 'thread-1', turnLimit: 1, before }], ctx)) as { messages: WireSessionLoadMessage[]; before: string | null },
  }
}

describe('activity on the Solus API', () => {
  const stopped = () => ({ id: '01STOPPED0000000000000000A', subject: { kind: 'session' as const, id: 'thread-1' }, at: 1_500, by: byAlice, kind: 'stopped' as const })
  const renamed = () => ({ id: '01RENAMED0000000000000000A', subject: { kind: 'session' as const, id: 'thread-1' }, at: 2_500, by: byAlice, kind: 'renamed' as const, title: 'Spec' })

  test('a mirrored session activity is stored once; a redelivery and a second copy of it add nothing', async () => {
    const report = { seq: 1, record: { sessionId: 'thread-1', provider: 'claude-code' as const, projectPath: '-repo', lastActivityAt: 1, privateToOwner: true } }
    await intake.applyRunnerSessionRecords(runner(), { hostId: 'runner-1', reports: [report] }, shares)
    const rows: WireSessionLoadMessage[] = [
      { messageId: 'u1', role: 'user', content: 'one', timestamp: 1_000 },
      { messageId: 'a1', role: 'assistant', content: 'done', timestamp: 1_100 },
      { messageId: 'u2', role: 'user', content: 'two', timestamp: 2_000 },
      { messageId: 'a2', role: 'assistant', content: 'done', timestamp: 2_100 },
      { messageId: 'u3', role: 'user', content: 'three', timestamp: 3_000 },
    ]
    const batch = { hostId: 'runner-1', items: [...rows.map((message, position) => transcriptItem(position + 1, position, message)), activityItem(6, stopped()), activityItem(7, renamed())] }
    const changed: string[] = []
    expect((await intake.applyRunnerMirror(runner(), batch, (sessionId) => changed.push(sessionId))).lastSeq).toBe(7)
    expect(await activityRows('thread-1')).toBe(2)
    expect(changed).toEqual(['thread-1'])

    // The acknowledgement was lost: the same items again apply nothing twice.
    await intake.applyRunnerMirror(runner(), batch)
    // The host queued the row again under a new sequence (its log was re-read): still one row.
    await intake.applyRunnerMirror(runner(), { hostId: 'runner-1', items: [activityItem(8, stopped())] })
    expect(await activityRows('thread-1')).toBe(2)
    const stored = await activityModule.activityFor('org1', { kind: 'session', id: 'thread-1' })
    expect(stored.map((row) => [row.kind, row.by.kind === 'user' && row.by.user.displayName])).toEqual([['stopped', 'Alice'], ['renamed', 'Alice']])
  })

  test('the API\'s session history places each activity where a host places it, once per history and once across pages', async () => {
    const history = await serviceHistory()
    const whole = await history.load()
    expect(whole.map((message) => message.activity?.kind ?? message.messageId)).toEqual(['u1', 'a1', 'stopped', 'u2', 'a2', 'renamed', 'u3'])
    // A window cut to its newest rows holds only the activity from its first message on.
    expect((await history.load(3)).map((message) => message.activity?.kind ?? message.messageId)).toEqual(['u2', 'a2', 'renamed', 'u3'])

    const pages: string[][] = []
    let before: string | undefined
    do {
      const page = await history.page(before)
      pages.push(page.messages.map((message) => message.activity?.kind ?? message.messageId))
      before = page.before ?? undefined
    } while (before)
    expect(pages).toEqual([['u3'], ['u2', 'a2', 'renamed'], ['u1', 'a1', 'stopped']])
  })

  test('the record API answers a session\'s activity to a reader who may open it, and nothing to one who may not', async () => {
    const answer = await operations.listSessionActivity(alice, 'thread-1', {})
    expect(answer.items.map((row) => row.kind)).toEqual(['stopped', 'renamed'])
    // The session is its owner's alone: Bob, in the same organization, gets no answer at all.
    await expect(operations.listSessionActivity(bob, 'thread-1', {})).rejects.toMatchObject({ status: 404 })
  })

  test('a task change from a runner\'s outbox is recorded once on the API, and read back to a reader who may open the task', async () => {
    let opCounter = 0
    const op = (name: string, payload: unknown): OutboxOp => ({ id: `op-${++opCounter}`, domain: 'tasks', resourceId: 'task-1', name, payload, sessionId: 'thread-1', recordedAt: opCounter, state: 'pending' })
    const create = op('create', { title: 'Ship it', projectKey: null, body: '', priority: null, labels: [], dueDate: null, status: 'todo', originSessionId: null, createdAt: 1_700_000_000_000 })
    const status = op('set-status', { status: 'in_progress', actor: { kind: 'agent', sessionId: 'thread-1', provider: 'claude-code', for: aliceUser } })
    const batch = { hostId: 'runner-1', ops: [{ seq: 1, op: create }, { seq: 2, op: status }] }
    await intake.applyRunnerOutbox(runner(), batch, shares)
    const once = (await operations.listTaskActivity(alice, 'task-1', {})).items
    expect(once.map((row) => row.kind === 'task_changed' && row.change)).toEqual(['created', 'status_changed'])
    // The same batch again: the cursor holds, nothing is applied twice.
    await intake.applyRunnerOutbox(runner(), batch, shares)
    expect((await operations.listTaskActivity(alice, 'task-1', {})).items.map((row) => row.id)).toEqual(once.map((row) => row.id))
  })

  test('a work\'s activity is answered to its readers only; "activity naming me" answers only the caller\'s own, on records they may open', async () => {
    // Alice's private work names Bob and Carol; her work shared with the organization names them too.
    const hidden = await operations.createWork(alice, { title: 'Private', type: 'doc', content: `Hi ${mention('bob', 'Bob')} ${mention('carol', 'Carol')}` }, 'activity-api-private-01')
    const shared = await operations.createWork(alice, { title: 'Shared', type: 'doc', content: `Hi ${mention('bob', 'Bob')} ${mention('carol', 'Carol')}` }, 'activity-api-shared-001')
    // On the Solus API a member stands in the organization's space (`cloud`), where a share with it is given.
    await shares.shareWithOrganization({ kind: 'work', id: shared.id }, { ...alice.principal, hostKind: 'cloud' })

    expect((await operations.listWorkActivity(alice, hidden.id, {})).items.map((row) => row.kind)).toEqual(['mentioned', 'mentioned'])
    await expect(operations.listWorkActivity(bob, hidden.id, {})).rejects.toMatchObject({ status: 404 })

    const bobs = (await operations.listMyActivity(bob, {})).items
    // WHY: the notifications hub reads this. Bob sees his mention on the work he may
    // open, never Carol's, and never the work he may not open.
    expect(bobs.map((row) => [row.subject.id, row.kind === 'mentioned' && row.userId])).toEqual([[shared.id, { kind: 'account', accountId: 'bob' }]])
    expect((await operations.listMyActivity(carol, {})).items.map((row) => row.subject.id)).toEqual([shared.id])
    expect((await operations.listMyActivity(alice, {})).items).toEqual([])
    // `since` leaves out what came before it.
    expect((await operations.listMyActivity(bob, { since: new Date(Date.now() + 60_000).toISOString() })).items).toEqual([])
    // A credential that may not read works reads no work mentions.
    expect((await operations.listMyActivity({ ...bob, scopes: ['tasks:read'] }, {})).items).toEqual([])
  })
})
