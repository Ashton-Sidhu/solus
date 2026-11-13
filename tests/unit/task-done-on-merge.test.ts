import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from './helpers/bun-sqlite'
import { githubIssue, REPO, repoRead } from './helpers/task-fixtures'
import { openTaskTestHost } from './helpers/task-test-host'

mock.module('node:sqlite', () => ({ DatabaseSync }))

// WHY: a merged pull request finishes the work, so Solus closes the task on
// GitHub or Jira. Tasks belong to no project (docs/tasks.md): the link to the
// pull request is the request. That is an outward write, so the pull
// request's own project can turn it off, and it happens only when all the work
// of the task is merged.

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

/** The issue is in the repository source and links pull request 7. No project is on the host. */
async function linkedTask(): Promise<void> {
  host.providers.answer(REPO, repoRead([githubIssue(1)]))
  await cache.storeSourceRead(REPO, repoRead([githubIssue(1)]))
  await attachments.linkTaskPullRequest('local', ISSUE, { number: 7, targetScope: PR.scope, url: PR.url }, BY)
}

/** A listed project of this host whose `origin` is `remote`, with this project config. */
async function listedProject(remote: string, config: { taskDoneOnMerge?: boolean }): Promise<void> {
  const cwd = join(host.dataDir, `project-${remote.split('/').pop()}`)
  mkdirSync(join(cwd, '.solus'), { recursive: true })
  execFileSync('git', ['init', '-q', '.'], { cwd })
  execFileSync('git', ['remote', 'add', 'origin', remote], { cwd })
  writeFileSync(join(cwd, '.solus', 'config.json'), JSON.stringify({ version: 1, ...config }))
  await manifest.recordProject(cwd)
}

const merged = (overrides: Partial<Parameters<typeof done.completeTasksForMergedPullRequest>[3]> = {}) =>
  done.completeTasksForMergedPullRequest('local', PR.scope, 7, { mergedAt: '2026-11-01T00:00:00Z', isSessionBusy: () => false, ...overrides })

describe('a merged pull request finishes its task', () => {
  test('the task moves to done on its provider, with no project on the host', async () => {
    await linkedTask()
    expect(await manifest.listProjects()).toEqual([])
    expect(await merged()).toEqual([ISSUE])
    expect(host.providers.callsOf('setState:')).toEqual([`setState:${ISSUE}:done`])
    expect((await store.loadTask(ISSUE))?.category).toBe('done')
    // A task that is done already is not written again.
    expect(await merged()).toEqual([])
    expect(host.providers.callsOf('setState:')).toHaveLength(1)
  })

  test('the project of the pull request can turn the rule off, and the task stays open', async () => {
    await linkedTask()
    await listedProject('https://github.com/acme/app.git', { taskDoneOnMerge: false })
    expect(await merged()).toEqual([])
    expect(host.providers.callsOf('setState:')).toEqual([])
  })

  test('a project of another repository that turned the rule off does not decide for this pull request', async () => {
    await linkedTask()
    await listedProject('https://github.com/acme/other.git', { taskDoneOnMerge: false })
    expect(await merged()).toEqual([ISSUE])
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
