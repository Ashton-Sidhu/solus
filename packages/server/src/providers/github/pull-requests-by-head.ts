import type { RepoRef } from '@solus/contracts/providers'
import type { PullRequestHead } from '@solus/contracts/repository-key'
import { HostBatches } from './host-batches'
import type { GitHubClient } from './octokit'
import { NEEDS_REVIEW_FIELDS, type GqlNeedsReviewPullRequest } from './pull-request-rows'

/** Pull requests read per branch name, newest first. A name can match other
 *  forks' branches (`patch-1`), so the caller keeps the exact head's rows. */
const PER_NAME = 50

type Rows = { nodes: Array<GqlNeedsReviewPullRequest | null> }

/** One branch of one read, with the alias its rows come back under. */
interface BranchLookup {
  alias: string
  branch: string
}

/**
 * The base repository's pull requests from any branch of one name
 * (docs/plans/pr-sync.md §3.2). One query per lookup, as t3code reads it
 * (`PullRequestsByHead`): a branch deleted after its pull request merged is
 * still found, and the exact head is kept by the caller.
 */
const pullRequestsByName = new HostBatches<Rows, BranchLookup>({
  operation: 'PrSyncByHead',
  perDocument: 20,
  // JSON's string escapes are GraphQL's, so the branch name cannot leave its string.
  field: ({ alias, branch }) => `${alias}: pullRequests(headRefName: ${JSON.stringify(branch)}, first: ${PER_NAME}, orderBy: { field: CREATED_AT, direction: DESC }) {
        nodes { ...NeedsReviewFields }
      }`,
  fragments: NEEDS_REVIEW_FIELDS,
})

/**
 * The pull requests into `repo` opened from each head's branch name, newest
 * first, by head key: one query for every head of the read, in documents
 * shared by the repositories of one account (host-batches.ts). Rows can name
 * another fork's branch of the same name: the caller keeps the exact head's.
 */
export async function readPullRequestsByHead(
  client: GitHubClient,
  repo: RepoRef,
  heads: readonly PullRequestHead[],
): Promise<Map<string, GqlNeedsReviewPullRequest[]>> {
  const names = [...new Set(heads.map((head) => head.branch))]
  const lookups = names.map((branch, index) => ({ alias: `h${index}`, branch }))
  const rows = await pullRequestsByName.read(client, repo, lookups)
  const byName = new Map(lookups.map(({ alias, branch }) => [branch, (rows[alias]?.nodes ?? []).flatMap((node) => node ? [node] : [])]))
  return new Map(heads.map((head) => [head.key, byName.get(head.branch) ?? []]))
}
