import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { sql } from 'drizzle-orm'
import type { HubNotification } from '@solus/contracts/notification-hub'
import type { AutomationAction } from '@solus/contracts/types'
import type { Attribution, User } from '@solus/contracts/user'
import type { Principal } from '@solus/server/admission/principal'
import type { WorkspaceRequestContext } from '@solus/server/admission/workspace-credentials'
import type { WorkspaceOperations } from '@solus/server/data/workspace/operations'
import type { HandlerCtx, SolusServer } from '@solus/server/transport/server'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// plans/015-notifications-hub.md, stage 3: each producer writes durable recipient
// rows inside the change that caused them. A review request reaches the reviewer
// the same way from RPC and from the record API; a retry notifies nobody twice and
// a deliberate re-request is a new row; a decision tells the requester; a failed
// reviewer grant leaves no row. A task names its assignee only by a typed user
// key. A mention is projected once with its activity id. An automation result is
// written in the run's own transaction with no client present. A generation
// result reaches its requester once. Whether a request is still open is the
// owning domain's answer, not the row's.

let operations: WorkspaceOperations
let store: typeof import('@solus/server/data/notifications/store')
let database: typeof import('@solus/server/db/database')
let reviews: typeof import('@solus/server/data/works/work-reviews')
let taskStore: typeof import('@solus/server/data/tasks/task-store')
let tasks: typeof import('@solus/server/data/tasks/task')
let automations: typeof import('@solus/server/data/automations/automations-store')
let jobResults: typeof import('@solus/server/notifications/review-job-results')
let shares: import('@solus/server/sharing/share-manager').ShareManager

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-notification-producers-'))
  process.env.SOLUS_DATA_DIR = dataDir
  store = await import('@solus/server/data/notifications/store')
  database = await import('@solus/server/db/database')
  reviews = await import('@solus/server/data/works/work-reviews')
  taskStore = await import('@solus/server/data/tasks/task-store')
  tasks = await import('@solus/server/data/tasks/task')
  automations = await import('@solus/server/data/automations/automations-store')
  jobResults = await import('@solus/server/notifications/review-job-results')
  const { ShareManager } = await import('@solus/server/sharing/share-manager')
  shares = new ShareManager({ db: database.getDatabase() })
  operations = (await import('@solus/server/data/workspace/service')).createWorkspaceOperations(shares)
})

