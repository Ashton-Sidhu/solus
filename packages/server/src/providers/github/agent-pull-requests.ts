import type { RepoRef } from '@solus/contracts/providers'
import { GraphqlResponseError } from '@octokit/graphql'
import { z } from 'zod'
import { repositoryKeyOf, type PullRequestHead } from '@solus/contracts/repository-key'
import type { AgentLinkedPullRequest, AgentPullRequestConversationInput, AgentPullRequestConversationPage, AgentPullRequestListInput, AgentPullRequestListRow, AgentPullRequestSummary, AgentReviewThread } from '../types'
import { agentCheckRuns, githubCheckRollupFields, type GqlChecksPullRequest } from './checks'
import { HostBatches, pullRequestByNumber } from './host-batches'
import { STACK_MEMBERSHIP_FIELDS, stackMembershipOf, type GqlStackMembership } from './stacks'
import { isGithubCredentialAccessFailure, type GitHubClient } from './octokit'
import { githubRateLimitOf } from './rate-limit'

interface CacheEntry<Value> {
  value: Promise<Value>
  expires: number
}

const clients = new WeakMap<GitHubClient, number>()
let clientSequence = 0

class CredentialReads<Value> {
  private readonly entries = new Map<string, CacheEntry<Value>>()

  invalidate(repo: RepoRef): void {
    const prefix = repositoryKeyOf(repo) + '#'
    for (const key of this.entries.keys()) if (key.startsWith(prefix)) this.entries.delete(key)
  }

  private key(client: GitHubClient, repo: RepoRef, request: string): string {
    let id = clients.get(client)
    if (id === undefined) {
      id = ++clientSequence
      clients.set(client, id)
    }
    return `${repositoryKeyOf(repo)}#${id}:${request}`
  }

  held(client: GitHubClient, repo: RepoRef, request: string): Promise<Value> | undefined {
    const entry = this.entries.get(this.key(client, repo, request))
    return entry && Date.now() < entry.expires ? entry.value : undefined
  }

  read(client: GitHubClient, repo: RepoRef, request: string, alternate: string | undefined,
    load: () => Promise<Value>, ttl: (value: Value) => number): Promise<Value> {
    const key = this.key(client, repo, request)
    for (const candidate of alternate ? [key, this.key(client, repo, alternate)] : [key]) {
      const matching = this.entries.get(candidate)
      if (matching && Date.now() < matching.expires) return matching.value
    }
    const entry: CacheEntry<Value> = { value: load(), expires: Infinity }
    this.entries.delete(key)
    this.entries.set(key, entry)
    if (this.entries.size > 512) this.entries.delete(this.entries.keys().next().value!)
    void entry.value.then((value) => {
      entry.expires = Date.now() + ttl(value)
    }, () => {
      if (this.entries.get(key) === entry) this.entries.delete(key)
    })
    return entry.value
  }
}

const summaries = new CredentialReads<AgentPullRequestSummary>()
const checkSummaries = new CredentialReads<AgentPullRequestSummary>()
const activities = new CredentialReads<AgentPullRequestConversationPage>()
const listings = new CredentialReads<Awaited<ReturnType<typeof loadList>>>()
const branchNumbers = new CredentialReads<number | undefined>()
const linked = new CredentialReads<AgentLinkedPullRequest | null>()
const linkedRows = new HostBatches<GqlStackMembership & {
  headRefName: string; baseRefName: string; headRepository: { nameWithOwner: string } | null
}>({
  operation: 'AgentLinkedPullRequests',
  perDocument: 25,
  field: pullRequestByNumber(() => `headRefName baseRefName headRepository { nameWithOwner } ${STACK_MEMBERSHIP_FIELDS}`),
})

export function invalidateAgentPullRequestReads(repo: RepoRef): void {
  summaries.invalidate(repo)
  checkSummaries.invalidate(repo)
  activities.invalidate(repo)
  listings.invalidate(repo)
  branchNumbers.invalidate(repo)
  linked.invalidate(repo)
}

