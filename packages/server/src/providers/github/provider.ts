import { readAgentLinkedPullRequests, readAgentPullRequestSummary, readAgentPullRequestConversation, readAgentPullRequestList, readAgentPullRequestNumberForHead, readAgentReviewThreadComments } from './agent-pull-requests'
import type { AgentPullRequestConversationInput, AgentPullRequestListInput } from '../types'
import type { CheckItem } from '@solus/contracts/checks-types'
import { readActionsCheckLog, rerunActionsChecks } from './check-runs'
import { githubCredentials } from './credentials'
import { isGithubNotFound, type GitHubClient } from './octokit'
import { runGithubRequest } from './request'
import { resolveUploadTarget, uploadGithubAsset } from './asset-upload'
import type { ChangedFileStat, MergeMethod } from '@solus/contracts/types'
import type { PrPageRequest, PriorityNumbers, Provider, PullRequestWatchFingerprint, ReviewProvider } from '../types'
import { decodeWatchFingerprints, fingerprintRows } from './watch-fingerprints'
import { pullRequestsByNumber } from './pull-requests-by-number'
import { readPullRequestsByHead } from './pull-requests-by-head'
import type { PullRequestHead } from '@solus/contracts/repository-key'
import { ConditionalChecks } from './conditional-checks'
import type {
  DraftReview,
  PrDiffFileContents,
  PrDiffFileContentsRequest,
  PrDiffRequest,
  PrDiffSlice,
  PrReviewer,
  PrReviewerCandidate,
  PrFilter, PrListPage,
  PullRequest,
  PullRequestOverview,
  PullRequestUpdate,
  RepoRef,
  ReviewComment,
  ReviewThread,
  PrConversationItem,
  PrFilterChoice,
  PrLabel,
  PrRevertResult,
  PrStack,
  PrStackMergeRequest,
  PrStateAction,
  PrPendingWorkflowRun,
  PrViewedFileChange,
  PrViewedFiles,
  ProviderRepository,
  ProviderViewer,
} from '@solus/contracts/providers'
import { createLogger } from '../../logger'
import {
  GithubStackMergeRefusal,
  mergeGithubPullRequestStack,
  readPullRequestStack,
  type GithubStackMerge,
} from './stacks'
import { approveGithubWorkflowRuns, listGithubPendingWorkflowRuns } from './workflow-approvals'
import {
  githubDefaultBranchOf,
  headRepoOf,
  NEEDS_REVIEW_FIELDS,
  needsReviewSearchTerms,
  requestedReviewers,
  toNeedsReviewPullRequest,
  type GqlNeedsReviewPage,
} from './pull-request-rows'
import { readGithubViewedFiles, writeGithubViewedFiles } from './viewed-files'
import { canonicalRepoRef } from './canonical-repo'
import { readGithubPullRequestCommits, readGithubPullRequestDetail } from './pull-request-detail'
import { GITHUB_REACTION_FIELDS, toPrReactions, type GqlReactionFields } from './pr-social'
import { readGithubPullRequestDiff } from './pull-request-diff'
import { readPriorityNumbers, readPullRequestPages } from './pull-request-search'
import { checkRows, normalizeChecksResponse, uniquePrNumbers } from './checks'
import type { NumberedPrChecksSummary } from '@solus/contracts/checks-rpc-types'
import {
  AUTO_MERGE_REFUSAL_HINT,
  disableGithubAutoMerge,
  enableGithubAutoMerge,
  githubAutoMergeMethod,
  githubPullRequestAccessFor,
  githubWriteRefusal,
  listGithubReviewerCandidates,
  mergeAgentPullRequest,
  revertGithubPullRequest,
  updateGithubPullRequestBranch,
  updateGithubPullRequestLifecycle,
  type PrAutoMergeUpdate,
  type PullRequestAccess,
} from './pull-request-actions'
import { z } from 'zod'

const log = createLogger('main', 'github-provider')

/** GitHub's file change types folded onto git's status letters. `COPIED`,
 *  `CHANGED` and `MODIFIED` have no letter of their own and read as edits. */
const GITHUB_FILE_STATUS = new Map<string, ChangedFileStat['status']>([
  ['ADDED', 'A'],
  ['DELETED', 'D'],
  ['RENAMED', 'R'],
])

/** Per-file sizes without the patches: the diff reads those on its own, so
 *  REST's file list paid for every patch twice. */
const PULL_REQUEST_FILE_STATS_QUERY = `
  query PrFileStats($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        files(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { path additions deletions changeType }
        }
      }
    }
  }
`

interface PullRequestFileStatsResponse {
  repository: {
    pullRequest: {
      files: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null }
        nodes: Array<{ path: string; additions: number; deletions: number; changeType: string } | null> | null
      } | null
    } | null
  } | null
}

interface GithubDiffFile {
  filename: string
  previous_filename?: string
  status: string
  patch?: string
  changes?: number
}

function diffPath(path: string): string {
  return /[\s"\\]/.test(path) ? JSON.stringify(path) : path
}

/** Only a real commit id may scope a diff — the sha travels into an API path. */
const COMMIT_SHA_PATTERN = /^[0-9a-f]{7,40}$/i

/** Convert complete GitHub file records into a unified patch. Keeping this
 * file-based is what guarantees pagination never cuts through a hunk. */
interface UnifiedGithubPatch {
  patch: string
  truncated: boolean
}

export function githubFilesToUnifiedPatch(files: GithubDiffFile[]): UnifiedGithubPatch {
  let truncated = false
  const patches = files.map((file) => {
    const oldPath = file.previous_filename ?? file.filename
    const oldLabel = file.status === 'added' ? '/dev/null' : `a/${oldPath}`
    const newLabel = file.status === 'removed' ? '/dev/null' : `b/${file.filename}`
    const lines = [`diff --git ${diffPath(`a/${oldPath}`)} ${diffPath(`b/${file.filename}`)}`]
    if (file.status === 'added') lines.push('new file mode 100644')
    if (file.status === 'removed') lines.push('deleted file mode 100644')
    if (file.status === 'renamed') {
      // GitHub gives no score. @pierre/diffs reads the rename type from this
      // line, so a changed rename needs one too.
      lines.push(`similarity index ${file.patch || file.changes ? 0 : 100}%`)
      lines.push(`rename from ${oldPath}`, `rename to ${file.filename}`)
    }
    lines.push(`--- ${diffPath(oldLabel)}`, `+++ ${diffPath(newLabel)}`)
    if (file.patch) lines.push(file.patch)
    else if (file.status !== 'renamed') {
      // GitHub omits `patch` for binary and oversized files. The file remains
      // visible, but expanded source context must come from the contents RPC.
      truncated = true
      lines.push(`Binary files ${diffPath(oldLabel)} and ${diffPath(newLabel)} differ`)
    }
    return lines.join('\n')
  })
  return { patch: patches.join('\n'), truncated }
}

/** GitHub's compare response has no `head_commit` field. The last ahead
 * commit is the compared head; when there are no ahead commits, the merge
 * base is the head because it is equal to or behind the base revision. */
export function githubComparedHeadSha(comparison: {
  commits: Array<{ sha: string }>
  merge_base_commit: { sha: string }
}): string {
  return comparison.commits[comparison.commits.length - 1]?.sha ?? comparison.merge_base_commit.sha
}

// ─── GraphQL documents ────────────────────────────────────────────────────────
// REST can't report a thread's resolution state, and there is no REST mutation to
// resolve/unresolve — so threads and their lifecycle go through GraphQL (§6.3).

const THREAD_COMMENT_FIELDS = `id author { login avatarUrl } body createdAt lastEditedAt isMinimized diffHunk pullRequestReview { id } ${GITHUB_REACTION_FIELDS}`

// Ten comments ride with each thread, as T3 Code reads them: a hundred
// threads of a hundred comments made GitHub reserve 10,000 nested rows and
// charge about a hundred points for one page, and reactions multiply that.
// A thread with more is followed from its own cursor (REVIEW_THREAD_COMMENTS_QUERY).
const THREAD_COMMENTS_PER_PAGE = 10

const REVIEW_THREADS_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
    viewer { login }
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            isResolved
            isOutdated
            path
            line
            diffSide
            comments(first: ${THREAD_COMMENTS_PER_PAGE}) {
              pageInfo { hasNextPage endCursor }
              nodes { ${THREAD_COMMENT_FIELDS} }
            }
          }
        }
      }
    }
  }
