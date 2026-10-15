import type { PrCommit, PrMergeMethod, PrReviewer, PullRequest, PullRequestOverview, RepoRef } from '@solus/contracts/providers'
import { z } from 'zod'
import type { GitHubClient } from './octokit'
import {
  branchMergeMethods,
  GITHUB_REPOSITORY_FACTS_FIELDS,
  githubAutoMergeMethod,
  githubPullRequestAccess,
  githubRepositorySettings,
  rememberGithubRepositoryFacts,
  type GithubRepositoryFacts,
} from './pull-request-actions'
import { headRepoOf, requestedReviewers, reviewStatusOf } from './pull-request-rows'

// ─── One pull request, read in one GraphQL request ────────────────────────────
// The detail, the viewer, the repository's merge settings, the base branch's
// rules, the reviewers and the first page of commits. REST needed `pulls.get`,
// `GET /user`, `repos.get`, a merge-methods query, the branch rules, the branch
// protection, the commits and the reviews for the same answer.

const COMMITS_PER_PAGE = 100

const COMMIT_FIELDS = `
  pageInfo { hasNextPage endCursor }
  nodes { commit { oid message committedDate author { name date user { login } } } }
`

const PULL_REQUEST_DETAIL_QUERY = `
  query PullRequestDetail($owner: String!, $repo: String!, $number: Int!) {
    viewer { login }
    repository(owner: $owner, name: $repo) {
      ${GITHUB_REPOSITORY_FACTS_FIELDS}
      pullRequest(number: $number) {
        number
        url
        title
        body
        state
        isDraft
        createdAt
        updatedAt
        author { login avatarUrl }
        headRefOid
        baseRefOid
        headRefName
        baseRefName
        additions
        deletions
        changedFiles
        mergeable
        mergeStateStatus
        reviewDecision
        reviews(first: 1) { totalCount }
        autoMergeRequest { mergeMethod }
        baseRepository { nameWithOwner }
        headRepository { nameWithOwner name owner { login } }
        labels(first: 100) { nodes { name color } }
        assignees(first: 100) { nodes { login } }
        reviewRequests(first: 100) { nodes { requestedReviewer { ... on User { login avatarUrl } } } }
        latestReviews(first: 100) { nodes { state author { login avatarUrl } } }
        latestOpinionatedReviews(first: 100) { nodes { state author { login avatarUrl } } }
        commits(first: ${COMMITS_PER_PAGE}) { ${COMMIT_FIELDS} }
        baseRef {
          branchProtectionRule { requiresLinearHistory requiredApprovingReviewCount }
          rules(first: 100) {
            nodes {
              type
              parameters { ... on PullRequestParameters { requiredApprovingReviewCount allowedMergeMethods } }
            }
          }
        }
      }
    }
  }
`

/** The commits after the first page, for the rare pull request with more. */
const PULL_REQUEST_COMMITS_QUERY = `
  query PullRequestCommits($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        commits(first: ${COMMITS_PER_PAGE}, after: $cursor) { ${COMMIT_FIELDS} }
      }
    }
  }
`

interface GqlCommitPage {
  pageInfo: { hasNextPage: boolean; endCursor: string | null }
  nodes: Array<{
    commit: {
      oid: string
      message: string
      committedDate: string
      author: { name: string | null; date: string | null; user: { login: string } | null } | null
    }
  } | null>
}

interface GqlReview {
  state: string
  author: { login: string; avatarUrl?: string } | null
}

interface GqlDetailPullRequest {
  number: number
  url: string
  title: string
  body: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  isDraft: boolean
  createdAt: string
  updatedAt: string
  author: { login: string; avatarUrl: string } | null
  headRefOid: string
  baseRefOid: string
  headRefName: string
  baseRefName: string
  additions: number
  deletions: number
  changedFiles: number
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  mergeStateStatus: string | null
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
  reviews: { totalCount: number }
  autoMergeRequest: { mergeMethod: string | null } | null
  baseRepository: { nameWithOwner: string } | null
  headRepository: { nameWithOwner: string; name: string; owner: { login: string } } | null
  labels: { nodes: Array<{ name: string; color: string } | null> }
  assignees: { nodes: Array<{ login: string } | null> }
  reviewRequests: { nodes: Array<{ requestedReviewer: { login?: string; avatarUrl?: string } | null } | null> }
  latestReviews: { nodes: Array<GqlReview | null> }
  latestOpinionatedReviews: { nodes: Array<GqlReview | null> }
  commits: GqlCommitPage
  /** Null when the base branch is gone. Absent when GitHub refused to say. */
  baseRef?: {
    branchProtectionRule: { requiresLinearHistory: boolean; requiredApprovingReviewCount: number | null } | null
    rules: {
      nodes: Array<{
        type: string
        parameters: { requiredApprovingReviewCount?: number; allowedMergeMethods?: string[] } | null
      } | null>
    } | null
  } | null
}

interface PullRequestDetailResponse {
  viewer: { login: string }
  repository: (GithubRepositoryFacts & { pullRequest: GqlDetailPullRequest | null }) | null
}

