import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { PullRequest, RepoRef } from '@solus/contracts/providers'
import { pullRequestFixture } from './__fixtures__/pull-request'
import type { Provider } from '@solus/server/providers/types'

/** The person every change in this file is made by. */
const BY = { kind: 'user' as const, user: { id: { kind: 'account' as const, accountId: 'user-1' }, displayName: 'Test User' } }

/**
 * PR sync: the one host service that reads pull request state
 * (docs/plans/pr-sync.md).
 *
 * These tests pin the cost model as much as the behavior. A tick costs one
 * request per repository with live interest, whatever number of tasks link it;
 * a settled or missing pull request is not asked about again, also after a
 * restart. The startup storm that motivated the plan was the opposite of each.
 *
 * Each test names its own repository, because `PrIndex` is a process-wide cache.
 */

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

const providers = new Map<string, Provider>()
mock.module('@solus/server/providers/registry', () => ({
  providerForRepo: (repo: RepoRef) => providers.get(repo.repo) ?? null,
}))

let dataDir: string
let taskStore: typeof import('@solus/server/data/tasks/task-store')
let tasks: typeof import('@solus/server/data/tasks/task')
let links: typeof import('@solus/server/data/tasks/task-links')
let PrSync: typeof import('@solus/server/prs/pr-sync')['PrSync']
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-pr-sync-'))
  process.env.SOLUS_DATA_DIR = dataDir
  taskStore = await import('@solus/server/data/tasks/task-store')
  tasks = await import('@solus/server/data/tasks/task')
  links = await import('@solus/server/data/tasks/task-links')
  ;({ PrSync } = await import('@solus/server/prs/pr-sync'))
})

