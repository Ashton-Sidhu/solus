import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { CheckItem } from '@solus/contracts/checks-types'
import type { PrConversationItem, PullRequest } from '@solus/contracts/providers'
import { resetTestDatabase } from './helpers/test-db'
import { installTestIdentities } from './helpers/acting-identities'

/**
 * The watcher reads a watched pull request only when its fingerprint moved,
 * and wakes each watching session once per piece of news
 * (docs/plans/pr-watch.md).
 */

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// The pull request index is one per process and keeps the provider it first
// saw for a pull request, so each test reads its own repository.
let repositoryCount = 0
let REPOSITORY = ''

let dataDir: string
let db: typeof import('@solus/server/db')
let watches: typeof import('@solus/server/data/sessions/pull-request-watches')
let rules: typeof import('@solus/server/prs/pr-watch-rules')
let watcherModule: typeof import('@solus/server/prs/pr-watcher')
let rateLimit: typeof import('@solus/server/providers/github/rate-limit')
let actingScope: typeof import('@solus/server/vault/acting-scope')
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-pr-watcher-'))
  process.env.SOLUS_DATA_DIR = dataDir
  db = await import('@solus/server/db')
  watches = await import('@solus/server/data/sessions/pull-request-watches')
  rules = await import('@solus/server/prs/pr-watch-rules')
  watcherModule = await import('@solus/server/prs/pr-watcher')
  rateLimit = await import('@solus/server/providers/github/rate-limit')
  actingScope = await import('@solus/server/vault/acting-scope')
  installTestIdentities()
})

beforeEach(() => {
  REPOSITORY = `github.com/acme/repo-${++repositoryCount}`
})

/** The code host of the test's repository, answering through `host`. */
function codeHostOf(host: FakeHost) {
  return async (repository: string) => {
    const [hostName, owner, repo] = repository.split('/')
    return { repo: { host: hostName, owner, repo }, provider: { id: 'github', review: host.review } } as never
  }
}

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

function check(name: string, conclusion: CheckItem['conclusion']): CheckItem {
  return { id: name, name, conclusion, inFlight: conclusion === null, detailsUrl: null, appName: null, startedAt: null, completedAt: null }
}

/** A code host whose pull request #7 a test changes between sweeps. */
class FakeHost {
  state: PullRequest['state'] = 'open'
  headSha = 'head-1'
  checks: CheckItem[] = [check('build', null)]
  comments: PrConversationItem[] = []
  fingerprintFailure: Error | null = null
  readFailure: Error | null = null
  fullReads = 0
  fingerprintReads = 0
  /** Whose account each fingerprint read used. */
  readAs: Array<string | null> = []

  fingerprint() {
    return {
      status: `${this.state} ${this.headSha} ${this.checks.map((item) => item.conclusion ?? 'running').join(',')}`,
      remarks: `${this.comments.length}`,
    }
  }

  readonly review = {
    readWatchFingerprints: async (_repo: object, numbers: number[]) => {
      this.fingerprintReads++
      this.readAs.push(actingScope.currentCredentialUserId())
      if (this.fingerprintFailure) throw this.fingerprintFailure
      return new Map(numbers.map((number) => [number, this.fingerprint()]))
    },
    getPullRequests: async (_repo: object, numbers: number[]) => {
      this.fullReads++
      if (this.readFailure) throw this.readFailure
      return new Map(numbers.map((number) => [number, {
        number, url: `https://github.com/acme/solus/pull/${number}`, title: 'Fix it', state: this.state,
        headSha: this.headSha, mergeable: true, draft: false, updatedAt: '2026-10-07T12:00:00Z',
      } as PullRequest]))
    },
    listChecks: async (_repo: object, numbers: number[]) => numbers.map((number) => ({
      number,
      summary: { state: 'pending' as const, required: this.checks, optional: [], headSha: this.headSha, inFlight: this.checks.some((item) => item.inFlight) },
    })),
    listComments: async () => this.comments,
    listReviewThreads: async () => [],
    getViewer: async () => 'agent-account',
  }
}

function setup(host: FakeHost) {
  const woke: Array<{ sessionId: string; text: string; actorUserId: string | null }> = []
  const watcher = new watcherModule.PrWatcher({
    wake: async (sessionId, text, actor) => {
      woke.push({ sessionId, text, actorUserId: actor?.user?.id.kind === 'account' ? actor.user.id.accountId : null })
    },
    codeHost: codeHostOf(host),
  })
  return { watcher, woke }
}

async function watch(sessionId: string, startedAt = Date.now() - 60_000, actingUserKey: string | null = null) {
  return watches.startPullRequestWatch(sessionId, REPOSITORY, 7, rules.initialWatchState(startedAt), actingUserKey, startedAt)
}

