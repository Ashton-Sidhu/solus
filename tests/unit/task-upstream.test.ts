import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { ProjectConfig } from '@solus/contracts/types'
import type { Task } from '@solus/contracts/task-types'

let config: ProjectConfig | null = { version: 1, taskProvider: 'github' }
let listCalls = 0
let getCalls = 0
let updatedPatch: Partial<Task> | null = null
let listError: Error | null = null
/** Tickets a native task already owns, as `task_external_links` would report. */
let mirroredExternalIds = new Set<string>()

interface CacheRow {
  fetched_at: number
  truncated: number | null
  tasks: string
}

const cacheRows = new Map<string, CacheRow>()
const cacheKey = (projectKey: string, provider: string, scope: string) =>
  `${projectKey}\0${provider}\0${scope}`
const db = {
  prepare(sql: string) {
    return {
      get(projectKey: string, provider: string, scope: string) {
        if (!sql.includes('SELECT fetched_at')) throw new Error(`Unexpected get: ${sql}`)
        return cacheRows.get(cacheKey(projectKey, provider, scope))
      },
      all(provider: string, externalKey: string) {
        if (!sql.includes('FROM task_external_links')) throw new Error(`Unexpected all: ${sql}`)
        expect([provider, externalKey]).toEqual(['github', 'example/repo'])
        return [...mirroredExternalIds].map((external_id) => ({ external_id }))
      },
      run(
        projectKey: string,
        provider: string,
        scope: string,
        fetchedAt: number,
        truncated: number | null,
        tasks: string,
      ) {
        if (!sql.includes('INSERT INTO upstream_task_cache')) throw new Error(`Unexpected run: ${sql}`)
        cacheRows.set(cacheKey(projectKey, provider, scope), {
          fetched_at: fetchedAt,
          truncated,
          tasks,
        })
      },
    }
  },
}

const upstreamTask: Task = {
  id: '42',
  providerId: 'github',
  kind: 'task',
  title: 'Upstream issue',
  body: '',
  status: 'todo',
  url: 'https://github.com/example/repo/issues/42',
  labels: [],
  updatedAt: 1_785_000_000_000,
}

mock.module('@solus/server/logger', () => ({
  createLogger: () => ({ info() {}, warn() {}, error() {}, child() { return this } }),
}))
mock.module('@solus/server/db', () => ({ getDb: () => db }))
mock.module('@solus/server/project-config/project-config', () => ({
  loadProjectConfig: async () => config,
  resolveProjectKey: (cwd: string) => cwd,
}))
mock.module('@solus/server/git/git-helpers', () => ({ resolveRepoRef: async () => null }))
mock.module('@solus/server/providers/github/auth', () => ({
  GitHubAuth: class { async status() { return { connected: true, scopes: [] } } },
}))
mock.module('@solus/server/providers/github/octokit', () => ({
  GitHubReauthRequiredError: class extends Error {},
}))
mock.module('@solus/server/tasks/providers/github', () => ({
  makeGitHubTaskProvider: async () => ({
    id: 'github',
    repo: { host: 'github.com', owner: 'example', repo: 'repo' },
    async listTasks() {
      listCalls++
      if (listError) throw listError
      return { tasks: [upstreamTask] }
    },
    async getTask() {
      getCalls++
      return upstreamTask
    },
    async updateTask(_id: string, patch: Partial<Task>) {
      updatedPatch = patch
      return { ...upstreamTask, ...patch }
    },
    async postComment() { return { body: 'note', author: null, createdAt: '' } },
  }),
}))

let service: typeof import('@solus/server/tasks/upstream')

beforeAll(async () => {
  service = await import('@solus/server/tasks/upstream')
})

beforeEach(() => {
  config = { version: 1, taskProvider: 'github' }
  listCalls = 0
  getCalls = 0
  listError = null
  updatedPatch = null
  cacheRows.clear()
  mirroredExternalIds = new Set<string>()
  service.invalidateTaskProvider('/workspace/solus')
})