afterAll(async () => {
  (await import('@solus/server/db')).closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

/** A code host for one repository that answers with what the test last said,
 *  and counts every request, because the cost is part of what is tested. */
function codeHost(name: string) {
  const baseRepo = { host: 'github.com', owner: 'owner', repo: name }
  const host = {
    /** The rows the next recent-list read returns if they are newer than `since`. */
    rows: [] as PullRequest[],
    /** Numbers the host has; others are missing. */
    known: new Map<number, PullRequest>(),
    branchRows: [] as PullRequest[],
    recentReads: 0,
    numberReads: [] as number[][],
    branchReads: 0,
    fail: false,
  }
  providers.set(name, { review: {
    listRecentPullRequests: async (_repo: RepoRef, since: string | null) => {
      host.recentReads += 1
      if (host.fail) throw new Error('unreachable')
      return host.rows.filter((row) => since === null || row.updatedAt > since)
    },
    getPullRequests: async (_repo: RepoRef, numbers: number[]) => {
      host.numberReads.push(numbers)
      return new Map(numbers.map((number) => [number, host.known.get(number) ?? null]))
    },
    listPullRequestsPage: async () => {
      host.branchReads += 1
      return { items: host.branchRows, page: 1, hasMore: false }
    },
  } } as unknown as Provider)
  const pullRequest = (number: number, overrides: Partial<PullRequest> = {}) => pullRequestFixture(number, {
    baseRepo, url: `https://github.com/owner/${name}/pull/${number}`, ...overrides,
  })
  return { scope: `github.com/owner/${name}`, host, pullRequest }
}

async function taskLinking(scope: string, numbers: number[], status: 'todo' | 'in_review' = 'in_review') {
  const created = await taskStore.createTask('local', { title: 'Linked work', status: 'todo' })
  const task = await tasks.Task.byId('local', created.id)
  if (status !== 'todo') await task.update({ status }, BY)
  const [, owner, repo] = scope.split('/')
  for (const number of numbers) {
    await task.linkPullRequest({ number, targetScope: scope, url: `https://github.com/${owner}/${repo}/pull/${number}` }, BY)
  }
  return task
}

async function linksOf(taskId: string) {
  const { getDatabase } = await import('@solus/server/db/database')
  return (await links.readTaskPrLinks(getDatabase(), 'local'))[taskId] ?? []
}

const later = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString()

describe('cost', () => {
  test('a warm tick is one request per repository, however many tasks link it', async () => {
    const { scope, host, pullRequest } = codeHost('many-tasks')
    host.rows = [pullRequest(1, { updatedAt: later(1) })]
    for (let i = 0; i < 20; i++) await taskLinking(scope, [1])
    let now = Date.now()
    const sync = new PrSync({ publish: () => {}, now: () => now })

    await sync.tick()
    now += 60_001
    await sync.tick()

    expect(host.recentReads).toBe(2)
    expect(host.numberReads).toEqual([])
  })

  test('finished work makes no repository worth a tick', async () => {
    const { scope, host } = codeHost('finished-work')
    const task = await taskLinking(scope, [1])
    await task.update({ status: 'done' }, BY)

    await new PrSync({ publish: () => {} }).tick()

    expect(host.recentReads).toBe(0)
  })

  test('a repository that fails waits before it is asked again', async () => {
    const { scope, host } = codeHost('failing')
    await taskLinking(scope, [1])
    let now = Date.now()
    const sync = new PrSync({ publish: () => {}, now: () => now })
    host.fail = true

    await sync.tick()
    await sync.tick()
    expect(host.recentReads).toBe(1)

    now += 5 * 60_000 + 1
    await sync.tick()
    expect(host.recentReads).toBe(2)
  })
})

describe('missing pull requests', () => {
  test('are read in one batch, saved on the link, and not asked again after a restart', async () => {
    // WHY: links to numbers the repository does not have caused the repeated
    // 404s at startup. A missing number is an answer, not a failure.
    const { scope, host } = codeHost('missing-numbers')
    const task = await taskLinking(scope, [60, 65, 66])

    await new PrSync({ publish: () => {} }).tick()
    expect(host.numberReads).toEqual([[60, 65, 66]])
    expect((await linksOf(task.id)).every((link) => link.missing && !link.snapshot)).toBe(true)

    await new PrSync({ publish: () => {} }).tick()
    expect(host.numberReads).toHaveLength(1)
  })
})

describe('merges made outside Solus', () => {
  test('are announced once, saved on the link, and complete the waiting task', async () => {
    const { scope, host, pullRequest } = codeHost('merged-elsewhere')
    const task = await taskLinking(scope, [1])
    const announced: PullRequest[] = []
    let now = Date.now()
    const sync = new PrSync({ publish: (change) => { announced.push(...change.pullRequests) }, now: () => now })

    host.rows = [pullRequest(1, { updatedAt: later(1) })]
    await sync.tick()
    // With no client listening, a first sight is not news: nothing holds an older answer.
    expect(announced).toEqual([])

    host.rows = [pullRequest(1, { state: 'merged', updatedAt: later(2) })]
    now += 60_001
    await sync.tick()

    expect(announced.map((detail) => detail.state)).toEqual(['merged'])
    expect((await linksOf(task.id))[0]?.snapshot?.state).toBe('merged')
    expect((await tasks.Task.byId('local', task.id)).status).toBe('done')
  })

  test('complete a task on a later tick once its busy session settles, without another read', async () => {
    const { getDb } = await import('@solus/server/db')
    const { scope, host, pullRequest } = codeHost('busy-session')
    const task = await taskLinking(scope, [1])
    getDb().prepare(`INSERT INTO sessions(session_id, provider, is_worktree, last_timestamp, size)
      VALUES ('pr-sync-busy', 'claude', 0, ?, 0)`).run(Date.now())
    await task.linkSession('pr-sync-busy', 'working', {})
    const busy = new Set(['pr-sync-busy'])
    const sync = new PrSync({ publish: () => {}, isSessionBusy: (sessionId) => busy.has(sessionId) })
    host.rows = [pullRequest(1, { state: 'merged', updatedAt: later(1) })]

    await sync.tick()
    expect((await tasks.Task.byId('local', task.id)).status).toBe('in_review')

    busy.clear()
    await new PrSync({ publish: () => {} }).tick()
    expect((await tasks.Task.byId('local', task.id)).status).toBe('done')
    expect(host.numberReads).toEqual([])
  })

  test('complete a task only when every linked pull request is merged', async () => {
    const first = codeHost('first-repository')
    const second = codeHost('second-repository')
    const task = await taskLinking(first.scope, [1])
    await task.linkPullRequest({ number: 2, targetScope: second.scope, url: 'https://github.com/owner/second-repository/pull/2' }, BY)
    let now = Date.now()
    const sync = new PrSync({ publish: () => {}, now: () => now })

    first.host.rows = [first.pullRequest(1, { state: 'merged', updatedAt: later(1) })]
    second.host.rows = [second.pullRequest(2, { updatedAt: later(1) })]
    await sync.tick()
    expect((await tasks.Task.byId('local', task.id)).status).toBe('in_review')

    second.host.rows = [second.pullRequest(2, { state: 'merged', updatedAt: later(2) })]
    now += 60_001
    await sync.tick()
    expect((await tasks.Task.byId('local', task.id)).status).toBe('done')
  })
})

describe('branch discovery', () => {
  test('many unloaded worktrees share project data; unmatched branches wait for later rows, also after restart', async () => {
    const { getDb } = await import('@solus/server/db')
    const sessionPrs = await import('@solus/server/data/sessions/session-pull-requests')
    const { scope, host, pullRequest } = codeHost('stored-worktrees')
    let now = Date.now()
    for (let index = 0; index < 12; index++) {
      getDb().prepare(`INSERT INTO sessions(session_id, provider, is_worktree, last_timestamp, size, branch, cwd)
        VALUES (?, 'codex', 1, ?, 0, ?, ?)`).run(`stored-worktree-${index}`, now, `topic-${index}`, scope)
    }
    host.rows = [pullRequest(1, { headRef: 'topic-0', updatedAt: later(1) })]
    // This answer must never be requested: a missing branch in the loaded
    // rows is not a reason to ask GitHub about that worktree separately.
    host.branchRows = [pullRequest(2, { headRef: 'topic-1', updatedAt: later(2) })]
    const sync = new PrSync({ publish: () => {}, now: () => now })
    await sync.tick()
    expect(host.recentReads).toBe(1)
    expect(host.branchReads).toBe(0)
    expect((await sessionPrs.readSessionPullRequests('local', ['stored-worktree-0']))['stored-worktree-0'] ?? []).toEqual([
      expect.objectContaining({ number: 1, source: 'branch' }),
    ])
    expect((await sessionPrs.readSessionPullRequests('local', ['stored-worktree-1']))['stored-worktree-1'] ?? []).toEqual([])

    // Registering another unknown branch after the project loaded must not
    // schedule another repository read just to answer it.
    sync.setInterest('stored-client', {
      repo: { host: 'github.com', owner: 'owner', repo: 'stored-worktrees' },
      provider: providers.get('stored-worktrees')!,
    }, [{ kind: 'branch', head: 'topic-11' }])
    await sync.tick()
    expect(host.recentReads).toBe(1)
    host.rows.push(host.branchRows[0]!)
    now += 60_001
    await sync.tick()
    expect((await sessionPrs.readSessionPullRequests('local', ['stored-worktree-1']))['stored-worktree-1'] ?? []).toEqual([
      expect.objectContaining({ number: 2, source: 'branch' }),
    ])
    await new PrSync({ publish: () => {}, now: () => now }).tick()
    expect(host.branchReads).toBe(0)
  })

  test('links isolated attempts from loaded project rows without branch requests', async () => {
    const { getDb } = await import('@solus/server/db')
    const { scope, host, pullRequest } = codeHost('branch-discovery')
    host.rows = [pullRequest(4, { headRef: 'feature' })]
    const owners: string[] = []
    for (const [index, isolated] of [true, true, false].entries()) {
      const created = await taskStore.createTask('local', { title: 'Branch task', projectKey: scope, status: 'todo' })
      owners.push(created.id)
      getDb().prepare(`INSERT INTO sessions(session_id, provider, is_worktree, last_timestamp, size, branch)
        VALUES (?, 'codex', ?, ?, 0, 'feature')`).run(`pr-sync-branch-${index}`, isolated ? 1 : 0, Date.now())
      await (await tasks.Task.byId('local', created.id)).linkSession(`pr-sync-branch-${index}`, 'working', {})
    }
    let now = Date.now()
    const sync = new PrSync({ publish: () => {}, now: () => now })

    await sync.tick()
    now += 60_001
    await sync.tick()

    expect(host.branchReads).toBe(0)
    expect((await linksOf(owners[0]!))[0]?.number).toBe(4)
    expect((await linksOf(owners[1]!))[0]?.number).toBe(4)
    expect(await linksOf(owners[2]!)).toEqual([])
    // The session owns the link; the task reads it.
    expect((await linksOf(owners[0]!))[0]?.ownerSessionId).toBe('pr-sync-branch-0')
  })

  test('links the pull request of a session that has no task', async () => {
    // WHY: a session has a task only when it joins one, so most sessions have
    // none. Their pull request must still be found, watched and shown.
    const { getDb } = await import('@solus/server/db')
    const sessionPrs = await import('@solus/server/data/sessions/session-pull-requests')
    const { scope, host, pullRequest } = codeHost('taskless-session')
    host.rows = [pullRequest(9, { headRef: 'solo' })]
    getDb().prepare(`INSERT INTO sessions(session_id, provider, is_worktree, last_timestamp, size, branch, cwd)
      VALUES ('pr-sync-solo', 'codex', 1, ?, 0, 'solo', ?)`).run(Date.now(), scope)
    let now = Date.now()
    const sync = new PrSync({ publish: () => {}, now: () => now })

    await sync.tick()
    const linked = (await sessionPrs.readSessionPullRequests('local', ['pr-sync-solo']))['pr-sync-solo'] ?? []
    expect(linked).toEqual([expect.objectContaining({ number: 9, source: 'branch', repository: scope })])

    // A person removes it; the next ticks do not link it again.
    await sessionPrs.unlinkSessionPullRequest('pr-sync-solo', scope, 9)
    now += 60_001
    await new PrSync({ publish: () => {}, now: () => now }).tick()
    expect((await sessionPrs.readSessionPullRequests('local', ['pr-sync-solo']))['pr-sync-solo']).toBeUndefined()
  })

  test("a merged pull request of a task's session completes the task", async () => {
    // WHY: the task reads the link from its session and holds no copy, so the
    // merge must find the task through the session.
    const sessionPrs = await import('@solus/server/data/sessions/session-pull-requests')
    const { host, pullRequest } = codeHost('session-owned-merge')
    const created = await taskStore.createTask('local', { title: 'Owned by its session', status: 'todo' })
    const task = await tasks.Task.byId('local', created.id)
    await task.update({ status: 'in_review' }, BY)
    await task.linkSession('pr-sync-owner', 'working', {})
    await sessionPrs.linkSessionPullRequest('pr-sync-owner', {
      url: 'https://github.com/owner/session-owned-merge/pull/3', source: 'created', by: BY,
    })
    host.known.set(3, pullRequest(3, { state: 'merged', updatedAt: later(1) }))

    await new PrSync({ publish: () => {} }).tick()

    expect((await linksOf(created.id))[0]?.snapshot?.state).toBe('merged')
    expect((await tasks.Task.byId('local', created.id)).status).toBe('done')
  })
})

describe('a session with no task', () => {
  test('is watched until it is settled, and its merged pull request settles it', async () => {
    // WHY: most sessions have no task. Their pull request must stay current
    // for as long as the session is live work, however old the link is, and
    // the merge is what ends that work.
    const sessionPrs = await import('@solus/server/data/sessions/session-pull-requests')
    const states = await import('@solus/server/data/sessions/session-states')
    const { getDatabase } = await import('@solus/server/db/database')
    const { sql } = await import('drizzle-orm')
    const { host, pullRequest } = codeHost('solo-watch')
    await sessionPrs.linkSessionPullRequest('pr-sync-watch', { url: 'https://github.com/owner/solo-watch/pull/4', source: 'manual', by: BY })
    await getDatabase().run(sql`UPDATE session_pull_requests SET linked_at = 1 WHERE session_id = 'pr-sync-watch'`)
    host.known.set(4, pullRequest(4))
    let now = Date.now()

    await new PrSync({ publish: () => {}, now: () => now }).tick()
    expect(host.numberReads).toEqual([[4]])
    expect((await states.readSessionShelf('local', ['pr-sync-watch']))).toEqual([])

    host.rows = [pullRequest(4, { state: 'merged', updatedAt: later(1) })]
    now += 60_001
    const sync = new PrSync({ publish: () => {}, now: () => now })
    await sync.tick()
    expect((await sessionPrs.readSessionPullRequests('local', ['pr-sync-watch']))['pr-sync-watch']?.[0]?.snapshot?.state).toBe('merged')
    expect((await states.readSessionShelf('local', ['pr-sync-watch']))[0]).toMatchObject({ settledBy: 'pull-request' })

    // A settled session is not live work: its repository is not read again.
    const reads = host.recentReads
    now += 60_001
    await sync.tick()
    expect(host.recentReads).toBe(reads)
  })
})

test('a tick row never replaces a newer answer another read already holds', async () => {
  const { prIndex } = await import('@solus/server/prs/pr-index')
  const { scope, host, pullRequest } = codeHost('newer-answer')
  await taskLinking(scope, [1])
  const repo = { host: 'github.com', owner: 'owner', repo: 'newer-answer' }
  prIndex.pullRequest(repo, providers.get('newer-answer')!, 1)
    .seed(pullRequest(1, { state: 'merged', updatedAt: later(5) }))
  host.rows = [pullRequest(1, { updatedAt: later(1) })]

  await new PrSync({ publish: () => {} }).tick()

  expect(prIndex.lastRead(scope, 1)?.state).toBe('merged')
})

describe('client interest', () => {
  const owner = 'client-a'
  const hostOf = (name: string) => ({
    repo: { host: 'github.com', owner: 'owner', repo: name },
    provider: providers.get(name)!,
  })

  test('many clients on one repository cost one request per tick, and a closed connection stops it', async () => {
    const { host, pullRequest } = codeHost('client-cost')
    host.rows = [pullRequest(7, { updatedAt: later(1) })]
    let now = Date.now()
    const changes: string[] = []
    const sync = new PrSync({ publish: (change) => { changes.push(change.repo) }, now: () => now })

    for (const client of ['a', 'b', 'c']) sync.setInterest(client, hostOf('client-cost'), [{ kind: 'pull-request', number: 7 }])
    await sync.tick()
    expect(host.recentReads).toBe(1)
    expect(changes).toEqual(['github.com/owner/client-cost'])

    for (const client of ['a', 'b', 'c']) sync.dropConnection(client)
    now += 60_001
    await sync.tick()
    expect(host.recentReads).toBe(1)
  })

  test('answers a branch from the loaded project rows', async () => {
    const { host, pullRequest } = codeHost('client-branch')
    host.rows = [pullRequest(3, { headRef: 'topic' })]
    const published: number[] = []
    const sync = new PrSync({ publish: (change) => { published.push(...change.pullRequests.map(({ number }) => number)) } })

    const first = sync.setInterest(owner, hostOf('client-branch'), [{ kind: 'branch', head: 'topic' }])
    expect(first.pullRequests).toEqual([])
    await sync.tick()
    expect(published).toContain(3)

    const second = sync.setInterest(owner, hostOf('client-branch'), [{ kind: 'branch', head: 'topic' }])
    expect(second.pullRequests.map(({ number }) => number)).toEqual([3])
    expect(host.branchReads).toBe(0)
  })

  test('an open review pane reads check runs and ticks faster', async () => {
    const { host, pullRequest } = codeHost('client-review')
    host.rows = [pullRequest(5, { updatedAt: later(1) })]
    let checkReads = 0
    const review = providers.get('client-review')!.review as unknown as { listChecks: (repo: RepoRef, numbers: number[]) => Promise<unknown> }
    review.listChecks = async (_repo, numbers) => {
      checkReads += 1
      return numbers.map((number) => ({ number, summary: { state: 'passing', inFlight: false, total: 1, passed: 1, failed: 0, pending: 0, runs: [] } }))
    }
    let now = Date.now()
    const checks: number[] = []
    const sync = new PrSync({ publish: (change) => { checks.push(...change.checks.map(({ number }) => number)) }, now: () => now })

    sync.setInterest(owner, hostOf('client-review'), [{ kind: 'review', number: 5 }])
    await sync.tick()
    now += 15_001
    await sync.tick()

    expect(checkReads).toBe(2)
    // Unchanged check runs are not sent again.
    expect(checks).toEqual([5])
  })
})

test('a write reaches clients and the task links without a read', async () => {
  const { scope, host, pullRequest } = codeHost('write-apply')
  const task = await taskLinking(scope, [2])
  const published: string[] = []
  const sync = new PrSync({ publish: (change) => { published.push(...change.pullRequests.map(({ state }) => state)) } })

  await sync.apply({ repo: { host: 'github.com', owner: 'owner', repo: 'write-apply' }, provider: providers.get('write-apply')! },
    pullRequest(2, { state: 'closed', updatedAt: later(1) }))

  expect(published).toEqual(['closed'])
  expect((await linksOf(task.id))[0]?.snapshot?.state).toBe('closed')
  expect(host.recentReads).toBe(0)
})