export function readAgentPullRequestNumberForHead(client: GitHubClient, repo: RepoRef, head: PullRequestHead, fresh: boolean) {
  const load = async () => {
    interface BranchRow {
      number: number
      state: SummaryRow['state']
      headRepository: { nameWithOwner: string } | null
      isCrossRepository: boolean
    }
    const answer = await client.graphql<{ repository: { pullRequests: { nodes: BranchRow[] } } | null }>(`
      query AgentPullRequestNumberForHead($owner: String!, $repo: String!, $branch: String!) {
        repository(owner: $owner, name: $repo) {
          pullRequests(headRefName: $branch, first: 50, orderBy: { field: CREATED_AT, direction: DESC }) {
            nodes { number state isCrossRepository headRepository { nameWithOwner } }
          }
        }
      }`, { owner: repo.owner, repo: repo.repo, branch: head.branch })
    const scope = repositoryKeyOf(head.repository)
    const matches = answer.repository?.pullRequests.nodes.filter(row => {
      if (row.headRepository) return `${repo.host}/${row.headRepository.nameWithOwner}`.toLowerCase() === scope
      return !row.isCrossRepository && repositoryKeyOf(repo) === scope
    })
    return (matches?.find(row => row.state === 'OPEN') ?? matches?.[0])?.number
  }
  return fresh ? load() : branchNumbers.read(client, repo, head.key, undefined, load, () => 30_000)
}

export async function readAgentLinkedPullRequests(client: GitHubClient, repo: RepoRef, numbers: number[]) {
  const unique = [...new Set(numbers)]
  const missing = unique.filter(number => !linked.held(client, repo, String(number)))
  const batch = missing.length ? linkedRows.read(client, repo, missing) : undefined
  const entries = await Promise.all(unique.map(async number => {
    const found = await linked.read(client, repo, String(number), undefined, async () => {
      const row = (await batch)?.[`p${number}`]
      if (!row) return null
      const head = row.headRepository?.nameWithOwner
      return { headRef: row.headRefName, baseRef: row.baseRefName, stack: stackMembershipOf(row),
        isFork: !head || head.toLowerCase() !== `${repo.owner}/${repo.repo}`.toLowerCase() }
    }, () => 60_000)
    return [number, found] as const
  }))
  return new Map(entries)
}

const IDENTITY = 'number url title state isDraft author { login } headRefName baseRefName'
const SUMMARY_QUERY = `
  query AgentPullRequestSummary($owner: String!, $repo: String!, $number: Int!, $body: Boolean!, $threads: Boolean!, $headRef: String!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        ${IDENTITY}
        headRefOid baseRefOid mergeable autoMergeRequest { enabledAt }
        body @include(if: $body)
        baseRef @include(if: $threads) { compare(headRef: $headRef) { behindBy } }
        reviewThreads(first: 100) @include(if: $threads) { totalCount nodes { isResolved } }
        ${githubCheckRollupFields('$number', true)}
      }
    }
  }
`

interface SummaryRow extends GqlChecksPullRequest {
  url: string
  title: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  isDraft: boolean
  author: { login: string } | null
  headRefName: string
  baseRefName: string
  baseRefOid: string
  baseRef?: { compare: { behindBy: number } | null } | null
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  autoMergeRequest: { enabledAt: string } | null
  reviewThreads?: { totalCount: number; nodes: Array<{ isResolved: boolean }> }
  body?: string
}

interface SummaryAnswer {
  repository: { pullRequest: SummaryRow | null } | null
}

