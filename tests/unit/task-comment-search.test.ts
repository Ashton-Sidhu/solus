import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { plainSnippet, SNIPPET_HIT_CLOSE, SNIPPET_HIT_OPEN } from '@solus/contracts/search-snippet'
import { resetTestDatabase } from './helpers/test-db'

const BY = { kind: 'user' as const, user: { id: { kind: 'account' as const, accountId: 'user-1' }, displayName: 'Test User' } }

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

type DbModule = typeof import('@solus/server/db')
type TaskStoreModule = typeof import('@solus/server/data/tasks/task-store')
type TaskModule = typeof import('@solus/server/data/tasks/task')
type CommentSearchModule = typeof import('@solus/server/data/tasks/comment-search')

let dataDir: string
let db: DbModule
let taskStore: TaskStoreModule
let tasks: TaskModule
let search: CommentSearchModule['searchTaskComments']
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-task-comment-search-'))
  process.env.SOLUS_DATA_DIR = dataDir
  db = await import('@solus/server/db')
  taskStore = await import('@solus/server/data/tasks/task-store')
  tasks = await import('@solus/server/data/tasks/task')
  ;({ searchTaskComments: search } = await import('@solus/server/data/tasks/comment-search'))
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

async function taskWithComments(organizationId: string, title: string, comments: string[], projectKey = '/repo') {
  const created = await taskStore.createTask(organizationId, { title, projectKey })
  const task = await tasks.Task.byId(organizationId, created.id)
  for (const body of comments) await task.comment(body, { by: BY })
  return created
}

describe('searchTaskComments', () => {
  test('a task is found by words across its comments, with the passage of the comment that holds the most', async () => {
    // WHY: a task's discussion is as much a record of the work as a session's
    // messages (docs/plans/unified-search.md §7). The words need not share one
    // comment, and the row shows the comment that best answers the query.
    const found = await taskWithComments('local', 'Startup hang', ['The sentry breadcrumb shows a WAL checkpoint.', 'Checkpoint again'])
    await taskWithComments('local', 'Other', ['Only a sentry mention'])
    const hits = await search('local', { query: 'sentry checkpoint' })
    expect(hits.map((hit) => hit.taskId)).toEqual([found.id])
    expect(hits[0]!.snippet).toContain(`${SNIPPET_HIT_OPEN}sentry${SNIPPET_HIT_CLOSE}`)
    expect(plainSnippet(hits[0]!.snippet)).toBe('The sentry breadcrumb shows a WAL checkpoint.')
  })

  test('every word starts a word of the comments, and the scope and project are kept', async () => {
    const here = await taskWithComments('local', 'Here', ['the pelican lands'])
    await taskWithComments('local', 'Elsewhere', ['the pelican lands'], '/other')
    await taskWithComments('org-a', 'Theirs', ['the pelican lands'])
    expect((await search('local', { query: 'pel' })).map((hit) => hit.taskId)).toHaveLength(2)
    expect((await search('local', { query: 'elican' }))).toEqual([])
    expect((await search('local', { query: 'pelican', projectKey: '/repo' })).map((hit) => hit.taskId)).toEqual([here.id])
  })
})