interface PullRequestCommitsResponse {
  repository: { pullRequest: { commits: GqlCommitPage } | null } | null
}

/** A missing PR in a repository GitHub did resolve is a domain result. */
const missingPullRequestSchema = z.object({
  data: z.object({ repository: z.object({ pullRequest: z.null() }) }),
  errors: z.array(z.object({
    type: z.literal('NOT_FOUND'),
    path: z.tuple([z.literal('repository'), z.literal('pullRequest')]),
  })).nonempty(),
})

/** The detail read, with the commit page it stopped at. */
export interface GithubPullRequestDetail extends PullRequestOverview {
  /** Where the commits continue; null when `commits` holds all of them. */
  commitsCursor: string | null
}

/**
 * Read one pull request in one request.
 *
 * A pull request missing from a repository this credential can see is final:
 * no other credential will find it. A repository this credential cannot see
 * stays GitHub's NOT_FOUND, so the credential chain tries the next one. All
 * other failures reach the shared request policy, including branch rule errors.
 */
export async function readGithubPullRequestDetail(
  client: GitHubClient,
  repo: RepoRef,
  number: number,
): Promise<GithubPullRequestDetail> {
  const response = await client.graphql<PullRequestDetailResponse>(PULL_REQUEST_DETAIL_QUERY, {
    owner: repo.owner,
    repo: repo.repo,
    number,
  }).catch((error) => rethrowDetailFailure(error, repo, number))
  const repository = response.repository
  const pr = repository?.pullRequest
  if (!repository || !pr) throw new Error(`Pull request #${number} was not found in ${repo.owner}/${repo.repo}.`)
  rememberGithubRepositoryFacts(client, repo, repository)

  return {
    pullRequest: toDetailPullRequest(pr, repo, response.viewer.login, repository),
    commits: commitsOf(pr.commits),
    reviewers: reviewersOf(pr),
    commitsCursor: pr.commits.pageInfo.hasNextPage ? pr.commits.pageInfo.endCursor : null,
  }
}

/** Keep a missing PR distinct from a repository hidden from this credential. */
function rethrowDetailFailure<Failure>(error: Failure, repo: RepoRef, number: number): never {
  if (missingPullRequestSchema.safeParse(error).success) {
    throw new Error(`Pull request #${number} was not found in ${repo.owner}/${repo.repo}.`)
  }
  throw error
}

/** The one mapping from the detail answer to the host-neutral pull request. */
function toDetailPullRequest(
  pr: GqlDetailPullRequest,
  repo: RepoRef,
  viewer: string,
  repository: GithubRepositoryFacts,
): PullRequest {
  const branch = branchPolicyOf(pr.baseRef)
  const access = githubPullRequestAccess({
    viewer,
    author: pr.author?.login ?? '',
    ...githubRepositorySettings(repository),
    branchMergeMethods: branch.mergeMethods,
  })
  const pullRequest: PullRequest = {
    number: pr.number,
    url: pr.url,
    title: pr.title,
    headSha: pr.headRefOid,
    baseSha: pr.baseRefOid,
    baseRepo: repo,
    headRepo: headRepoOf(
      repo,
      { owner: pr.headRepository?.owner.login, repo: pr.headRepository?.name, fullName: pr.headRepository?.nameWithOwner },
      pr.baseRepository?.nameWithOwner,
    ),
    author: pr.author?.login ?? '',
    authorAvatarUrl: pr.author?.avatarUrl ?? '',
    state: pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : 'open',
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    draft: pr.isDraft,
    labels: pr.labels.nodes.flatMap((label) => label ? [{ name: label.name, color: label.color }] : []),
    additions: pr.additions,
    deletions: pr.deletions,
    requestedReviewers: requestedReviewers(pr.reviewRequests.nodes.map((node) => node?.requestedReviewer ?? null)),
    assignees: pr.assignees.nodes.flatMap((user) => user?.login ? [user.login] : []),
    body: pr.body,
    baseRef: pr.baseRefName,
    headRef: pr.headRefName,
    changedFiles: pr.changedFiles,
    // GraphQL reports UNKNOWN while GitHub computes the merge in the background.
    mergeable: pr.mergeable === 'UNKNOWN' ? null : pr.mergeable === 'MERGEABLE',
    // Lowercase, as REST's `mergeable_state` spells the same states.
    mergeStateStatus: pr.mergeStateStatus?.toLowerCase() ?? null,
    requiredApprovingReviewCount: branch.requiredApprovingReviewCount,
    reviewStatus: reviewStatusOf(pr.reviewDecision, pr.reviews.totalCount),
    autoMergeEnabled: pr.autoMergeRequest !== null,
    ...access,
  }
  const autoMergeMethod = githubAutoMergeMethod(pr.autoMergeRequest?.mergeMethod)
  if (autoMergeMethod) pullRequest.autoMergeMethod = autoMergeMethod
  return pullRequest
}

