import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type {
  CandidateTicket,
  ExternalTicketRef,
  NormalizedTaskComment,
  NormalizedTicket,
  TaskCandidateOptions,
  TicketPatch,
} from '../../src/shared/task-types'
import { TASKS_AUTH_ERROR_PREFIX } from '../../src/shared/task-types'
import type { TaskSyncAdapter } from '../../src/main/tasks/adapters/types'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
mock.module('../../src/main/tasks/adapters/registry', () => ({
  taskSyncAdapter: () => adapter,
  resolveTaskPublishTarget: async () => null,
}))

class FakeAdapter implements TaskSyncAdapter {
  readonly id = 'github' as const
  remote!: NormalizedTicket
  pushes: TicketPatch[] = []
  posted: string[] = []
  fetches = 0
  fetchError: Error | null = null
  beforePushReturn: (() => void | Promise<void>) | null = null

  reset(): void {
    this.remote = ticket()
    this.pushes = []
    this.posted = []
    this.fetches = 0
    this.fetchError = null
    this.beforePushReturn = null
  }

  async fetchTicket(): Promise<NormalizedTicket> {
    this.fetches++
    if (this.fetchError) throw this.fetchError
    return structuredClone(this.remote)
  }

  async fetchTickets(refs: ExternalTicketRef[]): Promise<NormalizedTicket[]> {
    return Promise.all(refs.map(() => this.fetchTicket()))
  }

  async pushFields(_ref: ExternalTicketRef, patch: TicketPatch): Promise<NormalizedTicket> {
    this.pushes.push(structuredClone(patch))
    this.remote = {
      ...this.remote,
      ...patch,
      externalUpdatedAt: `remote-${this.pushes.length + 1}`,
    }
    await this.beforePushReturn?.()
    return structuredClone(this.remote)
  }

  async postComment(_ref: ExternalTicketRef, body: string): Promise<NormalizedTaskComment> {
    this.posted.push(body)
    return {
      externalId: `posted-${this.posted.length}`,
      author: 'you',
      body,
      createdAt: 1_800_000_000_000 + this.posted.length,
    }
  }

  async createTicket(): Promise<NormalizedTicket> {
    return structuredClone(this.remote)
  }

  async listCandidates(_target: never, _options?: TaskCandidateOptions): Promise<CandidateTicket[]> {
    return []
  }
}

function ticket(overrides: Partial<NormalizedTicket> = {}): NormalizedTicket {
  return {
    provider: 'github',
    externalKey: 'solus/desktop',
    externalId: '42',
    url: 'https://github.com/solus/desktop/issues/42',
    title: 'Remote title',
    body: 'Remote body',
    status: 'open',
    labels: ['bug'],
    externalUpdatedAt: 'remote-1',
    comments: [],
    snapshot: { number: 42 },
    ...overrides,
  }
}

type DbModule = typeof import('../../src/main/db')
type TaskStoreModule = typeof import('../../src/main/tasks/task-store')
type TaskModule = typeof import('../../src/main/tasks/task')
type SyncStoreModule = typeof import('../../src/main/tasks/task-sync-store')
type SyncEngineModule = typeof import('../../src/main/tasks/sync-engine')

let dataDir: string
let db: DbModule
let taskStore: TaskStoreModule
let tasks: TaskModule
let syncStore: SyncStoreModule
let syncEngine: SyncEngineModule
let adapter: FakeAdapter
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-task-sync-'))
  process.env.SOLUS_DATA_DIR = dataDir
  db = await import('../../src/main/db')
  taskStore = await import('../../src/main/tasks/task-store')
  tasks = await import('../../src/main/tasks/task')
  syncStore = await import('../../src/main/tasks/task-sync-store')
  syncEngine = await import('../../src/main/tasks/sync-engine')
})

beforeEach(() => {
  adapter = new FakeAdapter()
  adapter.reset()
})

afterEach(() => {
  db.closeDb()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `solus.db${suffix}`), { force: true })
})