describe('upstream task reads', () => {
  test('polls GitHub when the issue list opens', async () => {
    // WHY: the task page must start current like the PR page; SQLite is only an
    // offline fallback and must not make every normal page entry look stale.
    const result = await service.listUpstreamTasks('/workspace/solus')

    expect(result.tasks).toEqual([
      expect.objectContaining({ id: '42', providerId: 'github', projectKey: '/workspace/solus' }),
    ])
    expect(result.fromCache).toBeUndefined()
    expect(result.fetchedAt).toEqual(expect.any(Number))
    expect(listCalls).toBe(1)
  })

  test('leaves out a ticket a native task already owns', async () => {
    // WHY: publishing a task creates the issue and links it. Listing that issue
    // beside the task that owns it shows one piece of work twice — the duplicate
    // a user sees right after pressing Publish.
    mirroredExternalIds = new Set(['42'])

    const result = await service.listUpstreamTasks('/workspace/solus')

    expect(result.tasks).toEqual([])
    expect(listCalls).toBe(1)
  })

  test('still serves an unlinked ticket from the offline cache without its owner', async () => {
    // WHY: the filter must apply to the cached answer too, or a provider outage
    // resurrects the duplicate it was meant to remove.
    await service.listUpstreamTasks('/workspace/solus', { refresh: true })
    mirroredExternalIds = new Set(['42'])
    listError = new Error('offline')

    const cached = await service.listUpstreamTasks('/workspace/solus', { refresh: true })

    expect(cached.fromCache).toBe(true)
    expect(cached.tasks).toEqual([])
  })

  test('keeps local-only projects from making an upstream request', async () => {
    config = { version: 1, taskProvider: 'local' }

    expect(await service.listUpstreamTasks('/workspace/solus')).toEqual({ tasks: [] })
    expect(listCalls).toBe(0)
  })

  test('treats transport-null list options as the default scope', async () => {
    // WHY: optional RPC arguments cross JSON transports as null, and a missing
    // filter must still load the project's complete GitHub issue list.
    await service.listUpstreamTasks('/workspace/solus', { refresh: true })
    const result = await service.listUpstreamTasks('/workspace/solus', null)

    expect(result.tasks).toEqual([
      expect.objectContaining({ id: '42', projectKey: '/workspace/solus' }),
    ])
  })

  test('keeps the last successful GitHub snapshot visible when refresh fails', async () => {
    // WHY: a temporary upstream failure must not make GitHub rows disappear
    // beside native tasks after the local-first task migration.
    const live = await service.listUpstreamTasks('/workspace/solus', { refresh: true })
    listError = new Error('temporary GitHub failure')

    const cached = await service.listUpstreamTasks('/workspace/solus', { refresh: true })

    expect(live.fromCache).toBeUndefined()
    expect(cached).toEqual(expect.objectContaining({
      tasks: [expect.objectContaining({ id: '42', projectKey: '/workspace/solus' })],
      fromCache: true,
      fetchedAt: expect.any(Number),
    }))
  })

  test('resolves a single issue from the list cache before calling GitHub', async () => {
    // WHY: opening an issue already present in the page snapshot must not spend
    // another provider request or fail merely because the network went away.
    await service.listUpstreamTasks('/workspace/solus', { refresh: true })
    const task = await service.getUpstreamTask('/workspace/solus', '42')

    expect(task).toEqual(expect.objectContaining({ id: '42', projectKey: '/workspace/solus' }))
    expect(getCalls).toBe(0)
  })

  test('falls through to GitHub when a single issue is absent from the cache', async () => {
    const task = await service.getUpstreamTask('/workspace/solus', '42')

    expect(task.id).toBe('42')
    expect(getCalls).toBe(1)
  })

  test('passes the native lifecycle straight through to the provider', async () => {
    // WHY: the GitHub provider owns the mapping from native statuses onto
    // issue state / board options; the service must not pre-coarsen them.
    await service.updateUpstreamTask('/workspace/solus', '42', { status: 'todo' })

    expect(updatedPatch).toMatchObject({ status: 'todo' })
  })
})
