import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { pullRequestFixture } from './__fixtures__/pull-request'
import { TEST_HANDLER_CTX } from './helpers/handler-ctx'
import type { PrFilter, PrListPage, PrProjectListing, PullRequest } from '@solus/contracts/providers'
import type { IpcContext } from '@solus/contracts/types'
import type { Provider, RepoRef } from '@solus/server/providers/types'
import { SolusServer } from '@solus/server/server/server'
import type { HostEventPublisher } from '@solus/server/events/host-event-publisher'
import type { AgentDispatcher } from '@solus/server/agents/agent-runner'

// The handlers reach the production database module, which imports node:sqlite
// (absent under Bun's test runtime).
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

/** Each project root is its own repository, named after the root. */
function repoOf(scope: string): RepoRef | null {
  if (scope === '/plain-folder') return null
  return { host: 'github.com', owner: 'acme', repo: scope.slice(scope.lastIndexOf('/') + 1) }
}

let inFlight = 0
let maxInFlight = 0
const listed: { repo: string; filter: PrFilter | undefined; page: number }[] = []
/** What each repository answers for the viewer's own pull requests and for
 *  those waiting on their review. Empty unless a test says otherwise. */
let authoredRows: PullRequest[] = []
let reviewRows: PullRequest[] | Error = []
const priorityReads: string[] = []
mock.module('@solus/server/prs/pr-index', () => ({
  repoKeyOf: (target: RepoRef) => `${target.host}/${target.owner}/${target.repo}`,
  prIndex: {
    list: async (repo: RepoRef, _provider: Provider, _viewer: string, filter: PrFilter | undefined, page: number): Promise<PrListPage> => {
      if (filter?.query === 'author:octocat') {
        priorityReads.push(`authored ${filter.state}`)
        return { items: authoredRows, page, hasMore: false }
      }
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 2))
      inFlight--
      if (repo.repo === 'broken') throw new Error('GitHub is not connected')
      listed.push({ repo: repo.repo, filter, page })
      return { items: [pullRequestFixture(1, { title: repo.repo })], page, hasMore: false }
    },
    listNeedsReview: async (): Promise<PullRequest[]> => {
      priorityReads.push('review requested')
      if (reviewRows instanceof Error) throw reviewRows
      return reviewRows
    },
    invalidate: () => {},
  },
}))
mock.module('@solus/server/git/git-helpers', () => ({
  resolveRepoRef: async (scope: string) => repoOf(scope),
  // No local checkout, so no guide warming is scheduled from a list read.
  resolveRepoRoot: async () => null,
  computeGitState: async () => null,
}))
const provider = { review: { getViewer: async () => 'octocat' } } as unknown as Provider
mock.module('@solus/server/providers/registry', () => ({
  providerForRepo: () => provider,
  getProvider: () => provider,
}))

const { registerProviderHandlers } = await import('@solus/server/server/handlers/provider-handlers')

function server(): SolusServer {
  const solus = new SolusServer()
  registerProviderHandlers(solus, {
    isWorktreeInUse: () => false,
    isSessionBusy: () => false,
    dispatcher: {} as AgentDispatcher,
    events: { broadcast: () => 1, publish: () => 1 } as unknown as HostEventPublisher,
  })
  return solus
}

const ctx = { session: { projectPath: '/repos/active', workingDirectory: '/repos/active' } } as IpcContext

beforeEach(() => {
  authoredRows = []
  reviewRows = []
  priorityReads.length = 0
})

function rowsOf(listings: PrProjectListing[]): number[] {
  const [listing] = listings
  return 'page' in listing ? listing.page.items.map((item) => item.number) : []
}

