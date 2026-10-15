import { describe, expect, mock, test } from 'bun:test'
import type { PrFilter, PrListPage, RepoRef } from '@solus/contracts/providers'
import { pullRequestFixture } from './__fixtures__/pull-request'

// The inbox's pull requests for one bound GitHub scope. It used to page every
// open pull request of the repository and keep the viewer's afterwards; the
// code host's search now narrows them, so only the matches are read.

const reads: Array<{ filter: PrFilter | undefined; page: number; cursor: string | null }> = []
mock.module('@solus/server/project-config/projects-manifest', () => ({
  listProjects: async () => [{ path: '/repos/app', folderName: 'app' }],
}))
mock.module('@solus/server/data/tasks/adapters/registry', () => ({
  resolveTaskPublishTarget: async () => ({ adapter: { id: 'github' }, ref: { externalKey: 'acme/app' } }),
}))
mock.module('@solus/server/data/tasks/upstream', () => ({
  listUpstreamTasks: async () => ({ tasks: [], fetchedAt: 1, fromCache: false, truncated: false }),
}))
const provider = { review: { getViewer: async () => 'sidhu' } }
mock.module('@solus/server/providers/registry', () => ({
  providerForRepo: () => provider,
  getProvider: () => provider,
}))
mock.module('@solus/server/prs/pr-index', () => ({
  repoKeyOf: (repo: RepoRef) => `${repo.host}/${repo.owner}/${repo.repo}`,
  prIndex: {
    list: async (_repo: RepoRef, _provider: object, _viewer: string, filter: PrFilter | undefined, page: number, cursor: string | null): Promise<PrListPage> => {
      reads.push({ filter, page, cursor })
      return page === 1
        ? { items: [pullRequestFixture(1), pullRequestFixture(2)], page, hasMore: true, cursor: 'search:2' }
        : { items: [pullRequestFixture(2), pullRequestFixture(3)], page, hasMore: false }
    },
  },
}))

const { listInboxUpstream } = await import('@solus/server/data/tasks/inbox')

describe('inbox pull requests', () => {
  test('each involvement is a search qualifier, paged by cursor, each pull request once', async () => {
    for (const [involvement, query] of [
      ['authored', 'author:sidhu'],
      ['assigned', 'assignee:sidhu'],
      ['review_requested', 'user-review-requested:sidhu'],
    ] as const) {
      reads.length = 0
      const result = await listInboxUpstream({ kind: 'local' } as never, involvement)

      expect(reads).toEqual([
        { filter: { state: 'open', query }, page: 1, cursor: null },
        { filter: { state: 'open', query }, page: 2, cursor: 'search:2' },
      ])
      expect(result.scopes[0]?.pullRequests.map((row) => row.number)).toEqual([1, 2, 3])
    }
  })
})
