import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { resetTestDatabase } from './helpers/test-db'

/**
 * A session owns its pull request links, and a task reads the links of its
 * sessions (docs/plans/session-pull-requests.md).
 */

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

const PERSON = { kind: 'user' as const, user: { id: { kind: 'account' as const, accountId: 'user-1' }, displayName: 'Test User' } }
const SYSTEM = { kind: 'system' as const }
const URL_7 = 'https://github.com/Acme/Solus/pull/7'
const REPOSITORY = 'github.com/acme/solus'

let dataDir: string
let db: typeof import('@solus/server/db')
let database: typeof import('@solus/server/db/database')
let sessionPrs: typeof import('@solus/server/data/sessions/session-pull-requests')
let taskStore: typeof import('@solus/server/data/tasks/task-store')
let tasks: typeof import('@solus/server/data/tasks/task')
let taskLinks: typeof import('@solus/server/data/tasks/task-links')
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-session-prs-'))
  process.env.SOLUS_DATA_DIR = dataDir
  db = await import('@solus/server/db')
  database = await import('@solus/server/db/database')
  sessionPrs = await import('@solus/server/data/sessions/session-pull-requests')
  taskStore = await import('@solus/server/data/tasks/task-store')
  tasks = await import('@solus/server/data/tasks/task')
  taskLinks = await import('@solus/server/data/tasks/task-links')
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

async function linksOf(sessionId: string) {
  return (await sessionPrs.readSessionPullRequests('local', [sessionId]))[sessionId] ?? []
}

async function taskPrNumbers(taskId: string) {
  return ((await taskLinks.readTaskPrLinks(database.getDatabase(), 'local', [taskId]))[taskId] ?? [])
    .map((link) => [link.number, link.ownerSessionId ?? null])
}

describe('which source a link keeps', () => {
  test('a branch discovery never writes over a link, and an explicit link claims a discovered one', () => {
    // WHY: PR sync finds the pull request of a session's branch again at every
    // tick. It must not rename who linked it, and it must not bring back a
    // link that a person removed.
    const next = sessionPrs.nextSessionPullRequestSource
    expect(next(null, 'branch')).toBe('branch')
    expect(next('manual', 'branch')).toBeNull()
    expect(next('dismissed', 'branch')).toBeNull()
    expect(next('branch', 'agent')).toBe('agent')
    expect(next('dismissed', 'manual')).toBe('manual')
    expect(next('created', 'manual')).toBeNull()
  })
})

describe('a session and its pull requests', () => {
  test('a link names the repository in lower case and is idempotent', async () => {
    expect(await sessionPrs.linkSessionPullRequest('session-1', { url: URL_7, source: 'manual', by: PERSON })).toBe(true)
    expect(await sessionPrs.linkSessionPullRequest('session-1', { url: `${URL_7}/`, source: 'manual', by: PERSON })).toBe(false)

    expect(await linksOf('session-1')).toEqual([
      expect.objectContaining({ sessionId: 'session-1', repository: REPOSITORY, number: 7, source: 'manual', createdBy: PERSON }),
    ])
  })

  test('refuses a URL that is not a pull request', async () => {
    await expect(sessionPrs.linkSessionPullRequest('session-1', { url: 'https://github.com/acme/solus/issues/7', source: 'manual', by: PERSON }))
      .rejects.toThrow('full URL of the pull request')
  })

  test('a link a person removed stays removed when PR sync finds the branch again', async () => {
    await sessionPrs.linkSessionPullRequest('session-1', { url: URL_7, source: 'branch', by: SYSTEM })
    expect(await sessionPrs.unlinkSessionPullRequest('session-1', REPOSITORY, 7)).toBe(true)
    expect(await linksOf('session-1')).toEqual([])
    expect(await sessionPrs.sessionKnowsPullRequest('session-1', REPOSITORY, 7)).toBe(true)

    expect(await sessionPrs.linkSessionPullRequest('session-1', { url: URL_7, source: 'branch', by: SYSTEM })).toBe(false)
    expect(await linksOf('session-1')).toEqual([])

    // A person can link it again.
    await sessionPrs.linkSessionPullRequest('session-1', { url: URL_7, source: 'manual', by: PERSON })
    expect((await linksOf('session-1')).map((link) => link.source)).toEqual(['manual'])
  })

  test('one pull request can belong to two sessions, and an observation reaches both', async () => {
    await sessionPrs.linkSessionPullRequest('session-1', { url: URL_7, source: 'branch', by: SYSTEM })
    await sessionPrs.linkSessionPullRequest('session-2', { url: URL_7, source: 'manual', by: PERSON })
    const changed: string[] = []
    const stop = sessionPrs.onSessionPullRequestsChanged((sessionId) => changed.push(sessionId))
    try {
      // SAFETY: the store reads only these fields of a pull request.
      const merged = { title: 'Ship it', state: 'merged', draft: false, updatedAt: '2026-09-30T10:00:00Z' } as never
      expect((await sessionPrs.recordSessionPullRequestObservation(REPOSITORY, 7, merged)).sort())
        .toEqual(['session-1', 'session-2'])
    } finally {
      stop()
    }
    expect(changed.sort()).toEqual(['session-1', 'session-2'])
    expect((await linksOf('session-1'))[0]?.snapshot).toMatchObject({ state: 'merged', title: 'Ship it' })
    expect(await sessionPrs.sessionPullRequestIsMerged(REPOSITORY, 7)).toBe(true)
  })
})

