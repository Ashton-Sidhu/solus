import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { TaskSidebarFilter, TaskSidebarSnapshot } from '@solus/contracts/task-types'
import type { SessionMeta } from '@solus/contracts/types'
import type { HandlerCtx } from '@solus/server/transport/server'
import { actorFor } from '@solus/server/admission/actor'
import { resetTestDatabase } from './helpers/test-db'
import { TEST_HANDLER_CTX } from './helpers/handler-ctx'

// WHY: a client connects again often (network changes, sleep, a new grant every
// ten minutes). Each time it read the whole task list, more than 1 MB at a
// thousand tasks, even when nothing changed. A resume must send almost nothing
// when nothing changed, and must never let a client keep a row that changed.

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

const BY = { kind: 'user' as const, user: { id: { kind: 'account' as const, accountId: 'user-1' }, displayName: 'Test User' } }

let dataDir: string
const previousDataDir = process.env.SOLUS_DATA_DIR
let read: (filter?: TaskSidebarFilter, ctx?: HandlerCtx) => Promise<TaskSidebarSnapshot>
let taskStore: typeof import('@solus/server/data/tasks/task-store')
let tasks: typeof import('@solus/server/data/tasks/task')

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-task-resume-'))
  process.env.SOLUS_DATA_DIR = dataDir
  const { SolusServer } = await import('@solus/server/transport/server')
  const { registerTasksHandlers } = await import('@solus/server/transport/handlers/tasks-handlers')
  taskStore = await import('@solus/server/data/tasks/task-store')
  tasks = await import('@solus/server/data/tasks/task')
  const server = new SolusServer()
  registerTasksHandlers(server, { sync: false })
  read = (filter, ctx = TEST_HANDLER_CTX) => server.handle('tasksSidebarSnapshot', filter ? [filter] : [], ctx)
})

afterEach(async () => {
  await resetTestDatabase()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `solus.db${suffix}`), { force: true })
})

afterAll(async () => {
  ;(await import('@solus/server/db')).closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

describe('task list resume', () => {
  test('an unchanged list answers with no rows and the same revision', async () => {
    await taskStore.createTask('local', { title: 'Kept' })
    const whole = await read()
    expect(whole.tasks).toHaveLength(1)
    expect(whole.changedTaskIds).toBeUndefined()

    const resumed = await read({ since: whole.revision })
    expect(resumed).toEqual({ tasks: [], sessionsByTask: {}, revision: whole.revision, changedTaskIds: [] })
    expect(JSON.stringify(resumed).length).toBeLessThan(200)
  })

  test('a change while the client was away names that task and sends its new row', async () => {
    const kept = await taskStore.createTask('local', { title: 'Kept' })
    const edited = await taskStore.createTask('local', { title: 'Before' })
    const whole = await read()
    await (await tasks.Task.byId('local', edited.id)).update({ title: 'After' }, BY)

    const resumed = await read({ since: whole.revision })
    expect(resumed.changedTaskIds).toEqual([edited.id])
    expect(resumed.tasks.map((task) => [task.id, task.title])).toEqual([[edited.id, 'After']])
    expect(resumed.tasks.some((task) => task.id === kept.id)).toBe(false)
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
    const linked = await taskStore.createTask('local', { title: 'Linked' })
    await taskStore.createTask('local', { title: 'Unlinked' })
    await (await tasks.Task.byId('local', linked.id)).linkSession('thread-linked')
    await cacheIndexedSessions([session('First title', '2026-10-01T00:00:00.000Z')])
    const whole = await read()
    expect(whole.sessionsByTask[linked.id]?.[0]?.sessionTitle).toBe('First title')

    await cacheIndexedSessions([session('New title', '2026-10-02T00:00:00.000Z')])
    const resumed = await read({ since: whole.revision })
    expect(resumed.changedTaskIds).toEqual([linked.id])
    expect(resumed.sessionsByTask[linked.id]?.[0]).toMatchObject({
      sessionTitle: 'New title',
      lastActivityAt: Date.parse('2026-10-02T00:00:00.000Z'),
    })
  })

  test('a delete while away sends the whole list, so the deleted row leaves', async () => {
    const gone = await taskStore.createTask('local', { title: 'Gone' })
    await taskStore.createTask('local', { title: 'Kept' })
    const whole = await read()
    await (await tasks.Task.byId('local', gone.id)).delete()

    const resumed = await read({ since: whole.revision })
    expect(resumed.changedTaskIds).toBeUndefined()
    expect(resumed.tasks.map((task) => task.title)).toEqual(['Kept'])
  })

  test('a revision from another server process sends the whole list', async () => {
    await taskStore.createTask('local', { title: 'Kept' })
    const whole = await read()
    const [, changeNumber, readerKey] = whole.revision!.split('.')
    const resumed = await read({ since: `0000000000000000.${changeNumber}.${readerKey}` })
    expect(resumed.changedTaskIds).toBeUndefined()
    expect(resumed.tasks).toHaveLength(1)
  })

  test('a revision another reader was given sends the whole list', async () => {
    await taskStore.createTask('local', { title: 'Kept' })
    const owner = await read()
    const remoteOwner = { kind: 'remote-owner', userId: 'user-1', deviceId: 'device-1', expiresAt: 1, deviceLabel: 'Phone' } as const
    const ctx: HandlerCtx = { clientId: 'remote', principal: remoteOwner, actor: actorFor(remoteOwner) }
    const resumed = await read({ since: owner.revision }, ctx)
    expect(resumed.changedTaskIds).toBeUndefined()
    // A new grant changes only the expiry: that socket still resumes.
    const renewed = { ...remoteOwner, expiresAt: 2 }
    const again = await read({ since: resumed.revision }, { clientId: 'remote', principal: renewed, actor: actorFor(renewed) })
    expect(again.changedTaskIds).toEqual([])
  })

  test('a client that sends no revision gets the whole list, with PR links once per task', async () => {
    const task = await taskStore.createTask('local', { title: 'Ships' })
    await (await tasks.Task.byId('local', task.id)).linkPullRequest({
      number: 42, url: 'https://github.com/acme/app/pull/42', title: 'Fix', targetScope: 'github.com/acme/app',
    }, BY)
    const whole = await read()
    expect(whole.tasks).toHaveLength(1)
    expect(whole.prLinkListsByTask?.[task.id]?.[0]?.number).toBe(42)
    expect(whole).not.toHaveProperty('prLinksByTask')
  })
})
