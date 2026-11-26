import { z } from 'zod'
import { GITHUB_PROVIDER_CAPABILITIES, type TaskProviderMetadata, type TaskProviderPullRequest } from '@solus/contracts/task-data'
import type { GraphQLClient } from '../../../providers/github/octokit'
import { ISSUE_TIMELINE_FIELDS, issueHistoryOf, issueTimelineSchema } from './github-issue-timeline'

export const ISSUE_REACTION_FIELDS = 'reactionGroups { content viewerHasReacted users { totalCount } }'
const CLOSING_PR_FIELDS = 'pageInfo { hasNextPage endCursor } nodes { number title url state }'
export const ISSUE_PROVIDER_FIELDS = `
  author { login }
  ${ISSUE_REACTION_FIELDS}
  closedByPullRequestsReferences(first: 20, includeClosedPrs: true) { ${CLOSING_PR_FIELDS} }
  ${ISSUE_TIMELINE_FIELDS}
`

export const githubReactionContent = z.enum(['THUMBS_UP', 'THUMBS_DOWN', 'LAUGH', 'HOORAY', 'CONFUSED', 'HEART', 'ROCKET', 'EYES'])
const reactionGroups = z.array(z.object({
  content: githubReactionContent,
  viewerHasReacted: z.boolean(),
  users: z.object({ totalCount: z.number() })
}))
const target = z.object({ id: z.string(), reactionGroups: reactionGroups.optional() })
const closingPage = z.object({
  pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
  nodes: z.array(z.object({
    number: z.number(), title: z.string(), url: z.string(), state: z.enum(['OPEN', 'CLOSED', 'MERGED'])
  }).nullable())
})
const closingReferences = z.object({ closedByPullRequestsReferences: closingPage.nullable() })
const metadataSchema = target.extend({
  author: z.object({ login: z.string() }).nullable(),
  assignees: z.object({ nodes: z.array(z.object({ login: z.string(), avatarUrl: z.string() })) }),
  comments: z.object({ totalCount: z.number(), nodes: z.array(target) }),
  timelineItems: issueTimelineSchema.nullish(),
  ...closingReferences.shape
})
export type GitHubIssueMetadataSelection = Partial<z.input<typeof metadataSchema>>

export const GITHUB_ISSUE_METADATA_QUERY = `query IssueProviderMetadata($id: ID!) {
  node(id: $id) {
    __typename
    ... on Issue {
      id number repository { owner { login } name }
      assignees(first: 100) { nodes { login avatarUrl(size: 40) } }
      comments(last: 100) { totalCount nodes { id ${ISSUE_REACTION_FIELDS} } }
      ${ISSUE_PROVIDER_FIELDS}
    }
  }
}`

export const githubIssueIdentity = z.object({
  __typename: z.string(),
  number: z.number().optional(),
  repository: z.object({ owner: z.object({ login: z.string() }), name: z.string() }).optional()
})
export type GitHubIssueProviderSelection = z.infer<typeof githubIssueIdentity> & GitHubIssueMetadataSelection

/** Follow only the closing-PR connection when its first page is incomplete.
 *  The newest page of history comes with the selection, so it costs no read. */
export async function githubIssueMetadata(
  taskId: string, selection: GitHubIssueMetadataSelection, graphql: GraphQLClient
): Promise<TaskProviderMetadata | undefined> {
  const parsed = metadataSchema.safeParse(selection)
  if (!parsed.success) return undefined
  const node = parsed.data
  let page = node.closedByPullRequestsReferences
  const pullRequests = new Map<string, TaskProviderPullRequest>()
  const seen = new Set<string>()
  while (page) {
    for (const pr of page.nodes) {
      if (!pr) continue
      pullRequests.set(pr.url, {
        number: pr.number, title: pr.title, url: pr.url,
        state: pr.state === 'MERGED' ? 'merged' : pr.state === 'OPEN' ? 'open' : 'closed',
        closesIssue: true
      })
    }
    if (!page.pageInfo.hasNextPage) break
    const cursor = page.pageInfo.endCursor
    if (!cursor || seen.has(cursor)) throw new Error('GitHub did not return the next page of closing pull requests.')
    seen.add(cursor)
    const answer = await graphql(`query IssueClosingPullRequests($id: ID!, $cursor: String!) {
      node(id: $id) {
        ... on Issue { closedByPullRequestsReferences(first: 100, after: $cursor, includeClosedPrs: true) { ${CLOSING_PR_FIELDS} } }
      }
    }`, { id: node.id, cursor })
    page = z.object({ node: closingReferences }).parse(answer).node.closedByPullRequestsReferences
    if (!page) throw new Error('GitHub did not return the next page of closing pull requests.')
  }
  const history = node.timelineItems ? issueHistoryOf(taskId, node.timelineItems) : null
  for (const pr of history?.pullRequests ?? []) if (!pullRequests.has(pr.url)) pullRequests.set(pr.url, pr)
  return {
    ...(history && { events: history.events, comments: history.comments, historyCursor: history.historyCursor }),
    commentsTruncated: node.comments.totalCount > node.comments.nodes.length,
    author: node.author?.login ?? null,
    assignees: node.assignees.nodes,
    reactions: [node, ...node.comments.nodes].flatMap((target) =>
      (target.reactionGroups ?? []).map((group) => ({
        targetId: target.id,
        content: group.content,
        count: group.users.totalCount,
        viewerHasReacted: group.viewerHasReacted
      }))
    ),
    pullRequests: [...pullRequests.values()],
    capabilities: GITHUB_PROVIDER_CAPABILITIES
  }
}
