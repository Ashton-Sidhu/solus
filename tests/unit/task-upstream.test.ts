import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { ProjectConfig } from '@solus/contracts/types'
import type { Task } from '@solus/contracts/task-types'

let config: ProjectConfig | null = {
  version: 1,
  taskProvider: 'github',
  taskProviderConfig: { owner: 'example', repo: 'repo' },
}
let listCalls = 0
let getCalls = 0
let updatedPatch: Partial<Task> | null = null
let listError: Error | null = null
/** Every options object the adapter's list was called with. */
let listOptions: { query?: string }[] = []
/** Tickets a native task already owns, as `task_external_links` would report. */
let mirroredExternalIds = new Set<string>()

interface CacheRow {
  fetched_at: number
  truncated: number | null
  tasks: string
}

const cacheRows = new Map<string, CacheRow>()
const cacheKey = (projectKey: string, provider: string, externalKey: string, scope: string) =>
  `${projectKey}\0${provider}\0${externalKey}\0${scope}`
const db = {
  prepare(sql: string) {
    return {
      get(projectKey: string, provider: string, externalKey: string, scope: string) {
        if (!sql.includes('SELECT fetched_at')) throw new Error(`Unexpected get: ${sql}`)
        return cacheRows.get(cacheKey(projectKey, provider, externalKey, scope))
      },
      all(provider: string, externalKey: string) {
        if (!sql.includes('FROM task_external_links')) throw new Error(`Unexpected all: ${sql}`)
        expect([provider, externalKey]).toEqual(['github', 'example/repo'])
        return [...mirroredExternalIds].map((external_id) => ({ external_id }))
      },
      run(
        projectKey: string,
        provider: string,
        externalKey: string,
        scope: string,
        fetchedAt: number,
        truncated: number | null,
        tasks: string,
      ) {
        if (!sql.includes('INSERT INTO upstream_task_cache')) throw new Error(`Unexpected run: ${sql}`)
        cacheRows.set(cacheKey(projectKey, provider, externalKey, scope), {
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
mock.module('@solus/server/db', () => ({
  getDb: () => db,
  // The adapter records an asset publication inside a transaction; these tests
  // never publish one, so running the body directly is enough.
  withTx: (fn: () => void) => fn(),
}))
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
const adapter = {
  id: 'github' as const,
  writableFields: new Set(['title', 'body', 'status', 'labels']),
  statuses: ['todo', 'in_progress', 'done'] as const,
  statusKey: (status: string) => status,
  async listTickets(_target: { provider: string; externalKey: string }, options?: { query?: string }) {
      listCalls++
      listOptions.push(options ?? {})
      if (listError) throw listError
      return { tasks: [upstreamTask] }
  },
  async fetchTicket() {
      getCalls++
      return {
        provider: 'github' as const,
        externalKey: 'example/repo',
        externalId: upstreamTask.id,
        url: upstreamTask.url!,
        title: upstreamTask.title,
        body: upstreamTask.body,
        status: upstreamTask.status,
        labels: upstreamTask.labels,
        externalUpdatedAt: new Date(upstreamTask.updatedAt).toISOString(),
        comments: [],
      }
  },
  async pushFields(_ref: unknown, patch: Partial<Task>) {
      updatedPatch = patch
      return {
        provider: 'github' as const,
        externalKey: 'example/repo',
        externalId: upstreamTask.id,
        url: upstreamTask.url!,
        title: patch.title ?? upstreamTask.title,
        body: upstreamTask.body,
        status: patch.status ?? upstreamTask.status,
        labels: upstreamTask.labels,
        externalUpdatedAt: new Date(upstreamTask.updatedAt).toISOString(),
        comments: [],
      }
  },
  async postComment() { return { externalId: '1', body: 'note', createdAt: 1 } },
  // Nothing here references a local asset, so publishing is the identity.
  async publishAssets(_ref: unknown, body: string) { return body },
  unpublishableAssets() { return [] },
  async ticketUrl() { return upstreamTask.url! },
  async fetchTickets() { return [] },
  async createTicket() { throw new Error('not used') },
  async listCandidates() { return [] },
}
mock.module('@solus/server/tasks/adapters/registry', () => ({
  taskSyncAdapter: () => adapter,
  resolveTaskPublishTarget: async () => {
    if ((config?.taskProvider ?? 'local') === 'local') return null
    const owner = config?.taskProviderConfig?.owner
    const repo = config?.taskProviderConfig?.repo
    if (!owner || !repo) throw new Error('GitHub task sync needs a repository.')
    return { adapter, ref: { provider: 'github', externalKey: `${owner}/${repo}` } }
  },
}))

let service: typeof import('@solus/server/tasks/upstream')

beforeAll(async () => {
  service = await import('@solus/server/tasks/upstream')
})

beforeEach(() => {
  config = {
    version: 1,
    taskProvider: 'github',
    taskProviderConfig: { owner: 'example', repo: 'repo' },
  }
  listCalls = 0
  listOptions = []
  getCalls = 0
  listError = null
  updatedPatch = null
  cacheRows.clear()
  mirroredExternalIds = new Set<string>()
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
    await service.listUpstreamTasks('/workspace/solus')
    mirroredExternalIds = new Set(['42'])
    listError = new Error('offline')

    const cached = await service.listUpstreamTasks('/workspace/solus')

    expect(cached.fromCache).toBe(true)
    expect(cached.tasks).toEqual([])
  })

  test('keeps local-only projects from making an upstream request', async () => {
    config = { version: 1, taskProvider: 'local' }

    expect(await service.listUpstreamTasks('/workspace/solus')).toEqual({ tasks: [] })
    expect(listCalls).toBe(0)
  })

  test('does not infer a missing GitHub binding at runtime', async () => {
    // WHY: changing an origin remote must not silently repoint provider-owned
    // rows or future publishes. The picker is the only binding owner.
    config = { version: 1, taskProvider: 'github' }
    await expect(service.listUpstreamTasks('/workspace/solus')).rejects.toThrow(/needs a repository/i)
    expect(listCalls).toBe(0)
  })

  test('keys offline snapshots by the pinned external scope', async () => {
    await service.listUpstreamTasks('/workspace/solus')
    config = {
      version: 1,
      taskProvider: 'github',
      taskProviderConfig: { owner: 'example', repo: 'other' },
    }
    listError = new Error('offline')
    await expect(service.listUpstreamTasks('/workspace/solus')).rejects.toThrow('offline')
  })

  test('treats transport-null list options as the default scope', async () => {
    // WHY: optional RPC arguments cross JSON transports as null, and a missing
    // filter must still load the project's complete GitHub issue list.
    await service.listUpstreamTasks('/workspace/solus')
    const result = await service.listUpstreamTasks('/workspace/solus', null)

    expect(result.tasks).toEqual([
      expect.objectContaining({ id: '42', projectKey: '/workspace/solus' }),
    ])
  })

  test('keeps the last successful GitHub snapshot visible when refresh fails', async () => {
    // WHY: a temporary upstream failure must not make GitHub rows disappear
    // beside native tasks after the local-first task migration.
    const live = await service.listUpstreamTasks('/workspace/solus')
    listError = new Error('temporary GitHub failure')

    const cached = await service.listUpstreamTasks('/workspace/solus')

    expect(live.fromCache).toBeUndefined()
    expect(cached).toEqual(expect.objectContaining({
      tasks: [expect.objectContaining({ id: '42', projectKey: '/workspace/solus' })],
      fromCache: true,
      fetchedAt: expect.any(Number),
    }))
  })

  test('reads a provider-owned ticket live even when the list has a snapshot', async () => {
    // WHY: an unstored row has no local source of truth. The cache keeps an
    // offline list visible, but a detail page must show the provider's current
    // body, comments, and workflow state.
    await service.listUpstreamTasks('/workspace/solus')
    const task = await service.getUpstreamTask('/workspace/solus', '42')

    expect(task).toEqual(expect.objectContaining({ id: '42', projectKey: '/workspace/solus' }))
    expect(getCalls).toBe(1)
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

describe('searching the provider', () => {
  // WHY: the provider list stops at a cap. Filtering the rows that happen to be
  // loaded answers "no such issue" for anything older, so the text has to reach
  // the provider.
  test('hands the query to the adapter', async () => {
    await service.listUpstreamTasks('/workspace/solus', { query: '  payment retry  ' })

    expect(listOptions).toEqual([{ involvement: undefined, query: 'payment retry' }])
  })

  // A search result is not the project's list. Storing it would make the
  // offline fallback a filtered subset of the project, silently.
  test('never writes a search result into the offline snapshot', async () => {
    await service.listUpstreamTasks('/workspace/solus')
    const afterList = cacheRows.size
    await service.listUpstreamTasks('/workspace/solus', { query: 'payment' })

    expect(cacheRows.size).toBe(afterList)
  })

  // And never reads from it either: answering a search from the cached full
  // list would return rows that do not match what was asked.
  test('reports a failed search instead of serving the cached list', async () => {
    await service.listUpstreamTasks('/workspace/solus')
    listError = new Error('Jira is unreachable')

    await expect(service.listUpstreamTasks('/workspace/solus', { query: 'payment' }))
      .rejects.toThrow(/unreachable/)
  })
})