async function loadSummary(client: GitHubClient, repo: RepoRef, number: number, body: boolean, checksOnly = false): Promise<AgentPullRequestSummary> {
  const result = await client.graphql<SummaryAnswer>(SUMMARY_QUERY, {
    owner: repo.owner, repo: repo.repo, number, body, threads: !checksOnly, headRef: `refs/pull/${number}/head`,
  }).catch((error) => {
    // The compare can be absent for a deleted or inaccessible head. Keep
    // the response only when GitHub places every error at that one field.
    if (error instanceof GraphqlResponseError && error.data && error.errors?.length &&
        error.errors.every(item => item.type === 'NOT_FOUND' && item.path?.join('.') === 'repository.pullRequest.baseRef.compare')) {
      // SAFETY: GitHub returned the requested document and identified only the nullable comparison as unavailable.
      return error.data as SummaryAnswer
    }
    throw error
  })
  const row = result.repository?.pullRequest
  if (!row) throw new Error(`Pull request #${number} is unavailable.`)
  const rollup = row.commits.nodes[0]?.commit.statusCheckRollup
  const threads = row.reviewThreads
  return {
    number: row.number, url: row.url, title: row.title, state: stateOf(row.state), isDraft: row.isDraft,
    author: row.author?.login ?? null, headBranch: row.headRefName, baseBranch: row.baseRefName,
    headSha: row.headRefOid, baseSha: row.baseRefOid, mergeability: row.mergeable.toLowerCase() === 'mergeable'
      ? 'mergeable' : row.mergeable === 'CONFLICTING' ? 'conflicting' : 'unknown',
    behindBy: row.state === 'OPEN' ? row.baseRef?.compare?.behindBy ?? null : null,
    autoMergeEnabled: row.autoMergeRequest !== null,
    checkRuns: agentCheckRuns(row),
    checksIncomplete: !!rollup && rollup.contexts.totalCount > rollup.contexts.nodes.length,
    unresolvedThreads: threads?.nodes.filter(thread => !thread.isResolved).length ?? 0,
    unresolvedThreadsTruncated: !!threads && threads.totalCount > threads.nodes.length,
    body: row.body,
  }
}

function stateOf(state: SummaryRow['state']): AgentPullRequestSummary['state'] {
  if (state === 'MERGED') return 'merged'
  return state === 'OPEN' ? 'open' : 'closed'
}

/** Only completed reads get a TTL. Fresh mutations bypass both held and in-flight reads. */
export function readAgentPullRequestSummary(client: GitHubClient, repo: RepoRef, number: number, input: { body: boolean; fresh?: boolean; checksOnly?: boolean }) {
  if (input.fresh) return loadSummary(client, repo, number, input.body, input.checksOnly)
  if (input.checksOnly) return checkSummaries.read(client, repo, String(number), undefined,
    () => loadSummary(client, repo, number, false, true), () => 15_000)
  return summaries.read(client, repo, `${number}:${input.body}`, input.body ? undefined : `${number}:true`,
    () => loadSummary(client, repo, number, input.body), summary => summary.state === 'merged' ? 600_000 : 60_000)
}

interface Connection<Row> {
  pageInfo: { hasNextPage: boolean; endCursor: string | null }
  nodes: Row[]
}

const PAGE = 'pageInfo { hasNextPage endCursor }'
const COMMENT = 'author { login } body createdAt'
const ACTIVITY_QUERY = `
  query AgentPullRequestActivity($owner: String!, $repo: String!, $number: Int!,
    $threads: Boolean!, $comments: Boolean!, $reviews: Boolean!, $threadCursor: String, $commentCursor: String, $reviewCursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        id
        reviewThreads(first: 20, after: $threadCursor) @include(if: $threads) {
          ${PAGE}
          nodes { id path line isResolved isOutdated comments(first: 10) { ${PAGE} nodes { id isMinimized ${COMMENT} } } }
        }
        comments(first: 20, after: $commentCursor) @include(if: $comments) {
          ${PAGE} nodes { id ${COMMENT} isMinimized }
        }
        reviews(first: 20, after: $reviewCursor) @include(if: $reviews) {
          ${PAGE} nodes { id state author { login } body submittedAt isMinimized }
        }
      }
    }
  }
`
interface CommentNode {
  author: { login: string } | null
  body: string
  createdAt: string
}

