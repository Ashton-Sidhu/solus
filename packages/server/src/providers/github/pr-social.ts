import { z } from 'zod'
import type { RepoRef } from '@solus/contracts/providers'
import type { PrReaction, PrReactionContent, PrReactions } from '@solus/contracts/pr-social'
import { githubCredentials } from './credentials'
import { runGithubRequest } from './request'
import type { GitHubClient } from './octokit'

export const prRepoSchema = z
  .object({
    host: z.literal('github.com'),
    owner: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/),
    repo: z
      .string()
      .regex(/^[A-Za-z0-9_.-]{1,100}$/)
      .refine((repo) => repo !== '.' && repo !== '..')
  })
  .strict()
export const prNumberSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
export const prReactionContentSchema = z.enum([
  'THUMBS_UP',
  'THUMBS_DOWN',
  'LAUGH',
  'HOORAY',
  'CONFUSED',
  'HEART',
  'ROCKET',
  'EYES'
])
/**
 * The reaction fields of any reactable node, read with the node itself
 * (pull-request-detail.ts, provider.ts) rather than by a read of their own.
 * `reactors` is bounded: a hover names the first people, and `totalCount`
 * says how many more. GitHub never says which reactor is the viewer, so the
 * reads that use this also ask for `viewer { login }`.
 */
export const GITHUB_REACTION_FIELDS = `viewerCanReact reactionGroups { content viewerHasReacted reactors(first: 10) { totalCount nodes { ... on User { login } ... on Bot { login } ... on Organization { login } ... on Mannequin { login } } } }`

export const reactionFieldsSchema = z.object({
  viewerCanReact: z.boolean(),
  reactionGroups: z
    .array(
      z.object({
        content: prReactionContentSchema,
        viewerHasReacted: z.boolean(),
        reactors: z.object({
          totalCount: z.number().int().nonnegative(),
          nodes: z.array(z.object({ login: z.string().optional() }).nullable())
        })
      })
    )
    .nullable()
})
export type GqlReactionFields = z.infer<typeof reactionFieldsSchema>

/** GitHub's answer as the contract shapes it: groups nobody used are left out,
 *  and the viewer is `viewerHasReacted`, never an actor. */
export function toPrReactions(node: GqlReactionFields, viewer: string | null): PrReactions {
  const viewerKey = viewer?.toLowerCase() ?? null
  const groups: PrReaction[] = []
  for (const group of node.reactionGroups ?? []) {
    const logins = group.reactors.nodes.flatMap((reactor) => (reactor?.login ? [reactor.login] : []))
    const count = Math.max(group.reactors.totalCount, logins.length)
    if (count === 0) continue
    groups.push({
      content: group.content,
      count,
      viewerHasReacted: group.viewerHasReacted,
      actors: logins.filter((login) => login.toLowerCase() !== viewerKey)
    })
  }
  return { viewerCanReact: node.viewerCanReact, groups }
}
const repoIdentity = z.object({ nameWithOwner: z.string() })
const parent = z.object({ number: z.number(), repository: repoIdentity })
const subjectSchema = z.object({
  viewer: z.object({ login: z.string() }),
  node: z
    .discriminatedUnion('__typename', [
      z.object({
        __typename: z.literal('PullRequest'),
        number: prNumberSchema,
        repository: repoIdentity
      }),
      z.object({
        __typename: z.literal('IssueComment'),
        isMinimized: z.boolean(),
        pullRequest: parent.nullable()
      }),
      z.object({
        __typename: z.literal('PullRequestReview'),
        isMinimized: z.boolean(),
        reviewOf: parent
      }),
      z.object({
        __typename: z.literal('PullRequestReviewComment'),
        isMinimized: z.boolean(),
        reviewPullRequest: parent
      })
    ])
    .nullable()
})
// Each kind names its pull request under its own alias: GitHub rejects one
// field name that is nullable on a comment and non-null on a review.
export const PR_REACTION_TARGET_QUERY = `query PullRequestReactionTarget($id: ID!) { viewer { login } node(id: $id) { __typename
 ... on PullRequest { number repository { nameWithOwner } }
 ... on IssueComment { isMinimized pullRequest { number repository { nameWithOwner } } }
 ... on PullRequestReview { isMinimized reviewOf: pullRequest { number repository { nameWithOwner } } }
 ... on PullRequestReviewComment { isMinimized reviewPullRequest: pullRequest { number repository { nameWithOwner } } }
} }`
const pullRequestSubjectSchema = z.object({
  viewer: z.object({ login: z.string() }),
  repository: z.object({ pullRequest: z.object({ id: z.string() }).nullable() }).nullable()
})
export const PR_REACTION_PULL_REQUEST_QUERY = `query PullRequestReactionSubject($owner: String!, $repo: String!, $number: Int!) { viewer { login } repository(owner: $owner, name: $repo) { pullRequest(number: $number) { id } } }`
const mutationSchema = z.object({ change: z.object({ subject: reactionFieldsSchema }) })
const NOT_THIS_PULL_REQUEST = 'This reaction target does not belong to the pull request, or is hidden.'

