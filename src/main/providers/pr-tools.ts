import { z } from 'zod'
import { createLogger } from '../logger'
import { resolveRepoRef, resolveRepoRoot } from '../git/git-helpers'
import { runAsync } from '../git/exec'
import { writeReviewCheckpoint } from '../review/checkpoints'
import { providerForRepo } from './registry'
import { foreignTaskLinksFor } from '../tasks/foreign-tasks'
import { GitHubReauthRequiredError } from './github/octokit'
import type { DraftReview, DraftReviewComment, PrFilter, RepoRef, ReviewThread } from '../../shared/providers'
import type { AgentTool } from '../agents/tools/agent-tool'

const log = createLogger('main', 'pr-tools.ts')

const REVIEW_EVENTS = ['COMMENT', 'REQUEST_CHANGES'] as const
const PR_STATES = ['open', 'closed', 'all'] as const
const SIDES = ['LEFT', 'RIGHT'] as const

type PrsChangedListener = (cwd: string) => void
const prsChangedListeners = new Set<PrsChangedListener>()

/** Internal domain signal adapted to a host event by the composition root. */
export function onPrsChanged(listener: PrsChangedListener): () => void {
  prsChangedListeners.add(listener)
  return () => prsChangedListeners.delete(listener)
}

function notifyPrsChanged(cwd: string): void {
  for (const listener of prsChangedListeners) listener(cwd)
}

const listPrsFields = {
  state: z.enum(PR_STATES).optional().describe("PR state filter. Defaults to 'open'."),
  author: z.string().optional().describe('Optional author login filter.'),
}

const prNumberFields = {
  number: z.number().int().positive().describe('Pull request number.'),
}

const listThreadsFields = {
  number: z.number().int().positive().describe('Pull request number.'),
  include_resolved: z.boolean().optional().describe('Include resolved threads. Defaults to false.'),
}

const replyThreadFields = {
  thread_id: z.string().describe('Verbatim review thread id returned by list_pr_threads.'),
  body: z.string().describe('Reply body in markdown.'),
}

const resolveThreadFields = {
  thread_id: z.string().describe('Verbatim review thread id returned by list_pr_threads.'),
}

const reviewCommentInputSchema = z.object({
  path: z.string(),
  line: z.number().int().positive(),
  start_line: z.number().int().positive().optional(),
  side: z.enum(SIDES).optional(),
  body: z.string(),
})

type ReviewCommentInput = z.infer<typeof reviewCommentInputSchema>

const submitReviewFields = {
  number: z.number().int().positive().describe('Pull request number.'),
  event: z.enum(REVIEW_EVENTS).describe("Review event. APPROVE is intentionally unavailable to agents; approval stays human."),
  body: z.string().describe('Review summary body in markdown.'),
  comments: z.array(reviewCommentInputSchema).optional().describe('Optional inline review comments anchored to the PR head.'),
}

interface PrToolArgs {
  state?: PrFilter['state']
  author?: string
  number?: number
  include_resolved?: boolean
  thread_id?: string
  body?: string
  event?: 'COMMENT' | 'REQUEST_CHANGES'
  comments?: ReviewCommentInput[]
}

const LIST_PRS_DESC = 'List pull requests for the current git repository.'
const READ_PR_DESC = 'Read a pull request overview, including body, headSha, commits, reviewers, mergeability, and top-level conversation.'
const LIST_THREADS_DESC = 'List PR review threads. Use the verbatim thread_id values when replying or resolving.'
const REPLY_THREAD_DESC = 'Reply to a PR review thread by thread id.'
const RESOLVE_THREAD_DESC = 'Resolve a PR review thread by thread id.'
const SUBMIT_REVIEW_DESC = 'Submit a PR review with COMMENT or REQUEST_CHANGES. APPROVE is deliberately excluded; approval stays human.'

export interface PrToolCtx {
  cwd: string
  /** Solus session id — keys a dispatched session's shipped task snapshot,
   *  whose PR links still answer when this host has no provider access. */
  solusSessionId?: string
}

export interface PrToolDeps {
  ctx: PrToolCtx
}

export interface PrToolResult {
  ok: boolean
  text: string
}

async function targetFor(cwd: string): Promise<{ repo: RepoRef; provider: NonNullable<ReturnType<typeof providerForRepo>> } | { error: string }> {
  const repo = await resolveRepoRef(cwd)
  if (!repo) return { error: 'This project has no recognized git remote to review PRs from.' }
  const provider = providerForRepo(repo)
  if (!provider) return { error: `Unsupported git host ${repo.host}.` }
  const auth = await provider.auth.status()
  if (!auth.connected) return { error: 'GitHub is not connected — connect it in Settings → Connections.' }
  return { repo, provider }
}

function truncate(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > max ? `${normalized.slice(0, Math.max(0, max - 1))}…` : normalized
}