describe('a task and the pull requests of its sessions', () => {
  test('a task reads the links of its sessions and has no copy of them', async () => {
    // WHY: a session that joins a task brings its pull requests, and a session
    // that leaves takes them with it. A copy on the task would stay behind.
    const task = await taskStore.createTask('local', { title: 'Ship the store', projectKey: '/workspace/solus' })
    const model = await tasks.Task.byId('local', task.id)
    await sessionPrs.linkSessionPullRequest('worker', { url: URL_7, source: 'branch', by: SYSTEM })
    expect(await taskPrNumbers(task.id)).toEqual([])

    await model.linkSession('worker', 'working')
    expect(await taskPrNumbers(task.id)).toEqual([[7, 'worker']])
    expect((await model.details()).links).toEqual([
      expect.objectContaining({ kind: 'pr', targetScope: REPOSITORY, targetKey: '7', ownerSessionId: 'worker' }),
    ])

    await model.unlinkSession('worker', PERSON)
    expect(await taskPrNumbers(task.id)).toEqual([])
    expect(await linksOf('worker')).toHaveLength(1)
  })

  test('a referenced session brings no pull request', async () => {
    const task = await taskStore.createTask('local', { title: 'Only mentions a session' })
    await sessionPrs.linkSessionPullRequest('mentioned', { url: URL_7, source: 'manual', by: PERSON })
    await (await tasks.Task.byId('local', task.id)).linkSession('mentioned', 'referenced')
    expect(await taskPrNumbers(task.id)).toEqual([])
  })

  test("a pull request linked on the task and owned by its session is the task's own link", async () => {
    const task = await taskStore.createTask('local', { title: 'Linked twice', projectKey: '/workspace/solus' })
    const model = await tasks.Task.byId('local', task.id)
    await model.linkSession('worker', 'working')
    await sessionPrs.linkSessionPullRequest('worker', { url: URL_7, source: 'branch', by: SYSTEM })
    await model.linkPullRequest({ number: 7, targetScope: REPOSITORY, url: URL_7.toLowerCase() }, PERSON)
    expect(await taskPrNumbers(task.id)).toEqual([[7, null]])
  })

  test('unlinking from the task removes the link from the session that owns it', async () => {
    // WHY: the task page offers Unlink on every pull request it lists. For a
    // link the task only reads, the session's link is the one to remove, and
    // PR sync must not put it back.
    const task = await taskStore.createTask('local', { title: 'Unlink here', projectKey: '/workspace/solus' })
    const model = await tasks.Task.byId('local', task.id)
    await model.linkSession('worker', 'working')
    await sessionPrs.linkSessionPullRequest('worker', { url: URL_7, source: 'branch', by: SYSTEM })

    await model.unlink('pr', '7', REPOSITORY, PERSON)

    expect(await taskPrNumbers(task.id)).toEqual([])
    expect(await linksOf('worker')).toEqual([])
    expect(await sessionPrs.sessionKnowsPullRequest('worker', REPOSITORY, 7)).toBe(true)
  })
})

describe("an agent's link from an attached machine", () => {
  const AGENT = { kind: 'agent' as const, sessionId: 'worker' }
  const op = (domain: 'tasks' | 'sessions', resourceId: string, name: string, payload: object) => ({
    id: `op-${name}-${resourceId}`, domain, resourceId, name, payload, recordedAt: 1, state: 'pending' as const,
  })

  test('reaches the session on the host that owns it, with or without a task', async () => {
    // WHY: the organization's Solus API holds the session a person opens. A
    // link that stayed on the machine, or that landed on the task, would show
    // no pull request on that session.
    const outbox = await import('@solus/server/sync/outbox/outbox-store')
    ;(await import('@solus/server/data/sessions/session-applier')).registerSessionOutboxApplier()
    ;(await import('@solus/server/data/tasks/task-applier')).registerTaskOutboxApplier()

    await outbox.applyOutboxOp(op('sessions', 'solo', 'link-pull-request', { url: URL_7, actor: AGENT }), 'local')
    expect((await linksOf('solo')).map((link) => [link.number, link.source])).toEqual([[7, 'agent']])

    const task = await taskStore.createTask('local', { title: 'Ship it', projectKey: '/workspace/solus' })
    await (await tasks.Task.byId('local', task.id)).linkSession('worker', 'working', {})
    const link = { kind: 'pr', targetScope: REPOSITORY, targetKey: '7', url: URL_7, actor: AGENT }
    await outbox.applyOutboxOp(op('tasks', task.id, 'link', { ...link, originSessionId: 'worker' }), 'local')
    expect(await taskPrNumbers(task.id)).toEqual([[7, 'worker']])

    // A session that does not work on the task links the task itself.
    await outbox.applyOutboxOp(op('tasks', task.id, 'link', { ...link, targetKey: '8', url: 'https://github.com/acme/solus/pull/8', originSessionId: 'visitor' }), 'local')
    expect((await taskPrNumbers(task.id)).sort()).toEqual([[7, 'worker'], [8, null]])
  })
})
