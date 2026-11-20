import { describe, expect, test } from 'bun:test'
import {
  PrReactionWrites,
  PrUrlInspectionStore,
  reactionSummary,
  shownReactions,
  withReaction
} from '@solus/client-core/pr-social'
import type { PrReactions, PrUrlInspection } from '@solus/contracts/pr-social'
import type { RepoRef } from '@solus/contracts/providers'
import {
  changeGithubPrReaction,
  prRepoSchema,
  toPrReactions
} from '@solus/server/providers/github/pr-social'
import { GitHubProvider } from '@solus/server/providers/github/provider'
import { inspectPullRequestUrl } from '@solus/server/providers/pr-inspection'
import type { GitHubClient, GraphQLClient } from '@solus/server/providers/github/octokit'
import { deferred } from './helpers/native-mobile-prs-fixtures'
import { pullRequestFixture } from './__fixtures__/pull-request'
const repo: RepoRef = { host: 'github.com', owner: 'acme', repo: 'repo' }
const hearts = (count: number, viewerHasReacted = count > 0): PrReactions => ({
  viewerCanReact: true,
  groups: count > 0 ? [{ content: 'HEART', count, viewerHasReacted, actors: [] }] : []
})
const inspection: PrUrlInspection = {
  overview: { pullRequest: pullRequestFixture(1), commits: [], reviewers: [] },
  comments: [],
  threads: [],
  readOnly: true,
  truncated: false
}
const group = (content: string, logins: string[], totalCount = logins.length, viewerHasReacted = false) => ({
  content,
  viewerHasReacted,
  reactors: { totalCount, nodes: logins.map((login) => ({ login })) }
})

describe('GitHub reactions read with their subject', () => {
  test('the viewer is never an actor, groups nobody used are left out, and the count is GitHub\'s', () => {
    const reactions = toPrReactions(
      {
        viewerCanReact: false,
        reactionGroups: [
          group('HEART', ['ada', 'Viewer'], 12, true),
          group('EYES', []),
          { ...group('ROCKET', []), reactors: { totalCount: 0, nodes: [null] } }
        ] as never
      },
      'viewer'
    )
    expect(reactions).toEqual({
      viewerCanReact: false,
      groups: [{ content: 'HEART', count: 12, viewerHasReacted: true, actors: ['ada'] }]
    })
  })

  class FixtureProvider extends GitHubProvider {
    constructor(private readonly client: GitHubClient) {
      super()
    }
    protected override async clients(): Promise<GitHubClient[]> {
      return [this.client]
    }
  }
  const comment = (id: string) => ({
    id,
    author: { login: 'ada', avatarUrl: '' },
    body: id,
    createdAt: '2026-07-01T00:00:00Z',
    lastEditedAt: null,
    isMinimized: false,
    viewerCanReact: true,
    reactionGroups: [group('EYES', ['ada', 'viewer'], 2, true)]
  })
  test('a thread longer than its first page is followed from its own cursor, and only that thread', async () => {
    // WHY: T3 Code found that a hundred threads of a hundred comments cost
    // about a hundred points a page; ten comments ride with each thread.
    const queries: Array<{ query: string; variables: unknown }> = []
    const client = {
      rest: {},
      credential: { source: 'host', token: 'fixture-token' },
      graphql: async (query: string, variables: unknown) => {
        queries.push({ query, variables })
        if (query.includes('node(id: $threadId)'))
          return {
            node: {
              comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [comment('long-11')] }
            }
          }
        return {
          viewer: { login: 'viewer' },
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  { id: 'T_long', isResolved: false, isOutdated: false, path: 'a.ts', line: 1, diffSide: 'RIGHT', comments: { pageInfo: { hasNextPage: true, endCursor: 'c10' }, nodes: [comment('long-1')] } },
                  { id: 'T_short', isResolved: false, isOutdated: false, path: 'a.ts', line: 2, diffSide: 'RIGHT', comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [comment('short-1')] } }
                ]
              }
            }
          }
        }
      }
    } as unknown as GitHubClient
    const threads = await new FixtureProvider(client).listReviewThreads(repo, 1)
    expect(queries[0]!.query).toContain('comments(first: 10)')
    expect(queries.slice(1).map((entry) => entry.variables)).toEqual([{ threadId: 'T_long', cursor: 'c10' }])
    expect(threads.map((thread) => thread.comments.map((item) => item.id))).toEqual([['long-1', 'long-11'], ['short-1']])
    expect(threads[0]!.comments[0]!.reactions).toEqual({
      viewerCanReact: true,
      groups: [{ content: 'EYES', count: 2, viewerHasReacted: true, actors: ['ada'] }]
    })
  })
})

