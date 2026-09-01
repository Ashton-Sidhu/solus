import { describe, expect, test } from 'bun:test'
import type { NumberedPrChecksSummary } from '@solus/contracts/checks-rpc-types'
import type { PullRequest, PullRequestOverview, RepoRef } from '@solus/contracts/providers'
import type { Provider } from '@solus/server/providers/types'
import { PrIndex } from '@solus/server/prs/pr-index'

const repo: RepoRef = { host: 'github.com', owner: 'owner', repo: 'repo' }
const otherRepo: RepoRef = { host: 'github.com', owner: 'owner', repo: 'other' }

interface Calls {
  getPullRequest: number
  getPullRequestOverview: number
  listCommits: number
  listPullRequestsPage: number
  listPullRequestFileStats: number
}

function pullRequestFor(number: number, headSha = 'sha-1'): PullRequest {
  return { number, headSha, title: `PR ${number}` } as unknown as PullRequest
}

function checksFor(number: number, inFlight: boolean): NumberedPrChecksSummary {
  return { number, summary: { headSha: 'sha-1', inFlight, checks: [] } } as unknown as NumberedPrChecksSummary
}

/** A provider that counts what actually left for the host, and can be told which
 *  account it is signed in as so two viewers can be put on one repository. */
function fakeProvider(viewer = 'alice', gate?: Promise<void>): { provider: Provider; calls: Calls; headSha: { value: string } } {
  const calls: Calls = {
    getPullRequest: 0,
    getPullRequestOverview: 0,
    listCommits: 0,
    listPullRequestsPage: 0,
    listPullRequestFileStats: 0,
  }
  const headSha = { value: 'sha-1' }
  const review = {
    getViewer: async () => viewer,
    getPullRequest: async (_repo: RepoRef, number: number) => {
      calls.getPullRequest += 1
      if (gate) await gate
      return pullRequestFor(number, headSha.value)
    },
    getPullRequestOverview: async (_repo: RepoRef, number: number): Promise<PullRequestOverview> => {
      calls.getPullRequestOverview += 1
      return { pullRequest: pullRequestFor(number), commits: [], reviewers: [] } as unknown as PullRequestOverview
    },
    listCommits: async () => {
      calls.listCommits += 1
      return []
    },
    listPullRequestsPage: async () => {
      calls.listPullRequestsPage += 1
      return { items: [], page: 1, hasMore: false }
    },
    listPullRequestFileStats: async () => {
      calls.listPullRequestFileStats += 1
      return []
    },
  }
  return { provider: { review } as unknown as Provider, calls, headSha }
}

