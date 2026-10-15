import type { PrChecksState } from '@solus/contracts/checks-types'
import type { PrRequestedReviewer, PullRequest, RepoRef } from '@solus/contracts/providers'
import { githubAutoMergeMethod, type PullRequestAccess } from './pull-request-actions'
import { STACK_MEMBERSHIP_FIELDS, stackMembershipOf, type GqlStackMembership } from './stacks'

// ─── Pull request rows ────────────────────────────────────────────────────────
// One GraphQL row shape and one mapper for every read that lists pull requests
// through GraphQL: the list (`pull-request-search.ts`), PR sync, and
// by-number reads.

/** Everything `PullRequest` needs from a GraphQL row. Named once so no two
 *  reads can select different fields for the same rows. */
export const NEEDS_REVIEW_FIELDS = `
  fragment NeedsReviewFields on PullRequest {
    number
    url
    title
    headRefOid
    author { login avatarUrl }
    state
    createdAt
    updatedAt
    isDraft
    labels(first: 100) { nodes { name color } }
    additions
    deletions
    reviewRequests(first: 100) {
      nodes {
        requestedReviewer {
          ... on User { login avatarUrl }
        }
      }
    }
    assignees(first: 100) { nodes { login } }
    body
    baseRefName
    baseRefOid
    headRefName
    changedFiles
    mergeable
    reviewDecision
    reviews(first: 1) { totalCount }
    baseRepository { nameWithOwner }
    headRepository { nameWithOwner name owner { login } }
    autoMergeRequest { mergeMethod }
    commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
    ${STACK_MEMBERSHIP_FIELDS}
  }
`

export interface GqlNeedsReviewPullRequest extends GqlStackMembership {
  number: number
  url: string
  title: string
  headRefOid: string
  author: { login: string; avatarUrl: string } | null
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  createdAt: string
  updatedAt: string
  isDraft: boolean
  labels: { nodes: Array<{ name: string; color: string }> }
  additions: number
  deletions: number
  reviewRequests: {
    nodes: Array<{ requestedReviewer: { login?: string; avatarUrl?: string } | null }>
  }
  assignees: { nodes: Array<{ login: string }> }
  body: string
  baseRefName: string
  baseRefOid: string
  headRefName: string
  changedFiles: number
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
  reviews: { totalCount: number }
  baseRepository: { nameWithOwner: string } | null
  headRepository: { nameWithOwner: string; name: string; owner: { login: string } } | null
  /** Null while auto-merge is off. Absent from a row that did not select it. */
  autoMergeRequest?: { mergeMethod: string | null } | null
  /** The head commit's check rollup. Absent from a row that did not select it. */
  commits?: { nodes: Array<{ commit: { statusCheckRollup: { state: string } | null } } | null> }
}

export interface GqlNeedsReviewPage {
  pageInfo: { hasNextPage: boolean; endCursor: string | null }
  nodes: Array<GqlNeedsReviewPullRequest | null>
}

interface NeedsReviewSearchTerms {
  requestedQuery: string
  assignedQuery: string
}

export function needsReviewSearchTerms(repo: RepoRef, viewer: string): NeedsReviewSearchTerms {
  const scope = `repo:${repo.owner}/${repo.repo} is:pr is:open`
  return {
    requestedQuery: `${scope} review-requested:${viewer}`,
    assignedQuery: `${scope} assignee:${viewer}`,
  }
}