`

/** The rest of one thread's comments. GraphQL pages a connection nested in
 *  another only from the inner node, so a long thread is read on its own. */
const REVIEW_THREAD_COMMENTS_QUERY = `
  query($threadId: ID!, $cursor: String) {
    node(id: $threadId) {
      ... on PullRequestReviewThread {
        comments(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { ${THREAD_COMMENT_FIELDS} }
        }
      }
    }
  }
`

const REPLY_MUTATION = `
  mutation($threadId: ID!, $body: String!) {
    addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
      comment { id author { login avatarUrl } body createdAt ${GITHUB_REACTION_FIELDS} }
    }
  }
`

const RESOLVE_MUTATION = `
  mutation($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) { thread { id } }
  }
`

const UNRESOLVE_MUTATION = `
  mutation($threadId: ID!) {
    unresolveReviewThread(input: { threadId: $threadId }) { thread { id } }
  }
`

const DELETE_ISSUE_COMMENT_MUTATION = `
  mutation($commentId: ID!) {
    deleteIssueComment(input: { id: $commentId }) { clientMutationId }
  }
`

const PR_CONVERSATION_QUERY = `
  query PrConversation(
    $owner: String!
    $repo: String!
    $number: Int!
    $commentsCursor: String
    $reviewsCursor: String
    $timelineCursor: String
    $includeComments: Boolean!
    $includeReviews: Boolean!
    $includeTimeline: Boolean!
  ) {
    viewer { login }
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        comments(first: 100, after: $commentsCursor) @include(if: $includeComments) {
          pageInfo { hasNextPage endCursor }
          nodes { id author { login avatarUrl } body createdAt lastEditedAt isMinimized url ${GITHUB_REACTION_FIELDS} }
        }
        reviews(first: 100, after: $reviewsCursor) @include(if: $includeReviews) {
          pageInfo { hasNextPage endCursor }
          nodes { id author { login avatarUrl } body createdAt lastEditedAt isMinimized submittedAt state url ${GITHUB_REACTION_FIELDS} }
        }
        timelineItems(
          first: 100
          after: $timelineCursor
          itemTypes: [LABELED_EVENT, UNLABELED_EVENT]
        ) @include(if: $includeTimeline) {
          pageInfo { hasNextPage endCursor }
          nodes {
            __typename
            ... on LabeledEvent {
              id
              actor { login avatarUrl }
              createdAt
              label { name color }
            }
            ... on UnlabeledEvent {
              id
              actor { login avatarUrl }
              createdAt
              label { name color }
            }
          }
        }
      }
    }
  }
`

const NEEDS_REVIEW_QUERY = `
  query(
    $requestedQuery: String!
    $assignedQuery: String!
    $requestedCursor: String
    $assignedCursor: String
    $includeRequested: Boolean!
    $includeAssigned: Boolean!
  ) {
    requested: search(
      query: $requestedQuery
      type: ISSUE
      first: 100
      after: $requestedCursor
    ) @include(if: $includeRequested) {
      pageInfo { hasNextPage endCursor }
      nodes { ...NeedsReviewFields }
    }
    assigned: search(
      query: $assignedQuery
      type: ISSUE
      first: 100
      after: $assignedCursor
    ) @include(if: $includeAssigned) {
      pageInfo { hasNextPage endCursor }
      nodes { ...NeedsReviewFields }
    }
  }
  ${NEEDS_REVIEW_FIELDS}
