import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { PullRequest, RepoRef } from '@solus/contracts/providers'
import { pullRequestFixture } from './__fixtures__/pull-request'
import type { Provider } from '@solus/server/providers/types'

/**
 * Noticing a merge Solus did not make.
 *
 * Every in-Solus write announces itself, so the only pull requests that go
 * stale are the ones changed elsewhere — on github.com, through `gh`, or from
 * another machine. These tests pin the rule: a linked pull request the host no
 * longer reports open is news exactly once, and a merge also completes the work
 * that was waiting on it.
 *
 * Each test names its own repository. `PrIndex` is a process-wide cache of
 * answers *and* of the code host each pull request was first read through, so
 * tests sharing a repository would be reading each other's fixtures.
 */

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

const providers = new Map<string, Provider>()
mock.module('@solus/server/providers/registry', () => ({
  providerForRepo: (repo: RepoRef) => providers.get(repo.repo) ?? null,
}))

let dataDir: string
let taskStore: typeof import('@solus/server/tasks/task-store')
let tasks: typeof import('@solus/server/tasks/task')
let PrReconciler: typeof import('@solus/server/prs/pr-reconciler')['PrReconciler']
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-pr-reconciler-'))
  process.env.SOLUS_DATA_DIR = dataDir
  taskStore = await import('@solus/server/tasks/task-store')
  tasks = await import('@solus/server/tasks/task')
  ;({ PrReconciler } = await import('@solus/server/prs/pr-reconciler'))
})