/** The commits after `cursor`, to the end. */
export async function readGithubPullRequestCommits(
  client: GitHubClient,
  repo: RepoRef,
  number: number,
  cursor: string,
): Promise<PrCommit[]> {
  const commits: PrCommit[] = []
  let after: string | null = cursor
  while (after) {
    const response: PullRequestCommitsResponse = await client.graphql<PullRequestCommitsResponse>(
      PULL_REQUEST_COMMITS_QUERY,
      { owner: repo.owner, repo: repo.repo, number, cursor: after },
    )
    const page = response.repository?.pullRequest?.commits
    if (!page) break
    commits.push(...commitsOf(page))
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null
  }
  return commits
}

function commitsOf(page: GqlCommitPage): PrCommit[] {
  return page.nodes.flatMap((node) => node
    ? [{
        sha: node.commit.oid,
        // GitHub shows only the subject line in the timeline; drop the body.
        // `messageHeadline` is cut short with an ellipsis, so it is not used.
        message: node.commit.message.split('\n', 1)[0],
        author: node.commit.author?.user?.login ?? node.commit.author?.name ?? '',
        committedAt: node.commit.author?.date ?? node.commit.committedDate,
      }]
    : [])
}

const REVIEWER_STATES = new Map<string, NonNullable<PrReviewer['state']>>([
  ['APPROVED', 'APPROVED'],
  ['CHANGES_REQUESTED', 'CHANGES_REQUESTED'],
  ['COMMENTED', 'COMMENTED'],
  ['DISMISSED', 'DISMISSED'],
])

/**
 * Each reviewer's standing state, then the requested reviewers who have not
 * answered. GitHub's semantics: an approval or a change request holds until it
 * is dismissed or replaced, and a later comment does not demote it. That is
 * `latestOpinionatedReviews`; `latestReviews` names the reviewers who only
 * commented. A pending review is the viewer's own draft, not a state.
 */
function reviewersOf(pr: GqlDetailPullRequest): PrReviewer[] {
  const reviewers = new Map<string, PrReviewer>()
  const opinionated = new Map<string, GqlReview>()
  for (const review of pr.latestOpinionatedReviews.nodes) {
    if (review?.author?.login) opinionated.set(review.author.login, review)
  }
  for (const latest of pr.latestReviews.nodes) {
    const login = latest?.author?.login
    if (!login) continue
    const review = opinionated.get(login) ?? latest
    if (!review) continue
    if (review.state === 'PENDING') continue
    reviewers.set(login, reviewerOf(login, review.author?.avatarUrl, REVIEWER_STATES.get(review.state) ?? 'COMMENTED'))
  }
  for (const requested of requestedReviewers(pr.reviewRequests.nodes.map((node) => node?.requestedReviewer ?? null))) {
    if (!reviewers.has(requested.login)) reviewers.set(requested.login, reviewerOf(requested.login, requested.avatarUrl, null))
  }
  return [...reviewers.values()]
}

function reviewerOf(login: string, avatarUrl: string | undefined, state: PrReviewer['state']): PrReviewer {
  return avatarUrl ? { login, avatarUrl, state } : { login, state }
}

/** One active rule on the base branch, as the detail read names it. */
export interface GithubBranchRule {
  type: string
  parameters?: { required_approving_review_count?: number; allowed_merge_methods?: string[] }
}

interface BranchPolicy {
  /** What the rules leave of the repository's merge methods; null narrows nothing. */
  mergeMethods: PrMergeMethod[] | null
  /** Null when the rules could not be read. */
  requiredApprovingReviewCount: number | null
}

/**
 * The base branch's rulesets and classic protection, from the same answer.
 * Rules that could not be read narrow nothing: GitHub still refuses a
 * forbidden merge when it is sent, and the refusal names the reason.
 */
function branchPolicyOf(baseRef: GqlDetailPullRequest['baseRef']): BranchPolicy {
  if (!baseRef) return { mergeMethods: null, requiredApprovingReviewCount: null }
  const rules = (baseRef.rules?.nodes ?? []).flatMap((rule): GithubBranchRule[] => rule
    ? [{
        type: rule.type.toLowerCase(),
        parameters: {
          required_approving_review_count: rule.parameters?.requiredApprovingReviewCount,
          allowed_merge_methods: rule.parameters?.allowedMergeMethods,
        },
      }]
    : [])
  const protection = baseRef.branchProtectionRule
  return {
    mergeMethods: branchMergeMethods(rules, protection?.requiresLinearHistory ?? false),
    requiredApprovingReviewCount: requiredApprovalCount(rules, protection?.requiredApprovingReviewCount ?? null),
  }
}

/** The strongest active pull-request rule wins when repository and
 * organization rules both apply to the base branch. */
export function requiredApprovalCount(
  rules: GithubBranchRule[],
  branchProtectionCount: number | null = null,
): number {
  return rules.reduce(
    (required, rule) =>
      rule.type === 'pull_request'
        ? Math.max(required, rule.parameters?.required_approving_review_count ?? 0)
        : required,
    branchProtectionCount ?? 0,
  )
}