/** The node to react to, checked to be this pull request or a visible
 *  comment or review on it, and the viewer who reacts. */
async function reactionSubject(
  client: Pick<GitHubClient, 'graphql'>,
  repo: RepoRef,
  number: number,
  targetId: string | null
): Promise<{ id: string; viewer: string }> {
  if (targetId === null) {
    const parsed = pullRequestSubjectSchema.parse(
      await client.graphql(PR_REACTION_PULL_REQUEST_QUERY, { owner: repo.owner, repo: repo.repo, number })
    )
    const id = parsed.repository?.pullRequest?.id
    if (!id) throw new Error('This pull request is unavailable to your GitHub connection.')
    return { id, viewer: parsed.viewer.login }
  }
  const parsed = subjectSchema.safeParse(await client.graphql(PR_REACTION_TARGET_QUERY, { id: targetId }))
  if (!parsed.success) throw new Error(NOT_THIS_PULL_REQUEST)
  const { node, viewer } = parsed.data
  const belongs = node ? visibleSubjectParent(node) : null
  if (
    !belongs ||
    belongs.number !== number ||
    belongs.repository.nameWithOwner.toLowerCase() !== `${repo.owner}/${repo.repo}`.toLowerCase()
  )
    throw new Error(NOT_THIS_PULL_REQUEST)
  return { id: targetId, viewer: viewer.login }
}

/** The pull request a subject is on; null for a hidden comment or review. */
function visibleSubjectParent(node: NonNullable<z.infer<typeof subjectSchema>['node']>) {
  switch (node.__typename) {
    case 'PullRequest':
      return node
    case 'IssueComment':
      return node.isMinimized ? null : node.pullRequest
    case 'PullRequestReview':
      return node.isMinimized ? null : node.reviewOf
    case 'PullRequestReviewComment':
      return node.isMinimized ? null : node.reviewPullRequest
  }
}

/** Adds or removes the viewer's reaction, and answers with the subject's
 *  reactions from the mutation itself, so no read follows the write. */
export async function changeGithubPrReaction(
  client: Pick<GitHubClient, 'graphql'>,
  repo: RepoRef,
  number: number,
  targetId: string | null,
  content: PrReactionContent,
  add: boolean
): Promise<PrReactions> {
  const subject = await reactionSubject(client, repo, number, targetId)
  const mutation = add ? 'addReaction' : 'removeReaction'
  const answer = mutationSchema.parse(
    await client.graphql(
      `mutation ChangePullRequestReaction($id: ID!, $content: ReactionContent!) { change: ${mutation}(input: { subjectId: $id, content: $content }) { subject { ${GITHUB_REACTION_FIELDS} } } }`,
      { id: subject.id, content }
    )
  )
  return toPrReactions(answer.change.subject, subject.viewer)
}

export async function changePrReaction(
  repo: RepoRef,
  number: number,
  targetId: string | null,
  content: PrReactionContent,
  add: boolean
): Promise<PrReactions> {
  const target = prRepoSchema.parse(repo)
  prNumberSchema.parse(number)
  z.string().min(1).max(256).nullable().parse(targetId)
  prReactionContentSchema.parse(content)
  z.boolean().parse(add)
  return runGithubRequest(
    'change_pr_reaction',
    target.host,
    await githubCredentials().clients(target.host),
    (client) => changeGithubPrReaction(client, target, number, targetId, content, add)
  )
}