function formatThreads(threads: ReviewThread[]): string {
  if (!threads.length) return 'No matching review threads.'
  return threads.map((thread) => {
    const loc = thread.line === null ? `${thread.filePath}:outdated` : `${thread.filePath}:${thread.line}`
    const comments = thread.comments.map((comment) => `${comment.author}:\n${comment.body}`).join('\n\n')
    return `thread_id: ${thread.id}\n${loc}${thread.isOutdated || thread.line === null ? ' (outdated)' : ''}  ${thread.isResolved ? '[resolved]' : '[unresolved]'}\n${comments}`
  }).join('\n\n')
}

function toReviewComments(input: ReviewCommentInput[] | undefined): DraftReviewComment[] {
  return (input ?? []).map((item) => {
    const comment: DraftReviewComment = {
      path: item.path,
      line: item.line,
      side: item.side ?? 'RIGHT',
      body: item.body,
    }
    if (item.start_line !== undefined) comment.startLine = item.start_line
    return comment
  }).filter((comment) => comment.body.trim())
}

export async function executePrTool(
  name: string,
  args: PrToolArgs,
  deps: PrToolDeps,
): Promise<PrToolResult> {
  const cwd = deps.ctx.cwd
  try {
    const target = await targetFor(cwd)
    if ('error' in target) {
      // A dispatched session's task may link PRs this host cannot reach (no
      // remote, no auth). The link's snapshot facts still answer read_pr
      // honestly instead of a bare provider error.
      if (name === 'read_pr') {
        const number = Number(args.number ?? 0)
        const link = foreignTaskLinksFor(deps.ctx.solusSessionId).find(
          (candidate) => candidate.kind === 'pr' && candidate.targetKey === String(number),
        )
        if (link) {
          return {
            ok: true,
            text: [
              `#${link.targetKey} ${link.title}`,
              ...(link.url ? [`url: ${link.url}`] : []),
              '',
              `This host cannot read the PR itself (${target.error}) — only the task's linked facts are available here. Use the URL, or work the PR from the task's host.`,
            ].join('\n'),
          }
        }
      }
      return { ok: false, text: target.error }
    }
    const { repo, provider } = target

    if (name === 'list_prs') {
      const filter: PrFilter = {
        state: args.state ?? 'open',
        author: args.author?.trim() || undefined,
      }
      const prs = await provider.review.listPullRequests(repo, filter)
      if (!prs.length) return { ok: true, text: 'No pull requests matched.' }
      return {
        ok: true,
        text: prs.map((pr) =>
          `#${pr.number}  ${pr.title}  by ${pr.author}  [${pr.state}${pr.draft ? ', draft' : ''}]  +${pr.additions}/-${pr.deletions}  (updated ${pr.updatedAt})`,
        ).join('\n'),
      }
    }

    if (name === 'read_pr') {
      const number = Number(args.number ?? 0)
      if (!Number.isInteger(number) || number <= 0) return { ok: false, text: 'read_pr requires a positive PR number.' }
      const [overview, conversation] = await Promise.all([
        provider.review.getPullRequestOverview(repo, number),
        provider.review.listComments(repo, number),
      ])
      const d = overview.detail
      const lines = [
        `#${d.number} ${d.title}`,
        `author: ${d.author}`,
        `state: ${d.state}${d.draft ? ' (draft)' : ''}`,
        `refs: ${d.baseRef} ← ${d.headRef}`,
        `headSha: ${d.headSha}`,
        `mergeable: ${d.mergeable === null ? 'unknown' : String(d.mergeable)}`,
        `changedFiles: ${d.changedFiles}, +${d.additions}/-${d.deletions}`,
        '',
        truncate(d.body || '(no body)', 2000),
      ]
      if (overview.commits.length) {
        lines.push('', 'Commits:')
        for (const commit of overview.commits) lines.push(`- ${commit.sha.slice(0, 7)} ${commit.message} (${commit.author})`)
      }
      if (overview.reviewers.length) {
        lines.push('', 'Reviewers:')
        for (const reviewer of overview.reviewers) lines.push(`- ${reviewer.login}: ${reviewer.state ?? 'pending'}`)
      }
      if (conversation.length) {
        lines.push('', 'Top-level conversation:')
        for (const item of conversation) {
          const state = item.kind === 'review' && item.reviewState ? ` [${item.reviewState}]` : ''
          lines.push(`- ${item.author}${state} (${item.createdAt})\n${item.body}`)
        }
      }
      return { ok: true, text: lines.join('\n') }
    }

    if (name === 'list_pr_threads') {
      const number = Number(args.number ?? 0)
      if (!Number.isInteger(number) || number <= 0) return { ok: false, text: 'list_pr_threads requires a positive PR number.' }
      const threads = await provider.review.listReviewThreads(repo, number)
      const filtered = args.include_resolved === true ? threads : threads.filter((thread) => !thread.isResolved)
      return { ok: true, text: formatThreads(filtered) }
    }

    if (name === 'reply_pr_thread') {
      const threadId = String(args.thread_id ?? '').trim()
      const body = args.body?.trim() ?? ''
      if (!threadId) return { ok: false, text: 'reply_pr_thread requires thread_id.' }
      if (!body) return { ok: false, text: 'reply_pr_thread requires a non-empty body.' }
      const comment = await provider.review.replyToThread(repo, threadId, body)
      notifyPrsChanged(cwd)
      return { ok: true, text: `Replied to thread ${threadId} with comment ${comment.id}.` }
    }

    if (name === 'resolve_pr_thread') {
      const threadId = String(args.thread_id ?? '').trim()
      if (!threadId) return { ok: false, text: 'resolve_pr_thread requires thread_id.' }
      await provider.review.resolveThread(repo, threadId)
      notifyPrsChanged(cwd)
      return { ok: true, text: `Resolved thread ${threadId}.` }
    }

    if (name === 'submit_pr_review') {
      const number = Number(args.number ?? 0)
      if (!Number.isInteger(number) || number <= 0) return { ok: false, text: 'submit_pr_review requires a positive PR number.' }
      const event = args.event
      if (event === undefined) {
        return { ok: false, text: `submit_pr_review event must be one of ${REVIEW_EVENTS.join(', ')}. APPROVE is human-only.` }
      }
      const body = args.body?.trim() ?? ''
      if (!body) return { ok: false, text: 'submit_pr_review requires a non-empty body.' }
      const detail = await provider.review.getPullRequest(repo, number)
      const repoRoot = (await resolveRepoRoot(cwd)) ?? cwd
      let baseSha: string | null = null
      try {
        // Keep fetches sequential: concurrent fetches contend on FETCH_HEAD and
        // would make checkpoint capture flaky even though the review succeeds.
        await runAsync('git', ['fetch', 'origin', detail.baseRef], repoRoot)
        await runAsync('git', ['fetch', 'origin', `pull/${number}/head`], repoRoot)
        baseSha = await runAsync('git', ['merge-base', detail.headSha, detail.baseSha], repoRoot)
      } catch {}
      const review: DraftReview = {
        body,
        event,
        commitId: detail.headSha,
        baseSha: baseSha ?? undefined,
        comments: toReviewComments(args.comments),
      }
      await provider.review.createReview(repo, number, review)
      if (baseSha) {
        const saved = await writeReviewCheckpoint(repoRoot, {
          prNumber: number,
          headSha: detail.headSha,
          base: baseSha,
          reviewedAt: new Date().toISOString(),
        })
        if (!saved) log.warn('pr_review_checkpoint_save_failed', { prNumber: number })
      } else {
        log.warn('pr_review_merge_base_unresolved', { prNumber: number })
      }
      notifyPrsChanged(cwd)
      return { ok: true, text: `Submitted ${event} review on PR #${number} anchored to headSha ${detail.headSha}.` }
    }

    return { ok: false, text: `Unknown PR tool: ${name}` }
  } catch (err: any) {
    if (err instanceof GitHubReauthRequiredError) {
      return { ok: false, text: 'GitHub token expired — reconnect in Settings → Connections.' }
    }
    log.error('pr_tool_failed', { tool: name, error: String(err) })
    return { ok: false, text: `PR tool error: ${String(err?.message ?? err)}` }
  }
}

