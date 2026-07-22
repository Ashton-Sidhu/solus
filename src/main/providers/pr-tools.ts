import { z } from 'zod'
import { tool } from '@anthropic-ai/claude-agent-sdk'
import { createLogger } from '../logger'
import { resolveRepoRef, resolveRepoRoot } from '../git/git-helpers'
import { runAsync } from '../git/exec'
import { writeReviewCheckpoint } from '../review/checkpoints'
import { providerForRepo } from './registry'
import { GitHubReauthRequiredError } from './github/octokit'
import type { DraftReview, DraftReviewComment, PrFilter, RepoRef, ReviewThread } from '../../shared/providers'

const log = createLogger('main', 'pr-tools.ts')

const REVIEW_EVENTS = ['COMMENT', 'REQUEST_CHANGES'] as const
const PR_STATES = ['open', 'closed', 'all'] as const
const SIDES = ['LEFT', 'RIGHT'] as const

let notifyPrsChanged: ((cwd: string) => void) | null = null

export function setPrsChangedNotifier(fn: (cwd: string) => void): void {
  notifyPrsChanged = fn
}

const listPrsShape = {
  state: z.enum(PR_STATES).optional().describe("PR state filter. Defaults to 'open'."),
  author: z.string().optional().describe('Optional author login filter.'),
}

const prNumberShape = {
  number: z.number().int().positive().describe('Pull request number.'),
}

const listThreadsShape = {
  number: z.number().int().positive().describe('Pull request number.'),
  include_resolved: z.boolean().optional().describe('Include resolved threads. Defaults to false.'),
}

const replyThreadShape = {
  thread_id: z.string().describe('Verbatim review thread id returned by list_pr_threads.'),
  body: z.string().describe('Reply body in markdown.'),
}

const resolveThreadShape = {
  thread_id: z.string().describe('Verbatim review thread id returned by list_pr_threads.'),
}

const submitReviewShape = {
  number: z.number().int().positive().describe('Pull request number.'),
  event: z.enum(REVIEW_EVENTS).describe("Review event. APPROVE is intentionally unavailable to agents; approval stays human."),
  body: z.string().describe('Review summary body in markdown.'),
  comments: z.array(z.object({
    path: z.string(),
    line: z.number().int().positive(),
    start_line: z.number().int().positive().optional(),
    side: z.enum(SIDES).optional(),
    body: z.string(),
  })).optional().describe('Optional inline review comments anchored to the PR head.'),
}

const LIST_PRS_DESC = 'List pull requests for the current git repository.'
const READ_PR_DESC = 'Read a pull request overview, including body, headSha, commits, reviewers, mergeability, and top-level conversation.'
const LIST_THREADS_DESC = 'List PR review threads. Use the verbatim thread_id values when replying or resolving.'
const REPLY_THREAD_DESC = 'Reply to a PR review thread by thread id.'
const RESOLVE_THREAD_DESC = 'Resolve a PR review thread by thread id.'
const SUBMIT_REVIEW_DESC = 'Submit a PR review with COMMENT or REQUEST_CHANGES. APPROVE is deliberately excluded; approval stays human.'

