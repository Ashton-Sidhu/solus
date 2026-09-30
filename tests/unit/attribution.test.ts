/// <reference types="bun-types" />
/**
 * Who did something (plans/012-user-actor-and-activity.md §2, stage 4). A work
 * revision, a comment, a task change and an automation each record one
 * `Attribution` from the admitted actor, so one person reads as the same user
 * everywhere; an agent's work names its session and the person it worked for.
 * Rows written before stage 4 hold older shapes, and they must still read.
 *
 * Run with `bun run test:unit`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { sql } from 'drizzle-orm'
import type { Attribution, User } from '@solus/contracts/user'
import type { AutomationAction, PlanComment } from '@solus/contracts/types'
import type { HandlerCtx, SolusServer } from '@solus/server/transport/server'
import { memberPrincipal } from './helpers/actors'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

let dataDir: string
const previousDataDir = process.env.SOLUS_DATA_DIR
let db: typeof import('@solus/server/db')
let database: typeof import('@solus/server/db/database')
let actors: typeof import('@solus/server/admission/actor')
let credentials: typeof import('@solus/server/admission/workspace-credentials')
let hostUser: typeof import('@solus/server/host/host-user')
let works: typeof import('@solus/server/data/works/works')
let workModule: typeof import('@solus/server/data/works/work')
let workAnnotations: typeof import('@solus/server/data/works/work-annotations')
let taskStore: typeof import('@solus/server/data/tasks/task-store')
let tasks: typeof import('@solus/server/data/tasks/task')
let automations: typeof import('@solus/server/data/automations/automations-store')
let storedComments: typeof import('@solus/server/annotations/stored-comments')
let handlers: Map<string, (args: unknown[], ctx: HandlerCtx) => unknown>

const OWNER = { kind: 'local-owner', deviceId: null, deviceLabel: 'Mac' } as const
const action: AutomationAction = { prompt: 'Check CI.', agentProvider: 'codex', modelId: null, reasoningEffort: 'medium', cwd: '/repo' }

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-attribution-'))
  process.env.SOLUS_DATA_DIR = dataDir
  db = await import('@solus/server/db')
  database = await import('@solus/server/db/database')
  actors = await import('@solus/server/admission/actor')
  credentials = await import('@solus/server/admission/workspace-credentials')
  hostUser = await import('@solus/server/host/host-user')
  works = await import('@solus/server/data/works/works')
  workModule = await import('@solus/server/data/works/work')
  workAnnotations = await import('@solus/server/data/works/work-annotations')
  taskStore = await import('@solus/server/data/tasks/task-store')
  tasks = await import('@solus/server/data/tasks/task')
  automations = await import('@solus/server/data/automations/automations-store')
  storedComments = await import('@solus/server/annotations/stored-comments')
  // The handlers as `SolusServer.handle()` reaches them, with the actor it resolves.
  handlers = new Map()
  const server = { register: (method: string, handler: (args: unknown[], ctx: HandlerCtx) => unknown) => handlers.set(method, handler) } as unknown as SolusServer
  const { registerFolioHandlers } = await import('@solus/server/transport/handlers/folio-handlers')
  const { registerTasksHandlers } = await import('@solus/server/transport/handlers/tasks-handlers')
  const { registerAutomationHandlers } = await import('@solus/server/transport/handlers/automation-handlers')
  registerFolioHandlers(server)
  registerTasksHandlers(server, { sync: false })
  registerAutomationHandlers(server)
})

beforeEach(() => hostUser.useHostUser({ localId: 'L1' }))

afterEach(async () => {
  hostUser.useHostUser(null)
  await resetTestDatabase()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `solus.db${suffix}`), { force: true })
})

afterAll(() => {
  db.closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

function ownerCtx(): HandlerCtx {
  return { clientId: 'c-owner', principal: OWNER, actor: actors.actorFor(OWNER) }
}

async function call<T>(method: string, args: unknown[], ctx: HandlerCtx): Promise<T> {
  return await handlers.get(method)!(args, ctx) as T
}

describe('one person’s actions', () => {
  test('a work revision, a comment, a task change and an automation name the same user', async () => {
    // WHY: before stage 4 each wrote its own shape — a `person` with a key, a
    // `'you'` label, the `'user'` task actor, a creator with a bare id — and
    // none could say which user it was.
    const ctx = ownerCtx()
    const me: User = ctx.actor.user!
    const person: Attribution = { kind: 'user', user: me }

    // A work body the owner restores is theirs.
    const work = await works.createWork('local', 'Spec', 'doc', 'first', '', undefined, 'claude-code')
    await (await workModule.Work.byId('local', work.id)).updateContent({ content: 'second', expectedContentVersion: 1, author: { kind: 'agent', sessionId: 's-0' }, reason: 'agent' })
    const previousRevisionId = (await workModule.Work.byId('local', work.id)).previousRevisionId
    const reverted = await call<{ contentAuthor: Attribution | null }>('restoreWorkRevision', [work.id, previousRevisionId, 2], ctx)
    const revisions = await (await workModule.Work.byId('local', work.id)).revisions()

    // A thread they start on it.
    const annotations = await call<{ comments: PlanComment[] }>('applyWorkComment', [work.id, { kind: 'add', comment: { id: 'c1', selectedText: 'second', comment: 'Tighten this' } }], ctx)

    // A task they link that work to, and comment on.
    const task = await taskStore.createTask('local', { title: 'Ship it' })
    const linked = await call<{ links: Array<{ createdBy: Attribution }>; activity: Array<{ kind: string; change?: string; by: Attribution }> }>('tasksLink', [task.id, { kind: 'work', targetKey: work.id }], ctx)
    const commented = await call<{ comments: Array<{ author?: Attribution }> }>('tasksComment', [task.id, 'Linked the spec'], ctx)

    // An automation they create.
    const automation = await call<{ id: string }>('automationCreate', ['Nightly', action, true, { type: 'manual' }], ctx)

    expect(reverted.contentAuthor).toEqual(person)
    expect(revisions.at(-1)).toMatchObject({ reason: 'restore', author: person })
    expect(annotations.comments[0]!.author).toEqual(person)
    expect(linked.links[0]!.createdBy).toEqual(person)
    expect(linked.activity.find((entry) => entry.change === 'linked')!.by).toEqual(person)
    expect(commented.comments[0]!.author).toEqual(person)
    expect((await automations.loadAutomation(automation.id))!.createdBy).toEqual(person)
  })

  test('a client cannot say who made an automation', async () => {
    // The old RPC took a creator from the client; an argument in its place is no author.
    const created = await call<{ createdBy: Attribution }>('automationCreate', ['Claimed', action, true, { type: 'manual' }], ownerCtx())
    expect(created.createdBy).toEqual({ kind: 'user', user: ownerCtx().actor.user! })
  })
})

describe('a plan the client writes whole', () => {
  test('the host stamps what the client wrote and keeps every author it already gave', () => {
    // WHY: a plan's rail saves the whole thread list, so the client could name
    // anyone. It names nobody; the host stamps the new messages as the caller.
    const alice: Attribution = { kind: 'user', user: { id: { kind: 'account', accountId: 'alice' }, displayName: 'Alice' } }
    const agent: Attribution = { kind: 'agent', sessionId: 's-1' }
    const caller: Attribution = { kind: 'user', user: { id: { kind: 'local', localId: 'L1' }, displayName: 'Owner' } }
    const kept: PlanComment = { id: 'old', selectedText: 'a', comment: 'agent note', author: agent, replies: [{ id: 'r0', author: alice, text: 'agreed', createdAt: 1 }] }
    const [stampedOld, stampedNew] = storedComments.stampComments([
      { ...kept, resolvedAt: 5, replies: [...kept.replies!, { id: 'r1', text: 'done', createdAt: 2 }] },
      { id: 'new', selectedText: 'b', comment: 'mine' },
    ], caller)
    expect(stampedOld!.author).toEqual(agent)
    expect(stampedOld!.replies!.map((reply) => reply.author)).toEqual([alice, caller])
    expect(stampedOld!.resolvedBy).toEqual(caller)
    expect(stampedNew!.author).toEqual(caller)
    expect(storedComments.stampComments([kept], caller)[0]).toBe(kept)
  })
})

describe('an agent’s actions', () => {
  test('name the session and the person it worked for', async () => {
    // A save admitted as a person but made by their agent (agentSaveWork).
    const ctx = ownerCtx()
    const work = await works.createWork('local', 'Spec', 'doc', 'first', '', undefined, 'claude-code')
    await call('agentSaveWork', [work.id, { content: 'agent body' }, 1], ctx)
    expect((await workModule.Work.byId('local', work.id)).contentAuthor).toEqual({ kind: 'agent', sessionId: '', for: ctx.actor.user! })

    // A member's agent turn writing through the Solus API.
    const member = memberPrincipal('alice', 'Alice Chen')
    const context = { principal: member, home: { kind: 'organization' as const, serviceId: 'api', organizationId: 'org-1' }, scopes: ['works:write' as const], actingAgent: { sessionId: 'agent-7', organizationId: 'org-1' } }
    expect(credentials.requestAttribution(context)).toEqual({ kind: 'agent', sessionId: 'agent-7', for: { id: { kind: 'account', accountId: 'alice' }, displayName: 'Alice Chen' } })
    const { actingAgent: _agent, ...personal } = context
    expect(credentials.requestAttribution(personal)).toEqual({ kind: 'user', user: { id: { kind: 'account', accountId: 'alice' }, displayName: 'Alice Chen' } })
  })

  test('an automation an agent made pauses with the person whose session made it', async () => {
    // WHY: member removal pauses a person's automations (plans/010); an agent's
    // automation is that person's even when the tool could not name them.
    const created = await automations.createAutomation('By agent', action, { kind: 'agent', sessionId: 's-bob', provider: 'codex', for: { id: { kind: 'account', accountId: 'bob' }, displayName: 'Bob' } })
    const organizationId = created.organizationId!
    expect((await automations.pauseAutomationsOf('carol', organizationId)).map((automation) => automation.id)).toEqual([])
    expect((await automations.pauseAutomationsOf('bob', organizationId)).map((automation) => automation.id)).toEqual([created.id])
  })
})

describe('rows written before stage 4', () => {
  // Old task event actors move with `task_events` into `activity` (activity.test.ts).
  test('old comment authors and link makers still read', async () => {
    const task = await taskStore.createTask('local', { title: 'Old task' })
    const raw = database.getDatabase()
    await raw.run(sql`INSERT INTO task_comments (id, task_id, author, source, origin_session_id, body, created_at, organization_id) VALUES
      ('01C1', ${task.id}, 'You', 'local', NULL, 'mine', 10, 'local'),
      ('01C2', ${task.id}, 'agent', 'local', 'thread-9', 'the agent', 11, 'local')`)
    await raw.run(sql`INSERT INTO task_comments (id, task_id, author, source, external_id, body, created_at, organization_id) VALUES
      ('external:1', ${task.id}, 'octocat', 'external', '1', 'upstream', 12, 'local')`)
    await raw.run(sql`INSERT INTO task_links (task_id, kind, target_scope, target_key, title, created_by, origin_session_id, linked_at, organization_id) VALUES
      (${task.id}, 'automation', '', 'a1', 'A', 'migration', NULL, 1, 'local'),
      (${task.id}, 'automation', '', 'a2', 'B', 'agent', 'thread-9', 2, 'local')`)

    const details = await (await tasks.Task.byId('local', task.id)).details()
    const owner: Attribution = { kind: 'user', user: hostUser.hostUser()! }
    const agent: Attribution = { kind: 'agent', sessionId: 'thread-9' }
    expect(details.comments.map((comment) => [comment.author, comment.externalAuthor])).toEqual([[owner, undefined], [agent, undefined], [undefined, 'octocat']])
    expect(Object.fromEntries(details.links.map((link) => [link.targetKey, link.createdBy]))).toEqual({ a1: { kind: 'system' }, a2: agent })
  })

  test('old work and revision authors still read; nobody recorded is null, never a guess', async () => {
    const work = await works.createWork('local', 'Old work', 'doc', 'body', '', undefined, 'claude-code')
    const raw = database.getDatabase()
    await raw.run(sql`UPDATE works SET content_author = ${JSON.stringify({ kind: 'person', userId: 'host-owner', displayName: 'Host owner' })} WHERE id = ${work.id}`)
    await raw.run(sql`UPDATE work_revisions SET author = ${JSON.stringify({ kind: 'agent', sessionId: null })} WHERE work_id = ${work.id} AND rev = 1`)
    const entity = await workModule.Work.byId('local', work.id)
    expect(entity.contentAuthor).toEqual({ kind: 'user', user: hostUser.hostUser()! })
    expect((await entity.revisions())[0]!.author).toEqual({ kind: 'agent', sessionId: '' })

    await raw.run(sql`UPDATE works SET content_author = ${JSON.stringify({ kind: 'person', userId: 'bob', displayName: 'Bob' })} WHERE id = ${work.id}`)
    await raw.run(sql`UPDATE work_revisions SET author = ${JSON.stringify({ kind: 'unknown' })} WHERE work_id = ${work.id} AND rev = 1`)
    const again = await workModule.Work.byId('local', work.id)
    expect(again.contentAuthor).toEqual({ kind: 'user', user: { id: { kind: 'account', accountId: 'bob' }, displayName: 'Bob' } })
    expect((await again.revisions())[0]!.author).toBeNull()
  })

  test('an old automation creator still reads, and still pauses with its person', async () => {
    const byOwner = await automations.createAutomation('Old owner', action, { kind: 'system' })
    const byMember = await automations.createAutomation('Old member', action, { kind: 'system' })
    const byAgent = await automations.createAutomation('Old agent', action, { kind: 'system' })
    const legacy = (id: string, createdBy: object) => db.getDb().prepare('UPDATE automations SET last_run = ? WHERE id = ?').run(JSON.stringify({ createdBy }), id)
    legacy(byOwner.id, { kind: 'user' })
    legacy(byMember.id, { kind: 'user', userId: 'bob' })
    legacy(byAgent.id, { kind: 'agent', agentProvider: 'codex', sessionId: 's-1', userId: 'bob' })

    expect((await automations.loadAutomation(byOwner.id))!.createdBy).toEqual({ kind: 'user', user: hostUser.hostUser()! })
    expect((await automations.loadAutomation(byMember.id))!.createdBy).toEqual({ kind: 'user', user: { id: { kind: 'account', accountId: 'bob' }, displayName: 'Organization member' } })
    expect((await automations.loadAutomation(byAgent.id))!.createdBy).toMatchObject({ kind: 'agent', sessionId: 's-1', provider: 'codex', for: { id: { kind: 'account', accountId: 'bob' } } })
    const paused = await automations.pauseAutomationsOf('bob', byMember.organizationId!)
    expect(paused.map((automation) => automation.id).sort()).toEqual([byMember.id, byAgent.id].sort())
  })

  test('an old comment thread reads as attributions, on a host and on the Solus API', () => {
    const legacy = [
      { id: 'c1', selectedText: 'a', comment: 'mine', author: 'you' },
      { id: 'c2', selectedText: 'b', comment: 'theirs', author: 'you', person: { userId: 'bob', displayName: 'Bob', colorIndex: 2 }, replies: [
        { id: 'r1', author: 'solus', authorAgent: { sessionId: 's-1', provider: 'codex', title: 'Reviewer' }, text: 'noted', createdAt: 2 },
      ] },
      { id: 'c3', selectedText: 'c', comment: 'unsigned', author: 'solus', resolvedAt: 5, resolvedBy: 'you' },
    ] as unknown as PlanComment[]
    const host: User = { id: { kind: 'local', localId: 'L1' }, displayName: 'Owner' }
    const onHost = storedComments.readStoredComments(legacy, host)
    expect(onHost.map((thread) => thread.author)).toEqual([
      { kind: 'user', user: host },
      { kind: 'user', user: { id: { kind: 'account', accountId: 'bob' }, displayName: 'Bob' } },
      { kind: 'system' },
    ])
    expect(onHost[1]!.replies![0]!.author).toEqual({ kind: 'agent', sessionId: 's-1', provider: 'codex', title: 'Reviewer' })
    expect(onHost[2]!.resolvedBy).toEqual({ kind: 'user', user: host })
    expect(onHost.some((thread) => 'person' in thread || 'authorAgent' in thread)).toBe(false)
    // The Solus API has no host user: an unsigned `'you'` was the host's own work.
    expect(storedComments.readStoredComments(legacy, null)[0]!.author).toEqual({ kind: 'system' })
    // A thread already in the new shape comes back as the same object.
    expect(storedComments.readStoredComments(onHost, host)[1]).toBe(onHost[1])
  })
})