`

interface GqlComment extends GqlReactionFields {
  id: string
  author: { login: string; avatarUrl: string } | null
  body: string
  createdAt: string
  lastEditedAt?: string | null
  /** A maintainer hid it. Absent from a mutation's answer, which is never hidden. */
  isMinimized?: boolean
  diffHunk?: string
  /** The review the comment was submitted with; null on a lone comment. */
  pullRequestReview?: { id: string } | null
}

interface GqlThread {
  id: string
  isResolved: boolean
  isOutdated: boolean
  path: string
  line: number | null
  diffSide: 'LEFT' | 'RIGHT'
  comments: GqlThreadComments
}

interface GqlThreadComments {
  pageInfo: { hasNextPage: boolean; endCursor: string | null }
  nodes: GqlComment[]
}

interface ReviewThreadCommentsResponse {
  node: { comments: GqlThreadComments } | null
}

interface ReviewThreadsResponse {
  viewer: { login: string }
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null }
        nodes: GqlThread[]
      }
    }
  }
}

interface GqlConversationNode extends GqlReactionFields {
  id: string
  author: { login: string; avatarUrl: string } | null
  body: string
  createdAt: string
  lastEditedAt?: string | null
  isMinimized: boolean
  url?: string
}

interface GqlReviewBody extends GqlConversationNode {
  submittedAt: string | null
  state: Exclude<PrReviewer['state'], null>
}

interface GqlLabelEvent {
  __typename: 'LabeledEvent' | 'UnlabeledEvent'
  id: string
  actor: { login: string; avatarUrl: string } | null
  createdAt: string
  label: { name: string; color: string }
}

interface GqlConversationPage<T> {
  pageInfo: { hasNextPage: boolean; endCursor: string | null }
  nodes: T[]
}

interface PrConversationResponse {
  viewer: { login: string }
  repository: {
    pullRequest: {
      comments?: GqlConversationPage<GqlConversationNode>
      reviews?: GqlConversationPage<GqlReviewBody>
      timelineItems?: GqlConversationPage<GqlLabelEvent>
    }
  }
}

interface NeedsReviewSearchResponse {
  requested?: GqlNeedsReviewPage
  assigned?: GqlNeedsReviewPage
}

const githubApiErrorSchema = z.object({
  status: z.number().optional(),
  response: z
    .object({
      data: z
        .object({
          message: z.string().optional(),
          errors: z
            .array(
              z.object({
                message: z.string().optional(),
                resource: z.string().optional(),
                field: z.string().optional(),
                code: z.string().optional(),
              }),
            )
            .optional(),
        })
        .optional(),
    })
    .optional(),
})

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed || null
}

export function githubApiErrorMessage<T>(err: T, fallback: string): string {
  const parsed = githubApiErrorSchema.safeParse(err)
  const status = parsed.success ? parsed.data.status : undefined
  const responseData = parsed.success ? parsed.data.response?.data : undefined
  const bodyMessage = nonEmpty(responseData?.message)
  const details = responseData?.errors
    ? responseData.errors
        .map((detail) => {
          const message = nonEmpty(detail.message)
          if (message) return message

          const field = nonEmpty(detail.field)
          const code = nonEmpty(detail.code)
          const resource = nonEmpty(detail.resource)
          return [resource, field, code].filter(Boolean).join(' ')
        })
        .filter(Boolean)
    : []

  const parts = [bodyMessage, ...details].filter(Boolean)
  if (parts.length > 0) return `${fallback}${status ? ` (${status})` : ''}: ${parts.join('; ')}`

  const message = err instanceof Error ? err.message : String(err)
  return message ? `${fallback}: ${message}` : fallback
}

// ─── Mappers (Octokit/GraphQL → host-neutral DTOs) ────────────────────────────

/** Shared shape of a PR across the REST list and get responses we read. */
interface RestPull {
  node_id?: string
  number: number
  /** The pull request's own page, as GitHub names it. Every list and get
   *  response carries it, so Solus never has to assemble the string. */
  html_url: string
  title: string
  user: { login: string; avatar_url?: string } | null
  state: string
  merged_at: string | null
  created_at: string
  updated_at: string
  draft?: boolean
  labels?: Array<{ name: string; color: string }> | null
  additions?: number
  deletions?: number
  requested_reviewers?: Array<{ login: string; avatar_url?: string } | null> | null
  assignees?: Array<{ login: string } | null> | null
  body?: string | null
  changed_files?: number
  mergeable?: boolean | null
  mergeable_state?: string | null
  /** Null while auto-merge is off; GitHub names the method it will use. */
  auto_merge?: { merge_method?: string | null } | null
  base: { ref: string; sha: string; repo?: { full_name?: string; default_branch?: string } | null }
  head: { ref: string; sha: string; repo?: { full_name?: string; name?: string; owner?: { login?: string } } | null }
}

/** GitHub returns a null user where the account is gone. Those rows carry no
 *  login, so they name nobody rather than an empty reviewer. */
function logins(users: Array<{ login?: string } | null> | null | undefined): string[] {
  return (users ?? []).flatMap((user) => user?.login ? [user.login] : [])
}

/**
 * The one REST mapper. `pulls.list` and `pulls.get` return the same shape; the
 * list simply leaves the three host-computed fields off, which is what their
 * `null` means. Everything else — including access, which costs one memoised
 * `repos.get` for the whole page — is filled here so no reader downstream has
 * to ask which endpoint a row came from.
 */
function toPullRequest(
  pr: RestPull,
  repo: RepoRef,
  access: PullRequestAccess,
): PullRequest {
  return {
    number: pr.number,
    url: pr.html_url,
    title: pr.title,
    headSha: pr.head.sha,
    baseSha: pr.base.sha,
    baseRepo: repo,
    headRepo: headRepoOf(
      repo,
      { owner: pr.head.repo?.owner?.login, repo: pr.head.repo?.name, fullName: pr.head.repo?.full_name },
      pr.base.repo?.full_name,
    ),
    author: pr.user?.login ?? '',
    authorAvatarUrl: pr.user?.avatar_url ?? '',
    state: pr.merged_at ? 'merged' : pr.state === 'closed' ? 'closed' : 'open',
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    draft: pr.draft ?? false,
    labels: (pr.labels ?? []).map((l) => ({ name: l.name, color: l.color })),
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    requestedReviewers: requestedReviewers(pr.requested_reviewers),
    assignees: logins(pr.assignees),
    body: pr.body ?? '',
    baseRef: pr.base.ref,
    defaultBranch: githubDefaultBranchOf(pr.base.repo),
    headRef: pr.head.ref,
    changedFiles: pr.changed_files ?? null,
    mergeable: pr.mergeable ?? null,
    mergeStateStatus: pr.mergeable_state ?? null,
    ...autoMergeOf(pr),
    ...access,
  }
}

/** Left off entirely where GitHub did not answer: unknown is not "off". */
function autoMergeOf(pr: RestPull): Pick<PullRequest, 'autoMergeEnabled' | 'autoMergeMethod'> {
  const autoMerge: Pick<PullRequest, 'autoMergeEnabled' | 'autoMergeMethod'> = {}
  if (pr.auto_merge === undefined) return autoMerge
  autoMerge.autoMergeEnabled = pr.auto_merge !== null
  const autoMergeMethod = githubAutoMergeMethod(pr.auto_merge?.merge_method)
  if (autoMergeMethod) autoMerge.autoMergeMethod = autoMergeMethod
  return autoMerge
}

function toComment(c: GqlComment, viewer: string | null): ReviewComment {
  const comment: ReviewComment = {
    id: c.id,
    author: c.author?.login ?? '',
    body: c.body,
    createdAt: c.createdAt,
    reactions: toPrReactions(c, viewer),
  }
  if (c.author?.avatarUrl) comment.authorAvatarUrl = c.author.avatarUrl
  if (c.lastEditedAt) comment.editedAt = c.lastEditedAt
  if (c.diffHunk) comment.diffHunk = c.diffHunk
  if (c.pullRequestReview?.id) comment.reviewId = c.pullRequestReview.id
  return comment
}

/**
 * Comments a maintainer hid (minimized) are left out, as they are from the
 * conversation: they are spam, off-topic, or outdated, and reach no reader or
 * agent. A thread with no comment left is null.
 */
function toThread(t: GqlThread, viewer: string): ReviewThread | null {
  const comments = t.comments.nodes.filter((comment) => !comment.isMinimized)
  if (comments.length === 0) return null
  return {
    id: t.id,
    filePath: t.path,
    line: t.line,
    side: t.diffSide,
    isResolved: t.isResolved,
    isOutdated: t.isOutdated,
    comments: comments.map((comment) => toComment(comment, viewer)),
  }
}

/** The REST client targets api.github.com whatever `RepoRef.host` a caller
 *  passes, so the viewer identity is always the github.com one. */
const GITHUB_HOST = 'github.com'

/** The account a client is signed in as, read once per client. */
const viewerByClient = new WeakMap<GitHubClient, Promise<ProviderViewer>>()

function viewerProfile(client: GitHubClient): Promise<ProviderViewer> {
  let viewer = viewerByClient.get(client)
  if (!viewer) {
    viewer = client.rest.users.getAuthenticated()
      .then(({ data }) => {
        const profile: ProviderViewer = { login: data.login }
        if (data.avatar_url) profile.avatarUrl = data.avatar_url
        return profile
      })
      .catch((error) => {
        viewerByClient.delete(client)
        throw error
      })
    viewerByClient.set(client, viewer)
  }
  return viewer
}

async function viewerLogin(client: GitHubClient): Promise<string> {
  return (await viewerProfile(client)).login
}

/**
 * Access for one row. `githubPullRequestAccessFor` memoises the repository
 * settings per client, so a whole page costs one `repos.get` and one viewer
 * read no matter how many distinct authors it holds. It is repository-level:
 * no row but the detail read's reads its base branch's rules, and GitHub
 * refuses a merge they forbid. PR sync keeps the narrowing of a detail it
 * holds (`withBranchRules` in prs/pull-request.ts).
 */
async function accessFor(client: GitHubClient, repo: RepoRef, author: string): Promise<PullRequestAccess> {
  return githubPullRequestAccessFor(client, repo, await viewerLogin(client), author)
}

/**
 * Typed GitHub operations for PR review mode over REST + GraphQL. The consuming
 * layer imports `ReviewProvider`/DTOs only — never `@octokit/*`. Reads, threads,
 * and leaving review comments work identically for fork and same-repo PRs.
 */
export class GitHubProvider implements ReviewProvider {
  private diffBaseCache = new Map<string, Promise<string>>()

  constructor(private readonly checkout?: string) {}

  forCheckout(cwd: string): ReviewProvider {
    return new GitHubProvider(cwd)
  }

  /**
   * The clients to try for `host`, one per credential in chain order. This is
   * the provider's one seam: tests script GitHub's answers by replacing it.
   */
  protected async clients(host: string, credentialCwd?: string): Promise<GitHubClient[]> {
    return githubCredentials().clients(host, credentialCwd)
  }

  /**
   * Run one operation — read or write — with the first credential GitHub
   * accepts.
   *
   * A rejected token and GitHub's credential-specific access responses move to
   * the next client. GitHub uses both 403 and 404 when an OAuth app cannot see
   * an organization repository, while the user's gh credential may see it.
   * Validation, conflict, and other domain failures remain final.
   */
  private async withClient<Result>(
    operation: string,
    host: string,
    run: (client: GitHubClient) => Promise<Result>,
    credentialCwd = this.checkout,
  ): Promise<Result> {
    return runGithubRequest(operation, host, await this.clients(host, credentialCwd), run)
  }

  async getViewer(repo?: RepoRef): Promise<string> {
    if (!repo) return this.withClient('get_github_viewer', GITHUB_HOST, viewerLogin)
    return this.withClient('get_github_viewer_for_repo', repo.host, async (client) => {
      await accessFor(client, repo, '')
      return viewerLogin(client)
    })
  }

  async getViewerProfile(): Promise<ProviderViewer> {
    return this.withClient('get_github_viewer', GITHUB_HOST, viewerProfile)
  }

  /** Every repository the token can read — owned, collaborated on, and through
   *  organization membership — newest push first. Paginated to the end: a
   *  picker that stops at the first page hides the repository being looked for. */
  async listRepositories(): Promise<ProviderRepository[]> {
    return this.withClient('list_github_repositories', GITHUB_HOST, async (client) => {
      const repositories = await client.rest.paginate(client.rest.repos.listForAuthenticatedUser, {
        per_page: 100,
        sort: 'pushed',
        direction: 'desc',
      })
      return repositories.map((repository) => ({
        host: GITHUB_HOST,
        owner: repository.owner.login,
        repo: repository.name,
        isPrivate: repository.private,
        pushedAt: repository.pushed_at ?? null,
      }))
    })
  }