export interface PrToolCtx {
  cwd: string
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

function toReviewComments(raw: unknown): DraftReviewComment[] {
  if (!Array.isArray(raw)) return []
  return raw.map((item) => {
    const obj = item && typeof item === 'object' ? item as Record<string, unknown> : {}
    return {
      path: String(obj.path ?? ''),
      line: Number(obj.line ?? 0),
      startLine: obj.start_line === undefined ? undefined : Number(obj.start_line),
      side: (SIDES as readonly string[]).includes(String(obj.side)) ? obj.side as 'LEFT' | 'RIGHT' : 'RIGHT',
      body: String(obj.body ?? ''),
    }
  }).filter((comment) => comment.path && comment.line > 0 && comment.body.trim())
}

export async function executePrTool(
  name: string,
  args: Record<string, unknown>,
  deps: PrToolDeps,
): Promise<PrToolResult> {
  const cwd = deps.ctx.cwd
  try {
    const target = await targetFor(cwd)
    if ('error' in target) return { ok: false, text: target.error }
    const { repo, provider } = target

    if (name === 'list_prs') {
      const filter: PrFilter = {
        state: (PR_STATES as readonly string[]).includes(String(args.state)) ? args.state as PrFilter['state'] : 'open',
        author: typeof args.author === 'string' && args.author.trim() ? args.author.trim() : undefined,
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
      const body = typeof args.body === 'string' ? args.body.trim() : ''
      if (!threadId) return { ok: false, text: 'reply_pr_thread requires thread_id.' }
      if (!body) return { ok: false, text: 'reply_pr_thread requires a non-empty body.' }
      const comment = await provider.review.replyToThread(repo, threadId, body)
      notifyPrsChanged?.(cwd)
      return { ok: true, text: `Replied to thread ${threadId} with comment ${comment.id}.` }
    }

    if (name === 'resolve_pr_thread') {
      const threadId = String(args.thread_id ?? '').trim()
      if (!threadId) return { ok: false, text: 'resolve_pr_thread requires thread_id.' }
      await provider.review.resolveThread(repo, threadId)
      notifyPrsChanged?.(cwd)
      return { ok: true, text: `Resolved thread ${threadId}.` }
    }

    if (name === 'submit_pr_review') {
      const number = Number(args.number ?? 0)
      if (!Number.isInteger(number) || number <= 0) return { ok: false, text: 'submit_pr_review requires a positive PR number.' }
      const event = String(args.event ?? '')
      if (!(REVIEW_EVENTS as readonly string[]).includes(event)) {
        return { ok: false, text: `submit_pr_review event must be one of ${REVIEW_EVENTS.join(', ')}. APPROVE is human-only.` }
      }
      const body = typeof args.body === 'string' ? args.body.trim() : ''
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
        event: event as DraftReview['event'],
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
        if (!saved) log.warn(`review submitted for PR #${number}, but its checkpoint could not be saved`)
      } else {
        log.warn(`review submitted for PR #${number}, but its merge-base could not be resolved`)
      }
      notifyPrsChanged?.(cwd)
      return { ok: true, text: `Submitted ${event} review on PR #${number} anchored to headSha ${detail.headSha}.` }
    }

    return { ok: false, text: `Unknown PR tool: ${name}` }
  } catch (err: any) {
    if (err instanceof GitHubReauthRequiredError) {
      return { ok: false, text: 'GitHub token expired — reconnect in Settings → Connections.' }
    }
    log.error(`executePrTool(${name}) failed: ${String(err)}`)
    return { ok: false, text: `PR tool error: ${String(err?.message ?? err)}` }
  }
}

function toToolResult(r: PrToolResult) {
  return {
    content: [{ type: 'text' as const, text: r.text }],
    ...(r.ok ? {} : { isError: true as const }),
  }
}

export interface PrSdkDeps {
  cwd: string
}

export function prSdkTools(deps: PrSdkDeps) {
  const run = (n: string) => async (args: unknown) =>
    toToolResult(await executePrTool(n, (args ?? {}) as Record<string, unknown>, { ctx: { cwd: deps.cwd } }))
  return [
    tool('list_prs', LIST_PRS_DESC, listPrsShape, run('list_prs')),
    tool('read_pr', READ_PR_DESC, prNumberShape, run('read_pr')),
    tool('list_pr_threads', LIST_THREADS_DESC, listThreadsShape, run('list_pr_threads')),
    tool('reply_pr_thread', REPLY_THREAD_DESC, replyThreadShape, run('reply_pr_thread')),
    tool('resolve_pr_thread', RESOLVE_THREAD_DESC, resolveThreadShape, run('resolve_pr_thread')),
    tool('submit_pr_review', SUBMIT_REVIEW_DESC, submitReviewShape, run('submit_pr_review')),
  ]
}

export interface PrToolDescriptor {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export const PR_TOOL_JSON_SCHEMAS: PrToolDescriptor[] = [
  { name: 'list_prs', description: LIST_PRS_DESC, inputSchema: z.toJSONSchema(z.object(listPrsShape)) as Record<string, unknown> },
  { name: 'read_pr', description: READ_PR_DESC, inputSchema: z.toJSONSchema(z.object(prNumberShape)) as Record<string, unknown> },
  { name: 'list_pr_threads', description: LIST_THREADS_DESC, inputSchema: z.toJSONSchema(z.object(listThreadsShape)) as Record<string, unknown> },
  { name: 'reply_pr_thread', description: REPLY_THREAD_DESC, inputSchema: z.toJSONSchema(z.object(replyThreadShape)) as Record<string, unknown> },
  { name: 'resolve_pr_thread', description: RESOLVE_THREAD_DESC, inputSchema: z.toJSONSchema(z.object(resolveThreadShape)) as Record<string, unknown> },
  { name: 'submit_pr_review', description: SUBMIT_REVIEW_DESC, inputSchema: z.toJSONSchema(z.object(submitReviewShape)) as Record<string, unknown> },
]

export const PR_TOOL_NAMES = new Set(PR_TOOL_JSON_SCHEMAS.map((t) => t.name))
export const PR_MUTATING_TOOLS = new Set(['reply_pr_thread', 'resolve_pr_thread', 'submit_pr_review'])
