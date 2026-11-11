import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import type { TaskSidebarFilter, TaskSidebarSnapshot } from '@solus/contracts/task-types'
import type { SessionMeta } from '@solus/contracts/types'
import type { HandlerCtx } from '@solus/server/transport/server'
import { actorFor } from '@solus/server/admission/actor'
import { TEST_HANDLER_CTX } from './helpers/handler-ctx'
import { githubDraft, githubIssue, BOARD, boardRead, REPO, repoRead } from './helpers/task-fixtures'
import { openTaskTestHost } from './helpers/task-test-host'

// WHY: a client connects again often (network changes, sleep, a new grant every
// ten minutes). Each time it read the whole task list, more than 1 MB at a
// thousand tasks, even when nothing changed. A resume must send almost nothing
// when nothing changed, and must never let a client keep a row that changed.

mock.module('node:sqlite', () => ({ DatabaseSync }))

const BY = { kind: 'user' as const, user: { id: { kind: 'account' as const, accountId: 'user-1' }, displayName: 'Test User' } }
const KEPT = 'github:I_1'
const EDITED = 'github:I_2'

let host: Awaited<ReturnType<typeof openTaskTestHost>>
let server: import('@solus/server/transport/server').SolusServer
let read: (filter?: TaskSidebarFilter, ctx?: HandlerCtx) => Promise<TaskSidebarSnapshot>
let sources: typeof import('@solus/server/data/tasks/task-sources')
let attachments: typeof import('@solus/server/data/tasks/task-attachments')

beforeAll(async () => {
  host = await openTaskTestHost('task-resume')
  const { SolusServer } = await import('@solus/server/transport/server')
  const { registerTasksHandlers } = await import('@solus/server/transport/handlers/tasks-handlers')
  sources = await import('@solus/server/data/tasks/task-sources')
  attachments = await import('@solus/server/data/tasks/task-attachments')
  server = new SolusServer()
  registerTasksHandlers(server)
  read = (filter, ctx = TEST_HANDLER_CTX) => server.handle('tasksSidebarSnapshot', filter ? [filter] : [], ctx)
})
afterEach(() => host.reset())
afterAll(() => host.close())

/** Read the sources of a project as the caller of `ctx`, through the RPC a client uses. */
async function readSources(which: Array<typeof REPO>, ctx: HandlerCtx = TEST_HANDLER_CTX): Promise<void> {
  await server.handle('tasksSources', [[host.project(which)], { refresh: 'force' }], ctx)
  await sources.taskSourceReadsEnd()
}