  /** Every repository is read with the first credential that answers; one it
   *  cannot see is null and is listed alone, down the whole chain. */
  async listPullRequestPages(
    requests: PrPageRequest[],
    filter: PrFilter | undefined,
    viewer: string,
  ): Promise<Array<PrListPage | null>> {
    if (requests.length === 0) return []
    return this.withClient('list_pull_request_pages', requests[0].repo.host, async (client) => {
      const login = viewer || await viewerLogin(client)
      // Repository-level access: a list row does not read its base branch's
      // rules. The detail read narrows the merge methods by them.
      return readPullRequestPages(client, requests, filter, (repo, author) =>
        githubPullRequestAccessFor(client, repo, login, author))
    })
  }

  async listPriorityNumbers(
    repos: RepoRef[],
    state: NonNullable<PrFilter['state']>,
    viewer: string,
  ): Promise<Array<PriorityNumbers | null>> {
    if (repos.length === 0) return []
    return this.withClient('list_priority_numbers', repos[0].host, async (client) =>
      readPriorityNumbers(client, repos, state, viewer || await viewerLogin(client)))
  }

  defaultPullRequestBase(repo: RepoRef): Promise<string> {
    return this.withClient('pull_request_default_base', repo.host, async (client) =>
      (await client.rest.repos.get({ owner: repo.owner, repo: repo.repo })).data.default_branch)
  }

  async createPullRequest(
    repo: RepoRef,
    input: { baseRef?: string; headRef: string; headRepo?: string; title: string; body: string; draft?: boolean; credentialCwd?: string },
  ): Promise<PullRequest> {
    return this.withClient('create_pull_request', repo.host, async (client) => {
      const repository = { owner: repo.owner, repo: repo.repo }
      const base = input.baseRef ?? (await client.rest.repos.get(repository)).data.default_branch
      const { data } = await client.rest.pulls.create({
        owner: repo.owner,
        repo: repo.repo,
        base,
        head: input.headRef,
        head_repo: input.headRepo,
        title: input.title,
        body: input.body,
        draft: input.draft,
      })
      return toPullRequest(data, repo, await accessFor(client, repo, data.user?.login ?? ''))
    }, input.credentialCwd)
  }

