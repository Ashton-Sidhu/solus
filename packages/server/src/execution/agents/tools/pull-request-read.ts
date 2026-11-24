import { z } from 'zod'
import type { CheckItem } from '@solus/contracts/checks-types'
import { repositoryKeyOf } from '@solus/contracts/repository-key'
import type { AgentPullRequestConversationInput, AgentPullRequestConversationPage, AgentPullRequestSummary, AgentReviewThread } from '../../../providers/types'
import type { CodeHost } from '../../../prs/code-host'

export const pullRequestReadSection = z.enum(['body', 'checks', 'threads', 'comments', 'diff'])
type Section = z.infer<typeof pullRequestReadSection>

export function encodeCursor<Position extends { scope: string }>(position: Position): string {
  return Buffer.from(JSON.stringify(position)).toString('base64url')
}

export function readCursor<Schema extends z.ZodType>(schema: Schema, cursor: string): z.output<Schema> {
  try {
    return schema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')))
  } catch {
    throw new Error('This cursor is not from this tool. Pass a nextCursor from its last result.')
  }
}

const readPosition = z.discriminatedUnion('section', [
  z.object({
    section: z.literal('conversation'), scope: z.string(), includeResolved: z.boolean(),
    threadOffset: z.number().int().nonnegative(), commentOffset: z.number().int().nonnegative(),
    wantsThreads: z.boolean(), wantsComments: z.boolean(),
  }),
  z.object({
    section: z.literal('diff'), scope: z.string(), head: z.string(), base: z.string(),
    page: z.string().optional(), offset: z.number().int().nonnegative(),
  }),
])
type ReadPosition = z.output<typeof readPosition>

function describeCheck(check: CheckItem, required: boolean, name: string) {
  let status = check.conclusion ?? 'failure'
  if (status === 'timed_out' || status === 'stale') status = 'failure'
  return {
    name,
    status: check.inFlight ? 'pending' : status === 'action_required' ? 'action-required' : status,
    description: check.description ?? null,
    url: check.detailsUrl,
    required,
  }
}

export async function readAgentSummary(host: CodeHost, number: number, input: { body: boolean; fresh?: boolean; checksOnly?: boolean }): Promise<AgentPullRequestSummary> {
  const { repo, provider: { review } } = host
  if (!review.agentPullRequestSummary) throw new Error('This code host cannot read PR summaries.')
  return review.agentPullRequestSummary(repo, number, input)
}

function compact(summary: AgentPullRequestSummary, sections: Set<Section>) {
  const { baseSha: _baseSha, checkRuns, checksIncomplete, unresolvedThreadsTruncated, body, ...pr } = summary
  const runs = checkRuns.map(({ check, required, name }) => describeCheck(check, required, name))
  const failed: string[] = []
  let passed = 0
  let pending = 0
  for (const run of runs) {
    if (run.status === 'failure' || run.status === 'cancelled') failed.push(run.name)
    else if (run.status === 'pending' || run.status === 'action-required') pending++
    else passed++
  }
  return {
    ...pr,
    headSha: pr.headSha || null,
    checks: { passed, pending, failed, incomplete: checksIncomplete ? true : undefined },
    unresolvedThreadsTruncated: unresolvedThreadsTruncated ? true : undefined,
    body: sections.has('body') ? body : undefined,
    checkRuns: sections.has('checks') ? runs : undefined,
  }
}

async function readDiff(host: CodeHost, pr: AgentPullRequestSummary, scope: string, position?: Extract<ReadPosition, { section: 'diff' }>) {
  if (position && (position.head !== pr.headSha || position.base !== pr.baseSha)) {
    throw new Error('The PR head moved or its base changed. Start the diff read again.')
  }
  const { repo, provider: { review } } = host
  const baseSha = await review.getPullRequestDiffBase(repo, pr)
  const result = await review.getPullRequestDiff(repo, pr, { number: pr.number, baseSha, headSha: pr.headSha, cursor: position?.page })
  const start = position?.offset ?? 0
  const end = start + 32_000
  const remaining = end < result.patch.length
  const nextCursor = remaining || result.nextCursor ? encodeCursor({
    scope, section: 'diff', head: pr.headSha, base: pr.baseSha, page: remaining ? position?.page : result.nextCursor ?? undefined,
    offset: remaining ? end : 0,
  }) : null
  return { patch: result.patch.slice(start, end), truncated: result.truncated || remaining, nextCursor }
}

type ConversationPosition = Extract<ReadPosition, { section: 'conversation' }>

type Remark = NonNullable<AgentPullRequestConversationPage['comments']>[number]

