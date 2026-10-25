import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from './helpers/bun-sqlite'
import type { PrSyncChange, PullRequest, PullRequestOverview, RepoRef } from '@solus/contracts/providers'
import { pullRequestFixture } from './__fixtures__/pull-request'
import type { Provider } from '@solus/server/providers/types'
import { GitHubRateLimitedError } from '@solus/server/providers/github/rate-limit'
import { actAsHostForTests } from '@solus/server/execution/seats/acting-identity'

/** The person every change in this file is made by. */
const BY = { kind: 'user' as const, user: { id: { kind: 'account' as const, accountId: 'user-1' }, displayName: 'Test User' } }

/**
 * PR sync: the one host service that reads pull request state
 * (docs/plans/pr-sync.md).
 *
 * These tests pin the cost model as much as the behavior. A tick reads the
 * open pull requests live work links by number, whatever number of tasks link
 * them; a branch is looked up by name only while it has no open pull request,
 * and only when that is due; a settled or missing pull request is not asked
 * about again, also after a restart. The startup storm that motivated the plan
 * was the opposite of each.
 *
 * Each test names its own repository, because `PrIndex` is a process-wide cache.
 */

mock.module('node:sqlite', () => ({ DatabaseSync }))

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
    /** The pull requests the host has, by number; others are missing. A
     *  branch lookup answers from these by `headRef`, newest first. */
    known: new Map<number, PullRequest>(),
    numberReads: [] as number[][],
    /** The branches of each lookup. */
    branchLookups: [] as string[][],
    fail: false,
    /** The next reads answer with this rate limit. */
    limited: null as GitHubRateLimitedError | null,
  }
  const answer = () => {
    if (host.fail) throw new Error('unreachable')
    if (host.limited) throw host.limited
  }
  providers.set(name, { review: {
    getPullRequestsByHead: async (_repo: RepoRef, heads: string[]) => {
      host.branchLookups.push(heads)
      answer()
      const newestFirst = [...host.known.values()].sort((a, b) => b.number - a.number)
      return new Map(heads.map((head) => [head, newestFirst.filter((row) => row.headRef === head)]))
    },
    getPullRequests: async (_repo: RepoRef, numbers: number[]) => {
      host.numberReads.push(numbers)
      answer()
      return new Map(numbers.map((number) => [number, host.known.get(number) ?? null]))
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

/** An indexed session that runs in its own worktree on `branch`. */
async function worktreeSession(sessionId: string, branch: string, scope: string) {
  const { getDb } = await import('@solus/server/db')
  getDb().prepare(`INSERT INTO sessions(session_id, provider, is_worktree, last_timestamp, size, branch, cwd)
    VALUES (?, 'codex', 1, ?, 0, ?, ?)`).run(sessionId, Date.now(), branch, scope)
}

async function sessionLinks(sessionId: string) {
  const sessionPrs = await import('@solus/server/data/sessions/session-pull-requests')
  return (await sessionPrs.readSessionPullRequests('local', [sessionId]))[sessionId] ?? []
}

const later = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString()

// The helpers under test start processes; with no caller, they act as the host (plans/019).
actAsHostForTests()

describe('cost', () => {
  test('a warm tick reads the open pull requests live work links by number, however many tasks link them', async () => {
    const { scope, host, pullRequest } = codeHost('many-tasks')
    host.known.set(1, pullRequest(1))
    for (let i = 0; i < 20; i++) await taskLinking(scope, [1])
    let now = Date.now()
    const sync = new PrSync({ publish: () => {}, now: () => now })

    await sync.tick()
    now += 60_001
    await sync.tick()

    expect(host.numberReads).toEqual([[1], [1]])
    expect(host.branchLookups).toEqual([])
  })

  test('sessions on three repositories whose branches are matched cost no branch lookup, only reads by number', async () => {
    // WHY: the recent-list poll read every repository with interest each
    // minute. A branch that has its open pull request needs no lookup: the
    // read by number keeps that pull request fresh.
    const names = ['matched-a', 'matched-b', 'matched-c']
    const hosts = names.map((name) => codeHost(name))
    for (const [index, { scope, host, pullRequest }] of hosts.entries()) {
      host.known.set(1, pullRequest(1, { headRef: `matched-${index}` }))
      await worktreeSession(`matched-session-${index}`, `matched-${index}`, scope)
    }
    let now = Date.now()
    const sync = new PrSync({ publish: () => {}, now: () => now })
    await sync.tick()
    expect(hosts.map(({ host }) => host.branchLookups)).toEqual(names.map((_, index) => [[`matched-${index}`]]))

    for (let tick = 0; tick < 6; tick++) {
      now += 60_001
      await sync.tick()
    }

    expect(hosts.map(({ host }) => host.branchLookups.length)).toEqual([1, 1, 1])
    expect(hosts.map(({ host }) => host.numberReads)).toEqual(names.map(() => Array.from({ length: 6 }, () => [1])))
  })

  test('finished work makes no repository worth a tick', async () => {
    const { scope, host } = codeHost('finished-work')
    const task = await taskLinking(scope, [1])
    await task.update({ status: 'done' }, BY)

    await new PrSync({ publish: () => {} }).tick()

    expect(host.numberReads).toEqual([])
    expect(host.branchLookups).toEqual([])
  })

  test('a repository that fails waits before it is asked again', async () => {
    const { scope, host } = codeHost('failing')
    await taskLinking(scope, [1])
    let now = Date.now()
    const sync = new PrSync({ publish: () => {}, now: () => now })
    host.fail = true

    await sync.tick()
    await sync.tick()
    expect(host.numberReads).toHaveLength(1)

    now += 5 * 60_000 + 1
    await sync.tick()
    expect(host.numberReads).toHaveLength(2)
  })
})

describe('closed pull requests', () => {
  test('are read by number every 15 minutes, not every minute; a merged one is never read again', async () => {
    // WHY: a closed pull request can open again, so it is not settled for
    // good, but it changes rarely: reading it each minute spent the quota.
    const { scope, host, pullRequest } = codeHost('closed-cadence')
    host.known.set(1, pullRequest(1, { state: 'closed' }))
    host.known.set(2, pullRequest(2, { state: 'merged' }))
    await taskLinking(scope, [1, 2])
    let now = Date.now()
    const sync = new PrSync({ publish: () => {}, now: () => now })

    await sync.tick()
    expect(host.numberReads).toEqual([[1, 2]])

    // Fourteen minutes of ticks read nothing.
    for (let tick = 0; tick < 14; tick++) {
      now += 60_001
      await sync.tick()
    }
    expect(host.numberReads).toHaveLength(1)

    now += 60_001
    await sync.tick()
    expect(host.numberReads).toEqual([[1, 2], [1]])
  })

  test('one that opens again is read every minute after, and its branch prefers it', async () => {
    const { scope, host, pullRequest } = codeHost('closed-reopened')
    await worktreeSession('closed-reopened-session', 'again', scope)
    host.known.set(1, pullRequest(1, { headRef: 'again', state: 'closed' }))
    let now = Date.now()
    const sync = new PrSync({ publish: () => {}, now: () => now })

    // The lookup finds the closed pull request; then someone opens it again.
    await sync.tick()
    host.known.set(1, pullRequest(1, { headRef: 'again', state: 'open', updatedAt: later(1) }))
    now += 15 * 60_000 + 1
    await sync.tick()
    const reads = host.numberReads.length
    expect(host.numberReads.at(-1)).toEqual([1])

    now += 60_001
    await sync.tick()
    expect(host.numberReads).toHaveLength(reads + 1)
    expect(host.numberReads.at(-1)).toEqual([1])
    expect(sync.setInterest('closed-reopened-client', { repo: { host: 'github.com', owner: 'owner', repo: 'closed-reopened' }, provider: providers.get('closed-reopened')! },
      [{ kind: 'branch', head: 'again' }]).pullRequests.map(({ number, state }) => [number, state])).toEqual([[1, 'open']])
    // A matched open pull request needs no lookup.
    expect(host.branchLookups).toEqual([['again']])
  })
})

describe('needs review', () => {
  const repoOf = (name: string) => ({ host: 'github.com', owner: 'owner', repo: name })
  /** A code host that also answers who the viewer is and what waits on them. */
  function reviewHost(name: string) {
    const made = codeHost(name)
    const waiting = [made.pullRequest(8, { author: 'someone', requestedReviewers: [{ login: 'me' }] })]
    const reads = { needsReview: 0 }
    Object.assign(providers.get(name)!.review, {
      getViewer: async () => 'me',
      listPullRequestsNeedingReview: async () => {
        reads.needsReview += 1
        return waiting
      },
      listPullRequestPages: async (requests: unknown[]) => requests.map(() => ({
        page: { items: [], page: 1, hasMore: false }, authored: { items: [], page: 1, hasMore: false }, needsReview: waiting,
      })),
    })
    return { ...made, waiting, reads }
  }

  test('is asked once when a client first wants it, never on a clock', async () => {
    // WHY: a search every five minutes per repository spent the quota while
    // nothing changed. A list read answers the same question for free.
    const { reads } = reviewHost('needs-review-clock')
    let now = Date.now()
    const changes: PrSyncChange[] = []
    const sync = new PrSync({ publish: (change) => { changes.push(change) }, now: () => now })

    sync.setInterest('client', { repo: repoOf('needs-review-clock'), provider: providers.get('needs-review-clock')! }, [{ kind: 'needs-review' }])
    await sync.tick()
    expect(reads.needsReview).toBe(1)
    expect(changes.find((change) => change.needsReview)?.needsReview).toEqual([8])

    for (let tick = 0; tick < 60; tick++) {
      now += 60_001
      await sync.tick()
    }
    expect(reads.needsReview).toBe(1)
  })

  test("reaches clients and the notifications hub from a list read's review-requested rows", async () => {
    const { prIndex } = await import('@solus/server/prs/pr-index')
    const { reads, waiting } = reviewHost('needs-review-list')
    const provider = providers.get('needs-review-list')!
    const changes: PrSyncChange[] = []
    const observed: number[][] = []
    const sync = new PrSync({
      publish: (change) => { changes.push(change) },
      observeNeedingAttention: async (_repo, _viewer, rows) => { observed.push(rows.map(({ number }) => number)) },
    })
    sync.start()
    try {
      // A client that holds the repository, for a pull request it shows.
      sync.setInterest('client', { repo: repoOf('needs-review-list'), provider }, [{ kind: 'pull-request', number: 8 }])
      await sync.tick()
      waiting.push(pullRequestFixture(9, {
        baseRepo: repoOf('needs-review-list'), author: 'someone', assignees: ['me'],
      }))
      const pages = await prIndex.listPages(provider, [{ repo: repoOf('needs-review-list'), page: 1, cursor: null }], 'me', undefined)
      await pages.get('github.com/owner/needs-review-list')?.needsReview
    } finally {
      sync.stop()
    }

    expect(reads.needsReview).toBe(0)
    expect(observed).toEqual([[8, 9]])
    expect(changes.find((change) => change.needsReview)?.needsReview).toEqual([8, 9])
    // A client that asks later is answered from it, with no read.
    expect(sync.setInterest('later', { repo: repoOf('needs-review-list'), provider }, [{ kind: 'needs-review' }]).needsReview).toEqual([8, 9])
  })
})

describe('rate limits', () => {
  test('a rate-limited repository, and every repository on its code host, waits until the reset time', async () => {
    const first = codeHost('limited-a')
    const second = codeHost('limited-b')
    await taskLinking(first.scope, [1])
    await taskLinking(second.scope, [1])
    let now = Date.now()
    const retryAt = now + 20 * 60_000
    first.host.limited = new GitHubRateLimitedError(retryAt)
    second.host.limited = new GitHubRateLimitedError(retryAt)
    const sync = new PrSync({ publish: () => {}, now: () => now })

    await sync.tick()
    // The reads by number go at once, so on GitHub they are one shared
    // document (github-host-batches.test.ts), and that one request finds the
    // spent quota.
    expect([first.host.numberReads.length, second.host.numberReads.length]).toEqual([1, 1])

    // Past the fixed failure backoff, still before the reset GitHub gave.
    now += 10 * 60_000
    await sync.tick()
    expect(first.host.numberReads.length + second.host.numberReads.length).toBe(2)

    first.host.limited = null
    second.host.limited = null
    now = retryAt
    await sync.tick()
    expect([first.host.numberReads.length, second.host.numberReads.length]).toEqual([2, 2])
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

describe('host-wide documents', () => {
  test('the reads by number of every repository go at once, so they can share one document', async () => {
    // WHY: the provider gathers reads of one account for a short window
    // (host-batches.ts). Reads made one repository after another never meet,
    // and each costs a document of its own.
    const names = ['together-a', 'together-b', 'together-c']
    let inFlight = 0
    let mostInFlight = 0
    for (const name of names) {
      const { scope } = codeHost(name)
      await taskLinking(scope, [9])
      const review = providers.get(name)!.review as unknown as { getPullRequests: (repo: RepoRef, numbers: number[]) => Promise<Map<number, null>> }
      review.getPullRequests = async (_repo, numbers) => {
        mostInFlight = Math.max(mostInFlight, ++inFlight)
        await new Promise((resolve) => setTimeout(resolve, 5))
        inFlight -= 1
        return new Map(numbers.map((number) => [number, null]))
      }
    }

    await new PrSync({ publish: () => {} }).tick()

    expect(mostInFlight).toBe(3)
  })
})

describe('merges made outside Solus', () => {
  test('are announced once, saved on the link, and complete the waiting task', async () => {
    const { scope, host, pullRequest } = codeHost('merged-elsewhere')
    const task = await taskLinking(scope, [1])
    const announced: PullRequest[] = []
    let now = Date.now()
    const sync = new PrSync({ publish: (change) => { announced.push(...change.pullRequests) }, now: () => now })

    host.known.set(1, pullRequest(1, { updatedAt: later(1) }))
    await sync.tick()
    // With no client listening, a first sight is not news: nothing holds an older answer.
    expect(announced).toEqual([])

    host.known.set(1, pullRequest(1, { state: 'merged', updatedAt: later(2) }))
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
    host.known.set(1, pullRequest(1, { state: 'merged', updatedAt: later(1) }))

    await sync.tick()
    expect((await tasks.Task.byId('local', task.id)).status).toBe('in_review')

    busy.clear()
    await new PrSync({ publish: () => {} }).tick()
    expect((await tasks.Task.byId('local', task.id)).status).toBe('done')
    expect(host.numberReads).toEqual([[1]])
  })

  test('complete a task only when every linked pull request is merged', async () => {
    const first = codeHost('first-repository')
    const second = codeHost('second-repository')
    const task = await taskLinking(first.scope, [1])
    await task.linkPullRequest({ number: 2, targetScope: second.scope, url: 'https://github.com/owner/second-repository/pull/2' }, BY)
    let now = Date.now()
    const sync = new PrSync({ publish: () => {}, now: () => now })

    first.host.known.set(1, first.pullRequest(1, { state: 'merged', updatedAt: later(1) }))
    second.host.known.set(2, second.pullRequest(2, { updatedAt: later(1) }))
    await sync.tick()
    expect((await tasks.Task.byId('local', task.id)).status).toBe('in_review')

    second.host.known.set(2, second.pullRequest(2, { state: 'merged', updatedAt: later(2) }))
    now += 60_001
    await sync.tick()
    expect((await tasks.Task.byId('local', task.id)).status).toBe('done')
  })

  test('seen by another read path reach the links at once, after PR sync reads them itself', async () => {
    // WHY: a review pane's fresh read showed "Merged" while the task, the
    // session link and other clients waited for the next read by number, up
    // to a minute. The other answer is not trusted: PR sync reads the number again.
    const { prIndex } = await import('@solus/server/prs/pr-index')
    const { scope, host, pullRequest } = codeHost('heard-merge')
    const task = await taskLinking(scope, [1])
    const repo = { host: 'github.com', owner: 'owner', repo: 'heard-merge' }
    const provider = providers.get('heard-merge')!
    let paneAnswer = pullRequest(1, { updatedAt: later(1) })
    ;(provider.review as unknown as { getPullRequestOverview: () => Promise<PullRequestOverview> }).getPullRequestOverview = async () =>
      ({ pullRequest: paneAnswer, commits: [], reviewers: [] })
    const announced: string[] = []
    const now = Date.now()
    const sync = new PrSync({ publish: (change) => { announced.push(...change.pullRequests.map(({ state }) => state)) }, now: () => now })
    sync.start()
    try {
      host.known.set(1, pullRequest(1, { updatedAt: later(1) }))
      await sync.tick()

      // The same state costs nothing.
      await prIndex.pullRequest(repo, provider, 1).readFresh()
      await sync.tick()
      expect(host.numberReads).toEqual([[1]])

      paneAnswer = pullRequest(1, { state: 'merged', updatedAt: later(2) })
      host.known.set(1, paneAnswer)
      await prIndex.pullRequest(repo, provider, 1).readFresh()
      await sync.tick()
    } finally {
      sync.stop()
    }

    expect(host.numberReads).toEqual([[1], [1]])
    expect(announced).toEqual(['merged'])
    expect((await linksOf(task.id))[0]?.snapshot?.state).toBe('merged')
    expect((await tasks.Task.byId('local', task.id)).status).toBe('done')
  })
})

describe('branch discovery', () => {
  test('unmatched branches are looked up together once, then only on a turn end of their session or a refresh', async () => {
    // WHY: a branch's pull request is opened by its agent, so the turn end is
    // when one can appear. A clock that asked about every branch, each minute
    // and later each five minutes, spent the account's quota on branches that
    // have none.
    const { scope, host, pullRequest } = codeHost('stored-worktrees')
    let now = Date.now()
    for (let index = 0; index < 12; index++) await worktreeSession(`stored-worktree-${index}`, `topic-${index}`, scope)
    host.known.set(1, pullRequest(1, { headRef: 'topic-0' }))
    const published: PrSyncChange[] = []
    const sync = new PrSync({ publish: (change) => { published.push(change) }, now: () => now, sessionCheckout: () => scope })

    await sync.tick()
    expect(host.branchLookups).toHaveLength(1)
    expect(new Set(host.branchLookups[0])).toEqual(new Set(Array.from({ length: 12 }, (_, index) => `topic-${index}`)))
    expect(await sessionLinks('stored-worktree-0')).toEqual([expect.objectContaining({ number: 1, source: 'branch' })])
    expect(await sessionLinks('stored-worktree-1')).toEqual([])

    // An hour of ticks asks about no branch again.
    for (let tick = 0; tick < 60; tick++) {
      now += 60_001
      await sync.tick()
    }
    expect(host.branchLookups).toHaveLength(1)

    // The agent of one session opens a pull request; its turn end asks about its branch alone.
    host.known.set(2, pullRequest(2, { headRef: 'topic-1' }))
    await sync.turnEnded('stored-worktree-1')
    await sync.tick()
    expect(host.branchLookups.slice(1)).toEqual([['topic-1']])
    expect(await sessionLinks('stored-worktree-1')).toEqual([expect.objectContaining({ number: 2, source: 'branch' })])
    expect(published).toContainEqual(expect.objectContaining({ repo: scope, listChanged: true }))

    // No safety net: another hour asks about none of the ten that still have none.
    for (let tick = 0; tick < 60; tick++) {
      now += 60_001
      await sync.tick()
    }
    expect(host.branchLookups).toHaveLength(2)

    // A person's refresh asks about the ten branches that still have none.
    sync.refresh({ repo: { host: 'github.com', owner: 'owner', repo: 'stored-worktrees' }, provider: providers.get('stored-worktrees')! })
    await sync.tick()
    expect(host.branchLookups).toHaveLength(3)
    expect(host.branchLookups[2]).toHaveLength(10)
    expect(host.branchLookups[2]).not.toContain('topic-0')
    expect(host.branchLookups[2]).not.toContain('topic-1')
  })

  test('a branch whose pull request closed is looked up again on a turn end, and the new open one wins', async () => {
    const { scope, host, pullRequest } = codeHost('reopened-branch')
    await worktreeSession('reopened-session', 'retry', scope)
    host.known.set(3, pullRequest(3, { headRef: 'retry', state: 'closed' }))
    const sync = new PrSync({ publish: () => {}, sessionCheckout: () => scope })

    await sync.tick()
    host.known.set(4, pullRequest(4, { headRef: 'retry' }))
    await sync.turnEnded('reopened-session')
    await sync.tick()

    expect(host.branchLookups).toEqual([['retry'], ['retry']])
    expect((await sessionLinks('reopened-session')).map(({ number }) => number).sort()).toEqual([3, 4])
  })

  test('links every attempt on the branch from one lookup, in a worktree or on the shared checkout', async () => {
    // WHY: a session on the shared checkout works on its branch's pull request
    // as much as one in its own worktree. Only the branch the session last ran
    // on decides, as a thread's branch does in T3 Code.
    const { getDb } = await import('@solus/server/db')
    const { scope, host, pullRequest } = codeHost('branch-discovery')
    host.known.set(4, pullRequest(4, { headRef: 'feature' }))
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

    expect(host.branchLookups).toEqual([['feature']])
    expect((await linksOf(owners[0]!))[0]?.number).toBe(4)
    expect((await linksOf(owners[1]!))[0]?.number).toBe(4)
    expect((await linksOf(owners[2]!))[0]?.number).toBe(4)
    // The session owns the link; the task reads it.
    expect((await linksOf(owners[0]!))[0]?.ownerSessionId).toBe('pr-sync-branch-0')
  })

  test('links the pull request of a session that has no task', async () => {
    // WHY: a session has a task only when it joins one, so most sessions have
    // none. Their pull request must still be found, watched and shown.
    const sessionPrs = await import('@solus/server/data/sessions/session-pull-requests')
    const { scope, host, pullRequest } = codeHost('taskless-session')
    host.known.set(9, pullRequest(9, { headRef: 'solo' }))
    await worktreeSession('pr-sync-solo', 'solo', scope)
    let now = Date.now()
    const sync = new PrSync({ publish: () => {}, now: () => now })

    await sync.tick()
    expect(await sessionLinks('pr-sync-solo')).toEqual([expect.objectContaining({ number: 9, source: 'branch', repository: scope })])

    // A person removes it; the next ticks do not link it again.
    await sessionPrs.unlinkSessionPullRequest('pr-sync-solo', scope, 9)
    now += 60_001
    await new PrSync({ publish: () => {}, now: () => now }).tick()
    expect(await sessionLinks('pr-sync-solo')).toEqual([])
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
    expect((await new states.SessionShelf('pr-sync-watch').state()).settledAt).toBeNull()

    host.known.set(4, pullRequest(4, { state: 'merged', updatedAt: later(1) }))
    now += 60_001
    const sync = new PrSync({ publish: () => {}, now: () => now })
    await sync.tick()
    expect((await sessionPrs.readSessionPullRequests('local', ['pr-sync-watch']))['pr-sync-watch']?.[0]?.snapshot?.state).toBe('merged')
    expect(await new states.SessionShelf('pr-sync-watch').state()).toMatchObject({ settledBy: 'pull-request' })

    // A settled session is not live work: its repository is not read again.
    const reads = host.numberReads.length
    now += 60_001
    await sync.tick()
    expect(host.numberReads).toHaveLength(reads)
  })
})

test('a tick row never replaces a newer answer another read already holds', async () => {
  const { prIndex } = await import('@solus/server/prs/pr-index')
  const { scope, host, pullRequest } = codeHost('newer-answer')
  await taskLinking(scope, [1])
  const repo = { host: 'github.com', owner: 'owner', repo: 'newer-answer' }
  prIndex.pullRequest(repo, providers.get('newer-answer')!, 1)
    .seed(pullRequest(1, { state: 'merged', updatedAt: later(5) }))
  host.known.set(1, pullRequest(1, { updatedAt: later(1) }))

  await new PrSync({ publish: () => {} }).tick()

  expect(prIndex.lastRead(scope, 1)?.state).toBe('merged')
})

describe('base branch rules', () => {
  // WHY: a PR sync row is read without the base branch's rules, and a client
  // replaces the pull request its open detail shows with a pushed row. The
  // row must keep what the detail read narrowed, or the merge menu offers a
  // method the branch forbids and the approval count goes away.
  const narrowed = (capabilities: PullRequest['capabilities']): PullRequest['capabilities'] =>
    ({ ...capabilities, mergeMethods: ['squash'], defaultMergeMethod: 'squash' })

  test("a row of a pull request whose detail the server holds keeps the detail's merge methods and approval count", async () => {
    const { prIndex } = await import('@solus/server/prs/pr-index')
    const { host, pullRequest } = codeHost('held-detail')
    const repo = { host: 'github.com', owner: 'owner', repo: 'held-detail' }
    const detail = pullRequest(4, { requiredApprovingReviewCount: 2 })
    prIndex.pullRequest(repo, providers.get('held-detail')!, 4)
      .seed({ ...detail, capabilities: narrowed(detail.capabilities) })
    const row = pullRequest(4, { title: 'Renamed', updatedAt: later(1) })
    host.known.set(4, { ...row, capabilities: { ...row.capabilities, defaultMergeMethod: 'merge' } })
    const published: PullRequest[] = []
    const sync = new PrSync({ publish: (change) => { published.push(...change.pullRequests) } })

    sync.setInterest('client-a', { repo, provider: providers.get('held-detail')! }, [{ kind: 'pull-request', number: 4 }])
    await sync.tick()

    const shown = published.find(({ number }) => number === 4)
    expect(shown?.title).toBe('Renamed')
    expect(shown?.capabilities.mergeMethods).toEqual(['squash'])
    expect(shown?.capabilities.defaultMergeMethod).toBe('squash')
    expect(shown?.requiredApprovingReviewCount).toBe(2)
    expect(prIndex.lastRead('github.com/owner/held-detail', 4)?.capabilities.mergeMethods).toEqual(['squash'])
  })

  test('a row of a pull request with no held detail keeps the repository methods, and a detail read follows', async () => {
    const { prIndex } = await import('@solus/server/prs/pr-index')
    const { host, pullRequest } = codeHost('no-detail')
    const repo = { host: 'github.com', owner: 'owner', repo: 'no-detail' }
    host.known.set(5, pullRequest(5, { updatedAt: later(1) }))
    const published: PullRequest[] = []
    const sync = new PrSync({ publish: (change) => { published.push(...change.pullRequests) } })
    let detailReads = 0
    const review = providers.get('no-detail')!.review as unknown as { getPullRequestOverview: () => Promise<PullRequestOverview> }
    review.getPullRequestOverview = async () => {
      detailReads += 1
      const detail = pullRequest(5, { updatedAt: later(1), requiredApprovingReviewCount: 1 })
      return { pullRequest: { ...detail, capabilities: narrowed(detail.capabilities) }, commits: [], reviewers: [] }
    }

    sync.setInterest('client-a', { repo, provider: providers.get('no-detail')! }, [{ kind: 'pull-request', number: 5 }])
    await sync.tick()
    expect(published.find(({ number }) => number === 5)?.capabilities.mergeMethods).toEqual(['merge', 'squash', 'rebase'])

    // A client opens a detail with this read. The row PR sync just seeded is
    // not a detail, so it is not the answer.
    const opened = await prIndex.pullRequest(repo, providers.get('no-detail')!, 5).overview()
    expect(detailReads).toBe(1)
    expect(opened.pullRequest.capabilities.mergeMethods).toEqual(['squash'])
  })
})

describe('client interest', () => {
  const owner = 'client-a'
  const hostOf = (name: string) => ({
    repo: { host: 'github.com', owner: 'owner', repo: name },
    provider: providers.get(name)!,
  })

  test('many clients on one repository cost one request per tick, and a closed connection stops it', async () => {
    const { host, pullRequest } = codeHost('client-cost')
    host.known.set(7, pullRequest(7, { updatedAt: later(1) }))
    let now = Date.now()
    const changes: string[] = []
    const sync = new PrSync({ publish: (change) => { changes.push(change.repo) }, now: () => now })

    for (const client of ['a', 'b', 'c']) sync.setInterest(client, hostOf('client-cost'), [{ kind: 'pull-request', number: 7 }])
    await sync.tick()
    expect(host.numberReads).toEqual([[7]])
    expect(changes).toEqual(['github.com/owner/client-cost'])

    for (const client of ['a', 'b', 'c']) sync.dropConnection(client)
    now += 60_001
    await sync.tick()
    expect(host.numberReads).toEqual([[7]])
  })

  test('answers a branch with one lookup, then keeps its pull request fresh by number', async () => {
    const { host, pullRequest } = codeHost('client-branch')
    host.known.set(3, pullRequest(3, { headRef: 'topic' }))
    const published: number[] = []
    let now = Date.now()
    const sync = new PrSync({ publish: (change) => { published.push(...change.pullRequests.map(({ number }) => number)) }, now: () => now })

    const first = sync.setInterest(owner, hostOf('client-branch'), [{ kind: 'branch', head: 'topic' }])
    expect(first.pullRequests).toEqual([])
    await sync.tick()
    expect(published).toContain(3)

    const second = sync.setInterest(owner, hostOf('client-branch'), [{ kind: 'branch', head: 'topic' }])
    expect(second.pullRequests.map(({ number }) => number)).toEqual([3])
    now += 10 * 60_000
    await sync.tick()
    expect(host.branchLookups).toEqual([['topic']])
    expect(host.numberReads).toEqual([[3]])
  })

  test('an open review pane reads check runs and ticks faster', async () => {
    const { host, pullRequest } = codeHost('client-review')
    host.known.set(5, pullRequest(5, { updatedAt: later(1) }))
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
    // A fast pass reads check runs only; the read by number keeps its minute.
    expect(host.numberReads).toHaveLength(1)
    now += 45_000
    await sync.tick()
    expect(checkReads).toBe(3)
    expect(host.numberReads).toHaveLength(2)
  })

  test('a review pane of a merged pull request reads its checks once and keeps the minute', async () => {
    // WHY: a merged pull request's checks do not change, so polling them
    // every 15 seconds only spends the account's quota.
    const { host, pullRequest } = codeHost('client-review-merged')
    host.known.set(5, pullRequest(5, { state: 'merged', updatedAt: later(1) }))
    let checkReads = 0
    const review = providers.get('client-review-merged')!.review as unknown as { listChecks: (repo: RepoRef, numbers: number[]) => Promise<unknown> }
    review.listChecks = async (_repo, numbers) => {
      checkReads += 1
      return numbers.map((number) => ({ number, summary: { state: 'passing', required: [], optional: [], headSha: 'head', inFlight: false } }))
    }
    let now = Date.now()
    const sync = new PrSync({ publish: () => {}, now: () => now })

    sync.setInterest(owner, hostOf('client-review-merged'), [{ kind: 'review', number: 5 }])
    await sync.tick()
    now += 15_001
    await sync.tick()
    now += 45_000
    await sync.tick()

    expect(checkReads).toBe(1)
    // A merged pull request is not read again by number either.
    expect(host.numberReads).toEqual([[5]])
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
  expect(host.numberReads).toEqual([])
  expect(host.branchLookups).toEqual([])
})

describe('turn ends', () => {
  const repoOf = (name: string) => ({ host: 'github.com', owner: 'owner', repo: name })
  /** A code host that also answers list and detail reads, and counts them. */
  function listedHost(name: string) {
    const made = codeHost(name)
    const reads = { list: 0, detail: 0 }
    Object.assign(providers.get(name)!.review, {
      listPullRequestPages: async (requests: unknown[]) => {
        reads.list += 1
        return requests.map(() => ({ page: { items: [], page: 1, hasMore: false } }))
      },
      getPullRequestOverview: async (_repo: RepoRef, number: number) => {
        reads.detail += 1
        return { pullRequest: made.pullRequest(number, { requiredApprovingReviewCount: 0 }), commits: [], reviewers: [] }
      },
    })
    return { ...made, reads, repo: repoOf(name), provider: providers.get(name)! }
  }

  test('a turn that changed nothing in Git publishes nothing and costs no list read; a push forgets the lists only', async () => {
    // WHY: every turn end made every open list on every client read GitHub
    // again, also when the turn only answered a question.
    const { prIndex } = await import('@solus/server/prs/pr-index')
    const { scope, host, pullRequest, reads, repo, provider } = listedHost('quiet-turn')
    await worktreeSession('quiet-turn-session', 'quiet', scope)
    host.known.set(1, pullRequest(1, { headRef: 'quiet' }))
    let gitState = 'before'
    const published: PrSyncChange[] = []
    const sync = new PrSync({ publish: (change) => { published.push(change) }, sessionCheckout: () => scope, checkoutState: async () => gitState })
    await sync.tick()
    // The first turn end this server sees has nothing to compare with.
    await sync.turnEnded('quiet-turn-session')
    await sync.tick()
    await prIndex.list(repo, provider, 'me', undefined, 1)
    await prIndex.pullRequest(repo, provider, 1).read()
    published.length = 0

    await sync.turnEnded('quiet-turn-session')
    await sync.tick()
    expect(published).toEqual([])
    await prIndex.list(repo, provider, 'me', undefined, 1)
    expect(reads.list).toBe(1)
    // Its branch has its open pull request, so no lookup either.
    expect(host.branchLookups).toHaveLength(1)

    gitState = 'pushed'
    await sync.turnEnded('quiet-turn-session')
    await sync.tick()
    expect(published.filter((change) => change.listChanged)).toEqual([expect.objectContaining({ repo: scope, pullRequests: [] })])
    await prIndex.list(repo, provider, 'me', undefined, 1)
    expect(reads.list).toBe(2)
    // The pull requests the server holds are kept.
    await prIndex.pullRequest(repo, provider, 1).read()
    expect(reads.detail).toBe(1)
  })

  test('a lookup that finds a new pull request for the branch tells the lists, also with no Git change here', async () => {
    // WHY: an agent can open a pull request for a branch it pushed in an
    // earlier turn; the list does not show it until it reads again.
    const { scope, host, pullRequest } = listedHost('new-on-branch')
    await worktreeSession('new-on-branch-session', 'later', scope)
    const published: PrSyncChange[] = []
    const sync = new PrSync({ publish: (change) => { published.push(change) }, sessionCheckout: () => scope, checkoutState: async () => 'same' })
    await sync.tick()
    await sync.turnEnded('new-on-branch-session')
    await sync.tick()
    published.length = 0

    host.known.set(6, pullRequest(6, { headRef: 'later' }))
    await sync.turnEnded('new-on-branch-session')
    await sync.tick()

    expect(published).toEqual([expect.objectContaining({ repo: scope, listChanged: true })])
  })

  test('a tick that a turn end or another read started is background work; one a person waits on is not', async () => {
    // WHY: background work stops before it spends the reserve GitHub leaves
    // for the requests a person waits on.
    const { prIndex } = await import('@solus/server/prs/pr-index')
    const { isBackgroundWork } = await import('@solus/server/providers/github/request-budget')
    const { scope, host, pullRequest, repo, provider } = listedHost('background-ticks')
    await worktreeSession('background-session', 'bg', scope)
    const asBackground: Array<[string, boolean]> = []
    const review = provider.review as unknown as {
      getPullRequestsByHead: (repo: RepoRef, heads: string[]) => Promise<Map<string, PullRequest[]>>
      getPullRequests: (repo: RepoRef, numbers: number[]) => Promise<Map<number, PullRequest | null>>
    }
    const lookUp = review.getPullRequestsByHead
    const readNumbers = review.getPullRequests
    review.getPullRequestsByHead = (target, heads) => {
      asBackground.push(['lookup', isBackgroundWork()])
      return lookUp(target, heads)
    }
    review.getPullRequests = (target, numbers) => {
      asBackground.push(['numbers', isBackgroundWork()])
      return readNumbers(target, numbers)
    }
    const sync = new PrSync({ publish: () => {}, sessionCheckout: () => scope, checkoutState: async () => 'same' })
    sync.start()
    try {
      // A client opens a pane on a branch: a person waits.
      sync.setInterest('client', { repo, provider }, [{ kind: 'branch', head: 'pane' }])
      await sync.tick()
      host.known.set(2, pullRequest(2, { headRef: 'bg' }))
      await sync.turnEnded('background-session')
      await sync.tick()
      // Another read path sees a new state.
      ;(review as unknown as { getPullRequestOverview: () => Promise<PullRequestOverview> }).getPullRequestOverview = async () =>
        ({ pullRequest: pullRequest(2, { headRef: 'bg', state: 'closed', updatedAt: later(1) }), commits: [], reviewers: [] })
      await prIndex.pullRequest(repo, provider, 2).readFresh()
      await sync.tick()
    } finally {
      sync.stop()
    }

    expect(asBackground).toEqual([['lookup', false], ['lookup', true], ['numbers', true]])
  })
})

describe('a detail read and PR sync', () => {
  test('a pane that opens a pull request and keeps it fresh costs one read of it, in either order', async () => {
    // WHY: the pane read the detail, and PR sync read the same pull request
    // by number a moment later, because it had no record of it yet.
    const { prIndex } = await import('@solus/server/prs/pr-index')
    for (const [name, detailFirst] of [['detail-first', true], ['interest-first', false]] as const) {
      const { host, pullRequest } = codeHost(name)
      const repo = { host: 'github.com', owner: 'owner', repo: name }
      const provider = providers.get(name)!
      let detailReads = 0
      Object.assign(provider.review, {
        getPullRequestOverview: async () => {
          detailReads += 1
          await new Promise((resolve) => setTimeout(resolve, 5))
          return { pullRequest: pullRequest(3, { requiredApprovingReviewCount: 1 }), commits: [], reviewers: [] }
        },
        listChecks: async (_repo: RepoRef, numbers: number[]) =>
          numbers.map((number) => ({ number, summary: { state: 'passing', required: [], optional: [], headSha: 'head', inFlight: false } })),
      })
      const published: number[] = []
      const sync = new PrSync({ publish: (change) => { published.push(...change.pullRequests.map(({ number }) => number)) } })

      const open = () => prIndex.pullRequest(repo, provider, 3).read()
      const want = () => { sync.setInterest('pane', { repo, provider }, [{ kind: 'review', number: 3 }]) }
      let detail: Promise<PullRequest>
      if (detailFirst) {
        detail = open()
        want()
      } else {
        want()
        detail = open()
      }
      await Promise.all([detail, sync.tick()])

      expect([name, detailReads, host.numberReads]).toEqual([name, 1, []])
      expect(published).toContain(3)
    }
  })
})

test('one read of interest reads the sessions of live tasks once', async () => {
  // WHY: the live task sessions were read twice per read of interest, once
  // for the checkouts and once for the session links.
  const { spyOn } = await import('bun:test')
  const taskSessionsModule = await import('@solus/server/data/tasks/task-sessions')
  const spy = spyOn(taskSessionsModule, 'taskSessions')
  try {
    // With no code host, the tick reads interest and nothing else.
    await new PrSync({ publish: () => {}, codeHost: async () => null }).tick()
    expect(spy).toHaveBeenCalledTimes(1)
  } finally {
    spy.mockRestore()
  }
})

test('a turn end in a session outside a repository publishes nothing', async () => {
  const published: PrSyncChange[] = []
  const sync = new PrSync({ publish: (change) => { published.push(change) }, sessionCheckout: () => null })

  await sync.turnEnded('no-checkout')
  await sync.tick()

  expect(published.filter((change) => change.listChanged)).toEqual([])
})

describe("an organization's Solus API", () => {
  test("links an organization session's branch pull request, reading as the session's owner", async () => {
    // WHY: the machines that run organization sessions rotate and go offline,
    // so the session's home keeps its pull requests fresh
    // (docs/plans/session-archive.md). It has no checkout and no connection of
    // its own: it reads the branch from the record, and GitHub as the owner.
    // The Solus API installs acting identities at boot; the test does as it does.
    const { installTestIdentities } = await import('./helpers/acting-identities')
    installTestIdentities()
    const { scope, host, pullRequest } = codeHost('org-branch')
    host.known.set(5, pullRequest(5, { headRef: 'feat', updatedAt: later(1) }))
    const readers: Array<string | null> = []
    const { requireActingScope } = await import('@solus/server/vault/acting-scope')
    const provider = providers.get('org-branch')!
    const lookup = provider.review!.getPullRequestsByHead.bind(provider.review)
    provider.review!.getPullRequestsByHead = (async (...args: Parameters<typeof lookup>) => {
      readers.push(requireActingScope('a test read').personKey)
      return lookup(...args)
    }) as typeof lookup
    const records = await import('@solus/server/data/sessions/session-records')
    await records.upsertSessionRecord('A', { sessionId: 'org-s1', provider: 'codex', projectPath: '-repo', lastActivityAt: Date.now(), projectRemote: scope, branch: 'feat' }, { organizationId: 'A', published: true, ownerKey: 'alice' })

    const { organizationPrSync } = await import('@solus/server/prs/organization-pr-sync')
    await organizationPrSync(() => {}).tick()

    const { readSessionPullRequests } = await import('@solus/server/data/sessions/session-pull-requests')
    const { ANY_ORGANIZATION } = await import('@solus/server/admission/principal')
    expect((await readSessionPullRequests(ANY_ORGANIZATION, ['org-s1']))['org-s1']?.map((link) => [link.number, link.source])).toEqual([[5, 'branch']])
    expect(readers).toEqual(['alice'])
  })
})
