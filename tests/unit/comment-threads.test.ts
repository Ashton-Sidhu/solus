import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Param, SQL, sql } from 'drizzle-orm'
import { DatabaseSync } from './helpers/bun-sqlite'
import { resetTestDatabase } from './helpers/test-db'
import type { Attribution } from '@solus/contracts/user'
import type { NormalizedTicket, Task } from '@solus/contracts/task-types'
import type { PlanAnnotations, PlanComment } from '@solus/contracts/types'
import type { CommentActor } from '@solus/contracts/comment-commands'

// plans/029-fresh-database-baseline.md §5.2: one `comment_threads` table for
// tasks, works, and plans, with the six corrections the model validation named
// (plans/data-model-validation/README.md). The fixtures there ran against a
// synthetic schema; these are the same assertions against the stores.

mock.module('node:sqlite', () => ({ DatabaseSync }))

type DbModule = typeof import('@solus/server/db')
type DatabaseModule = typeof import('@solus/server/db/database')
type ThreadsModule = typeof import('@solus/server/data/comments/comment-threads')
type TaskStoreModule = typeof import('@solus/server/data/tasks/task-store')
type TaskModule = typeof import('@solus/server/data/tasks/task')
type TaskSyncStoreModule = typeof import('@solus/server/data/tasks/task-sync-store')
type WorksModule = typeof import('@solus/server/data/works/works')
type WorkModule = typeof import('@solus/server/data/works/work')
type WorkAnnotationsModule = typeof import('@solus/server/data/works/work-annotations')
type PlanAnnotationsModule = typeof import('@solus/server/plans/annotations')
type PlanIndexModule = typeof import('@solus/server/plans/plan-index')
type HostUserModule = typeof import('@solus/server/host/host-user')

let dataDir: string
let db: DbModule
let database: DatabaseModule
let threads: ThreadsModule
let taskStore: TaskStoreModule
let tasks: TaskModule
let syncStore: TaskSyncStoreModule
let works: WorksModule
let workModule: WorkModule
let workAnnotations: WorkAnnotationsModule
let planAnnotations: PlanAnnotationsModule
let planIndex: PlanIndexModule
let hostUser: HostUserModule
const previousDataDir = process.env.SOLUS_DATA_DIR

const ALICE: Attribution = { kind: 'user', user: { id: { kind: 'account', accountId: 'alice' }, displayName: 'Alice' } }
const BOB: Attribution = { kind: 'user', user: { id: { kind: 'account', accountId: 'bob' }, displayName: 'Bob' } }
const AGENT: Attribution = { kind: 'agent', sessionId: 'agent-1' }
const SYSTEM: Attribution = { kind: 'system' }

function actor(by: Attribution, now = 10, canModerate = false): CommentActor {
  return { by, canModerate, now }
}