describe('PR watcher', () => {
  test('with nothing watched, a sweep asks the code host nothing', async () => {
    const host = new FakeHost()
    const { watcher } = setup(host)
    await watcher.start()
    await watcher.sweep()
    watcher.stop()
    expect(host.fingerprintReads).toBe(0)
  })

  test('a quiet pull request costs one fingerprint per sweep; news reads it and wakes the session once', async () => {
    const host = new FakeHost()
    await watch('session-1')
    const { watcher, woke } = setup(host)
    await watcher.start()
    await watcher.sweep()
    // A check is running, so the counts cannot say which one finished: each
    // sweep reads (the start's own sweep, then this one).
    expect(host.fullReads).toBe(2)

    host.checks = [check('build', 'failure')]
    await watcher.sweep()
    expect(woke).toHaveLength(1)
    expect(woke[0]?.text).toContain('Checks failed')

    // Settled and unchanged: only the fingerprint is read.
    const reads = host.fullReads
    await watcher.sweep()
    await watcher.sweep()
    expect(host.fullReads).toBe(reads)
    expect(woke).toHaveLength(1)
    watcher.stop()
  })

  test('what a session was told survives a restart', async () => {
    const host = new FakeHost()
    host.checks = [check('build', 'failure')]
    await watch('session-1')
    const first = setup(host)
    await first.watcher.start()
    await first.watcher.sweep()
    first.watcher.stop()
    expect(first.woke).toHaveLength(1)

    const second = setup(host)
    await second.watcher.start()
    await second.watcher.sweep()
    second.watcher.stop()
    expect(second.woke).toEqual([])
  })

  test('sessions that watch one pull request share its read, and each is woken', async () => {
    const host = new FakeHost()
    host.checks = [check('build', 'success')]
    host.comments = [{ id: 'c1', kind: 'comment', author: 'reviewer', body: 'Please rename', createdAt: new Date().toISOString() }]
    await watch('session-1')
    await watch('session-2')
    const { watcher, woke } = setup(host)
    await watcher.start()
    await watcher.sweep()
    watcher.stop()
    expect(host.fullReads).toBe(1)
    expect(woke.map(({ sessionId }) => sessionId).sort()).toEqual(['session-1', 'session-2'])
  })

  test('a new comment wakes the session once, with what it says', async () => {
    const host = new FakeHost()
    host.checks = [check('build', 'success')]
    await watch('session-1')
    const { watcher, woke } = setup(host)
    await watcher.start()
    await watcher.sweep()
    expect(woke.map(({ text }) => text.includes('passed'))).toEqual([true])

    host.comments = [{ id: 'c1', kind: 'comment', author: 'reviewer', body: 'Please rename this', createdAt: new Date().toISOString() }]
    await watcher.sweep()
    await watcher.sweep()
    watcher.stop()
    expect(woke).toHaveLength(2)
    expect(woke[1]?.text).toContain('reviewer: "Please rename this"')
  })

  test('each person\'s watches are read with their own account', async () => {
    // WHY: two people may watch one pull request, and only one of them may be
    // able to see it. Each reads as themselves, never as the host for them.
    const host = new FakeHost()
    host.checks = [check('build', 'success')]
    await watch('session-1', undefined, 'member-1')
    await watch('session-2', undefined, null)
    const { watcher } = setup(host)
    await watcher.start()
    await watcher.sweep()
    watcher.stop()
    expect([...new Set(host.readAs)].sort()).toEqual([null, 'member-1'].sort())
  })

  test('a member\'s watch wakes the session as that member, after a restart too', async () => {
    // WHY: after a restart the session's live actor is gone. A wake with no
    // actor would run the member's agent as the host.
    const host = new FakeHost()
    host.checks = [check('build', 'failure')]
    await watch('session-1', undefined, 'member-1')
    const { watcher, woke } = setup(host)
    await watcher.start()
    await watcher.sweep()
    watcher.stop()
    expect(woke.map(({ actorUserId }) => actorUserId)).toEqual(['member-1'])
  })

  test('a merge ends the watch without a wake', async () => {
    const host = new FakeHost()
    host.state = 'merged'
    await watch('session-1')
    const { watcher, woke } = setup(host)
    await watcher.start()
    await watcher.sweep()
    watcher.stop()
    expect(woke).toEqual([])
    expect(await watches.readPullRequestWatches()).toEqual([])
  })

  test('a rate limit never ends a watch; repeated read failures do, and say so', async () => {
    const host = new FakeHost()
    await watch('session-1')
    let now = Date.now()
    const woke: string[] = []
    const watcher = new watcherModule.PrWatcher({
      wake: async (_sessionId, text) => { woke.push(text) },
      codeHost: codeHostOf(host),
      now: () => now,
    })
    await watcher.start()

    for (let index = 0; index < 12; index++) {
      host.fingerprintFailure = new rateLimit.GitHubRateLimitedError(now + 1_000)
      await watcher.sweep()
      now += 2_000
    }
    expect(await watches.readPullRequestWatches()).toHaveLength(1)

    host.fingerprintFailure = null
    host.readFailure = new Error('boom')
    for (let index = 0; index < 8; index++) await watcher.sweep()
    watcher.stop()
    expect(await watches.readPullRequestWatches()).toEqual([])
    expect(woke).toHaveLength(1)
    expect(woke[0]).toContain('could not read it')
  })

  test('a stop during a read wins: the read wakes nobody', async () => {
    const host = new FakeHost()
    host.checks = [check('build', 'failure')]
    await watch('session-1')
    const { watcher, woke } = setup(host)
    await watcher.start()
    const listChecks = host.review.listChecks
    host.review.listChecks = async (repo, numbers) => {
      await watches.stopPullRequestWatch('session-1', REPOSITORY, 7)
      return listChecks(repo, numbers)
    }
    await watcher.sweep()
    watcher.stop()
    expect(woke).toEqual([])
  })
})