async function collectActivity(
  { repo, provider: { review } }: CodeHost, number: number, position: ConversationPosition,
) {
  if (!review.agentPullRequestConversation) throw new Error('This code host cannot page PR conversation.')
  const reviewThreads: AgentReviewThread[] = []
  const comments: Remark[] = []
  let request: AgentPullRequestConversationInput = {
    threads: position.wantsThreads || position.wantsComments ? null : undefined,
    comments: position.wantsComments ? null : undefined,
    reviews: position.wantsComments ? null : undefined,
  }
  let truncated = false
  let commentsTruncated = false
  for (let index = 0; index < 10; index++) {
    const page = await review.agentPullRequestConversation(repo, number, request)
    if (position.wantsThreads && page.reviewThreads) reviewThreads.push(...page.reviewThreads)
    if (position.wantsComments && page.comments) comments.push(...page.comments)
    if (position.wantsComments && page.reviewThreads?.some(thread => thread.nextCommentsCursor)) commentsTruncated = true
    request = page.next
    truncated = Object.values(request).some(cursor => cursor !== undefined)
    if (!truncated) break
  }
  const uniqueThreads = [...new Map(reviewThreads.map(thread => [thread.id, thread])).values()]
  const orderedComments = [...new Map(comments.map(comment => [comment.id, comment])).values()]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  return { reviewThreads: uniqueThreads, comments: orderedComments, truncated: truncated || commentsTruncated }
}

function conversationPage(activity: Awaited<ReturnType<typeof collectActivity>>, position: ConversationPosition) {
  let threadOffset = Math.min(position.threadOffset, activity.reviewThreads.length)
  let commentOffset = Math.min(position.commentOffset, activity.comments.length)
  const threads: AgentReviewThread[] = []
  const remarks: Remark[] = []
  let size = 0
  const fits = (item: AgentReviewThread | Remark) => {
    const length = JSON.stringify(item).length
    if (size > 0 && size + length > 32_000) return false
    size += length
    return true
  }
  while (threadOffset < activity.reviewThreads.length) {
    const thread = activity.reviewThreads[threadOffset]
    if (position.includeResolved || !thread.isResolved) {
      if (!fits(thread)) break
      threads.push(thread)
    }
    threadOffset++
  }
  if (threadOffset === activity.reviewThreads.length) {
    while (commentOffset < activity.comments.length && fits(activity.comments[commentOffset])) {
      remarks.push(activity.comments[commentOffset++])
    }
  }
  const done = threadOffset === activity.reviewThreads.length && commentOffset === activity.comments.length
  return { threads, remarks, nextCursor: done ? null : encodeCursor({ ...position, threadOffset, commentOffset }) }
}

async function readConversation(
  host: CodeHost, number: number, position: ConversationPosition,
) {
  const { repo, provider: { review } } = host
  const activity = await collectActivity(host, number, position)
  const page = conversationPage(activity, position)
  const reviewThreads = []
  for (let index = 0; index < page.threads.length; index += 4) {
    reviewThreads.push(...await Promise.all(page.threads.slice(index, index + 4).map(async thread => {
      const reply = thread.nextCommentsCursor ? await review.agentReviewThreadComments?.(repo, thread) : undefined
      const { comments, nextCommentsCursor } = reply ?? thread
      return {
        id: thread.id, path: thread.filePath, line: thread.line, isResolved: thread.isResolved, isOutdated: thread.isOutdated,
        comments: comments.map(comment => ({ ...comment, author: comment.author || null })),
        moreComments: nextCommentsCursor !== undefined,
      }
    })))
  }
  return {
    reviewThreads: position.wantsThreads ? reviewThreads : undefined,
    comments: position.wantsComments ? page.remarks.map(comment => ({ ...comment, author: comment.author || null })) : undefined,
    truncated: activity.truncated || reviewThreads.some(thread => thread.moreComments),
    nextCursor: page.nextCursor,
  }
}

function sectionsFor(input: Section[] | undefined, position: ReadPosition | undefined): Set<Section> {
  if (!position) return new Set(input)
  if (position.section === 'diff') return new Set(['diff'])
  const sections = new Set<Section>()
  if (position.wantsThreads) sections.add('threads')
  if (position.wantsComments) sections.add('comments')
  return sections
}

export async function readSections(
  host: CodeHost, number: number,
  input: { include?: Section[]; includeResolved?: boolean; cursor?: string },
) {
  const scope = `${repositoryKeyOf(host.repo)}#${number}`
  const position = input.cursor ? readCursor(readPosition, input.cursor) : undefined
  if (position && position.scope !== scope) throw new Error('Use a cursor from this pull request.')
  const sections = sectionsFor(input.include, position)
  const wantsThreads = sections.has('threads')
  const wantsComments = sections.has('comments')
  const start: ConversationPosition = position?.section === 'conversation' ? position : {
    scope, section: 'conversation', wantsThreads, wantsComments, includeResolved: input.includeResolved ?? false,
    threadOffset: 0, commentOffset: 0,
  }
  const [summary, conversation] = await Promise.all([
    readAgentSummary(host, number, { body: sections.has('body'), fresh: sections.has('diff') }),
    wantsThreads || wantsComments ? readConversation(host, number, start) : undefined,
  ])
  return {
    host: host.repo.host, repository: `${host.repo.owner}/${host.repo.repo}`,
    ...compact(summary, sections),
    conversation,
    diff: sections.has('diff') ? await readDiff(host, summary, scope, position?.section === 'diff' ? position : undefined) : undefined,
  }
}