function ticket(overrides: Partial<NormalizedTicket> = {}): NormalizedTicket {
  return {
    provider: 'github',
    externalKey: 'solus/desktop',
    externalId: '42',
    url: 'https://github.com/solus/desktop/issues/42',
    title: 'Remote',
    body: '',
    status: 'todo',
    labels: [],
    externalUpdatedAt: 'r1',
    comments: [],
    ...overrides,
  }
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-comment-threads-'))
  process.env.SOLUS_DATA_DIR = dataDir
  db = await import('@solus/server/db')
  database = await import('@solus/server/db/database')
  threads = await import('@solus/server/data/comments/comment-threads')
  taskStore = await import('@solus/server/data/tasks/task-store')
  tasks = await import('@solus/server/data/tasks/task')
  syncStore = await import('@solus/server/data/tasks/task-sync-store')
  works = await import('@solus/server/data/works/works')
  workModule = await import('@solus/server/data/works/work')
  workAnnotations = await import('@solus/server/data/works/work-annotations')
  planAnnotations = await import('@solus/server/plans/annotations')
  planIndex = await import('@solus/server/plans/plan-index')
  hostUser = await import('@solus/server/host/host-user')
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

async function task(title = 'Task'): Promise<Task> {
  return taskStore.createTask('local', { title })
}

async function work(title = 'Spec') {
  return works.createWork('local', title, 'doc', 'The body.', '', undefined, 'claude-code', '/tmp/proj')
}

function workSubject(workId: string): import('@solus/server/data/comments/comment-threads').ThreadSubject {
  return { organizationId: 'local', kind: 'work', id: workId }
}

async function planWith(sessionId: string, planToolUseId: string, comments: PlanComment[] = [], updatedAt = 0): Promise<PlanAnnotations> {
  const annotations: PlanAnnotations = {
    version: 1, sessionId, projectPath: '/p', cwd: '/p', planToolUseId, title: 'Plan', status: 'pending', comments, bookmarked: false, updatedAt,
  }
  await planAnnotations.saveAnnotations('local', annotations, ALICE)
  return (await planAnnotations.loadAnnotations('local', sessionId, planToolUseId))!
}

async function threadCount(where: SQL): Promise<number> {
  const row = await database.getDatabase().get<{ count: number }>(sql`SELECT COUNT(*) AS count FROM comment_threads WHERE ${where}`)
  return Number(row?.count ?? 0)
}

describe('ordering', () => {
  test("a task's comments read by (created_at, id): two in one millisecond keep their id order", async () => {
    // WHY: two comments written in the same millisecond used to come back in
    // arbitrary order (task-store.test.ts flaked on it). The id breaks the tie.
    const created = await task()
    const subject = { organizationId: 'local', kind: 'task' as const, id: created.id }
    const dbh = database.getDatabase()
    for (const [id, at] of [['z', 9], ['b', 2], ['a', 2]] as const) {
      await threads.insertThread(dbh, subject, { threadId: id, body: 'note', author: ALICE, createdBy: 'alice', createdAt: at })
    }
    expect((await threads.readThreads(dbh, subject)).map((thread) => thread.threadId)).toEqual(['a', 'b', 'z'])
    expect((await (await tasks.Task.byId('local', created.id)).details()).comments.map((comment) => comment.id)).toEqual(['a', 'b', 'z'])
  })

  test("a work's and a plan's threads read in the order they were added, by a position the parent allocates", async () => {
    // WHY: a review rail is a list the person built; a comment written later
    // about an earlier passage stays where it was put, whatever its clock says.
    const created = await work()
    await workAnnotations.applyWorkComment('local', created.id, { kind: 'add', comment: { id: 'z', selectedText: 'q', comment: 'first', pin: { x: 0.2, y: 0.4 } } }, actor(ALICE, 30))
    await workAnnotations.applyWorkComment('local', created.id, { kind: 'add', comment: { id: 'a', selectedText: 'r', comment: 'second' } }, actor(ALICE, 1))
    const rows = await threads.readThreads(database.getDatabase(), workSubject(created.id))
    expect(rows.map((thread) => [thread.threadId, thread.position])).toEqual([['z', 1], ['a', 2]])
    const loaded = (await workAnnotations.loadWorkAnnotations('local', created.id))!
    expect(loaded.comments.map((comment) => comment.id)).toEqual(['z', 'a'])
    expect(loaded.comments[0]).toEqual({ id: 'z', selectedText: 'q', comment: 'first', pin: { x: 0.2, y: 0.4 }, author: ALICE, createdAt: 30, readBy: [{ userId: 'alice', readAt: 30 }] })

    const plan = await planWith('s1', 'tool', [
      { id: 'z', selectedText: 'q', comment: 'late', author: ALICE, createdAt: 30 },
      { id: 'a', selectedText: 'r', comment: 'early', author: ALICE, createdAt: 1 },
    ])
    expect(plan.comments.map((comment) => comment.id)).toEqual(['z', 'a'])
  })

  test('a replayed insert writes nothing and leaves the position counter where it was', async () => {
    // WHY: a redelivered outbox op inserts under the same id. A second row, or a
    // skipped position, would make the replay visible.
    const created = await task()
    const subject = { organizationId: 'local', kind: 'task' as const, id: created.id }
    const dbh = database.getDatabase()
    expect(await threads.insertThread(dbh, subject, { threadId: 'a', body: 'note', author: ALICE, createdBy: 'alice', createdAt: 1 })).toBe(true)
    expect(await threads.insertThread(dbh, subject, { threadId: 'a', body: 'replayed', author: ALICE, createdBy: 'alice', createdAt: 1 })).toBe(false)
    expect((await threads.readThread(dbh, subject, 'a'))?.body).toBe('note')
    const counter = await dbh.get<{ comment_position: number }>(sql`SELECT comment_position FROM tasks WHERE id = ${created.id}`)
    expect(counter?.comment_position).toBe(1)
  })
})

describe('who made a thread', () => {
  test('created_by is the acting person, the person an agent acts for, else the host user', async () => {
    const created = await task()
    const t = await tasks.Task.byId('local', created.id)
    await t.comment('by alice', { by: ALICE })
    await t.comment('by an agent for bob', { by: { kind: 'agent', sessionId: 'a', for: BOB.kind === 'user' ? BOB.user : undefined } })
    await t.comment('by an agent', { by: AGENT })
    const rows = await threads.readThreads(database.getDatabase(), { organizationId: 'local', kind: 'task', id: created.id })
    expect(rows.map((thread) => thread.createdBy)).toEqual(['alice', 'bob', hostUser.hostUserKey()])
    expect(rows.map((thread) => thread.author)).toEqual([ALICE, { kind: 'agent', sessionId: 'a', for: BOB.kind === 'user' ? BOB.user : undefined }, AGENT])
  })
})

describe('external identity', () => {
  test('an upstream comment is one row under its target; the same id under another target, task, or organization is another row', async () => {
    // WHY (correction 3): a task relinked to another ticket must not have the new
    // ticket's comment 42 collide with the old ticket's comment 42.
    const dbh = database.getDatabase()
    const first = await task('first')
    const second = await task('second')
    const other = await taskStore.createTask('org-a', { title: 'theirs' })
    await syncStore.writeExternalLink(dbh, 'local', first.id, ticket({ comments: [{ externalId: '42', author: 'octocat', body: 'upstream', createdAt: 5 }] }))
    expect(await syncStore.insertExternalComments(dbh, 'local', first.id, [{ externalId: '42', author: 'octocat', body: 'replayed', createdAt: 5 }])).toBe(0)
    await syncStore.writeExternalLink(dbh, 'local', second.id, ticket({ externalId: '43', comments: [{ externalId: '42', author: 'octocat', body: 'elsewhere', createdAt: 5 }] }))
    await syncStore.writeExternalLink(dbh, 'org-a', other.id, ticket({ externalKey: 'theirs/repo', comments: [{ externalId: '42', author: 'octocat', body: 'theirs', createdAt: 5 }] }))
    expect(await threadCount(sql`external_id = '42'`)).toBe(3)

    // Relinked to another ticket: its comment 42 is a new row beside the old target's.
    await syncStore.writeExternalLink(dbh, 'local', first.id, ticket({ provider: 'jira', externalKey: 'cloud/PROJ', externalId: 'PROJ-7', comments: [{ externalId: '42', author: 'jane', body: 'jira', createdAt: 6 }] }))
    const details = await (await tasks.Task.byId('local', first.id)).details()
    expect(details.comments.map((comment) => [comment.externalAuthor, comment.externalId, comment.source])).toEqual([['octocat', '42', 'external'], ['jane', '42', 'external']])
    expect(details.comments.every((comment) => comment.author === undefined)).toBe(true)
  })
})

describe('deletion and delivery', () => {
  test('only an unpublished local comment can be deleted: private and pending yes, sent and imported no', async () => {
    const dbh = database.getDatabase()
    const created = await task()
    await syncStore.writeExternalLink(dbh, 'local', created.id, ticket({ comments: [{ externalId: '1', author: 'octocat', body: 'imported', createdAt: 1 }] }))
    const t = await tasks.Task.byId('local', created.id)
    await t.comment('private', { by: ALICE })
    await t.comment('queued', { by: ALICE })
    await t.comment('sent', { by: ALICE })
    const byBody = async () => Object.fromEntries((await t.details()).comments.map((comment) => [comment.body, comment]))
    let comments = await byBody()
    await t.publishComments([comments.queued!.id, comments.sent!.id])
    await syncStore.markCommentSynced(dbh, 'local', created.id, comments.sent!.id, '2')
    comments = await byBody()
    expect(comments.queued!.syncPending).toBe(true)
    expect(comments.sent!.externalId).toBe('2')
    expect(comments.sent!.syncPending).toBeUndefined()

    const moderator = { by: BOB, canModerate: true }
    await t.deleteComment(comments.private!.id, moderator)
    await t.deleteComment(comments.queued!.id, moderator)
    await expect(t.deleteComment(comments.sent!.id, moderator)).rejects.toThrow('unpublished')
    await expect(t.deleteComment(comments.imported!.id, moderator)).rejects.toThrow('unpublished')
    expect(Object.keys(await byBody()).sort()).toEqual(['imported', 'sent'])
  })

  test('queueing selects private local comments once; the acknowledgement dedupes the later import', async () => {
    // WHY (correction 4): the delivery state is the comment's own, and the
    // ticket's copy of a comment Solus posted must not come back as a second row.
    const dbh = database.getDatabase()
    const created = await task()
    await syncStore.writeExternalLink(dbh, 'local', created.id, ticket())
    const t = await tasks.Task.byId('local', created.id)
    const id = (await t.comment('note', { by: ALICE })).comments[0]!.id
    expect(await syncStore.queueCommentsForPush(dbh, 'local', created.id, [id])).toBe(1)
    expect(await syncStore.queueCommentsForPush(dbh, 'local', created.id, [id])).toBe(0)
    expect(await syncStore.pendingCommentsForTask('local', created.id)).toEqual([{ id, body: 'note' }])
    expect(await syncStore.hasPendingSync('local', created.id)).toBe(true)

    await syncStore.markCommentSynced(dbh, 'local', created.id, id, '44')
    expect(await syncStore.pendingCommentsForTask('local', created.id)).toEqual([])
    expect(await syncStore.insertExternalComments(dbh, 'local', created.id, [{ externalId: '44', author: 'me', body: 'note', createdAt: 9 }])).toBe(0)
    expect((await t.details()).comments).toHaveLength(1)
    const thread = await threads.readThread(dbh, { organizationId: 'local', kind: 'task', id: created.id }, id)
    expect(thread).toMatchObject({ deliveryState: 'sent', external: { scope: 'github:solus/desktop:42', id: '44' } })
  })
})

describe('thread versions', () => {
  test('a stale write is refused; a command is reapplied on the thread as it is now; other threads are untouched', async () => {
    // WHY (correction 5): the version is the thread's own. A reply that lost the
    // race lands beside the one that won, not over it, and a thread nobody
    // touched keeps version 1.
    const created = await work()
    const subject = workSubject(created.id)
    const dbh = database.getDatabase()
    await workAnnotations.applyWorkComment('local', created.id, { kind: 'add', comment: { id: 'z', selectedText: 'q', comment: 'note' } }, actor(ALICE, 1))
    await workAnnotations.applyWorkComment('local', created.id, { kind: 'add', comment: { id: 'a', selectedText: 'r', comment: 'other' } }, actor(ALICE, 1))
    const before = (await threads.readThread(dbh, subject, 'z'))!

    await workAnnotations.applyWorkComment('local', created.id, { kind: 'reply', commentId: 'z', reply: { id: 'r1', text: 'first' } }, actor(BOB, 2))
    expect(await threads.updateThread(dbh, subject, 'z', before.version, { body: 'stale' })).toBe(false)
    await workAnnotations.applyWorkComment('local', created.id, { kind: 'reply', commentId: 'z', reply: { id: 'r2', text: 'second' } }, actor(ALICE, 3))
    await workAnnotations.applyWorkComment('local', created.id, { kind: 'edit', commentId: 'z', text: 'edited' }, actor(ALICE, 4))
    const now = (await threads.readThread(dbh, subject, 'z'))!
    expect(now.body).toBe('edited')
    expect(now.review.replies?.map((reply) => reply.id)).toEqual(['r1', 'r2'])
    expect(now.version).toBe(before.version + 3)

    const other = (await threads.readThread(dbh, subject, 'a'))!
    expect(other.version).toBe(1)
    expect(await threads.updateThread(dbh, subject, 'a', 1, { body: 'independent' })).toBe(true)
    // A replayed reply is a conflict, not a second reply.
    await expect(workAnnotations.applyWorkComment('local', created.id, { kind: 'reply', commentId: 'z', reply: { id: 'r1', text: 'first' } }, actor(BOB, 5))).rejects.toThrow('already exists')
  })

  test('resolve-open resolves every open thread once; a repeat changes nothing', async () => {
    const created = await work()
    const subject = workSubject(created.id)
    const dbh = database.getDatabase()
    for (const id of ['a', 'b', 'c']) {
      await workAnnotations.applyWorkComment('local', created.id, { kind: 'add', comment: { id, selectedText: id, comment: 'note' } }, actor(ALICE, 1))
    }
    await workAnnotations.applyWorkComment('local', created.id, { kind: 'resolve', commentId: 'b', resolved: true }, actor(BOB, 5))
    await workAnnotations.applyWorkComment('local', created.id, { kind: 'resolve-open' }, actor(ALICE, 30))
    const rows = await threads.readThreads(dbh, subject)
    expect(rows.map((thread) => [thread.review.resolvedAt, thread.version])).toEqual([[30, 2], [5, 2], [30, 2]])
    await workAnnotations.applyWorkComment('local', created.id, { kind: 'resolve-open' }, actor(ALICE, 31))
    expect((await threads.readThreads(dbh, subject)).map((thread) => thread.version)).toEqual([2, 2, 2])
    expect((await workAnnotations.loadWorkAnnotations('local', created.id))!.comments.every((comment) => comment.resolvedAt !== undefined)).toBe(true)
  })

  test('a mark command needs no moderation and an edit of another person\'s thread is refused', async () => {
    const created = await work()
    await workAnnotations.applyWorkComment('local', created.id, { kind: 'add', comment: { id: 'a', selectedText: 'q', comment: 'mine' } }, actor(ALICE, 1))
    await expect(workAnnotations.applyWorkComment('local', created.id, { kind: 'edit', commentId: 'a', text: 'theirs' }, actor(BOB, 2))).rejects.toThrow('Only the person')
    await workAnnotations.applyWorkComment('local', created.id, { kind: 'read', commentId: 'a' }, actor(BOB, 3))
    const loaded = (await workAnnotations.loadWorkAnnotations('local', created.id))!
    expect(loaded.comments[0]!.readBy).toEqual([{ userId: 'alice', readAt: 1 }, { userId: 'bob', readAt: 3 }])
    await workAnnotations.applyWorkComment('local', created.id, { kind: 'edit', commentId: 'a', text: 'moderated' }, actor(BOB, 4, true))
    expect((await workAnnotations.loadWorkAnnotations('local', created.id))!.comments[0]!.comment).toBe('moderated')
  })
})

describe('private threads and external state', () => {
  test('a refresh of the external state keeps every private thread, and a private edit keeps the external state', async () => {
    const created = await work()
    await workAnnotations.applyWorkComment('local', created.id, { kind: 'add', comment: { id: 'a', selectedText: 'q', comment: 'private' } }, actor(ALICE, 1))
    const before = (await workAnnotations.loadWorkAnnotations('local', created.id))!.comments
    const state = { provider: 'gdrive' as const, externalKey: 'root', documentId: 'doc', threads: [], operations: [] }
    const { version } = await workAnnotations.readExternalComments('local', created.id)
    await workAnnotations.saveExternalComments('local', created.id, state, version)
    expect((await workAnnotations.loadWorkAnnotations('local', created.id))!.comments).toEqual(before)
    await expect(workAnnotations.saveExternalComments('local', created.id, { ...state, documentId: 'stale' }, version)).rejects.toThrow('changed')
    await workAnnotations.applyWorkComment('local', created.id, { kind: 'edit', commentId: 'a', text: 'private edit' }, actor(ALICE, 2))
    const after = (await workAnnotations.loadWorkAnnotations('local', created.id))!
    expect(after.externalComments).toEqual(state)
    expect(after.comments[0]!.comment).toBe('private edit')
  })
})

describe('the subject\'s lifetime', () => {
  test('a task move and a task delete remove its threads; a work move keeps them; a work delete removes them; nothing dangles', async () => {
    // WHY (correction 6, P5): the subject is polymorphic, so the parent deletes
    // its threads itself. A moved task keeps nothing here; a moved work keeps
    // its body and its comments.
    const dbh = database.getDatabase()
    const moved = await task('moved')
    const deleted = await task('deleted')
    const kept = await task('kept')
    for (const created of [moved, deleted, kept]) await (await tasks.Task.byId('local', created.id)).comment('note', { by: ALICE })
    const movedWork = await work('moved')
    const deletedWork = await work('deleted')
    for (const created of [movedWork, deletedWork]) {
      await workAnnotations.applyWorkComment('local', created.id, { kind: 'add', comment: { id: 'a', selectedText: 'q', comment: 'note' } }, actor(ALICE, 1))
    }

    await (await tasks.Task.byId('local', moved.id)).moveTo({ organizationId: 'org-a' })
    expect(await (await tasks.Task.byId('local', deleted.id)).delete()).toBe(true)
    await (await workModule.Work.byId('local', movedWork.id)).moveTo({ organizationId: 'org-a' })
    await (await workModule.Work.byId('local', deletedWork.id)).delete()

    expect(await threadCount(sql`subject_kind = 'task' AND subject_id = ${moved.id}`)).toBe(0)
    expect(await threadCount(sql`subject_kind = 'task' AND subject_id = ${kept.id}`)).toBe(1)
    expect((await workAnnotations.loadWorkAnnotations('local', movedWork.id))!.comments).toHaveLength(1)
    expect(await threadCount(sql`subject_kind = 'work' AND subject_id = ${deletedWork.id}`)).toBe(0)
    // Zero dangling threads: every task and work thread names a parent that exists.
    expect(await threadCount(sql`subject_kind = 'task' AND NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.id = comment_threads.subject_id)`)).toBe(0)
    expect(await threadCount(sql`subject_kind = 'work' AND NOT EXISTS (SELECT 1 FROM works WHERE works.id = comment_threads.subject_id)`)).toBe(0)
  })

  test("a plan index rebuild keeps the plan's threads", async () => {
    // WHY (correction 6): the threads belong to the durable annotation identity,
    // not to the rebuildable `indexed_plans` row.
    await planWith('s1', 'tool', [{ id: 'a', selectedText: 'q', comment: 'note', author: ALICE, createdAt: 1 }])
    await planIndex.indexLivePlan({ provider: 'claude-code', sessionId: 's1', threadId: 's1', planToolUseId: 'tool', projectPath: '/p', cwd: '/p', timestamp: 1, content: '# Plan\n\nDo.' })
    expect((await planIndex.listIndexedPlans('local', 'claude-code', '/p', false))[0]?.commentCount).toBe(1)
    await planIndex.replaceIndexedPlansForThread('claude-code', 's1', [])
    expect(await planIndex.listIndexedPlans('local', 'claude-code', '/p', false)).toEqual([])
    expect((await planAnnotations.loadAnnotations('local', 's1', 'tool'))!.comments).toHaveLength(1)
  })
})

describe('a whole copy of a plan\'s threads', () => {
  test('a stale copy cannot delete a thread it never saw, may delete its own, and only adds to a thread that moved', async () => {
    // WHY (§5.2): the plan rail still saves the plan whole. The copy carries the
    // `updatedAt` it was read at; the host reconciles against that state.
    const plan = await planWith('s1', 'tool', [
      { id: 'mine', selectedText: 'a', comment: 'alice wrote this', author: ALICE, createdAt: 1 },
      { id: 'shared', selectedText: 'b', comment: 'discussed', author: BOB, createdAt: 1 },
    ])
    const snapshot = plan.updatedAt
    // Later, an agent adds a thread and replies to the shared one.
    const later = snapshot + 1000
    await planAnnotations.applyPlanComment('local', 's1', 'tool', { kind: 'add', comment: { id: 'agent', selectedText: 'c', comment: 'from the agent' } }, actor(AGENT, later))
    await planAnnotations.applyPlanComment('local', 's1', 'tool', { kind: 'reply', commentId: 'shared', reply: { id: 'agent-reply', text: 'answered' } }, actor(AGENT, later))

    // Alice's copy, read before that: she deleted her own thread, resolved the
    // shared one, and replied to it.
    const resolved: PlanComment = { ...plan.comments[1]!, resolvedAt: 50, resolvedBy: ALICE, replies: [{ id: 'alice-reply', author: ALICE, text: 'thanks', createdAt: 50 }] }
    await planAnnotations.saveAnnotations('local', { ...plan, comments: [resolved], updatedAt: snapshot }, ALICE)

    const after = (await planAnnotations.loadAnnotations('local', 's1', 'tool'))!
    expect(after.comments.map((comment) => comment.id)).toEqual(['shared', 'agent'])
    const shared = after.comments[0]!
    expect(shared.resolvedAt).toBeUndefined()
    expect(shared.replies?.map((reply) => reply.id)).toEqual(['agent-reply', 'alice-reply'])

    // Read again, her copy is current: the deletion of the shared thread goes through.
    await planAnnotations.saveAnnotations('local', { ...after, comments: after.comments.filter((comment) => comment.id === 'agent') }, ALICE)
    expect((await planAnnotations.loadAnnotations('local', 's1', 'tool'))!.comments.map((comment) => comment.id)).toEqual(['agent'])
  })

  test('the metadata is saved with the copy, and the bookmark toggle leaves the threads alone', async () => {
    const plan = await planWith('s1', 'tool', [{ id: 'a', selectedText: 'q', comment: 'note', author: ALICE, createdAt: 1 }])
    await planAnnotations.saveAnnotations('local', { ...plan, status: 'accepted' }, ALICE)
    const toggled = await planAnnotations.toggleBookmarkAnnotations('local', 's1', '/p', '/p', 'tool', 'Plan')
    expect(toggled).toMatchObject({ status: 'accepted', bookmarked: true })
    expect(toggled.comments).toHaveLength(1)
    const index = await planAnnotations.loadAllAnnotations('local')
    expect(index.get('s1__tool')).toMatchObject({ status: 'accepted', bookmarked: true, commentCount: 1 })
  })
})

/** The bytes of every bound value a statement carries: a nested `sql` is walked; a value a template interpolated is measured; the statement's own text is not. */
function boundBytes(query: SQL): number {
  let bytes = 0
  for (const chunk of query.queryChunks) {
    if (chunk instanceof SQL) bytes += boundBytes(chunk)
    else if (chunk instanceof Param) bytes += JSON.stringify(chunk.value).length
    else if (typeof chunk === 'string' || typeof chunk === 'number' || typeof chunk === 'boolean') bytes += JSON.stringify(chunk).length
  }
  return bytes
}

describe('what one edit writes', () => {
  test('a single-thread edit writes one thread, however many threads the work has', async () => {
    // WHY (§5.2, measured): the whole-list sidecar wrote 121,991 bytes per edit at
    // 100 threads; one row writes one thread. The write must not grow with the list.
    const body = 'x'.repeat(1024)
    const written: number[] = []
    for (const count of [10, 100]) {
      const created = await work(`with ${count}`)
      const subject = workSubject(created.id)
      const dbh = database.getDatabase()
      for (let index = 0; index < count; index++) {
        await threads.insertThread(dbh, subject, { threadId: `t${index}`, body, author: ALICE, createdBy: 'alice', createdAt: 1, review: { selectedText: 'q'.repeat(128) } })
      }
      let bytes = 0
      const recording: typeof dbh = {
        engine: dbh.engine,
        all: (query) => dbh.all(query),
        get: (query) => dbh.get(query),
        run: (query) => { bytes += boundBytes(query); return dbh.run(query) },
        transaction: (fn) => dbh.transaction(fn),
      }
      await threads.applyThreadCommand(recording, subject, { kind: 'edit', commentId: 't0', text: 'y'.repeat(1024) }, actor(ALICE, 2, true))
      written.push(bytes)
      const wholeList = JSON.stringify((await workAnnotations.loadWorkAnnotations('local', created.id))!.comments).length
      expect(bytes).toBeLessThan(wholeList / (count / 2))
    }
    expect(written[1]!).toBeLessThan(written[0]! * 1.5)
    expect(written[1]!).toBeLessThan(4 * 1024)
  })
})