afterAll(() => {
  db.closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

async function linkedTask() {
  const created = await taskStore.createTask({
    title: adapter.remote.title,
    body: adapter.remote.body,
    status: 'todo',
    projectKey: '/workspace/solus',
    labels: adapter.remote.labels,
  })
  db.withTx(() => syncStore.writeExternalLink(db.getDb(), created.id, adapter.remote, 1))
  return tasks.Task.byId(created.id)
}

function engine(): InstanceType<SyncEngineModule['TaskSyncEngine']> {
  return new syncEngine.TaskSyncEngine({ adapterFor: () => adapter, now: () => 10 })
}

describe('task sync engine', () => {
  test('coalesces dirty fields into one provider patch and clears them after success', async () => {
    // WHY: SQLite is the durable queue. Rapid inline edits must not become one
    // remote request per keystroke or leave a stale dirty flag after success.
    const task = await linkedTask()
    await task.update({ title: 'Local title' })
    await task.update({ body: 'Local body' })

    expect(syncStore.externalLinkForTask(task.id)?.dirtyFields).toEqual(['title', 'body'])

    await engine().syncTask(task.id)

    expect(adapter.pushes).toEqual([{ title: 'Local title', body: 'Local body' }])
    expect(syncStore.externalLinkForTask(task.id)).toMatchObject({
      dirtyFields: [],
      syncState: 'ok',
      externalUpdatedAt: 'remote-2',
    })
  })

  test('applies an external change over dirty local fields without pushing the conflict', async () => {
    // WHY: the external-favored rule must be atomic and visible. A local dirty
    // marker must not overwrite a ticket that changed after the last snapshot.
    const task = await linkedTask()
    await task.update({ title: 'Unsynced local title' })
    adapter.remote = ticket({ title: 'New remote title', externalUpdatedAt: 'remote-new' })

    await engine().syncTask(task.id)

    expect((await tasks.Task.byId(task.id)).title).toBe('New remote title')
    expect(adapter.pushes).toHaveLength(0)
    expect(syncStore.externalLinkForTask(task.id)).toMatchObject({ dirtyFields: [], syncState: 'ok' })
  })

  test('does not clear a local edit that arrives while a push is in flight', async () => {
    // WHY: a provider request can take seconds. A second inline edit during
    // that request must remain durable and schedule the next coalesced push.
    const task = await linkedTask()
    await task.update({ title: 'First edit' })
    adapter.beforePushReturn = () => task.update({ body: 'Second edit' })

    await engine().syncTask(task.id)

    expect(adapter.pushes).toEqual([{ title: 'First edit' }])
    expect(syncStore.externalLinkForTask(task.id)).toMatchObject({
      dirtyFields: ['body'],
      syncState: 'dirty',
    })
  })

  test('compares status by equivalence class and does not downgrade in-review work', async () => {
    // WHY: GitHub only has an in-progress equivalence class. Pulling that class
    // must not erase Solus's more precise review state.
    const task = await linkedTask()
    await task.update({ status: 'in_review' })
    adapter.remote = ticket({ status: 'in_progress', externalUpdatedAt: 'remote-new' })

    await engine().syncTask(task.id)

    expect((await tasks.Task.byId(task.id)).status).toBe('in_review')
    expect(adapter.pushes).toHaveLength(0)
  })

  test('deduplicates pulled comments and pushes only comments that were flagged', async () => {
    // WHY: comments are local-first by default. Pull retries must be idempotent,
    // while an explicit push must attach the provider id to the same local row.
    const task = await linkedTask()
    adapter.remote = ticket({
      comments: [{ externalId: 'remote-comment', author: 'octo', body: 'Remote note', createdAt: 2 }],
    })
    await engine().syncTask(task.id)
    await engine().syncTask(task.id)
    await task.comment('Private note')
    await engine().syncTask(task.id)

    expect(adapter.posted).toEqual([])
    expect((await task.details()).comments.filter((comment) => comment.externalId === 'remote-comment'))
      .toHaveLength(1)

    await task.comment('Publish this note', { pushToExternal: true })
    await engine().syncTask(task.id)

    expect(adapter.posted).toEqual(['Publish this note'])
    expect((await task.details()).comments.find((comment) => comment.body === 'Publish this note'))
      .toMatchObject({ externalId: 'posted-1' })
  })

  test('marks authentication failures and skips background retries until an explicit sync', async () => {
    // WHY: an invalid credential must not make every five-minute tick hammer
    // the provider. Explicit sync is the retry boundary after re-authentication.
    const task = await linkedTask()
    adapter.fetchError = new Error(`${TASKS_AUTH_ERROR_PREFIX}Reconnect GitHub.`)
    const sync = engine()

    await sync.syncTask(task.id, { retryAuth: false })
    expect(syncStore.externalLinkForTask(task.id)).toMatchObject({
      syncState: 'auth_error',
      syncError: 'Reconnect GitHub.',
    })
    expect(adapter.fetches).toBe(1)

    adapter.fetchError = null
    await sync.syncTask(task.id, { retryAuth: false })
    expect(adapter.fetches).toBe(1)

    await sync.syncTask(task.id, { retryAuth: true })
    expect(adapter.fetches).toBe(2)
    expect(syncStore.externalLinkForTask(task.id)?.syncState).toBe('ok')
  })

  test('moves linked in-review tasks to done after an authoritative merge', async () => {
    // WHY: the merge handler already knows the provider accepted the merge.
    // Task completion must not wait for a later issue or PR poll.
    const task = await linkedTask()
    const projectRoot = process.cwd()
    await task.update({ projectKey: projectRoot, status: 'in_review' })
    await task.linkPullRequest({ number: 17, targetScope: projectRoot })

    expect(await syncEngine.completeTasksForMergedPullRequest(projectRoot, 17)).toEqual([task.id])
    expect((await tasks.Task.byId(task.id)).status).toBe('done')
    expect(syncStore.externalLinkForTask(task.id)?.dirtyFields).toContain('status')
  })
})