afterAll(async () => {
  await resetTestDatabase()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

beforeEach(async () => {
  await database.getDatabase().run(sql`DELETE FROM notifications`)
})

const memberPrincipal = (userId: string): Extract<Principal, { kind: 'org-member' }> => ({
  kind: 'org-member', userId, organizationId: 'org1', organizationRole: 'member', teamIds: [], hostKind: 'cloud',
  displayName: userId, deviceId: `${userId}-device`, deviceLabel: 'Browser', expiresAt: Date.now() + 300_000,
})
const member = (userId: string): WorkspaceRequestContext => ({
  principal: memberPrincipal(userId),
  home: { kind: 'organization', organizationId: 'org1', serviceId: 'api' },
  scopes: ['tasks:read', 'tasks:write', 'works:read', 'works:write', 'sessions:read'],
})
const alice = member('alice')
const user = (accountId: string): User => ({ id: { kind: 'account', accountId }, displayName: accountId })
const byAlice: Attribution = { kind: 'user', user: user('alice') }

async function inbox(recipientKey: string, organizationId = 'org1'): Promise<HubNotification[]> {
  return (await store.listNotifications({ scope: organizationId, recipientKey }, {})).items
}

let workCounter = 0
async function newWork(content = 'body') {
  workCounter++
  return operations.createWork(alice, { title: `Spec ${workCounter}`, type: 'doc', content }, `producers-work-${workCounter}`.padEnd(16, '0'))
}

function rpcHandlers(register: (server: SolusServer) => void): Map<string, (args: unknown[], ctx: HandlerCtx) => Promise<unknown>> {
  const handlers = new Map<string, (args: unknown[], ctx: HandlerCtx) => Promise<unknown>>()
  // SAFETY: the handlers only call `register` at registration time.
  register({ register: (name: string, handler: (args: unknown[], ctx: HandlerCtx) => Promise<unknown>) => { handlers.set(name, handler) } } as unknown as SolusServer)
  return handlers
}
const handlerCtx = (principal: Principal): HandlerCtx => ({ principal, actor: { principal, user: user(principal.kind === 'org-member' ? principal.userId : 'x') }, clientId: 'c' } as HandlerCtx)

describe('work reviews', () => {
  test('a request reaches each reviewer the same way from RPC and from the record API', async () => {
    const viaApi = await newWork()
    await operations.requestWorkReview(alice, viaApi.id, { reviewerIds: ['bob'], expectedContentVersion: viaApi.contentVersion })
    const viaRpc = await newWork()
    const { registerWorkReviewHandlers } = await import('@solus/server/transport/handlers/work-review-handlers')
    const rpc = rpcHandlers((server) => registerWorkReviewHandlers(server, { shares }))
    await rpc.get('workReviewRequest')!([viaRpc.id, { reviewers: [{ userId: 'bob', displayName: 'Bob' }], expectedContentVersion: viaRpc.contentVersion }], handlerCtx(memberPrincipal('alice')))

    const rows = await inbox('bob')
    expect(rows.map((row) => [row.facts.kind, row.resource.kind === 'work' && row.resource.workId, row.by.kind]).sort())
      .toEqual([['work.review_requested', viaApi.id, 'user'], ['work.review_requested', viaRpc.id, 'user']].sort())
    // The requester's own hub stays quiet.
    expect(await inbox('alice')).toEqual([])
  })

  test('a retried request notifies nobody twice; a deliberate re-request is a new notification', async () => {
    const work = await newWork()
    const ask = (requestId: string) => operations.requestWorkReview(alice, work.id, { reviewerIds: ['bob', 'bob'], expectedContentVersion: work.contentVersion, requestId })
    await ask('req-1')
    await ask('req-1')
    expect(await inbox('bob')).toHaveLength(1)
    await ask('req-2')
    const rows = await inbox('bob')
    expect(rows.map((row) => row.eventId.split(':').at(-1))).toEqual(['req-2', 'req-1'])
  })

  test('a decision tells the requester, and leaves the reviewer\'s own read state alone', async () => {
    const work = await newWork()
    await operations.requestWorkReview(alice, work.id, { reviewerIds: ['bob'], expectedContentVersion: work.contentVersion })
    await reviews.decideWorkReview('org1', work.id, { target: { kind: 'current', contentVersion: work.contentVersion }, decision: 'approved' }, user('bob'))
    const [request] = await inbox('bob')
    expect(request).toMatchObject({ facts: { kind: 'work.review_requested' }, readAt: null })
    const [decision] = await inbox('alice')
    expect(decision).toMatchObject({ facts: { kind: 'work.review_decided', decision: 'approved' }, by: { kind: 'user' } })
  })

  test('a reviewer grant that fails rolls the notification back with the request', async () => {
    const work = await newWork()
    const { registerWorkReviewHandlers } = await import('@solus/server/transport/handlers/work-review-handlers')
    const failingShares = { list: async () => { throw new Error('the grant failed') } } as unknown as import('@solus/server/sharing/share-manager').ShareManager
    const rpc = rpcHandlers((server) => registerWorkReviewHandlers(server, { shares: failingShares }))
    await expect(rpc.get('workReviewRequest')!([work.id, { reviewers: [{ userId: 'bob', displayName: 'Bob' }], expectedContentVersion: work.contentVersion }], handlerCtx(memberPrincipal('alice')))).rejects.toThrow('the grant failed')
    expect(await inbox('bob')).toEqual([])
  })

  test('deleting a work removes its notifications', async () => {
    const work = await newWork()
    await operations.requestWorkReview(alice, work.id, { reviewerIds: ['bob'], expectedContentVersion: work.contentVersion })
    await operations.deleteWork(alice, work.id, (await operations.getWork(alice, work.id)).version)
    expect(await inbox('bob')).toEqual([])
  })
})

describe('task assignment', () => {
  test('only a typed assignee is notified; a reassignment notifies the new assignee', async () => {
    const created = await taskStore.createTask('org1', { title: 'Ship it', assignee: 'bob-on-github', assigneeUserId: 'bob' }, undefined, byAlice)
    expect((await inbox('bob')).map((row) => row.facts.kind)).toEqual(['task.assigned'])
    // A provider login alone names nobody.
    const unmapped = await taskStore.createTask('org1', { title: 'Upstream', assignee: 'carol' }, undefined, byAlice)
    expect(await inbox('carol')).toEqual([])

    const task = await tasks.Task.byId('org1', created.id)
    await task.update({ assigneeUserId: 'carol', assignee: 'Carol' }, byAlice)
    expect((await inbox('carol')).map((row) => row.resource.kind === 'task' && row.resource.taskId)).toEqual([created.id])
    // Assigning yourself is not news.
    await (await tasks.Task.byId('org1', unmapped.id)).update({ assigneeUserId: 'alice' }, byAlice)
    expect(await inbox('alice')).toEqual([])
  })

  test('a task cannot name a guest, nor anyone but the host user on a Local task', async () => {
    await expect(taskStore.createTask('org1', { title: 'x', assigneeUserId: 'guest:g1' }, undefined, byAlice)).rejects.toThrow('member account')
    await expect(taskStore.createTask('local', { title: 'x', assigneeUserId: 'someone' }, undefined, byAlice)).rejects.toThrow('Local task')
  })
})

describe('mentions', () => {
  test('a saved mention is projected once, with its activity id', async () => {
    const work = await newWork('Hi [@Bob](person://ref?userId=bob)')
    const [row] = await inbox('bob')
    expect(row).toMatchObject({ facts: { kind: 'mention' }, resource: { kind: 'work', workId: work.id } })
    expect(row!.activityId).toBeString()
    expect(row!.summary.title).toBe(work.title)
    // An edit that keeps the mention records nothing new.
    const current = await operations.getWork(alice, work.id)
    await operations.updateWork(alice, work.id, { content: 'Hi [@Bob](person://ref?userId=bob) again', expectedContentVersion: current.contentVersion }, current.version)
    expect(await inbox('bob')).toHaveLength(1)
  })
})

describe('automation results', () => {
  const action: AutomationAction = { prompt: 'Check CI.', agentProvider: 'codex', modelId: null, reasoningEffort: 'medium', cwd: '/repo' }

  // Automation runs live in the host's SQLite file; the hub row is written there atomically or not at all.
  test.skipIf(Boolean(process.env.DATABASE_URL))('a finished run reaches its creator with no client connected, once however often it is finished', async () => {
    const automation = await automations.createAutomation('Nightly', action, { kind: 'user', user: user('dana') })
    const run = await automations.startRun(automation.id)
    await automations.finishRun(automation.id, run.id, { status: 'failed', error: 'boom' })
    await automations.finishRun(automation.id, run.id, { status: 'failed', error: 'boom' })
    const rows = await inbox('dana', automation.organizationId ?? 'local')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ facts: { kind: 'automation.finished', status: 'failed' }, resource: { kind: 'automation', automationId: automation.id, runId: run.id }, summary: { title: 'Nightly' } })
  })
})