function prAgentTool(
  name: string,
  description: string,
  inputFields: AgentTool['inputFields'],
  requiresApproval: boolean,
): AgentTool {
  return {
    name,
    description,
    inputFields,
    requiresApproval,
    execute: async (args, context) => executePrTool(name, args, {
      ctx: { cwd: context.cwd, solusSessionId: context.solusSessionId() },
    }),
  }
}

export const listPrsAgentTool = prAgentTool('list_prs', LIST_PRS_DESC, listPrsFields, false)
export const readPrAgentTool = prAgentTool('read_pr', READ_PR_DESC, prNumberFields, false)
export const listPrThreadsAgentTool = prAgentTool('list_pr_threads', LIST_THREADS_DESC, listThreadsFields, false)
export const replyPrThreadAgentTool = prAgentTool('reply_pr_thread', REPLY_THREAD_DESC, replyThreadFields, true)
export const resolvePrThreadAgentTool = prAgentTool('resolve_pr_thread', RESOLVE_THREAD_DESC, resolveThreadFields, true)
export const submitPrReviewAgentTool = prAgentTool('submit_pr_review', SUBMIT_REVIEW_DESC, submitReviewFields, true)

export const prAgentTools: AgentTool[] = [
  listPrsAgentTool,
  readPrAgentTool,
  listPrThreadsAgentTool,
  replyPrThreadAgentTool,
  resolvePrThreadAgentTool,
  submitPrReviewAgentTool,
]
