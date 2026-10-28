import type { RepoRef } from '@solus/contracts/providers'
import { repositoryKeyOf, type PullRequestHead } from '@solus/contracts/repository-key'
import { HostBatches } from './host-batches'
import type { GitHubClient } from './octokit'
import { NEEDS_REVIEW_FIELDS, type GqlNeedsReviewPullRequest } from './pull-request-rows'

/** Pull requests read per head. A head seldom has more than one into the
 *  base repository, but a ref also names pull requests into other
 *  repositories, such as forks opened from upstream's branch, and those are
 *  dropped after the read. */
const PER_HEAD = 20
/** Pull requests read per branch name when the head's branch is gone. Many
 *  forks can share a name, such as `patch-1`, and the exact head is kept. */
const PER_NAME = 50

type Rows = { nodes: Array<GqlNeedsReviewPullRequest | null> }

/** One branch of one read, with the alias its rows come back under. */
interface BranchLookup {
  alias: string
  branch: string
}

/**
 * The pull requests opened from one branch of the head repository
 * (docs/plans/pr-sync.md §3.2). A ref names one repository and one branch,
 * so the answer is exact: no other fork's branch of the same name is in it.
 * Null when the branch is not on the code host: never pushed, or deleted
 * after its pull request merged.
 */
const pullRequestsOfRef = new HostBatches<{ associatedPullRequests: Rows }, BranchLookup>({
  operation: 'PrSyncByHeadRef',
  perDocument: 20,
  // JSON's string escapes are GraphQL's, so the branch name cannot leave its string.
  field: ({ alias, branch }) => `${alias}: ref(qualifiedName: ${JSON.stringify(`refs/heads/${branch}`)}) {
        associatedPullRequests(first: ${PER_HEAD}, orderBy: { field: CREATED_AT, direction: DESC }) {
          nodes { ...NeedsReviewFields }
        }
      }`,
  fragments: NEEDS_REVIEW_FIELDS,
})

/**
 * The base repository's pull requests from any branch of one name, for a head
 * whose branch is gone. The name matches in every fork; the caller keeps the
 * exact head.
 */
const pullRequestsByName = new HostBatches<Rows, BranchLookup>({
  operation: 'PrSyncByHead',
  perDocument: 20,
  field: ({ alias, branch }) => `${alias}: pullRequests(headRefName: ${JSON.stringify(branch)}, first: ${PER_NAME}, orderBy: { field: CREATED_AT, direction: DESC }) {
        nodes { ...NeedsReviewFields }
      }`,
  fragments: NEEDS_REVIEW_FIELDS,
})

/**
 * The pull requests into `repo` opened from each head, newest first, by head
 * key. PR sync's lookup of the pull requests of a branch (docs/plans/pr-sync.md
 * §3.2), in documents shared by the repositories of one account
 * (host-batches.ts). Each head is read from its own repository's ref. A head
 * whose ref is gone, or whose repository this credential cannot read, is read
 * from `repo` by branch name. Rows of the name read can still name another
 * fork: the caller keeps the rows of the exact head.
 */
export async function readPullRequestsByHead(
  client: GitHubClient,
  repo: RepoRef,
  heads: readonly PullRequestHead[],
): Promise<Map<string, GqlNeedsReviewPullRequest[]>> {
  const base = `${repo.owner}/${repo.repo}`.toLowerCase()
  const intoBase = (rows: Rows | null | undefined) => (rows?.nodes ?? []).flatMap((node) =>
    node && node.baseRepository?.nameWithOwner.toLowerCase() === base ? [node] : [])
  const answers = new Map<string, GqlNeedsReviewPullRequest[]>()
  const gone: PullRequestHead[] = []

  const byRepository = new Map<string, PullRequestHead[]>()
  for (const head of heads) {
    const key = repositoryKeyOf(head.repository)
    byRepository.set(key, [...byRepository.get(key) ?? [], head])
  }
  await Promise.all([...byRepository.values()].map(async (group) => {
    const lookups = group.map((head, index) => ({ alias: `h${index}`, branch: head.branch }))
    const rows = await pullRequestsOfRef.read(client, group[0]!.repository, lookups).catch(() => null)
    group.forEach((head, index) => {
      const ref = rows?.[lookups[index]!.alias]
      if (ref) answers.set(head.key, intoBase(ref.associatedPullRequests))
      else gone.push(head)
    })
  }))

  if (gone.length) {
    const names = [...new Set(gone.map((head) => head.branch))]
    const lookups = names.map((branch, index) => ({ alias: `n${index}`, branch }))
    const rows = await pullRequestsByName.read(client, repo, lookups)
    const byName = new Map(lookups.map(({ alias, branch }) => [branch, intoBase(rows[alias])]))
    for (const head of gone) answers.set(head.key, byName.get(head.branch) ?? [])
  }
  return answers
}