afterAll(async () => {
  (await import('@solus/server/db')).closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

interface Announcement {
  projectRoot: string
  detail: PullRequest
}

/** A project, a task waiting on pull request #1, and a code host that answers
 *  with whatever the test last said — counting what it was asked, because the
 *  poll's cost is part of what these tests pin. */
async function project(name: string, status: 'in_review' | 'todo' = 'in_review') {
  const projectScope = `github.com/owner/${name}`
  const created = await taskStore.createTask({ title: 'Work on #1', status: 'todo', projectKey: join(dataDir, name) })
  const task = await tasks.Task.byId(created.id)
  await task.update({ status })
  // With the URL supplied, linking stays local: resolving one is a code-host
  // round trip, and these tests are about the poll, not about linking.
  await task.linkPullRequest({
    number: 1,
    targetScope: projectScope,
    url: `https://github.com/owner/${name}/pull/1`,
  })

  const announced: Announcement[] = []
  const host = { reads: 0, state: 'open' as PullRequest['state'], now: Date.now(), fail: false }
  const provider = {
    // SAFETY: the reconciler reaches the host through `PrIndex`, which reads a
    // pull request with this one method.
    review: {
      getPullRequest: async (_repo: RepoRef, number: number): Promise<PullRequest> => {
        host.reads += 1
        if (host.fail) throw new Error('404')
        return { number, state: host.state, draft: false, headSha: 'sha-1', headRef: 'feature', title: 'Saved PR', url: `https://github.com/owner/${name}/pull/1`, updatedAt: new Date(host.now).toISOString(), baseRepo: { host: 'github.com', owner: 'owner', repo: name } } as unknown as PullRequest
      },
    },
  } as unknown as Provider

  providers.set(name, provider)
  return {
    projectScope,
    task,
    announced,
    host,
    reconciler: new PrReconciler({
      announce: (projectRoot, detail) => { announced.push({ projectRoot, detail }) },
      watchList: () => [{ projectScope, number: 1 }],
      now: () => host.now,
      discover: async () => {},
    }),
  }
}

describe('reconciling pull requests changed outside Solus', () => {
  test('waits for linked pull requests in both repositories through the normal host lookup', async () => {
    const first = await project('first-repository')
    const second = await project('second-repository')
    await first.task.linkPullRequest({
      number: 1,
      targetScope: second.projectScope,
      url: 'https://github.com/owner/second-repository/pull/1',
    })

    first.host.state = 'merged'
    await first.reconciler.poll()
    expect((await tasks.Task.byId(first.task.id)).status).toBe('in_review')

    second.host.state = 'merged'
    await second.reconciler.poll()
    expect((await tasks.Task.byId(first.task.id)).status).toBe('done')
    expect((await tasks.Task.byId(second.task.id)).status).toBe('done')
  })

  test('announces a merge made on the code host and completes the task waiting on it', async () => {
    const { projectScope, task, announced, host, reconciler } = await project('merged-elsewhere')

    // An open pull request is what every surface would read for itself.
    await reconciler.poll()
    expect(announced[0]?.detail.state).toBe('open')
    announced.length = 0
    host.now += 60_001

    host.state = 'merged'
    await reconciler.poll()

    expect(announced).toHaveLength(1)
    expect(announced[0]?.projectRoot).toBe(projectScope)
    expect(announced[0]?.detail.state).toBe('merged')
    expect((await tasks.Task.byId(task.id)).status).toBe('done')
  })

  test('finishes a task on a later poll once its busy session settles, without another host read', async () => {
    // WHY: a merge under a session still mid-turn must not close the card,
    // but the answer the host already gave is enough to close it later. The
    // poll re-asks the task from memory, so waiting costs no requests.
    const { getDb } = await import('@solus/server/db')
    const busy = new Set<string>()
    const scope = 'github.com/owner/busy-session'
    const created = await taskStore.createTask({ title: 'Work on #1', status: 'in_progress', projectKey: join(dataDir, 'busy-session') })
    const task = await tasks.Task.byId(created.id)
    await task.linkPullRequest({ number: 1, targetScope: scope, url: 'https://github.com/owner/busy-session/pull/1' })
    getDb().prepare(`INSERT INTO sessions(session_id, provider, is_worktree, last_timestamp, message_count, size)
      VALUES ('busy-1', 'claude', 0, ?, 0, 0)`).run(Date.now())
    await task.linkSession('busy-1', 'working', {})
    const host = { reads: 0, now: Date.now() + 60_000 }
    providers.set('busy-session', { review: {
      getPullRequest: async (_repo: RepoRef, number: number) => {
        host.reads += 1
        return pullRequestFixture(number, { state: 'merged', updatedAt: new Date(host.now).toISOString(), baseRepo: { host: 'github.com', owner: 'owner', repo: 'busy-session' } })
      },
    } } as unknown as Provider)
    const reconciler = new PrReconciler({
      announce: () => {}, discover: async () => {}, now: () => host.now,
      watchList: () => [{ projectScope: scope, number: 1 }],
      isSessionBusy: (sessionId) => busy.has(sessionId),
    })

    busy.add('busy-1')
    await reconciler.poll()
    expect((await tasks.Task.byId(task.id)).status).toBe('in_progress')

    busy.clear()
    await reconciler.poll()
    expect((await tasks.Task.byId(task.id)).status).toBe('done')
    expect(host.reads).toBe(1)
  })

  test('reports a settled pull request once, then stops asking', async () => {
    // WHY: this is both the correctness rule and the cost model. A merged pull
    // request cannot change again, so a repository whose linked work is
    // finished must cost no requests at all.
    const { announced, host, reconciler } = await project('settled', 'todo')
    host.state = 'closed'

    await reconciler.poll()
    await reconciler.poll()

    expect(announced).toHaveLength(1)
    expect(host.reads).toBe(1)
  })

  test('watches the pull requests of work that is still going, and no others', async () => {
    // WHY: a pull request nobody's task points at has no Solus surface to go
    // stale, and a task that is done has stopped asking what became of its
    // pull request. This query is what keeps the poll small.
    const db = await import('@solus/server/db')
    const links = await import('@solus/server/tasks/task-links')
    const going = await project('watch-list-active', 'in_review')
    const finished = await project('watch-list-finished', 'todo')
    await (await tasks.Task.byId(finished.task.id)).update({ status: 'done' })

    const watched = links.readActivePrLinkTargets(db.getDb())

    expect(watched).toContainEqual({ projectScope: going.projectScope, number: 1 })
    expect(watched).not.toContainEqual({ projectScope: finished.projectScope, number: 1 })
  })
})

describe('host memory PR summaries on boot and reload', () => {
  test('100 task links render with host memory summaries and reload without provider reads', async () => {
    const fixture = await project('many-links')
    const { readTaskSidebarSnapshot } = await import('@solus/server/tasks/task-sidebar')
    const { SolusServer } = await import('@solus/server/server/server')
    const { TEST_HANDLER_CTX } = await import('./helpers/handler-ctx')
    const server = new SolusServer()
    server.register('tasksSidebarSnapshot', readTaskSidebarSnapshot)
    const { getDb } = await import('@solus/server/db')
    expect(getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pr_snapshots'").all()).toEqual([])
    // One PR linked by many tasks is one host interest, never one request per row.
    for (let i = 0; i < 99; i++) {
      const created = await taskStore.createTask({ title: `Linked task ${i}`, status: 'todo' })
      await (await tasks.Task.byId(created.id)).linkPullRequest({
        number: 1, targetScope: fixture.projectScope,
        url: 'https://github.com/owner/many-links/pull/1',
      })
    }
    for (let client = 0; client < 3; client++) await server.handle('tasksSidebarSnapshot', [], TEST_HANDLER_CTX)
    expect(fixture.host.reads).toBe(0)
    await fixture.reconciler.poll()
    expect(fixture.host.reads).toBe(1)
    for (let reload = 0; reload < 10; reload++) {
      const snapshot = await server.handle('tasksSidebarSnapshot', [], TEST_HANDLER_CTX)
      const rows = Object.values(snapshot.prLinkListsByTask ?? {}).flat()
        .filter((link) => link.targetScope === fixture.projectScope)
      expect(rows).toHaveLength(100)
      expect(rows.every((link) => link.snapshot?.title === 'Saved PR')).toBe(true)
    }
    // Replacing the worker in the same host retains the shared memory cache.
    const restarted = new PrReconciler({
      announce: () => {}, discover: async () => {}, now: () => fixture.host.now,
      watchList: () => Array.from({ length: 100 }, () => ({ projectScope: fixture.projectScope, number: 1 })),
    })
    await restarted.poll()
    expect(fixture.host.reads).toBe(1)
    fixture.host.now += 60_001
    await Promise.all([restarted.poll(), restarted.poll()])
    expect(fixture.host.reads).toBe(2)
  })

  test('failed PR reads retain their cooldown across workers and leave a saved summary visible', async () => {
    const fixture = await project('failure-cooldown')
    const { getDb } = await import('@solus/server/db')
    const { readTaskPrLinks } = await import('@solus/server/tasks/task-links')
    await fixture.reconciler.poll()
    fixture.host.fail = true
    fixture.host.now += 60_001
    await fixture.reconciler.poll()
    expect(fixture.host.reads).toBe(2)
    // Replacing the worker in the same host retains the shared memory cache.
    const restarted = new PrReconciler({
      announce: () => {}, discover: async () => {}, now: () => fixture.host.now,
      watchList: () => [{ projectScope: fixture.projectScope, number: 1 }],
    })
    for (let i = 0; i < 3; i++) {
      await restarted.poll()
      expect(readTaskPrLinks(getDb())[fixture.task.id]?.[0]?.snapshot?.state).toBe('open')
    }
    expect(fixture.host.reads).toBe(2)
    fixture.host.now += 300_001
    fixture.host.fail = false
    await restarted.poll()
    expect(fixture.host.reads).toBe(3)
  })

  test('closed PRs can be reopened and are checked again at the slower cadence', async () => {
    const fixture = await project('reopened')
    fixture.host.state = 'closed'
    await fixture.reconciler.poll()
    fixture.host.state = 'open'
    fixture.host.now += 60_001
    await fixture.reconciler.poll()
    expect(fixture.host.reads).toBe(1)
    fixture.host.now += 15 * 60_000
    await fixture.reconciler.poll()
    expect(fixture.host.reads).toBe(2)
    expect(fixture.announced.at(-1)?.detail.state).toBe('open')
  })
})

test('an older worker response cannot replace a newer explicit PR update', async () => {
  const { prIndex } = await import('@solus/server/prs/pr-index')
  const repo = { host: 'github.com', owner: 'owner', repo: 'stale-worker' }
  const scope = 'github.com/owner/stale-worker'
  let resolveRead!: (pr: PullRequest) => void
  let started!: () => void
  const ready = new Promise<void>((resolve) => { started = resolve })
  const pending = new Promise<PullRequest>((resolve) => { resolveRead = resolve })
  const provider = { review: { getPullRequest: () => { started(); return pending } } } as unknown as Provider
  const worker = new PrReconciler({
    announce: () => {}, discover: async () => {},
    watchList: () => [{ projectScope: scope, number: 1 }],
    codeHost: async () => ({ repo, provider }),
  })
  const polling = worker.poll()
  await ready
  // A listing row that arrived while the worker's read was in flight, and is
  // newer than what that read will answer with.
  prIndex.pullRequest(repo, provider, 1).seed(pullRequestFixture(1, {
    baseRepo: repo, state: 'merged', updatedAt: '2026-01-02T00:00:00Z',
  }))
  resolveRead(pullRequestFixture(1, { baseRepo: repo, state: 'open', updatedAt: '2026-01-01T00:00:00Z' }))
  await polling
  expect(prIndex.lastRead(scope, 1)?.state).toBe('merged')
})

test('host branch discovery links local isolated attempts once per repository and branch', async () => {
  const { getDb } = await import('@solus/server/db')
  const { PrLinkDiscovery } = await import('@solus/server/prs/pr-link-discovery')
  const { readTaskPrLinks } = await import('@solus/server/tasks/task-links')
  const scope = 'github.com/owner/branch-discovery'
  let lists = 0
  providers.set('branch-discovery', { review: {
    listPullRequestsPage: async () => {
      lists++
      return { items: [pullRequestFixture(4, {
        baseRepo: { host: 'github.com', owner: 'owner', repo: 'branch-discovery' },
        url: 'https://github.com/owner/branch-discovery/pull/4', headRef: 'feature',
      })], page: 1, hasMore: false }
    },
  } } as unknown as Provider)
  const owners: string[] = []
  for (const [index, isolated] of [true, true, false, true].entries()) {
    const created = await taskStore.createTask({ title: 'Branch task', projectKey: scope, status: 'todo' })
    owners.push(created.id)
    getDb().prepare(`INSERT INTO sessions(session_id, provider, is_worktree, last_timestamp, message_count, size, branch)
      VALUES (?, 'codex', ?, ?, 0, 0, 'feature')`).run(`discovery-${index}`, isolated ? 1 : 0, Date.now())
    if (index === 3) getDb().prepare('UPDATE sessions SET server_id = ? WHERE session_id = ?').run('remote-host', `discovery-${index}`)
    await (await tasks.Task.byId(created.id)).linkSession(`discovery-${index}`, 'working', {})
  }
  const discovery = new PrLinkDiscovery()
  await discovery.poll()
  await discovery.poll()
  expect(lists).toBe(1)
  const links = readTaskPrLinks(getDb())
  expect(links[owners[0]!]?.[0]?.number).toBe(4)
  expect(links[owners[1]!]?.[0]?.number).toBe(4)
  expect(links[owners[2]!]).toBeUndefined()
  expect(links[owners[3]!]?.[0]?.number).toBe(4)
})

test('a missing PR is tried once across reloads; explicit reads bypass background cooldown', async () => {
  const fixture = await project('missing-pr')
  fixture.host.fail = true
  await fixture.reconciler.poll()
  const restarted = new PrReconciler({
    announce: () => {}, discover: async () => {}, now: () => fixture.host.now,
    watchList: () => [{ projectScope: fixture.projectScope, number: 1 }],
  })
  await restarted.poll()
  expect(fixture.host.reads).toBe(1)
  fixture.host.fail = false
  const { codeHostFor } = await import('@solus/server/prs/code-host')
  const { prIndex } = await import('@solus/server/prs/pr-index')
  const host = await codeHostFor(fixture.projectScope)
  expect(host).not.toBeNull()
  await prIndex.pullRequest(host!.repo, host!.provider, 1).read()
  expect(fixture.host.reads).toBe(2)
})

test('branch discovery discards ownership that changed while the provider read was pending', async () => {
  const { getDb } = await import('@solus/server/db')
  const { PrLinkDiscovery } = await import('@solus/server/prs/pr-link-discovery')
  const { readTaskPrLinks } = await import('@solus/server/tasks/task-links')
  const created = await taskStore.createTask({ title: 'Branch moved', projectKey: 'github.com/owner/moved-branch', status: 'todo' })
  getDb().prepare(`INSERT INTO sessions(session_id, provider, is_worktree, last_timestamp, message_count, size, branch)
    VALUES ('moved-session', 'claude', 1, ?, 0, 0, 'old')`).run(Date.now())
  await (await tasks.Task.byId(created.id)).linkSession('moved-session', 'working', {})
  let release!: () => void
  let started!: () => void
  const ready = new Promise<void>((resolve) => { started = resolve })
  const pending = new Promise<void>((resolve) => { release = resolve })
  providers.set('moved-branch', { review: {
    listPullRequestsPage: async () => {
      started()
      await pending
      return { items: [pullRequestFixture(9, {
        baseRepo: { host: 'github.com', owner: 'owner', repo: 'moved-branch' },
        url: 'https://github.com/owner/moved-branch/pull/9', headRef: 'old',
      })], page: 1, hasMore: false }
    },
  } } as unknown as Provider)
  const poll = new PrLinkDiscovery().poll()
  await ready
  getDb().prepare("UPDATE sessions SET branch = 'new' WHERE session_id = 'moved-session'").run()
  release()
  await poll
  expect(readTaskPrLinks(getDb())[created.id]).toBeUndefined()
})

test('a fresh merged summary from branch discovery completes work without another provider read', async () => {
  const fixture = await project('saved-merge')
  const { prIndex } = await import('@solus/server/prs/pr-index')
  const repo = { host: 'github.com', owner: 'owner', repo: 'saved-merge' }
  prIndex.pullRequest(repo, providers.get('saved-merge')!, 1).seed(pullRequestFixture(1, {
    state: 'merged', baseRepo: repo, updatedAt: new Date(Date.now() + 60_000).toISOString(),
  }))
  await fixture.reconciler.poll()
  expect(fixture.host.reads).toBe(0)
  expect((await tasks.Task.byId(fixture.task.id)).status).toBe('done')
})
