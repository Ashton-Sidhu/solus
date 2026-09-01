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
  TaskStatus,
  TaskSyncField,
  TicketPatch,
} from '@solus/contracts/task-types'
import { TASKS_AUTH_ERROR_PREFIX } from '@solus/contracts/task-types'
import type { TaskSyncAdapter } from '@solus/server/tasks/adapters/types'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
mock.module('@solus/server/tasks/adapters/registry', () => ({
  taskSyncAdapter: () => adapter,
  resolveTaskPublishTarget: async () => null,
  blockedAssetReferences: () => [],
}))

class FakeAdapter implements TaskSyncAdapter {
  readonly id = 'github' as const
  /** GitHub's real set: priority is inferred from labels, never written. */
  readonly writableFields: ReadonlySet<TaskSyncField> = new Set(['title', 'body', 'status', 'labels'])
  readonly statuses = ['todo', 'in_progress', 'done'] as const
  remote!: NormalizedTicket
  pushes: TicketPatch[] = []
  posted: string[] = []
  publishedBodies: string[] = []
  fetches = 0
  fetchError: Error | null = null
  beforePushReturn: (() => void | Promise<void>) | null = null
  /** Stands in for an upload: the engine must send what this returns, not the
   *  stored body, and must never write it back onto the local row. */
  publishAsset: ((body: string) => string) | null = null

  reset(): void {
    this.remote = ticket()
    this.pushes = []
    this.posted = []
    this.publishedBodies = []
    this.fetches = 0
    this.fetchError = null
    this.beforePushReturn = null
    this.publishAsset = null
    this.postedExternalId = (index) => `posted-${index}`
    this.changed = null
    this.changedQueries = []
  }

  /** The GitHub collapse: six local statuses, three states an issue can hold. */
  statusKey(status: TaskStatus): string {
    if (status === 'done' || status === 'dropped') return 'closed'
    if (status === 'in_progress' || status === 'in_review') return 'in_progress'
    return 'open'
  }

  ticketUrl(target: Omit<ExternalTicketRef, 'externalId' | 'url'>, externalId: string): Promise<string> {
    return Promise.resolve(`https://github.com/${target.externalKey}/issues/${externalId}`)
  }

  async publishAssets(_ref: ExternalTicketRef, body: string): Promise<string> {
    this.publishedBodies.push(body)
    return this.publishAsset ? this.publishAsset(body) : body
  }