describe('GitHub reaction writes', () => {
  const parent = { number: 1, repository: { nameWithOwner: 'ACME/repo' } }
  const viewer = { login: 'viewer' }
  const answer = { change: { subject: { viewerCanReact: true, reactionGroups: [group('HEART', ['ada', 'viewer'], 2, true)] } } }
  const targets = [
    { __typename: 'PullRequest', ...parent },
    { __typename: 'IssueComment', isMinimized: false, pullRequest: parent },
    { __typename: 'PullRequestReview', isMinimized: false, reviewOf: parent },
    { __typename: 'PullRequestReviewComment', isMinimized: false, reviewPullRequest: parent }
  ]
  test('a reaction on the PR, a comment, a review, or an inline comment answers with the reactions after it', async () => {
    for (const node of targets)
      for (const add of [true, false]) {
        const calls: string[] = []
        const graphql: GraphQLClient = async <T>(query: string) => {
          calls.push(query)
          return (query.includes('mutation') ? answer : { viewer, node }) as T
        }
        const reactions = await changeGithubPrReaction({ graphql }, repo, 1, 'target', 'HEART', add)
        // One check, one write; the write's answer replaces a read.
        expect(calls).toHaveLength(2)
        expect(calls[1]).toContain(add ? 'addReaction' : 'removeReaction')
        expect(reactions.groups).toEqual([{ content: 'HEART', count: 2, viewerHasReacted: true, actors: ['ada'] }])
      }
  })
  test('the PR itself is named by its number, so a client needs no node id for it', async () => {
    const calls: Array<{ query: string; variables: unknown }> = []
    const graphql: GraphQLClient = async <T>(query: string, variables?: unknown) => {
      calls.push({ query, variables })
      return (query.includes('mutation') ? answer : { viewer, repository: { pullRequest: { id: 'PR_node' } } }) as T
    }
    await changeGithubPrReaction({ graphql }, repo, 1, null, 'HEART', true)
    expect(calls[0]!.variables).toEqual({ owner: 'acme', repo: 'repo', number: 1 })
    expect(calls[1]!.variables).toEqual({ id: 'PR_node', content: 'HEART' })
  })
  test('never writes to another PR, another repo, a hidden comment or review, or another node kind', async () => {
    for (const node of [
      { __typename: 'PullRequest', ...parent, number: 2 },
      { __typename: 'PullRequest', ...parent, repository: { nameWithOwner: 'other/repo' } },
      { ...targets[1], isMinimized: true },
      { ...targets[2], isMinimized: true },
      { __typename: 'Issue', ...parent },
      { __typename: 'IssueComment', isMinimized: false, pullRequest: null },
      null
    ]) {
      let writes = 0
      const graphql: GraphQLClient = async <T>(query: string) => {
        if (query.includes('mutation')) writes++
        return { viewer, node } as T
      }
      await expect(changeGithubPrReaction({ graphql }, repo, 1, 'target', 'HEART', true)).rejects.toThrow(
        'does not belong'
      )
      expect(writes).toBe(0)
    }
  })
})

