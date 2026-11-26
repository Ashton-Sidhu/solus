import { z } from 'zod'
import type { TaskProviderEvent, TaskProviderPullRequest } from '@solus/contracts/task-data'
import type { IssueComment } from '@solus/contracts/task-types'
import type { GraphQLClient } from '../../../providers/github/octokit'

/**
 * An issue's GitHub history as one GraphQL connection, newest page first. The
 * issue detail query carries its first page, so the issue page needs no second
 * read; an older page is one query (`readGithubIssueTimeline`). Comments are in
 * the timeline too, so a page older than the detail's newest comments brings
 * its comments with it.
 */

const ACTOR = 'actor { login }'
const TIMELINE_NODES = `
  __typename
  ... on IssueComment { id createdAt body author { login } }
  ... on AssignedEvent { id createdAt ${ACTOR} assignee { ... on Actor { login } } }
  ... on UnassignedEvent { id createdAt ${ACTOR} assignee { ... on Actor { login } } }
  ... on LabeledEvent { id createdAt ${ACTOR} label { name } }
  ... on UnlabeledEvent { id createdAt ${ACTOR} label { name } }
  ... on RenamedTitleEvent { id createdAt ${ACTOR} previousTitle currentTitle }
  ... on MilestonedEvent { id createdAt ${ACTOR} milestoneTitle }
  ... on DemilestonedEvent { id createdAt ${ACTOR} milestoneTitle }
  ... on ReferencedEvent { id createdAt ${ACTOR} commit { oid url } }
  ... on CrossReferencedEvent { id createdAt ${ACTOR}
    source {
      __typename
      ... on Issue { number title url issueState: state }
      ... on PullRequest { number title url pullRequestState: state merged }
    }
  }
  ... on ClosedEvent { id createdAt ${ACTOR} }
  ... on ReopenedEvent { id createdAt ${ACTOR} }
  ... on LockedEvent { id createdAt ${ACTOR} }
  ... on UnlockedEvent { id createdAt ${ACTOR} }
  ... on PinnedEvent { id createdAt ${ACTOR} }
  ... on UnpinnedEvent { id createdAt ${ACTOR} }
  ... on TransferredEvent { id createdAt ${ACTOR} }
`
const ITEM_TYPES = `[
  ISSUE_COMMENT ASSIGNED_EVENT UNASSIGNED_EVENT LABELED_EVENT UNLABELED_EVENT RENAMED_TITLE_EVENT
  MILESTONED_EVENT DEMILESTONED_EVENT REFERENCED_EVENT CROSS_REFERENCED_EVENT CLOSED_EVENT
  REOPENED_EVENT LOCKED_EVENT UNLOCKED_EVENT PINNED_EVENT UNPINNED_EVENT TRANSFERRED_EVENT
]`
const PAGE_SIZE = 100

/** The newest page of an issue's timeline, as a field of the issue. */
export const ISSUE_TIMELINE_FIELDS = `
  timelineItems(last: ${PAGE_SIZE}, itemTypes: ${ITEM_TYPES}) {
    pageInfo { hasPreviousPage startCursor }
    nodes { ${TIMELINE_NODES} }
  }
`

/** The page of an issue's timeline before `cursor`. */
export const GITHUB_ISSUE_TIMELINE_QUERY = `query IssueTimeline($id: ID!, $cursor: String) {
  node(id: $id) {
    __typename
    ... on Issue {
      timelineItems(last: ${PAGE_SIZE}, before: $cursor, itemTypes: ${ITEM_TYPES}) {
        pageInfo { hasPreviousPage startCursor }
        nodes { ${TIMELINE_NODES} }
      }
    }
  }
}`

const login = z.object({ login: z.string() }).nullish().catch(null)
const timelineNode = z.object({
  __typename: z.string(),
  id: z.string().optional(),
  createdAt: z.string().optional(),
  actor: login,
  author: login,
  body: z.string().optional(),
  assignee: login,
  label: z.object({ name: z.string() }).nullish().catch(null),
  previousTitle: z.string().optional(),
  currentTitle: z.string().optional(),
  milestoneTitle: z.string().optional(),
  commit: z.object({ oid: z.string(), url: z.string() }).nullish().catch(null),
  source: z.object({
    __typename: z.string(),
    number: z.number().optional(),
    title: z.string().optional(),
    url: z.string().optional(),
    pullRequestState: z.string().optional(),
    merged: z.boolean().optional(),
  }).nullish().catch(null),
})
export const issueTimelineSchema = z.object({
  pageInfo: z.object({ hasPreviousPage: z.boolean(), startCursor: z.string().nullable() }),
  nodes: z.array(z.unknown().nullable()),
})
export type GitHubIssueTimeline = z.infer<typeof issueTimelineSchema>

export interface GitHubIssueHistory {
  events: TaskProviderEvent[]
  comments: IssueComment[]
  pullRequests: TaskProviderPullRequest[]
  historyCursor: string | null
}