  unpublishableAssets(): [] {
    return []
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

  /** Overridden by the id-space test, which reproduces a provider that named a
   *  comment one way on write and another way on read. */
  postedExternalId: (index: number) => string = (index) => `posted-${index}`

  async postComment(_ref: ExternalTicketRef, body: string): Promise<NormalizedTaskComment> {
    this.posted.push(body)
    return {
      externalId: this.postedExternalId(this.posted.length),
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

  async listTickets() {
    return { tasks: [] }
  }

  /** What the scope query will answer, and how often it was asked. `null` is a
   *  provider saying it cannot answer, which must put the engine back on the
   *  per-ticket pass. */
  changed: Set<string> | null = null
  changedQueries: number[] = []

  async changedSince(
    _target: Omit<ExternalTicketRef, 'externalId' | 'url'>,
    since: number,
  ): Promise<Set<string> | null> {
    this.changedQueries.push(since)
    return this.changed
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
    status: 'todo',
    labels: ['bug'],
    externalUpdatedAt: 'remote-1',
    comments: [],
    snapshot: { number: 42 },
    ...overrides,
  }
}

type DbModule = typeof import('@solus/server/db')
type TaskStoreModule = typeof import('@solus/server/tasks/task-store')
type TaskModule = typeof import('@solus/server/tasks/task')
type SyncStoreModule = typeof import('@solus/server/tasks/task-sync-store')
type SyncEngineModule = typeof import('@solus/server/tasks/sync-engine')

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
  db = await import('@solus/server/db')
  taskStore = await import('@solus/server/tasks/task-store')
  tasks = await import('@solus/server/tasks/task')
  syncStore = await import('@solus/server/tasks/task-sync-store')
  syncEngine = await import('@solus/server/tasks/sync-engine')
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

/** Supplied so linking stays local: resolving a URL is a code-host round trip. */
const PR_URL = (number: number) => `https://github.com/owner/repo/pull/${number}`
/** What the host says about a task's *other* pull requests. Stated by the test
 *  rather than read, so completion is exercised without a code host. */
const neverMerged = async () => false
const alwaysMerged = async () => true

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
  test('does not invalidate a no-change pull but invalidates a newly imported comment', async () => {
    // WHY: task detail reloads schedule a pull. A no-change pull must not emit
    // another invalidation and create a reload-pull loop. New comments still
    // need to refresh every mounted task surface.
    const task = await linkedTask()
    const sync = engine()
    let changeCount = 0
    const unsubscribe = taskStore.onTasksChanged(() => changeCount++)

    try {
      await sync.syncTask(task.id)
      expect(changeCount).toBe(0)

      adapter.remote = ticket({
        comments: [{ externalId: 'remote-comment', author: 'octo', body: 'Remote note', createdAt: 2 }],
      })
      await sync.syncTask(task.id)
      expect(changeCount).toBe(1)
    } finally {
      unsubscribe()
    }
  })

  test('never pushes a field the provider cannot write, and never keeps holding it', async () => {
    // WHY: GitHub infers priority from labels — an issue write cannot set it.
    // Sending it would fail the whole patch, and holding it dirty would show a
    // pending change on the task page that has nowhere to land.
    const task = await linkedTask()
    await task.update({ priority: 'urgent' })
    expect(syncStore.externalLinkForTask(task.id)?.dirtyFields).toEqual(['priority'])

    await engine().syncTask(task.id)

    expect(adapter.pushes).toEqual([])
    expect(syncStore.externalLinkForTask(task.id)).toMatchObject({
      dirtyFields: [],
      syncState: 'ok',
    })
  })

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

  test('applies an external priority change during pull sync', async () => {
    // WHY: advancing the link timestamp without copying priority makes the
    // stale local value look synchronized until Jira changes again.
    const task = await linkedTask()
    await task.update({ priority: 'urgent' }, { actor: 'system' }, { markSyncDirty: false })
    adapter.remote = ticket({ priorityHint: 'low', externalUpdatedAt: 'remote-new' })

    await engine().syncTask(task.id)

    expect((await tasks.Task.byId(task.id)).priority).toBe('low')
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

  test('names the ticket on every task read, not only on the detail page', async () => {
    // WHY: the Tasks list has no detail read to consult. Without the ticket on
    // the row itself, a task the user just published keeps reading as local.
    const task = await linkedTask()

    const listed = taskStore.listTasks().tasks.find((row) => row.id === task.id)

    expect(listed?.mirroredTicket).toEqual({
      provider: 'github',
      externalId: adapter.remote.externalId,
      url: adapter.remote.url,
    })
    // Ownership does not move: reads and writes still take the native path.
    expect(listed?.providerId).toBe('local')
  })

  test('publishes a comment that was held back, and never re-posts a published one', async () => {
    // WHY: Publish is the whole point of holding a comment back — and pressing
    // it on an already-posted comment must not put a second copy on the ticket.
    const task = await linkedTask()
    await task.comment('Held back')
    await engine().syncTask(task.id)
    expect(adapter.posted).toEqual([])

    const held = (await task.details()).comments.find((comment) => comment.body === 'Held back')!
    await task.publishComments([held.id])
    await engine().syncTask(task.id)
    expect(adapter.posted).toEqual(['Held back'])

    await task.publishComments([held.id])
    await engine().syncTask(task.id)
    expect(adapter.posted).toEqual(['Held back'])
  })

  test('posts the published body and keeps the local reference', async () => {
    // WHY: an asset lives on this host, so the provider needs a URL it can
    // resolve. The stored comment must keep `asset://` anyway — it is the
    // durable content, and rewriting it would strand the local render and make
    // republishing depend on a provider URL that can be revoked.
    const assetId = `${'a'.repeat(64)}.png`
    adapter.publishAsset = (body) => body.replace(`asset://${assetId}`, 'https://github.test/asset')
    const task = await linkedTask()
    await task.comment(`Look: ![shot](asset://${assetId})`, { pushToExternal: true })
    await engine().syncTask(task.id)

    expect(adapter.posted).toEqual(['Look: ![shot](https://github.test/asset)'])
    const stored = (await task.details()).comments.at(-1)!
    expect(stored.body).toBe(`Look: ![shot](asset://${assetId})`)
  })

  test('keeps a dirty body acknowledged after its assets are published', async () => {
    // WHY: the engine compares what it pushed against the task row to notice an
    // edit that landed mid-push. Comparing the *published* body would never
    // match the stored one, leaving the description dirty and re-pushing forever.
    const assetId = `${'b'.repeat(64)}.png`
    adapter.publishAsset = () => 'rewritten upstream body'
    const task = await linkedTask()
    await task.update({ body: `Body ![shot](asset://${assetId})` })
    await engine().syncTask(task.id)

    expect(adapter.pushes.at(-1)?.body).toBe('rewritten upstream body')
    const link = syncStore.externalLinkForTask(task.id)!
    expect(link.dirtyFields).not.toContain('body')
  })

  test('does not duplicate a pushed comment that the provider names differently on read', async () => {
    // WHY: GitHub answers a REST write with a database id and a GraphQL read
    // with a node id. Stamping the row with the write id made the very next
    // pull treat our own comment as a new one and insert a second copy — the
    // duplicate a user saw whenever they ticked "also post to GitHub".
    const task = await linkedTask()
    adapter.postedExternalId = () => '2384927'
    await task.comment('Same note', { pushToExternal: true })
    await engine().syncTask(task.id)
    expect(adapter.posted).toEqual(['Same note'])

    adapter.remote = ticket({
      externalUpdatedAt: 'remote-new',
      comments: [{ externalId: 'IC_kwDO1', author: 'you', body: 'Same note', createdAt: 3 }],
    })
    await engine().syncTask(task.id)

    const bodies = (await task.details()).comments.filter((comment) => comment.body === 'Same note')
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toMatchObject({ externalId: 'IC_kwDO1' })
  })

  test('names the provider on every read of a linked task, not just the detail read', async () => {
    // WHY: the Tasks list has no detail read to consult, so without this a task
    // published to GitHub keeps showing as local everywhere but its own page.
    const task = await linkedTask()

    const listed = taskStore.listTasks().tasks.find((row) => row.id === task.id)

    expect(listed?.mirroredTicket).toEqual({
      provider: 'github',
      externalId: adapter.remote.externalId,
      url: adapter.remote.url,
    })
    // Ownership does not move: reads and writes still take the native path.
    expect(listed?.providerId).toBe('local')
  })

  test('refuses to publish comments for a task with no linked ticket', async () => {
    // WHY: marking rows nothing will ever read would leave the page claiming a
    // push is queued when there is nowhere to push to.
    const task = await tasks.Task.byId((await taskStore.createTask({ title: 'Local only' })).id)
    await task.comment('Note')
    const comment = (await task.details()).comments[0]
    expect(task.publishComments([comment.id])).rejects.toThrow(/not linked/i)
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

  test('completes a task whose one pull request merged, whatever column it was in', async () => {
    // WHY: the old rule only completed a task sitting in review, so the
    // ordinary case — several `todo` tasks landing on one branch — left every
    // one of them open after the branch merged. Work merged is work finished.
    const task = await linkedTask()
    const projectRoot = process.cwd()
    await task.update({ projectKey: projectRoot, status: 'todo' })
    await task.linkPullRequest({ number: 17, targetScope: projectRoot, url: PR_URL(17) })

    expect(await syncEngine.completeTasksForMergedPullRequest(projectRoot, 17, neverMerged))
      .toEqual([task.id])
    expect((await tasks.Task.byId(task.id)).status).toBe('done')
    expect(syncStore.externalLinkForTask(task.id)?.dirtyFields).toContain('status')
  })

  test('leaves a task alone while any of its other pull requests is unmerged', async () => {
    // WHY: a task that took two pull requests is not finished by the first one.
    const task = await linkedTask()
    const projectRoot = process.cwd()
    await task.update({ projectKey: projectRoot, status: 'in_review' })
    await task.linkPullRequest({ number: 17, targetScope: projectRoot, url: PR_URL(17) })
    await task.linkPullRequest({ number: 18, targetScope: projectRoot, url: PR_URL(18) })

    expect(await syncEngine.completeTasksForMergedPullRequest(projectRoot, 17, neverMerged))
      .toEqual([])
    expect((await tasks.Task.byId(task.id)).status).toBe('in_review')

    // #18 merges too, and the task has nothing left outstanding.
    expect(await syncEngine.completeTasksForMergedPullRequest(projectRoot, 18, alwaysMerged))
      .toEqual([task.id])
    expect((await tasks.Task.byId(task.id)).status).toBe('done')
  })
})

describe('polling many links', () => {
  /** A second linked task in the same scope, on its own issue. */
  async function linkedTaskFor(externalId: string) {
    const created = await taskStore.createTask({
      title: `Issue ${externalId}`,
      body: '',
      status: 'todo',
      projectKey: '/workspace/solus',
      labels: [],
    })
    db.withTx(() => syncStore.writeExternalLink(
      db.getDb(),
      created.id,
      ticket({ externalId, externalUpdatedAt: `remote-${externalId}` }),
      1,
    ))
    return tasks.Task.byId(created.id)
  }

  // WHY: the poll used to ask the provider about every link on every interval,
  // so its cost grew with the number of linked tasks and never with the amount
  // of change. One scope query answers for all of them.
  //
  // The first poll of a run has no window to measure from and is a plain pass;
  // it is also what establishes the mark, so the second poll asks the scope.
  test('asks the scope once and fetches only what changed', async () => {
    const changedTask = await linkedTaskFor('101')
    await linkedTaskFor('102')
    const sync = engine()
    await sync.poll()
    expect(adapter.fetches).toBe(2)

    adapter.fetches = 0
    adapter.changed = new Set(['101'])
    adapter.remote = ticket({ externalId: '101', externalUpdatedAt: 'remote-moved' })
    await sync.poll()

    expect(adapter.changedQueries).toEqual([10])
    expect(adapter.fetches).toBe(1)
    expect((await tasks.Task.byId(changedTask.id)).title).toBe('Remote title')
  })

  test('touches nothing on a scope where nothing moved', async () => {
    await linkedTaskFor('102')
    const sync = engine()
    await sync.poll()

    adapter.fetches = 0
    adapter.changed = new Set()
    await sync.poll()

    expect(adapter.fetches).toBe(0)
  })

  // An unchanged ticket says nothing about a local edit waiting to be sent.
  test('still visits a link with local work pending', async () => {
    const task = await linkedTaskFor('103')
    // The upstream copy is exactly the one the link recorded, so nothing pulls
    // and the pending push is the only thing this sync has to do.
    adapter.remote = ticket({ externalId: '103', externalUpdatedAt: 'remote-103' })
    const sync = engine()
    await sync.poll()

    await task.update({ title: 'Local edit' })
    adapter.changed = new Set()
    await sync.poll()

    expect(adapter.pushes).toEqual([{ title: 'Local edit' }])
  })

  // A provider that cannot answer must cost correctness nothing: the engine
  // falls back to the pass it has always done.
  test('asks about every link when the scope query cannot answer', async () => {
    await linkedTaskFor('104')
    await linkedTaskFor('105')
    const sync = engine()
    await sync.poll()

    adapter.fetches = 0
    adapter.changed = null
    await sync.poll()

    expect(adapter.fetches).toBe(2)
  })
})