describe('generation results', () => {
  test('the requester hears the first ready or failed of their run, never a cancellation', async () => {
    const requester = { recipientKey: 'erin', organizationId: 'local', by: { kind: 'user', user: user('erin') } as Attribution }
    const target = { kind: 'pr' as const, host: 'github.com', owner: 'o', repo: 'r', number: 7 }
    const forwarded: string[] = []
    const listener = jobResults.notifyOnReviewJobResult(requester, { job: 'guide', target, title: 'Guide for o/r#7' }, (event: { status: 'queued' | 'generating' | 'ready' | 'failed' | 'cancelled' }) => forwarded.push(event.status))
    listener({ status: 'queued' })
    await listener({ status: 'ready' })
    expect(listener({ status: 'ready' })).toBeUndefined()
    const cancelled = jobResults.notifyOnReviewJobResult(requester, { job: 'lens', target, title: 'Security' }, () => {})
    expect(cancelled({ status: 'cancelled' })).toBeUndefined()
    expect(forwarded).toEqual(['queued', 'ready', 'ready'])
    const rows = await inbox('erin', 'local')
    expect(rows.map((row) => [row.facts, row.resource.kind])).toEqual([[{ kind: 'review_job.finished', status: 'ready' }, 'review_job']])
    // A job nobody asked for (the warmer) notifies nobody.
    expect(jobResults.notifyOnReviewJobResult(null, { job: 'guide', target, title: 'x' }, () => {})).toBeFunction()
  })
})