describe('task list resume', () => {
  test('an unchanged list answers with no rows and the same revision', async () => {
    host.providers.answer(REPO, repoRead([githubIssue(1)]))
    await readSources([REPO])
    const whole = await read()
    expect(whole.tasks).toHaveLength(1)
    expect(whole.changedTaskIds).toBeUndefined()

    const resumed = await read({ since: whole.revision })
    expect(resumed).toEqual({ tasks: [], sessionsByTask: {}, revision: whole.revision, changedTaskIds: [] })
    expect(JSON.stringify(resumed).length).toBeLessThan(200)
  })

  test('a change while the client was away names that task and sends its new row', async () => {
    host.providers.answer(REPO, repoRead([githubIssue(1), githubIssue(2)]))
    await readSources([REPO])
    const whole = await read()
    await server.handle('tasksUpdate', [EDITED, { title: 'After' }], TEST_HANDLER_CTX)

    const resumed = await read({ since: whole.revision })
    expect(resumed.changedTaskIds).toEqual([EDITED])
    expect(resumed.tasks.map((task) => [task.id, task.title])).toEqual([[EDITED, 'After']])
    expect(resumed.tasks.some((task) => task.id === KEPT)).toBe(false)
    expect(resumed.revision).not.toBe(whole.revision)
    // The new revision covers that change, so the next resume is empty again.
    expect((await read({ since: resumed.revision })).changedTaskIds).toEqual([])
  })

  test('a linked session that changed while away names its task, with the new title and activity', async () => {
    // WHY: a task row shows its sessions' titles, branches, and activity. Those
    // change in the session index, not in a task write, and a full read used
    // to refresh them at each reconnect. A resume must refresh them too.
    const { cacheIndexedSessions } = await import('@solus/server/db/session-indexer')
    const session = (firstMessage: string, lastTimestamp: string): SessionMeta => ({
      provider: 'codex', sessionId: 'thread-linked', slug: null, firstMessage, lastTimestamp, size: 1, cwd: '/tmp/project', projectPath: '-tmp-project',
    })
    host.providers.answer(REPO, repoRead([githubIssue(1), githubIssue(2)]))
    await readSources([REPO])
    await attachments.linkTaskSession('local', KEPT, 'thread-linked')
    await cacheIndexedSessions([session('First title', '2026-10-01T00:00:00.000Z')])
    const whole = await read()
    expect(whole.sessionsByTask[KEPT]?.[0]?.sessionTitle).toBe('First title')

    await cacheIndexedSessions([session('New title', '2026-10-02T00:00:00.000Z')])
    const resumed = await read({ since: whole.revision })
    expect(resumed.changedTaskIds).toEqual([KEPT])
    expect(resumed.sessionsByTask[KEPT]?.[0]).toMatchObject({
      sessionTitle: 'New title',
      lastActivityAt: Date.parse('2026-10-02T00:00:00.000Z'),
    })
  })

  test('a delete while away sends the whole list, so the deleted row leaves', async () => {
    const draft = githubDraft('DI_1')
    host.providers.answer(BOARD, boardRead([{ task: draft, columnId: null }, { task: githubIssue(1), columnId: null }]))
    await readSources([BOARD])
    const whole = await read()
    await server.handle('tasksDelete', ['github:DI_1'], TEST_HANDLER_CTX)

    const resumed = await read({ since: whole.revision })
    expect(resumed.changedTaskIds).toBeUndefined()
    expect(resumed.tasks.map((task) => task.id)).toEqual([KEPT])
  })

  test('a revision from another server process sends the whole list', async () => {
    host.providers.answer(REPO, repoRead([githubIssue(1)]))
    await readSources([REPO])
    const whole = await read()
    const [, changeNumber, readerKey] = whole.revision!.split('.')
    const resumed = await read({ since: `0000000000000000.${changeNumber}.${readerKey}` })
    expect(resumed.changedTaskIds).toBeUndefined()
    expect(resumed.tasks).toHaveLength(1)
  })

  test('a revision another reader was given sends the whole list', async () => {
    host.providers.answer(REPO, repoRead([githubIssue(1)]))
    await readSources([REPO])
    const owner = await read()
    const remoteOwner = { kind: 'owner', via: 'grant', userId: 'user-1', deviceId: 'device-1', expiresAt: 1, deviceLabel: 'Phone' } as const
    const ctx: HandlerCtx = { clientId: 'remote', principal: remoteOwner, actor: actorFor(remoteOwner) }
    const resumed = await read({ since: owner.revision }, ctx)
    expect(resumed.changedTaskIds).toBeUndefined()
    // A new grant changes only the expiry: that socket still resumes.
    const renewed = { ...remoteOwner, expiresAt: 2 }
    const again = await read({ since: resumed.revision }, { clientId: 'remote', principal: renewed, actor: actorFor(renewed) })
    expect(again.changedTaskIds).toEqual([])
  })

  test('a client that sends no revision gets the whole list, with PR links once per task', async () => {
    host.providers.answer(REPO, repoRead([githubIssue(1)]))
    await readSources([REPO])
    await attachments.linkTaskPullRequest('local', KEPT, {
      number: 42, url: 'https://github.com/acme/app/pull/42', title: 'Fix', targetScope: 'github.com/acme/app',
    }, BY)
    const whole = await read()
    expect(whole.tasks).toHaveLength(1)
    expect(whole.tasks[0].pr).toEqual({ url: 'https://github.com/acme/app/pull/42', number: 42 })
    expect(whole.prLinkListsByTask?.[KEPT]?.[0]?.number).toBe(42)
  })
})
