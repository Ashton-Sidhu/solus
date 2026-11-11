import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from './helpers/bun-sqlite'
import { githubIssue, REPO, repoRead } from './helpers/task-fixtures'
import { openTaskTestHost } from './helpers/task-test-host'

mock.module('node:sqlite', () => ({ DatabaseSync }))

// WHY: a merged pull request finishes the work, so Solus closes the task on
// GitHub or Jira. That is an outward write: it must happen only where a
// project asked for it, and only when all the work of the task is merged.

const BY = { kind: 'system' as const }
const ISSUE = 'github:I_1'
const PR = { scope: 'github.com/acme/app', url: 'https://github.com/acme/app/pull/7' }

let host: Awaited<ReturnType<typeof openTaskTestHost>>
let done: typeof import('@solus/server/data/tasks/done-on-merge')
let attachments: typeof import('@solus/server/data/tasks/task-attachments')
let store: typeof import('@solus/server/data/tasks/task-store')
let cache: typeof import('@solus/server/data/tasks/task-cache')
let manifest: typeof import('@solus/server/project-config/projects-manifest')

beforeAll(async () => {
  host = await openTaskTestHost('task-done-on-merge')
  done = await import('@solus/server/data/tasks/done-on-merge')
  attachments = await import('@solus/server/data/tasks/task-attachments')
  store = await import('@solus/server/data/tasks/task-store')
  cache = await import('@solus/server/data/tasks/task-cache')
  manifest = await import('@solus/server/project-config/projects-manifest')
})
afterEach(() => host.reset())
afterAll(() => host.close())

/** The issue is in the repository source, links pull request 7, and a project of this host lists the source. */
async function linkedTask(config: { taskDoneOnMerge?: boolean } = {}): Promise<string> {
  host.providers.answer(REPO, repoRead([githubIssue(1)]))
  await cache.storeSourceRead(REPO, repoRead([githubIssue(1)]))
  const cwd = host.project([REPO])
  writeFileSync(join(cwd, '.solus', 'config.json'), JSON.stringify({ version: 1, taskSources: [REPO], ...config }))
  await manifest.recordProject(cwd)
  await attachments.linkTaskPullRequest('local', ISSUE, { number: 7, targetScope: PR.scope, url: PR.url }, BY)
  return cwd
}

const merged = (overrides: Partial<Parameters<typeof done.completeTasksForMergedPullRequest>[3]> = {}) =>
  done.completeTasksForMergedPullRequest('local', PR.scope, 7, { mergedAt: '2026-11-01T00:00:00Z', isSessionBusy: () => false, ...overrides })

describe('a merged pull request finishes its task', () => {
  test('the task moves to done on its provider when a project of the host lists its source', async () => {
    await linkedTask()
    expect(await merged()).toEqual([ISSUE])
    expect(host.providers.callsOf('setState:')).toEqual([`setState:${ISSUE}:done`])
    expect((await store.loadTask(ISSUE))?.category).toBe('done')
    // A task that is done already is not written again.
    expect(await merged()).toEqual([])
    expect(host.providers.callsOf('setState:')).toHaveLength(1)
  })

  test('a project that turned the rule off leaves the task open', async () => {
    await linkedTask({ taskDoneOnMerge: false })
    expect(await merged()).toEqual([])
    expect(host.providers.callsOf('setState:')).toEqual([])
  })

  test('a task that no project of the host lists is left alone: nobody asked Solus to close it', async () => {
    host.providers.hold(githubIssue(1))
    await cache.storeProviderTask(githubIssue(1))
    await attachments.linkTaskPullRequest('local', ISSUE, { number: 7, targetScope: PR.scope, url: PR.url }, BY)
    expect(await merged()).toEqual([])
    expect(host.providers.callsOf('setState:')).toEqual([])
  })

  test('the task stays open while a session still works, and while another linked pull request is not merged', async () => {
    await linkedTask()
    await attachments.linkTaskSession('local', ISSUE, 'worker')
    expect(await merged({ isSessionBusy: (sessionId) => sessionId === 'worker' })).toEqual([])

    await attachments.linkTaskPullRequest('local', ISSUE, { number: 8, targetScope: PR.scope, url: 'https://github.com/acme/app/pull/8' }, BY)
    expect(await merged({ isMerged: async () => false })).toEqual([])
    expect(await merged({ isMerged: async () => true })).toEqual([ISSUE])
  })

  test('a provider that refuses the move is logged, and the task stays open', async () => {
    await linkedTask()
    host.providers.failure = new Error('GitHub is not connected')
    expect(await merged()).toEqual([])
    expect((await store.loadTask(ISSUE))?.category).toBe('open')
  })
})