describe('reaction writes as a page shows them', () => {
  const writes = (prReact: (content: string) => Promise<PrReactions>) =>
    new PrReactionWrites(() => ({ prReact: (_repo, _number, _target, content) => prReact(content) }), repo, 1)

  test('a reaction shows at once, the write\'s answer replaces it, and a newer read wins', async () => {
    const answered = deferred<PrReactions>()
    const page = writes(() => answered.promise)
    const read = hearts(0)
    const writing = page.toggle('C1', 'HEART', read)
    expect(page.shown('C1', read)).toEqual(hearts(1))
    answered.resolve({ ...hearts(2), groups: [{ content: 'HEART', count: 2, viewerHasReacted: true, actors: ['ada'] }] })
    await writing
    // Someone else reacted too; the write's answer says so before any read.
    expect(page.shown('C1', read)?.groups[0]?.count).toBe(2)
    // A read that differs from the one the write began from is newer.
    expect(page.shown('C1', hearts(5))).toEqual(hearts(5))
    expect(page.shown('C2', read)).toBe(read)
  })
  test('a failed write puts back what was shown', async () => {
    const page = writes(async () => {
      throw new Error('forbidden')
    })
    const read = hearts(1)
    const writing = page.toggle(null, 'HEART', read)
    expect(page.shown(null, read)).toEqual(hearts(0))
    await expect(writing).rejects.toThrow('forbidden')
    expect(page.shown(null, read)).toBe(read)
  })
  test('the answer to an earlier write does not undo a later toggle that is still queued', async () => {
    const first = deferred<PrReactions>()
    let calls = 0
    const page = writes(() => (++calls === 1 ? first.promise : Promise.resolve(hearts(0))))
    const read = hearts(0)
    const adding = page.toggle('C1', 'HEART', read)
    const removing = page.toggle('C1', 'HEART', read)
    expect(page.shown('C1', read)).toEqual(hearts(0))
    first.resolve(hearts(1))
    await adding
    expect(page.shown('C1', read)).toEqual(hearts(0))
    await removing
    expect(calls).toBe(2)
  })
  test('a page that closed takes no answer', async () => {
    const late = deferred<PrReactions>()
    const page = writes(() => late.promise)
    const read = hearts(0)
    const writing = page.toggle('C1', 'HEART', read)
    page.dispose()
    late.resolve(hearts(9))
    await writing
    expect(page.shown('C1', read)).toBe(read)
  })
  test('adding a held reaction or removing one not held changes nothing', () => {
    const added = withReaction(hearts(0), 'HEART', true)
    expect(added).toEqual(hearts(1))
    expect(withReaction(added, 'HEART', true)).toBe(added)
    expect(withReaction(added, 'HEART', false)).toEqual(hearts(0))
  })
  test('pills follow GitHub\'s order and name who reacted, the viewer first', () => {
    const shown = shownReactions({
      viewerCanReact: true,
      groups: [
        { content: 'EYES', count: 6, viewerHasReacted: false, actors: ['ada', 'bob', 'cy', 'di'] },
        { content: 'HEART', count: 3, viewerHasReacted: true, actors: ['ada', 'bob'] },
        { content: 'THUMBS_UP', count: 2, viewerHasReacted: false, actors: [] }
      ]
    })
    expect(shown.map((reaction) => reaction.label)).toEqual(['👍', '❤️', '👀'])
    expect(shown.map(reactionSummary)).toEqual([
      '2 people reacted with thumbs up',
      'You, ada and bob reacted with heart',
      'ada, bob, cy and 3 others reacted with eyes'
    ])
  })
})

describe('read-only PR URL inspection', () => {
  test('rejects other hosts, credentials in URLs, and invalid repository identities before provider access', async () => {
    let calls = 0
    for (const url of [
      'https://gitlab.com/a/b/pull/1',
      'https://user@github.com/a/b/pull/1',
      'https://github.com:444/a/b/pull/1',
      'https://github.com/a%2Fb/repo/pull/1',
      'https://github.com/a/b/pull/0'
    ]) {
      await expect(
        inspectPullRequestUrl(url, () => {
          calls++
          return null
        })
      ).rejects.toThrow()
    }
    expect(calls).toBe(0)
    expect(prRepoSchema.safeParse({ ...repo, repo: '..' }).success).toBe(false)
  })
  test('reads with repository identity and no project, with bounded transport output', async () => {
    const calls: string[] = []
    const value = await inspectPullRequestUrl(
      ' https://github.com/acme/repo/pull/1?x=1#comment ',
      (target) => {
        expect(target).toEqual(repo)
        return {
          getPullRequestOverview: async (_repo, number) => {
            calls.push('overview')
            expect(number).toBe(1)
            return {
              ...inspection.overview,
              pullRequest: pullRequestFixture(1, { body: 'a'.repeat(300_000) })
            }
          },
          listComments: async () => {
            calls.push('comments')
            return []
          },
          listReviewThreads: async () => {
            calls.push('threads')
            return []
          }
        }
      }
    )
    expect(calls).toEqual(['overview', 'comments', 'threads'])
    expect(value.readOnly).toBe(true)
    expect(value.truncated).toBe(true)
    expect(value.overview.pullRequest.body.length).toBeLessThan(270_000)
  })
  test('switching URLs or closing prevents an old response from reopening the inspector', async () => {
    const old = deferred<PrUrlInspection>()
    const store = new PrUrlInspectionStore(() => ({
      prInspectUrl: async (url) => (url === 'old' ? old.promise : inspection)
    }))
    const reading = store.open('old')
    await store.open('new')
    old.resolve({ ...inspection, readOnly: true })
    await reading
    expect(store.current.value).toBe(inspection)
    const late = deferred<PrUrlInspection>(),
      other = new PrUrlInspectionStore(() => ({ prInspectUrl: async () => late.promise }))
    const pending = other.open('url')
    other.close()
    late.resolve(inspection)
    await pending
    expect(other.current).toEqual({ value: null, pending: false, error: null })
  })
})