type TimelineNode = z.infer<typeof timelineNode>

const assigneeOf = (node: TimelineNode) => node.assignee?.login ?? 'an account'
const EVENT_TEXT = new Map<string, (node: TimelineNode) => string>([
  ['AssignedEvent', (node) => node.assignee?.login && node.assignee.login === node.actor?.login
    ? 'self-assigned this issue' : `assigned ${assigneeOf(node)}`],
  ['UnassignedEvent', (node) => `unassigned ${assigneeOf(node)}`],
  ['LabeledEvent', (node) => `added label ${node.label?.name ?? ''}`.trim()],
  ['UnlabeledEvent', (node) => `removed label ${node.label?.name ?? ''}`.trim()],
  ['RenamedTitleEvent', (node) => node.previousTitle !== undefined && node.currentTitle !== undefined
    ? `changed the title from “${node.previousTitle}” to “${node.currentTitle}”` : 'renamed the issue'],
  ['MilestonedEvent', (node) => `added this issue to milestone ${node.milestoneTitle ?? ''}`.trim()],
  ['DemilestonedEvent', (node) => `removed this issue from milestone ${node.milestoneTitle ?? ''}`.trim()],
  ['ReferencedEvent', () => 'added a commit that references this issue'],
  ['CrossReferencedEvent', () => 'referenced this issue'],
  ['ClosedEvent', () => 'closed the issue'],
  ['ReopenedEvent', () => 'reopened the issue'],
  ['LockedEvent', () => 'locked the conversation'],
  ['UnlockedEvent', () => 'unlocked the conversation'],
  ['PinnedEvent', () => 'pinned the issue'],
  ['UnpinnedEvent', () => 'unpinned the issue'],
  ['TransferredEvent', () => 'transferred the issue'],
])

function eventText(node: TimelineNode): string {
  return EVENT_TEXT.get(node.__typename)?.(node)
    ?? `recorded “${node.__typename.replace(/Event$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}”`
}

function linkOf(node: TimelineNode): { url: string; label: string } | undefined {
  const source = node.source
  if (source?.url?.startsWith('https://github.com/') && source.title !== undefined) return { url: source.url, label: source.title }
  if (node.commit?.url.startsWith('https://github.com/')) return { url: node.commit.url, label: node.commit.oid.slice(0, 7) }
}

/** The pull request that a cross-reference names, or null for any other event. */
function pullRequestOf(node: TimelineNode, link: { url: string; label: string }): TaskProviderPullRequest | null {
  const source = node.source
  if (source?.__typename !== 'PullRequest' || source.number === undefined) return null
  const state = source.merged ? 'merged' : source.pullRequestState === 'OPEN' ? 'open' : source.pullRequestState === 'CLOSED' ? 'closed' : 'unknown'
  return { url: link.url, number: source.number, title: link.label, state, closesIssue: false }
}

/** One page of the timeline as events, comments and the pull requests that reference the issue. */
export function issueHistoryOf(taskId: string, timeline: GitHubIssueTimeline): GitHubIssueHistory {
  const events: TaskProviderEvent[] = []
  const comments: IssueComment[] = []
  const pullRequests = new Map<string, TaskProviderPullRequest>()
  for (const value of timeline.nodes) {
    const parsed = timelineNode.safeParse(value)
    if (!parsed.success || !parsed.data.id) continue
    const node = parsed.data
    const at = Date.parse(node.createdAt ?? '')
    if (!Number.isFinite(at)) continue
    if (node.__typename === 'IssueComment') {
      if (node.body !== undefined) comments.push({ id: node.id!, providerCommentId: node.id!, issueId: taskId, body: node.body, externalAuthor: node.author?.login ?? null, createdAt: at })
      continue
    }
    const link = linkOf(node)
    events.push({ id: node.id!, at, actor: node.actor?.login ?? null, text: eventText(node), ...(link && { link }) })
    const pullRequest = link && pullRequestOf(node, link)
    if (pullRequest) pullRequests.set(pullRequest.url, pullRequest)
  }
  const historyCursor = timeline.pageInfo.hasPreviousPage ? timeline.pageInfo.startCursor : null
  return { events, comments, pullRequests: [...pullRequests.values()], historyCursor }
}

/** The page of an issue's history before `cursor`: one GraphQL query. */
export async function readGithubIssueTimeline(graphql: GraphQLClient, taskId: string, issueNodeId: string, cursor?: string): Promise<GitHubIssueHistory | null> {
  const answer = await graphql<{ node: { __typename: string; timelineItems?: unknown } | null }>(GITHUB_ISSUE_TIMELINE_QUERY, { id: issueNodeId, cursor: cursor ?? null })
  if (answer.node?.__typename !== 'Issue') return null
  return issueHistoryOf(taskId, issueTimelineSchema.parse(answer.node.timelineItems))
}