type ThreadCommentNode = CommentNode & { id: string; isMinimized: boolean }

interface ActivityRow {
  id: string
  comments?: Connection<CommentNode & { id: string; isMinimized: boolean }>
  reviews?: Connection<Omit<CommentNode, 'createdAt'> & {
    id: string; state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING'
    submittedAt: string | null; isMinimized: boolean
  }>
  reviewThreads?: Connection<{
    id: string; path: string; line: number | null; isResolved: boolean; isOutdated: boolean
    comments: Connection<ThreadCommentNode>
  }>
}

function next<Row>(page?: Connection<Row>): string | undefined {
  return page?.pageInfo.hasNextPage ? page.pageInfo.endCursor ?? undefined : undefined
}

function comment(node: CommentNode) {
  return { author: node.author?.login ?? '', body: node.body, createdAt: node.createdAt }
}

export function readAgentPullRequestConversation(
  client: GitHubClient, repo: RepoRef, number: number, input: AgentPullRequestConversationInput,
): Promise<AgentPullRequestConversationPage> {
  return activities.read(client, repo, JSON.stringify([number, input]), undefined,
    () => loadConversation(client, repo, number, input), () => 60_000)
}

async function loadConversation(
  client: GitHubClient, repo: RepoRef, number: number, input: AgentPullRequestConversationInput,
): Promise<AgentPullRequestConversationPage> {
  const result = await client.graphql<{ repository: { pullRequest: ActivityRow | null } | null }>(ACTIVITY_QUERY, {
    owner: repo.owner, repo: repo.repo, number,
    threads: input.threads !== undefined, comments: input.comments !== undefined, reviews: input.reviews !== undefined,
    threadCursor: input.threads ?? null, commentCursor: input.comments ?? null, reviewCursor: input.reviews ?? null,
  })
  const row = result.repository?.pullRequest
  if (!row) throw new Error(`Pull request #${number} is unavailable.`)
  const reviewThreads = row.reviewThreads?.nodes.map(thread => ({
    id: thread.id, filePath: thread.path, line: thread.line, isResolved: thread.isResolved, isOutdated: thread.isOutdated,
    pullRequestId: row.id, nextCommentsCursor: next(thread.comments), comments: thread.comments.nodes.filter(node => !node.isMinimized).map(comment),
  }))
  return { reviewThreads, comments: activityComments(row),
    next: { threads: next(row.reviewThreads), comments: next(row.comments), reviews: next(row.reviews) } }
}

export async function readAgentReviewThreadComments(
  client: GitHubClient, thread: AgentReviewThread,
) {
  const comments = [...thread.comments]
  let cursor = thread.nextCommentsCursor
  for (let page = 0; cursor && page < 4; page++) {
    const result = await client.graphql<{ node: { pullRequest: { id: string }; comments: Connection<ThreadCommentNode> } | null }>(`
      query AgentPullRequestThreadComments($thread: ID!, $after: String!) {
        node(id: $thread) {
          ... on PullRequestReviewThread {
            pullRequest { id }
            comments(first: 20, after: $after) { ${PAGE} nodes { id isMinimized ${COMMENT} } }
          }
        }
      }`, { thread: thread.id, after: cursor }).catch((error) => {
      if (githubRateLimitOf(error) || isGithubCredentialAccessFailure(error)) throw error
      return null
    })
    const found = result?.node
    if (!found || found.pullRequest.id !== thread.pullRequestId) break
    for (const node of found.comments.nodes) if (!node.isMinimized) comments.push(comment(node))
    cursor = next(found.comments)
  }
  return { comments, nextCommentsCursor: cursor }
}