export function toNeedsReviewPullRequest(
  pr: GqlNeedsReviewPullRequest,
  repo: RepoRef,
  access: PullRequestAccess,
): PullRequest {
  return {
    number: pr.number,
    url: pr.url,
    title: pr.title,
    headSha: pr.headRefOid,
    baseSha: pr.baseRefOid,
    baseRepo: repo,
    headRepo: headRepoOf(
      repo,
      {
        owner: pr.headRepository?.owner.login,
        repo: pr.headRepository?.name,
        fullName: pr.headRepository?.nameWithOwner,
      },
      pr.baseRepository?.nameWithOwner,
    ),
    author: pr.author?.login ?? '',
    authorAvatarUrl: pr.author?.avatarUrl ?? '',
    state: pr.state === 'OPEN' ? 'open' : pr.state === 'MERGED' ? 'merged' : 'closed',
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    draft: pr.isDraft,
    labels: pr.labels.nodes,
    additions: pr.additions,
    deletions: pr.deletions,
    requestedReviewers: requestedReviewers(
      pr.reviewRequests.nodes.map((node) => node.requestedReviewer),
    ),
    assignees: pr.assignees.nodes.map(({ login }) => login),
    body: pr.body,
    baseRef: pr.baseRefName,
    headRef: pr.headRefName,
    changedFiles: pr.changedFiles,
    // GraphQL reports UNKNOWN while GitHub computes the merge in the background.
    mergeable: pr.mergeable === 'UNKNOWN' ? null : pr.mergeable === 'MERGEABLE',
    // `mergeStateStatus` is behind an Accept-header preview this query does not
    // request; search rows say "not computed" rather than guessing a state.
    mergeStateStatus: null,
    reviewStatus: reviewStatusOf(pr.reviewDecision, pr.reviews.totalCount),
    stack: stackMembershipOf(pr),
    ...autoMergeOfRow(pr),
    ...checksOfRow(pr),
    ...access,
  }
}

/** GitHub's rollup states on the list's four. A row that did not select the
 *  rollup leaves the field off; a head with no checks reads `none`. */
function checksOfRow(pr: GqlNeedsReviewPullRequest): Pick<PullRequest, 'checksState'> {
  if (!pr.commits) return {}
  return { checksState: checksStateOf(pr.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null) }
}

export function checksStateOf(rollupState: string | null): PrChecksState {
  if (rollupState === null) return 'none'
  if (rollupState === 'SUCCESS') return 'passing'
  if (rollupState === 'FAILURE' || rollupState === 'ERROR') return 'failing'
  return 'pending'
}

/** The same rule as the REST mapper: a row that did not say leaves the fields off. */
function autoMergeOfRow(pr: GqlNeedsReviewPullRequest): Pick<PullRequest, 'autoMergeEnabled' | 'autoMergeMethod'> {
  if (pr.autoMergeRequest === undefined) return {}
  const autoMergeMethod = githubAutoMergeMethod(pr.autoMergeRequest?.mergeMethod)
  return autoMergeMethod
    ? { autoMergeEnabled: pr.autoMergeRequest !== null, autoMergeMethod }
    : { autoMergeEnabled: pr.autoMergeRequest !== null }
}

export type PullRequestReviewStatus = NonNullable<PullRequest['reviewStatus']>

export function reviewStatusOf(
  decision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null,
  reviewCount: number,
): PullRequestReviewStatus {
  if (decision === 'APPROVED') return 'approved'
  if (decision === 'CHANGES_REQUESTED') return 'changes-requested'
  if (decision === 'REVIEW_REQUIRED') return 'review-required'
  return reviewCount === 0 ? 'no-reviews' : 'reviewed'
}

/**
 * Where the head branch lives. It is a fork when its repository differs from the
 * base's; a head repository GitHub no longer names — a deleted fork — reads as
 * the base rather than as a repository that does not exist.
 *
 * Shared by both mappers so the REST and search views of one pull request can
 * never disagree about whether it came from a fork.
 */
export function headRepoOf(
  base: RepoRef,
  head: { owner?: string; repo?: string; fullName?: string },
  baseFullName: string | undefined,
): PullRequest['headRepo'] {
  return {
    owner: head.owner ?? base.owner,
    repo: head.repo ?? base.repo,
    isFork: !!head.fullName && !!baseFullName && head.fullName !== baseFullName,
  }
}

/** The same rule as `logins`, keeping the profile image the list already paid
 *  for so a row can draw the reviewer rather than their initials. Both of
 *  GitHub's spellings land here: REST's `avatar_url` and GraphQL's `avatarUrl`. */
export function requestedReviewers(
  users: Array<{ login?: string; avatarUrl?: string; avatar_url?: string } | null> | null | undefined,
): PrRequestedReviewer[] {
  return (users ?? []).flatMap((user) => {
    if (!user?.login) return []
    const avatarUrl = user.avatarUrl ?? user.avatar_url
    return [avatarUrl ? { login: user.login, avatarUrl } : { login: user.login }]
  })
}