  async listPullRequestsNeedingReview(repo: RepoRef, viewer: string): Promise<PullRequest[]> {
    return this.withClient('list_pull_requests_needing_review', repo.host, async (client) => {
      // A renamed repository is still reachable by its old name everywhere except
      // search, where the stale qualifier silently matches nothing.
      const queries = needsReviewSearchTerms(await canonicalRepoRef(client, repo), viewer)
      const pullRequests = new Map<number, PullRequest>()
      let requestedCursor: string | null = null
      let assignedCursor: string | null = null
      let hasMoreRequested = true
      let hasMoreAssigned = true

      while (hasMoreRequested || hasMoreAssigned) {
        const response: NeedsReviewSearchResponse = await client.graphql<NeedsReviewSearchResponse>(NEEDS_REVIEW_QUERY, {
          ...queries,
          requestedCursor,
          assignedCursor,
          includeRequested: hasMoreRequested,
          includeAssigned: hasMoreAssigned,
        })
        const requested = response.requested
        const assigned = response.assigned
        for (const pr of [...(requested?.nodes ?? []), ...(assigned?.nodes ?? [])]) {
          if (!pr) continue
          const access = await accessFor(client, repo, pr.author?.login ?? '')
          pullRequests.set(pr.number, toNeedsReviewPullRequest(pr, repo, access))
        }
        hasMoreRequested = requested?.pageInfo.hasNextPage ?? false
        hasMoreAssigned = assigned?.pageInfo.hasNextPage ?? false
        requestedCursor = requested?.pageInfo.endCursor ?? requestedCursor
        assignedCursor = assigned?.pageInfo.endCursor ?? assignedCursor
      }

      return [...pullRequests.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    })
  }

  async getPullRequestDiffBase(repo: RepoRef, pullRequest: Pick<PullRequest, 'number' | 'baseSha' | 'headSha'>): Promise<string> {
    const key = `${repo.host}/${repo.owner}/${repo.repo}:${pullRequest.number}:${pullRequest.baseSha}:${pullRequest.headSha}`
    let pending = this.diffBaseCache.get(key)
    if (!pending) {
      pending = this.withClient('get_pull_request_diff_base', repo.host, async ({ rest }) => {
        const { data } = await rest.repos.compareCommitsWithBasehead({
          owner: repo.owner,
          repo: repo.repo,
          basehead: `${pullRequest.baseSha}...refs/pull/${pullRequest.number}/head`,
        })
        if (githubComparedHeadSha(data) !== pullRequest.headSha) {
          throw new Error('This pull request changed while its diff base was loading.')
        }
        return data.merge_base_commit.sha
      }).catch((error) => {
        this.diffBaseCache.delete(key)
        throw error
      })
      this.diffBaseCache.set(key, pending)
    }
    return pending
  }

  async getPullRequestDiff(repo: RepoRef, detail: Pick<PullRequest, 'number' | 'baseSha' | 'headSha'>, request: PrDiffRequest): Promise<PrDiffSlice> {
    if (detail.headSha !== request.headSha) {
      throw new Error('This pull request changed. Refresh it before reviewing the new diff.')
    }
    const page = request.cursor === undefined ? 1 : Number(request.cursor)
    if (!Number.isSafeInteger(page) || page < 1) throw new Error('Invalid pull request diff cursor.')
    return this.withClient('get_pull_request_diff', repo.host, async (client) => {
      const { rest } = client
      if (request.commitSha) {
        // One commit of the change rather than the whole of it. A commit is
        // content-addressed, so no base staleness check applies: the sha either
        // exists with exactly this diff or the request fails.
        if (!COMMIT_SHA_PATTERN.test(request.commitSha)) throw new Error('Invalid pull request commit.')
        const response = await rest.repos.getCommit({
          owner: repo.owner,
          repo: repo.repo,
          ref: request.commitSha,
          page,
          per_page: 100,
        })
        const converted = githubFilesToUnifiedPatch(response.data.files ?? [])
        const hasNextPage = /<[^>]+>;\s*rel="next"/.test(response.headers.link ?? '')
        return {
          patch: converted.patch,
          truncated: converted.truncated,
          nextCursor: hasNextPage ? String(page + 1) : null,
        }
      }
      // The first page asks for the whole diff in one answer. Opening the
      // review already read the diff base, so that half costs no request. A
      // later page means the whole diff was refused, and the file pages go on.
      const [diffBaseSha, whole] = await Promise.all([
        this.getPullRequestDiffBase(repo, detail),
        page === 1 ? readGithubPullRequestDiff(client, repo, request.number) : null,
      ])
      if (diffBaseSha !== request.baseSha) {
        throw new Error('This pull request base changed. Refresh it before reviewing the new diff.')
      }
      if (whole) return { patch: whole.patch, truncated: whole.truncated, nextCursor: null }
      const response = await rest.pulls.listFiles({
        owner: repo.owner,
        repo: repo.repo,
        pull_number: request.number,
        page,
        per_page: 100,
      })
      const converted = githubFilesToUnifiedPatch(response.data)
      const hasNextPage = /<[^>]+>;\s*rel="next"/.test(response.headers.link ?? '')
      return {
        patch: converted.patch,
        truncated: converted.truncated,
        nextCursor: hasNextPage ? String(page + 1) : null,
      }
    })
  }

  async getPullRequestDiffFileContents(
    repo: RepoRef,
    detail: PullRequest,
    request: PrDiffFileContentsRequest,
  ): Promise<PrDiffFileContents> {
    if (detail.headSha !== request.headSha) {
      throw new Error('This pull request changed. Refresh it before loading file contents.')
    }
    return this.withClient('get_pull_request_diff_file_contents', repo.host, async ({ rest }) => {
      const readFile = async (source: RepoRef, path: string, ref: string): Promise<string> => {
        const { data } = await rest.repos.getContent({ owner: source.owner, repo: source.repo, path, ref })
        if (Array.isArray(data) || data.type !== 'file' || !('content' in data)) {
          throw new Error(`GitHub did not return file contents for ${path}.`)
        }
        if (data.encoding !== 'base64') throw new Error(`GitHub returned an unsupported encoding for ${path}.`)
        return Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8')
      }
      const headRepo: RepoRef = { host: repo.host, owner: detail.headRepo.owner, repo: detail.headRepo.repo }
      if (request.commitSha) {
        // A commit-scoped diff compares against the commit's parent, not the PR
        // base, and the contents API accepts no `sha^` expression — resolve the
        // parent explicitly. A root commit has no parent; its old side is empty.
        if (!COMMIT_SHA_PATTERN.test(request.commitSha)) throw new Error('Invalid pull request commit.')
        const commitSha = request.commitSha
        const [oldContents, newContents] = await Promise.all([
          request.changeType === 'new'
            ? ''
            : rest.git.getCommit({ owner: repo.owner, repo: repo.repo, commit_sha: commitSha })
                .then(({ data: commit }) => {
                  const parentSha = commit.parents[0]?.sha
                  return parentSha ? readFile(headRepo, request.oldPath, parentSha) : ''
                }),
          request.changeType === 'deleted' ? '' : readFile(headRepo, request.newPath, commitSha),
        ])
        return { oldContents, newContents }
      }
      // Both sides and the base check at once. The old side reads at the base
      // the client names, and the answer stands only if that is still the diff
      // base; opening the review already read it, so the check is free.
      if (!COMMIT_SHA_PATTERN.test(request.baseSha)) throw new Error('Invalid pull request base.')
      const [, oldContents, newContents] = await Promise.all([
        this.getPullRequestDiffBase(repo, detail).then((diffBaseSha) => {
          if (diffBaseSha !== request.baseSha) {
            throw new Error('This pull request base changed. Refresh it before loading file contents.')
          }
        }),
        request.changeType === 'new' ? '' : readFile(repo, request.oldPath, request.baseSha),
        request.changeType === 'deleted' ? '' : readFile(headRepo, request.newPath, request.headSha),
      ])
      return { oldContents, newContents }
    })
  }

  agentPullRequestSummary(repo: RepoRef, number: number, input: { body: boolean; fresh?: boolean; checksOnly?: boolean }) {
    return this.withClient('agent_pull_request_summary', repo.host, (client) =>
      readAgentPullRequestSummary(client, repo, number, input))
  }

  agentPullRequestConversation(repo: RepoRef, number: number, input: AgentPullRequestConversationInput) {
    return this.withClient('agent_pull_request_activity', repo.host, (client) =>
      readAgentPullRequestConversation(client, repo, number, input))
  }

  agentPullRequestList(repo: RepoRef, input: AgentPullRequestListInput) {
    return this.withClient('agent_pull_request_list', repo.host, async (client) =>
      readAgentPullRequestList(client, repo, input, input.involvement === 'all' ? undefined : await viewerLogin(client)))
  }

  async agentLinkedPullRequests(repo: RepoRef, numbers: number[]) {
    return this.withClient('agent_linked_pull_requests', repo.host, client => readAgentLinkedPullRequests(client, repo, numbers))
  }

  async agentReviewThreadComments(repo: RepoRef, thread: Parameters<typeof readAgentReviewThreadComments>[1]) {
    return this.withClient('agent_review_thread_comments', repo.host, client => readAgentReviewThreadComments(client, thread))
  }

  async agentPullRequestNumberForHead(repo: RepoRef, head: PullRequestHead, fresh: boolean) {
    return this.withClient('agent_pull_request_number_for_head', repo.host, client => readAgentPullRequestNumberForHead(client, repo, head, fresh))
  }

  async agentMergePullRequest(repo: RepoRef, pr: PullRequest, method: MergeMethod, auto: boolean): Promise<PullRequest['state']> {
    if (repo.host === 'github.com') {
      return this.withClient('agent_merge_pull_request', repo.host, client => mergeAgentPullRequest(client, repo, pr, method, auto))
    }
    if (auto) return (await this.enablePullRequestAutoMerge(repo, pr.number, method, pr.headSha)).state
    const result = await this.mergePullRequest(repo, pr.number, method, pr.headSha)
    if (!result.merged) throw new Error(result.message ?? 'GitHub could not merge the pull request.')
    return 'merged'
  }

  async getPullRequest(repo: RepoRef, number: number): Promise<PullRequest> {
    return this.withClient('get_pull_request', repo.host, async (client) =>
      (await readGithubPullRequestDetail(client, repo, number)).pullRequest)
  }

  async getPullRequestOverview(repo: RepoRef, number: number): Promise<PullRequestOverview> {
    return this.withClient('get_pull_request_overview', repo.host, async (client) => {
      const detail = await readGithubPullRequestDetail(client, repo, number)
      const commits = detail.commitsCursor
        ? [...detail.commits, ...await readGithubPullRequestCommits(client, repo, number, detail.commitsCursor, detail.pullRequest.headSha)]
        : detail.commits
      return { pullRequest: detail.pullRequest, commits, reviewers: detail.reviewers }
    })
  }

  async getPullRequestOverviewPage(repo: RepoRef, number: number) {
    return this.withClient('get_pull_request_overview', repo.host, async (client) => {
      const detail = await readGithubPullRequestDetail(client, repo, number)
      const { pullRequest, commits, reviewers, commitsCursor } = detail
      const completeCommits = commitsCursor
        ? () => this.withClient('list_pull_request_commits', repo.host, async (current) => {
          // An opaque cursor and its first page belong to the same credential.
          const first = current === client ? detail : await readGithubPullRequestDetail(current, repo, number)
          if (first.pullRequest.headSha !== pullRequest.headSha) {
            throw new Error('This pull request changed. Refresh it to load its commits.')
          }
          return first.commitsCursor
            ? [...first.commits, ...await readGithubPullRequestCommits(current, repo, number, first.commitsCursor, pullRequest.headSha)]
            : first.commits
        })
        : undefined
      return { pullRequest, commits, reviewers, completeCommits }
    })
  }

  async getPullRequestStack(repo: RepoRef, number: number, options?: { headsOnly?: boolean }): Promise<PrStack | null> {
    return this.withClient('get_pull_request_stack', repo.host, async (client) => {
      return readPullRequestStack(client, repo, number, options).catch(async (error) => {
        // GitHub answers 404 both where stacks are not on and for a repository
        // this credential cannot see. Only the second should try the next credential.
        if (!isGithubNotFound(error)) throw error
        const repositoryVisible = await githubPullRequestAccessFor(client, repo, '', '').then(() => true, () => false)
        if (repositoryVisible) return null
        throw error
      })
    })
  }

  async getPullRequestsByHead(repo: RepoRef, heads: readonly PullRequestHead[]): Promise<Map<string, PullRequest[]>> {
    const answers = new Map<string, PullRequest[]>()
    const unique = [...new Map(heads.map((head) => [head.key, head])).values()]
    if (unique.length === 0) return answers
    // Lookups in other repositories on this account share the document (pull-requests-by-head.ts).
    await this.withClient('get_pull_requests_by_head', repo.host, async (client) => {
      const found = await readPullRequestsByHead(client, repo, unique)
      for (const head of unique) {
        const rows = await Promise.all((found.get(head.key) ?? []).map(async (row) =>
          toNeedsReviewPullRequest(row, repo, await accessFor(client, repo, row.author?.login ?? ''))))
        answers.set(head.key, rows.filter((pullRequest) => head.isHeadOf(pullRequest)))
      }
    })
    return answers
  }

  async getPullRequests(repo: RepoRef, numbers: number[]): Promise<Map<number, PullRequest | null>> {
    const answers = new Map<number, PullRequest | null>()
    const unique = [...new Set(numbers)].filter((number) => Number.isSafeInteger(number) && number > 0)
    if (unique.length === 0) return answers
    // Reads of other repositories on this account share the document (host-batches.ts).
    await this.withClient('get_pull_requests', repo.host, async (client) => {
      const rows = await pullRequestsByNumber.read(client, repo, unique)
      for (const number of unique) {
        const row = rows[`p${number}`]
        answers.set(number, row
          ? toNeedsReviewPullRequest(row, repo, await accessFor(client, repo, row.author?.login ?? ''))
          : null)
      }
    })
    return answers
  }

  async updatePullRequest(
    repo: RepoRef,
    number: number,
    patch: PullRequestUpdate,
  ): Promise<PullRequest> {
    interface PullRequestEditFields {
      title?: string
      body?: string
    }
    const fields: PullRequestEditFields = {}
    if (patch.title !== undefined) fields.title = patch.title
    if (patch.body !== undefined) fields.body = patch.body
    if (Object.keys(fields).length > 0) {
      await this.withClient('update_pull_request', repo.host, async ({ rest }) => {
        await rest.pulls.update({
          owner: repo.owner,
          repo: repo.repo,
          pull_number: number,
          ...fields,
        })
      })
    }
    return this.getPullRequest(repo, number)
  }

  async containsReviewThread(repo: RepoRef, number: number, threadId: string): Promise<boolean> {
    return this.withClient('contains_review_thread', repo.host, async ({ graphql }) => {
      const result = await graphql<{ repository: { pullRequest: { id: string } | null } | null; node: { pullRequest?: { id: string } } | null }>(`
        query AgentReviewThreadSubject($owner: String!, $repo: String!, $number: Int!, $thread: ID!) {
          repository(owner: $owner, name: $repo) { pullRequest(number: $number) { id } }
          node(id: $thread) { ... on PullRequestReviewThread { pullRequest { id } } }
        }`, { owner: repo.owner, repo: repo.repo, number, thread: threadId })
      const subject = result.repository?.pullRequest?.id
      return subject !== undefined && subject === result.node?.pullRequest?.id
    })
  }

  async listReviewThreads(repo: RepoRef, number: number): Promise<ReviewThread[]> {
    return this.withClient('list_pull_request_threads', repo.host, async ({ graphql }) => {
      const threads: ReviewThread[] = []
      let cursor: string | null = null
      for (;;) {
        const res: ReviewThreadsResponse = await graphql<ReviewThreadsResponse>(REVIEW_THREADS_QUERY, {
          owner: repo.owner,
          repo: repo.repo,
          number,
          cursor,
        })
        const page = res.repository.pullRequest.reviewThreads
        // Only a thread longer than its first page costs a request of its own.
        await Promise.all(page.nodes.map(async (node) => {
          let comments = node.comments
          while (comments.pageInfo.hasNextPage) {
            const more: ReviewThreadCommentsResponse = await graphql<ReviewThreadCommentsResponse>(
              REVIEW_THREAD_COMMENTS_QUERY,
              { threadId: node.id, cursor: comments.pageInfo.endCursor },
            )
            if (!more.node) break
            node.comments.nodes.push(...more.node.comments.nodes)
            comments = more.node.comments
          }
        }))
        for (const node of page.nodes) {
          const thread = toThread(node, res.viewer.login)
          if (thread) threads.push(thread)
        }
        if (!page.pageInfo.hasNextPage) break
        cursor = page.pageInfo.endCursor
      }
      return threads
    })
  }

  async listReviewerCandidates(repo: RepoRef, pullRequest: PullRequest): Promise<PrReviewerCandidate[]> {
    return this.withClient(
      'list_pull_request_reviewer_candidates',
      repo.host,
      (client) => listGithubReviewerCandidates(client, repo, pullRequest.number, pullRequest.author),
    )
  }

  async listLabelCandidates(repo: RepoRef): Promise<PrLabel[]> {
    return this.withClient('list_pull_request_label_candidates', repo.host, async ({ rest }) => {
      const labels = await rest.paginate(rest.issues.listLabelsForRepo, {
        owner: repo.owner,
        repo: repo.repo,
        per_page: 100,
      })
      return labels.map((label) => ({ name: label.name, color: label.color }))
    })
  }

  async listMentionableUsers(repo: RepoRef, query: string, limit: number): Promise<PrFilterChoice[]> {
    return this.withClient('list_mentionable_users', repo.host, async ({ graphql }) => {
      const res = await graphql<MentionableUsersResponse>(MENTIONABLE_USERS_QUERY, {
        owner: repo.owner,
        repo: repo.repo,
        query: query || undefined,
        first: limit,
      })
      return res.repository.mentionableUsers.nodes.map((user) => ({ value: user.login, avatarUrl: user.avatarUrl }))
    })
  }

  async setLabels(repo: RepoRef, number: number, names: string[]): Promise<PrLabel[]> {
    return this.withClient('set_pull_request_labels', repo.host, async ({ rest }) => {
      const { data } = await rest.issues.setLabels({
        owner: repo.owner,
        repo: repo.repo,
        issue_number: number,
        labels: names,
      })
      return data.map((label) => ({ name: label.name, color: label.color ?? '' }))
    })
  }

  async changeLabels(repo: RepoRef, number: number, change: { add: string[]; remove: string[] }): Promise<void> {
    const target = { owner: repo.owner, repo: repo.repo, issue_number: number }
    if (change.add.length) {
      await this.withClient('add_pull_request_labels', repo.host, ({ rest }) =>
        rest.issues.addLabels({ ...target, labels: change.add }))
    }
    for (const name of change.remove) {
      await this.withClient('remove_pull_request_label', repo.host, async ({ rest: client }) => {
        try {
          await client.rest.issues.removeLabel({ ...target, name })
        } catch (error) {
          if (!isGithubNotFound(error)) throw error
          // A second editor may have removed the label. Confirm that the
          // credential can still read this PR before treating 404 as success.
          const labels = await client.paginate(client.rest.issues.listLabelsOnIssue, { ...target, per_page: 100 })
          if (labels.some(label => label.name.toLowerCase() === name.toLowerCase())) throw error
        }
      })
    }
  }

  async requestReviewers(repo: RepoRef, number: number, logins: string[]): Promise<PrReviewer[]> {
    await this.withClient('request_reviewers', repo.host, async ({ rest }) => {
      const reviewers = logins.filter((login) => !login.includes('/'))
      const teams = logins.filter((login) => login.includes('/')).map((login) => {
        const [organization, slug, extra] = login.split('/')
        if (extra !== undefined || !slug || organization.toLowerCase() !== repo.owner.toLowerCase()) {
          throw new Error('A team reviewer must belong to the repository organization.')
        }
        return slug
      })
      await rest.pulls.requestReviewers({
        owner: repo.owner, repo: repo.repo, pull_number: number, reviewers, team_reviewers: teams,
      })
    })
    return this.readReviewers(repo, number)
  }

  async removeRequestedReviewer(repo: RepoRef, number: number, reviewerId: string, kind: 'user' | 'team' = 'user'): Promise<PrReviewer[]> {
    await this.withClient('remove_requested_reviewer', repo.host, async ({ rest }) => {
      await rest.pulls.removeRequestedReviewers({
        owner: repo.owner,
        repo: repo.repo,
        pull_number: number,
        reviewers: kind === 'team' ? [] : [reviewerId],
        ...(kind === 'team' ? { team_reviewers: [reviewerId] } : {}),
      })
    })
    return this.readReviewers(repo, number)
  }

  /** The reviewers after a change to them, from the one detail read. */
  private async readReviewers(repo: RepoRef, number: number): Promise<PrReviewer[]> {
    return this.withClient('list_pull_request_reviewers', repo.host, async (client) =>
      (await readGithubPullRequestDetail(client, repo, number)).reviewers)
  }

  async updatePullRequestLifecycle(
    repo: RepoRef,
    number: number,
    action: PrStateAction,
    expectedHeadSha: string,
  ): Promise<PullRequest> {
    return this.withClient('update_pull_request_lifecycle', repo.host, async (client) => {
      const { data: raw } = await client.rest.pulls.get({ owner: repo.owner, repo: repo.repo, pull_number: number })
      const access = await accessFor(client, repo, raw.user?.login ?? '')
      if (!access.viewerPermissions.actions.includes(action)) {
        throw new Error(`You do not have permission to ${action} this pull request.`)
      }
      if (!raw.node_id) throw new Error('GitHub did not return the pull request node ID.')
      const current = toPullRequest(raw, repo, access)
      const lifecycle = await updateGithubPullRequestLifecycle(
        client,
        repo,
        number,
        action,
        expectedHeadSha,
        { headSha: current.headSha, nodeId: raw.node_id, draft: current.draft },
      )
      return { ...current, ...lifecycle }
    })
  }

  async createReview(repo: RepoRef, number: number, review: DraftReview): Promise<void> {
    // One request = atomic from our side: either the whole batch posts or nothing does.
    try {
      type CreateReviewRequest = Parameters<GitHubClient['rest']['pulls']['createReview']>[0]
      const request: CreateReviewRequest = {
        owner: repo.owner,
        repo: repo.repo,
        pull_number: number,
        commit_id: review.commitId,
        event: review.event,
      }
      // GitHub treats an omitted optional body differently from an empty one.
      if (review.body) request.body = review.body
      if (review.comments.length > 0) {
        request.comments = review.comments.map((comment) => {
          const item = {
            path: comment.path,
            body: comment.body,
            line: comment.line,
            side: comment.side,
          }
          if (comment.startLine !== undefined) {
            Object.assign(item, { start_line: comment.startLine, start_side: comment.side })
          }
          return item
        })
      }
      await this.withClient('create_review', repo.host, async ({ rest }) => {
        await rest.pulls.createReview(request)
      })
    } catch (err) {
      throw new Error(githubApiErrorMessage(err, 'Could not submit the review'))
    }
  }

  async mergePullRequest(repo: RepoRef, number: number, method: MergeMethod, expectedHeadSha?: string): Promise<{ merged: boolean; message?: string }> {
    try {
      const { data } = await this.withClient('merge_pull_request', repo.host, ({ rest }) => rest.pulls.merge({
        owner: repo.owner,
        repo: repo.repo,
        pull_number: number,
        merge_method: method,
        sha: expectedHeadSha,
      }))
      return { merged: data.merged, message: data.message }
    } catch (err) {
      // 405/409 = not mergeable (conflicts, protection, stale head). Return the
      // host message so the individual PR action can explain the refusal.
      return { merged: false, message: githubApiErrorMessage(err, 'GitHub could not merge the pull request') }
    }
  }

  async enablePullRequestAutoMerge(
    repo: RepoRef,
    number: number,
    method: MergeMethod,
    expectedHeadSha: string,
  ): Promise<PullRequest> {
    try {
      return await this.writeAutoMerge('enable_pull_request_auto_merge', repo, number, (client, nodeId) =>
        enableGithubAutoMerge(client, nodeId, method, expectedHeadSha))
    } catch (err) {
      throw githubWriteRefusal(err, 'GitHub could not turn on auto-merge', AUTO_MERGE_REFUSAL_HINT)
    }
  }

  async disablePullRequestAutoMerge(repo: RepoRef, number: number): Promise<PullRequest> {
    try {
      return await this.writeAutoMerge('disable_pull_request_auto_merge', repo, number, disableGithubAutoMerge)
    } catch (err) {
      throw githubWriteRefusal(
        err,
        'GitHub could not turn off auto-merge',
        'Check that you have write access, and that the merge has not already happened.',
      )
    }
  }

  async revertPullRequest(repo: RepoRef, number: number): Promise<PrRevertResult> {
    try {
      return await this.withClient('revert_pull_request', repo.host, async (client) => {
        const { data: raw } = await client.rest.pulls.get({ owner: repo.owner, repo: repo.repo, pull_number: number })
        if (!raw.node_id) throw new Error('GitHub did not return the pull request node ID.')
        return revertGithubPullRequest(client, raw.node_id)
      })
    } catch (err) {
      throw githubWriteRefusal(
        err,
        'GitHub could not open a revert pull request',
        'Check that you have write access and that this pull request was merged on the host.',
      )
    }
  }

  async updatePullRequestBranch(
    repo: RepoRef,
    number: number,
    method: 'merge' | 'rebase',
    expectedHeadSha: string,
  ): Promise<void> {
    try {
      await this.withClient('update_pull_request_branch', repo.host, async (client) => {
        const { data: raw } = await client.rest.pulls.get({ owner: repo.owner, repo: repo.repo, pull_number: number })
        if (!raw.node_id) throw new Error('GitHub did not return the pull request node ID.')
        await updateGithubPullRequestBranch(client, raw.node_id, method, expectedHeadSha)
      })
    } catch (err) {
      throw githubWriteRefusal(
        err,
        'GitHub could not update the branch',
        'Check that you can push to the head branch and that it does not conflict with the base.',
      )
    }
  }

  async mergePullRequestStack(repo: RepoRef, request: PrStackMergeRequest, options?: { byStackNumber?: boolean }): Promise<GithubStackMerge> {
    try {
      return await this.withClient('merge_pull_request_stack', repo.host, (client) =>
        mergeGithubPullRequestStack(client, repo, request, undefined, options))
    } catch (err) {
      if (err instanceof GithubStackMergeRefusal) throw err
      throw githubWriteRefusal(
        err,
        'GitHub could not merge the stack',
        'Check that you have write access, that this repository has stacks, and that every layer to merge can merge.',
      )
    }
  }

  async listPendingWorkflowRuns(repo: RepoRef, pullRequest: PullRequest): Promise<PrPendingWorkflowRun[]> {
    return this.withClient('list_pending_workflow_runs', repo.host, (client) =>
      listGithubPendingWorkflowRuns(client, repo, pullRequest))
  }

  async approvePendingWorkflowRuns(repo: RepoRef, pullRequest: PullRequest): Promise<number> {
    try {
      return await this.withClient('approve_pending_workflow_runs', repo.host, (client) =>
        approveGithubWorkflowRuns(client, repo, pullRequest))
    } catch (err) {
      throw githubWriteRefusal(
        err,
        'GitHub could not approve the workflow runs',
        'Check that you have write access to this repository.',
      )
    }
  }

  async listViewedFiles(repo: RepoRef, number: number): Promise<PrViewedFiles> {
    return this.withClient('list_viewed_files', repo.host, (client) => readGithubViewedFiles(client, repo, number))
  }

  async setFilesViewed(repo: RepoRef, number: number, changes: PrViewedFileChange[]): Promise<void> {
    try {
      await this.withClient('set_files_viewed', repo.host, (client) => writeGithubViewedFiles(client, repo, number, changes))
    } catch (err) {
      throw githubWriteRefusal(err, 'GitHub could not save which files you viewed', 'Refresh the pull request and try again.')
    }
  }

  /** One auto-merge write: read the pull request for its node ID, run the
   *  mutation, and answer the pull request as the mutation left it. */
  private writeAutoMerge(
    operation: string,
    repo: RepoRef,
    number: number,
    write: (client: GitHubClient, nodeId: string) => Promise<PrAutoMergeUpdate>,
  ): Promise<PullRequest> {
    return this.withClient(operation, repo.host, async (client) => {
      const { data: raw } = await client.rest.pulls.get({ owner: repo.owner, repo: repo.repo, pull_number: number })
      if (!raw.node_id) throw new Error('GitHub did not return the pull request node ID.')
      const current = toPullRequest(raw, repo, await accessFor(client, repo, raw.user?.login ?? ''))
      return { ...current, ...(await write(client, raw.node_id)) }
    })
  }

  async listPullRequestFileStats(repo: RepoRef, number: number): Promise<ChangedFileStat[]> {
    return this.withClient('list_pull_request_file_stats', repo.host, async ({ graphql }) => {
      const stats: ChangedFileStat[] = []
      let cursor: string | null = null
      for (;;) {
        const response: PullRequestFileStatsResponse = await graphql<PullRequestFileStatsResponse>(
          PULL_REQUEST_FILE_STATS_QUERY,
          { owner: repo.owner, repo: repo.repo, number, cursor },
        )
        const files = response.repository?.pullRequest?.files
        if (!files) throw new Error(`Pull request #${number} was not found in ${repo.owner}/${repo.repo}.`)
        for (const file of files.nodes ?? []) {
          if (!file) continue
          stats.push({
            path: file.path,
            additions: file.additions,
            deletions: file.deletions,
            status: GITHUB_FILE_STATUS.get(file.changeType) ?? 'M',
          })
        }
        if (!files.pageInfo.hasNextPage) return stats
        cursor = files.pageInfo.endCursor
      }
    })
  }

  async replyToThread(repo: RepoRef, threadId: string, body: string): Promise<ReviewComment> {
    return this.withClient('reply_to_thread', repo.host, async ({ graphql }) => {
      // Reply by thread node id directly — the REST replies endpoint needs the first
      // comment's numeric id, which our signature doesn't carry. GraphQL is cleaner here.
      const res = await graphql<{ addPullRequestReviewThreadReply: { comment: GqlComment } }>(
        REPLY_MUTATION,
        { threadId, body },
      )
      // A new reply has no reactions yet, so no viewer is needed to read them.
      return toComment(res.addPullRequestReviewThreadReply.comment, null)
    })
  }

  async resolveThread(repo: RepoRef, threadId: string): Promise<void> {
    await this.withClient('resolve_thread', repo.host, ({ graphql }) => graphql(RESOLVE_MUTATION, { threadId }))
  }

  async unresolveThread(repo: RepoRef, threadId: string): Promise<void> {
    await this.withClient('unresolve_thread', repo.host, ({ graphql }) => graphql(UNRESOLVE_MUTATION, { threadId }))
  }

  async listComments(repo: RepoRef, number: number): Promise<PrConversationItem[]> {
    return this.withClient('list_pull_request_comments', repo.host, async ({ graphql }) => {
      const items: PrConversationItem[] = []
      let commentsCursor: string | null = null
      let reviewsCursor: string | null = null
      let timelineCursor: string | null = null
      let includeComments = true
      let includeReviews = true
      let includeTimeline = true

      // The two GraphQL connections paginate independently. Once one is complete,
      // @include keeps later pages of the other from refetching duplicate nodes.
      while (includeComments || includeReviews || includeTimeline) {
        const res: PrConversationResponse = await graphql<PrConversationResponse>(PR_CONVERSATION_QUERY, {
          owner: repo.owner,
          repo: repo.repo,
          number,
          commentsCursor,
          reviewsCursor,
          timelineCursor,
          includeComments,
          includeReviews,
          includeTimeline,
        })
        const conversation: PrConversationResponse['repository']['pullRequest'] = res.repository.pullRequest
        if (conversation.comments) {
          // A comment or review a maintainer hid (minimized) is left out: it is
          // spam, off-topic, or outdated, and reaches no reader or agent.
          for (const comment of conversation.comments.nodes.filter((node) => !node.isMinimized)) {
            const item: PrConversationItem = {
              id: comment.id,
              kind: 'comment',
              author: comment.author?.login ?? '',
              body: comment.body,
              createdAt: comment.createdAt,
              reactions: toPrReactions(comment, res.viewer.login),
            }
            if (comment.author?.avatarUrl) item.authorAvatarUrl = comment.author.avatarUrl
            if (comment.lastEditedAt) item.editedAt = comment.lastEditedAt
            if (comment.url) item.url = comment.url
            items.push(item)
          }
          includeComments = conversation.comments.pageInfo.hasNextPage
          commentsCursor = conversation.comments.pageInfo.endCursor
        }
        if (conversation.reviews) {
          for (const review of conversation.reviews.nodes.filter((node) => !node.isMinimized)) {
            // A bodiless review is still an event: an approval, or the owner
            // of inline threads. The client drops one that is neither.
            if (review.state === 'PENDING') continue
            const item: PrConversationItem = {
              id: review.id,
              kind: 'review',
              author: review.author?.login ?? '',
              body: review.body,
              createdAt: review.submittedAt ?? review.createdAt,
              reviewState: review.state,
              reactions: toPrReactions(review, res.viewer.login),
            }
            if (review.author?.avatarUrl) item.authorAvatarUrl = review.author.avatarUrl
            if (review.lastEditedAt) item.editedAt = review.lastEditedAt
            if (review.url) item.url = review.url
            items.push(item)
          }
          includeReviews = conversation.reviews.pageInfo.hasNextPage
          reviewsCursor = conversation.reviews.pageInfo.endCursor
        }
        if (conversation.timelineItems) {
          for (const event of conversation.timelineItems.nodes) {
            const item: PrConversationItem = {
              id: event.id,
              kind: 'label',
              author: event.actor?.login ?? '',
              createdAt: event.createdAt,
              action: event.__typename === 'LabeledEvent' ? 'added' : 'removed',
              label: event.label,
            }
            if (event.actor?.avatarUrl) item.authorAvatarUrl = event.actor.avatarUrl
            items.push(item)
          }
          includeTimeline = conversation.timelineItems.pageInfo.hasNextPage
          timelineCursor = conversation.timelineItems.pageInfo.endCursor
        }
      }

      return items.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    })
  }

  async addIssueComment(repo: RepoRef, number: number, body: string): Promise<{ id: string; url: string }> {
    return this.withClient('add_issue_comment', repo.host, async ({ rest }) => {
      const { data } = await rest.issues.createComment({
        owner: repo.owner,
        repo: repo.repo,
        issue_number: number,
        body,
      })
      return { id: data.node_id, url: data.html_url }
    })
  }

  /**
   * Upload a stored asset through the endpoint GitHub's own CLI uses for
   * `--attach`, and return the URL a comment can reference.
   *
   * GitHub has no attachment API in the REST reference; this endpoint is the
   * one its web composer and `gh` both use, so the bytes land where a normal
   * attachment would rather than as a file committed into the repository.
   */
  async publishAsset(repo: RepoRef, assetId: string): Promise<string> {
    return this.withClient('publish_asset', repo.host, async (client) => {
      const target = await resolveUploadTarget(client, repo.owner, repo.repo)
      return uploadGithubAsset(client, target, assetId)
    })
  }

  async deleteIssueComment(repo: RepoRef, commentId: string): Promise<void> {
    await this.withClient('delete_issue_comment', repo.host, ({ graphql }) =>
      graphql(DELETE_ISSUE_COMMENT_MUTATION, { commentId }))
  }

  /** Check summaries held since their last GraphQL read (conditional-checks.ts). */
  private readonly heldChecks = new ConditionalChecks()

  /** Only the pull requests whose checks moved are read in full, and reads of
   *  other repositories on this account share the document. */
  readCheckLog(repo: RepoRef, check: CheckItem, headSha: string, tailLines: number) {
    return this.withClient('read_check_log', repo.host, (client) => readActionsCheckLog(client, repo, check, headSha, tailLines))
  }

  rerunChecks(repo: RepoRef, checks: CheckItem[], headSha: string) {
    return this.withClient('rerun_checks', repo.host, (client) => rerunActionsChecks(client, repo, checks, headSha))
  }

  async listChecks(repo: RepoRef, numbers: number[]): Promise<NumberedPrChecksSummary[]> {
    const unique = uniquePrNumbers(numbers)
    if (unique.length === 0) return []
    return this.withClient('list_pull_request_checks', repo.host, (client) =>
      this.heldChecks.read(client, repo, unique, async (moved) =>
        normalizeChecksResponse(await checkRows.read(client, repo, moved), moved, (message) => log.warn('pr_checks_normalize_warning', { message }))))
  }

  async readWatchFingerprints(repo: RepoRef, numbers: number[]): Promise<Map<number, PullRequestWatchFingerprint>> {
    if (numbers.length === 0) return new Map()
    return this.withClient('read_pull_request_watch_fingerprints', repo.host, async (client) =>
      decodeWatchFingerprints(await fingerprintRows.read(client, repo, numbers), numbers))
  }
}

export function makeGitHubProvider(): Provider {
  // Read at each use: tests install their own credentials after this registry is built.
  return { id: 'github', get auth() { return githubCredentials() }, review: new GitHubProvider() }
}

interface MentionableUsersResponse {
  repository: { mentionableUsers: { nodes: Array<{ login: string; avatarUrl: string }> } }
}

const MENTIONABLE_USERS_QUERY = `
  query($owner: String!, $repo: String!, $query: String, $first: Int!) {
    repository(owner: $owner, name: $repo) {
      mentionableUsers(first: $first, query: $query) { nodes { login avatarUrl } }
    }
  }
`
