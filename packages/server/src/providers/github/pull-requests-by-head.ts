import type { RepoRef } from '@solus/contracts/providers'
import { HostBatches } from './host-batches'
import type { GitHubClient } from './octokit'
import { NEEDS_REVIEW_FIELDS, type GqlNeedsReviewPullRequest } from './pull-request-rows'

/** Pull requests read per branch. A branch seldom has more than one. */
const PER_BRANCH = 5

/** One branch of one read, with the alias its rows come back under. */
interface HeadLookup {
  alias: string
  head: string
}

/**
 * PR sync's lookup of the pull requests opened from a branch
 * (docs/plans/pr-sync.md §3.2): every state, newest first, in documents
 * shared by the repositories of one account (host-batches.ts).
 */
const pullRequestsByHead = new HostBatches<{ nodes: Array<GqlNeedsReviewPullRequest | null> }, HeadLookup>({
  operation: 'PrSyncByHead',
  perDocument: 20,
  // JSON's string escapes are GraphQL's, so the branch name cannot leave its string.
  field: ({ alias, head }) => `${alias}: pullRequests(headRefName: ${JSON.stringify(head)}, first: ${PER_BRANCH}, orderBy: { field: CREATED_AT, direction: DESC }) {
        nodes { ...NeedsReviewFields }
      }`,
  fragments: NEEDS_REVIEW_FIELDS,
})

/** The pull requests opened from each branch, newest first. A branch with none has an empty list. */
export async function readPullRequestsByHead(
  client: GitHubClient,
  repo: RepoRef,
  heads: string[],
): Promise<Map<string, GqlNeedsReviewPullRequest[]>> {
  const lookups = heads.map((head, index) => ({ alias: `h${index}`, head }))
  const rows = await pullRequestsByHead.read(client, repo, lookups)
  return new Map(lookups.map(({ alias, head }) => [head, (rows[alias]?.nodes ?? []).flatMap((node) => node ? [node] : [])]))
}