describe('PrIndex', () => {
  test('two readers of one pull request cost one host request', async () => {
    const index = new PrIndex()
    const { provider, calls } = fakeProvider()

    // Two clients, two separate reads, arriving one after the other.
    await index.pullRequest(repo, provider, 7).read()
    await index.pullRequest(repo, provider, 7).read()

    expect(calls.getPullRequest).toBe(1)
  })

  test('concurrent readers share one in-flight request', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const index = new PrIndex()
    const { provider, calls } = fakeProvider('alice', gate)

    const both = Promise.all([
      index.pullRequest(repo, provider, 7).read(),
      index.pullRequest(repo, provider, 7).read(),
    ])
    release()
    const [first, second] = await both

    expect(calls.getPullRequest).toBe(1)
    expect(first).toBe(second)
  })

  test('a guard read reaches the host even when a fresh answer is remembered', async () => {
    const index = new PrIndex()
    const { provider, calls, headSha } = fakeProvider()

    const pullRequest = index.pullRequest(repo, provider, 7)
    expect((await pullRequest.read()).headSha).toBe('sha-1')

    // Somebody pushes. A remembered answer would still say sha-1, which is
    // exactly the case optimistic concurrency exists to catch.
    headSha.value = 'sha-2'
    expect((await pullRequest.readFresh()).headSha).toBe('sha-2')
    expect(calls.getPullRequest).toBe(2)

    // And the guard's answer replaces what was remembered.
    expect((await pullRequest.read()).headSha).toBe('sha-2')
    expect(calls.getPullRequest).toBe(2)
  })

  test('two checkouts of one repository are one pull request', async () => {
    const index = new PrIndex()
    const { provider, calls } = fakeProvider()

    // Two worktrees, two project paths, one pull request. Keying by project is
    // what made a server read the same host twice for one answer.
    await index.pullRequest(repo, provider, 7).read()
    await index.pullRequest(repo, provider, 7).read()

    expect(index.size).toBe(1)
    expect(calls.getPullRequest).toBe(1)
  })

  test('the checks poll files its answer on each pull request it covered', () => {
    const index = new PrIndex()
    const { provider } = fakeProvider()

    // The poll asks about a whole repository and acts for no client, so it must
    // be able to reach a pull request nothing has opened.
    index.absorbChecks(repo, provider, [checksFor(7, true), checksFor(9, false)])

    expect(index.pullRequest(repo, provider, 7).checks()?.summary.inFlight).toBe(true)
    expect(index.checksFor(repo, [7, 9]).map((entry) => entry.number)).toEqual([7, 9])
    // A pull request the poll did not name has nothing to say yet.
    expect(index.pullRequest(repo, provider, 11).checks()).toBeNull()
    expect(index.checksFor(repo, [11])).toEqual([])
  })

  test('a large repository keeps every open pull request the poll filed', () => {
    const index = new PrIndex()
    const { provider } = fakeProvider()
    const openPrNumbers = Array.from({ length: 600 }, (_, offset) => offset + 1)

    index.absorbChecks(repo, provider, openPrNumbers.map((number) => checksFor(number, false)))

    // The snapshot is assembled by reading these back, so an entity evicted
    // mid-poll is a row that silently vanishes from the list's check marks.
    expect(index.checksFor(repo, openPrNumbers)).toHaveLength(600)
  })

  test('a write forgets what was read but not the state of the build', () => {
    const index = new PrIndex()
    const { provider } = fakeProvider()
    index.absorbChecks(repo, provider, [checksFor(7, true)])

    // Commenting on a pull request does not re-run its CI, and blanking the
    // check marks until the poller next comes round would be a worse answer
    // than the one already on screen.
    index.invalidate(repo)

    expect(index.pullRequest(repo, provider, 7).checks()?.summary.inFlight).toBe(true)
  })

  test('an overview seeds the fields it carries', async () => {
    const index = new PrIndex()
    const { provider, calls } = fakeProvider()

    const pullRequest = index.pullRequest(repo, provider, 7)
    await pullRequest.overview()
    await pullRequest.commits()
    await pullRequest.read()

    expect(calls.getPullRequestOverview).toBe(1)
    // Both arrived inside the overview, so neither costs a second request.
    expect(calls.listCommits).toBe(0)
    expect(calls.getPullRequest).toBe(0)
  })

  test('invalidating after a write sends the next read back to the host', async () => {
    const index = new PrIndex()
    const { provider, calls } = fakeProvider()

    await index.pullRequest(repo, provider, 7).read()
    await index.list(repo, provider, { state: 'open' }, 1)
    expect(calls.getPullRequest).toBe(1)
    expect(calls.listPullRequestsPage).toBe(1)

    index.invalidate(repo)

    await index.pullRequest(repo, provider, 7).read()
    await index.list(repo, provider, { state: 'open' }, 1)
    expect(calls.getPullRequest).toBe(2)
    expect(calls.listPullRequestsPage).toBe(2)
  })

  test('invalidating one repository leaves another alone', async () => {
    const index = new PrIndex()
    const { provider, calls } = fakeProvider()

    await index.pullRequest(otherRepo, provider, 7).read()
    index.invalidate(repo)
    await index.pullRequest(otherRepo, provider, 7).read()

    expect(calls.getPullRequest).toBe(1)
  })

  test('changed-file counts are re-read when the revision they described has moved', async () => {
    const index = new PrIndex()
    const { provider, calls } = fakeProvider()

    const pullRequest = index.pullRequest(repo, provider, 7)
    await pullRequest.changedFiles('sha-1')
    await pullRequest.changedFiles('sha-1')
    expect(calls.listPullRequestFileStats).toBe(1)

    // A push replaces the whole diff, so the size of the one it replaced is not
    // an answer about this pull request any more.
    await pullRequest.changedFiles('sha-2')
    expect(calls.listPullRequestFileStats).toBe(2)
  })

  test('a caller that names no revision takes the ordinary lifetime', async () => {
    const index = new PrIndex()
    const { provider, calls } = fakeProvider()

    const pullRequest = index.pullRequest(repo, provider, 7)
    await pullRequest.changedFiles('sha-1')
    // The changed-files panel shows whatever is current and has no revision to
    // assert, so it must not be treated as disagreeing with the one on record.
    await pullRequest.changedFiles()
    expect(calls.listPullRequestFileStats).toBe(1)
  })

  test('the index does not grow without bound', async () => {
    const index = new PrIndex()
    const { provider } = fakeProvider()

    for (let number = 1; number <= 4000; number += 1) {
      index.pullRequest(repo, provider, number)
    }

    // A long-running server must not hold every pull request it was ever asked
    // about; the exact cap is a tuning choice, the bound is the intent.
    expect(index.size).toBeLessThanOrEqual(1024)
  })
})