function activityComments(row: ActivityRow): NonNullable<AgentPullRequestConversationPage['comments']> {
  const comments: AgentPullRequestConversationPage['comments'] = []
  for (const node of row.comments?.nodes ?? []) {
    if (!node.isMinimized) comments.push({ id: node.id, kind: 'issue-comment', path: null, reviewState: null, ...comment(node) })
  }
  for (const node of row.reviews?.nodes ?? []) {
    if (!node.isMinimized && node.submittedAt && node.state !== 'PENDING' &&
        (node.state !== 'COMMENTED' || node.body.trim())) {
      comments.push({ id: node.id, kind: 'review', path: null, reviewState: node.state,
        ...comment({ ...node, createdAt: node.submittedAt }) })
    }
  }
  for (const thread of row.reviewThreads?.nodes ?? []) {
    for (const node of thread.comments.nodes) {
      if (!node.isMinimized) comments.push({ id: node.id, kind: 'review-comment', path: thread.path, reviewState: null, ...comment(node) })
    }
  }
  return comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

const LIST = `${PAGE} nodes {
  ... on PullRequest {
    ${IDENTITY}
    baseRepository { nameWithOwner }
    reviewDecision updatedAt
    commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  }
}`
interface ListNode extends Pick<SummaryRow, 'number' | 'url' | 'title' | 'state' | 'isDraft' | 'author' | 'headRefName' | 'baseRefName'> {
  baseRepository: { nameWithOwner: string }
  updatedAt: string
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
  commits: { nodes: Array<{ commit: { statusCheckRollup: { state: string } | null } }> }
}

function listRow(node: ListNode): AgentPullRequestListRow {
  const checks = node.commits.nodes[0]?.commit.statusCheckRollup?.state
  const review: AgentPullRequestListRow['reviewDecision'] = node.reviewDecision === 'APPROVED' ? 'approved'
    : node.reviewDecision === 'CHANGES_REQUESTED' ? 'changes-requested' : node.reviewDecision === 'REVIEW_REQUIRED' ? 'review-required' : null
  return {
    number: node.number, url: node.url, title: node.title, state: stateOf(node.state), isDraft: node.isDraft,
    author: node.author?.login ?? null, headBranch: node.headRefName, baseBranch: node.baseRefName,
    reviewDecision: review, updatedAt: node.updatedAt,
    checksState: !checks ? null : checks === 'SUCCESS' ? 'passing' : checks === 'FAILURE' || checks === 'ERROR' ? 'failing' : 'pending',
  }
}

export function readAgentPullRequestList(client: GitHubClient, repo: RepoRef, input: AgentPullRequestListInput, viewer?: string) {
  return listings.read(client, repo, JSON.stringify([input, viewer]), undefined,
    () => loadList(client, repo, input, viewer), () => 30_000)
}

const listCheckpoint = z.object({
  after: z.string().nullable(),
  updatedBefore: z.iso.datetime({ offset: true }),
  seenAt: z.array(z.number().int().positive()),
})
type ListCheckpoint = z.output<typeof listCheckpoint>
const listError = z.object({ status: z.number().int() })

function listCandidates(
  connection: Connection<ListNode>, slug: string, position: ListCheckpoint | undefined, seen: Set<number>,
) {
  const rows: AgentPullRequestListRow[] = []
  for (const node of connection.nodes) {
    if (node?.baseRepository?.nameWithOwner.toLowerCase() !== slug.toLowerCase()) continue
    if (position && (node.updatedAt > position.updatedBefore ||
        (node.updatedAt === position.updatedBefore && seen.has(node.number)))) continue
    rows.push(listRow(node))
  }
  return rows
}

function listResult(rows: AgentPullRequestListRow[], limit: number, more: string | undefined, search: boolean, position?: ListCheckpoint) {
  const pullRequests = rows.slice(0, limit)
  const last = pullRequests.at(-1)
  const hasMore = more !== undefined || pullRequests.length < rows.length
  const nextCursor = hasMore && last ? JSON.stringify({
    after: !search && rows.length === pullRequests.length ? more ?? null : null,
    updatedBefore: last.updatedAt,
    seenAt: [
      ...(last.updatedAt === position?.updatedBefore ? position.seenAt : []),
      ...pullRequests.filter(row => row.updatedAt === last.updatedAt).map(row => row.number),
    ],
  }) : null
  return { pullRequests, nextCursor }
}

function partialListFailure(error: Parameters<typeof githubRateLimitOf>[0], rowCount: number): null {
  const status = listError.safeParse(error).data?.status ?? 0
  if (rowCount && status >= 500 && !githubRateLimitOf(error)) return null
  throw error
}

async function loadList(client: GitHubClient, repo: RepoRef, input: AgentPullRequestListInput, viewer?: string) {
  const slug = `${repo.owner}/${repo.repo}`
  const position = input.cursor ? listCheckpoint.parse(JSON.parse(input.cursor)) : undefined
  const wantsSearch = !!input.query || input.involvement !== 'all'
  const seen = new Set(position?.seenAt)
  const rows: AgentPullRequestListRow[] = []
  let more: string | undefined
  let search = wantsSearch || position !== undefined
  let after: string | undefined
  for (let page = 0; page < 10; page++) {
    const first = Math.min(100, input.limit - rows.length + (search && !after ? seen.size : 0))
    const request = search
      ? searchAgentPullRequests(client, slug, input, viewer, position?.updatedBefore, first, after)
      : listRepositoryPullRequests(client, repo, input, first, after)
    const connection = await request.catch(error => partialListFailure(error, rows.length))
    if (connection === null) break
    // An unindexed repository can answer an empty search despite offering a
    // normal listing. Only an unfiltered query can use that fallback.
    if (search && !wantsSearch && page === 0 && !connection.nodes.length) {
      search = false
      after = position?.after ?? undefined
      if (!after) break
      continue
    }
    rows.push(...listCandidates(connection, slug, position, seen))
    more = next(connection)
    after = more
    if (!more || rows.length >= input.limit) break
  }
  return listResult(rows, input.limit, more, search, position)
}

async function searchAgentPullRequests(
  client: GitHubClient, slug: string, input: AgentPullRequestListInput, viewer: string | undefined,
  updatedBefore: string | undefined, first: number, after?: string,
) {
  const involvement = viewer && (input.involvement === 'authored' ? `author:${viewer}` : `review-requested:${viewer}`)
  const state = input.state === 'all' ? '' : input.state === 'closed' ? 'is:closed is:unmerged' : `is:${input.state}`
  const phrase = input.query ? JSON.stringify(input.query) : undefined
  const boundary = updatedBefore && `updated:<=${updatedBefore}`
  const query = [`repo:${slug}`, 'is:pr', 'sort:updated-desc', state, involvement, phrase, boundary].filter(Boolean).join(' ')
  const result = await client.graphql<{ search: Connection<ListNode> }>(`
    query AgentPullRequestSearch($query: String!, $first: Int!, $after: String) {
      search(type: ISSUE, query: $query, first: $first, after: $after) { ${LIST} }
    }
  `, { first, after: after ?? null, query })
  return result.search
}

async function listRepositoryPullRequests(
  client: GitHubClient, repo: RepoRef, input: AgentPullRequestListInput, first: number, after?: string,
) {
  const states = input.state === 'all' ? ['OPEN', 'CLOSED', 'MERGED'] : [input.state.toUpperCase()]
  const result = await client.graphql<{ repository: { pullRequests: Connection<ListNode> } | null }>(`
    query AgentPullRequestList($owner: String!, $repo: String!, $first: Int!, $after: String) {
      repository(owner: $owner, name: $repo) {
        pullRequests(states: [${states.join(',')}], first: $first, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) { ${LIST} }
      }
    }
  `, { first, after: after ?? null, owner: repo.owner, repo: repo.repo })
  if (!result.repository) throw new Error('Could not list this repository’s pull requests.')
  return result.repository.pullRequests
}