describe('listing every project on one host', () => {
  test('answers for each named project in one reply, in the order asked', async () => {
    listed.length = 0
    const roots = ['/repos/a', '/repos/b', '/repos/c']

    const listings = await server().handle('prListProjects', [ctx, roots, { state: 'open' }], TEST_HANDLER_CTX)

    expect(listings).toEqual(roots.map((projectRoot) => ({
      projectRoot,
      page: {
        items: [expect.objectContaining({ number: 1, title: projectRoot.slice('/repos/'.length) })],
        page: 1,
        hasMore: false,
      },
    })))
    // Each project's own repository was read, not the caller's active project.
    expect(listed.map((read) => read.repo).sort()).toEqual(['a', 'b', 'c'])
    expect(listed.every((read) => read.page === 1 && read.filter?.state === 'open')).toBe(true)
  })

  // WHY: one project the host cannot read — a plain folder, a lapsed token —
  // must not cost the reader every other project's rows.
  test('reports a failing project by itself and still answers for the rest', async () => {
    const listings = await server().handle(
      'prListProjects',
      [ctx, ['/repos/a', '/plain-folder', '/repos/broken'], undefined],
      TEST_HANDLER_CTX,
    )

    expect(listings).toEqual([
      expect.objectContaining({ projectRoot: '/repos/a', page: expect.objectContaining({ page: 1 }) }),
      { projectRoot: '/plain-folder', error: 'This folder has no recognizable git remote to review PRs from.' },
      { projectRoot: '/repos/broken', error: 'GitHub is not connected' },
    ])
  })

  test('bounds how many projects it asks the code host about at once', async () => {
    maxInFlight = 0
    const roots = Array.from({ length: 20 }, (_unused, index) => `/repos/r${index}`)

    const listings = await server().handle('prListProjects', [ctx, roots, undefined], TEST_HANDLER_CTX)

    expect(listings).toHaveLength(20)
    expect(maxInFlight).toBeGreaterThan(1)
    expect(maxInFlight).toBeLessThanOrEqual(6)
  })
})

// WHY: the Authored and Review requested sections are drawn from the rows the
// list holds. The first page holds the thirty most recently updated pull
// requests, so in a busy repository the viewer's own older work never reached
// its section.
describe('the viewer\'s own pull requests in an every-project read', () => {
  test('adds authored and review-requested rows that are not on the first page', async () => {
    authoredRows = [pullRequestFixture(40, { author: 'octocat' }), pullRequestFixture(1)]
    reviewRows = [pullRequestFixture(55), pullRequestFixture(40)]

    const listings = await server().handle('prListProjects', [ctx, ['/repos/a'], { state: 'open' }], TEST_HANDLER_CTX)

    // The page first, then each priority row once — #1 and #40 are not repeated.
    expect(rowsOf(listings)).toEqual([1, 40, 55])
    expect(priorityReads.sort()).toEqual(['authored open', 'review requested'])
  })

  test('a search answers with its matches alone', async () => {
    authoredRows = [pullRequestFixture(40)]

    const listings = await server().handle('prListProjects', [ctx, ['/repos/a'], { state: 'open', query: 'fix' }], TEST_HANDLER_CTX)

    expect(rowsOf(listings)).toEqual([1])
    expect(priorityReads).toEqual([])
  })

  test('closed pull requests ask for authored rows but not review requests', async () => {
    authoredRows = [pullRequestFixture(40, { state: 'closed' })]

    const listings = await server().handle('prListProjects', [ctx, ['/repos/a'], { state: 'closed' }], TEST_HANDLER_CTX)

    expect(rowsOf(listings)).toEqual([1, 40])
    expect(priorityReads).toEqual(['authored closed'])
  })

  test('a failed priority read costs only its own rows', async () => {
    authoredRows = [pullRequestFixture(40)]
    reviewRows = new Error('search is rate limited')

    const listings = await server().handle('prListProjects', [ctx, ['/repos/a'], { state: 'open' }], TEST_HANDLER_CTX)

    expect(rowsOf(listings)).toEqual([1, 40])
  })

  test('a single-project list read by page stays the page alone', async () => {
    authoredRows = [pullRequestFixture(40)]

    const page = await server().handle('prList', [ctx, { state: 'open' }, 1], TEST_HANDLER_CTX)

    expect(page.items.map((item) => item.number)).toEqual([1])
    expect(priorityReads).toEqual([])
  })
})
