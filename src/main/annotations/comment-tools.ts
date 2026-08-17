import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { createLogger } from '../logger'
import type { AgentTool } from '../agents/tools/agent-tool'
import { loadWork } from '../folio/works'
import { loadWorkAnnotations, saveWorkAnnotations } from '../folio/work-annotations'
import { loadAnnotations, saveAnnotations } from '../plans/annotations'
import { extractPlanTitle } from '../agents/plan-text'
import { findSession, getSessionController, type SessionToolCtx } from '../sessions/session-tools'
import { foreignLinkedItemsFor } from '../tasks/foreign-tasks'
import { notifyAnnotationsChanged } from './annotation-events'
import type { CommentAgentAuthor, PlanAnnotations, PlanComment, SessionMeta } from '../../shared/types'

const log = createLogger('annotations', 'comment-tools.ts')

/**
 * Comment threads on plans and works, written by an agent instead of by the
 * user — the same threads the plan/work editor renders in its rail.
 *
 * Storage differs per target (plans key on `sessionId + planToolUseId`, works on
 * `workId`) but the `PlanComment` shape is identical, so one module with a small
 * target resolver beats two parallel copies. Provider-neutral throughout: works
 * and annotations have no provider dimension.
 */

// ─── Target resolution ───

/** A plan is addressed by the composite key `planKey()` already uses, a work by
 *  its id; only the plan key contains `__`, so one `target_id` covers both. */
function isPlanTarget(targetId: string): boolean {
  return targetId.includes('__')
}

interface TargetThreads {
  label: string
  comments: PlanComment[]
  save: (comments: PlanComment[]) => Promise<void>
}

/** Resolves a target's threads AND the text a quote must anchor into. Both are
 *  loaded together because a plan needs its session's provider and cwd for
 *  either one, and that lookup should happen once. */
async function resolveTarget(targetId: string): Promise<(TargetThreads & { content: string | null }) | null> {
  if (isPlanTarget(targetId)) return resolvePlanTarget(targetId)

  const work = await loadWork(targetId)
  if (!work) return null
  const existing = await loadWorkAnnotations(targetId)
  return {
    label: `work "${work.title}"`,
    content: work.content,
    comments: existing?.comments ?? [],
    save: async (comments) => {
      await saveWorkAnnotations({ version: 1, workId: targetId, comments, updatedAt: Date.now() })
      notifyAnnotationsChanged({ kind: 'work', targetId })
    },
  }
}

async function resolvePlanTarget(targetId: string): Promise<(TargetThreads & { content: string | null }) | null> {
  const controller = getSessionController()
  if (!controller) return null
  const separator = targetId.indexOf('__')
  const sessionId = targetId.slice(0, separator)
  const planToolUseId = targetId.slice(separator + 2)
  const meta = await findSession(sessionId)
  if (!meta) return null
  const content = await controller.loadPlanContent(meta.provider, sessionId, meta.projectPath || meta.cwd, planToolUseId)
  const existing = await loadAnnotations(sessionId, planToolUseId)
  // A plan nobody has annotated yet has no row at all — the first comment on it
  // creates one, exactly as the first comment from the user's rail does.
  if (!existing && content === null) return null
  const base: PlanAnnotations = existing ?? {
    version: 1,
    sessionId,
    projectPath: meta.projectPath || meta.cwd,
    cwd: meta.cwd,
    planToolUseId,
    title: extractPlanTitle(content ?? ''),
    status: 'pending',
    comments: [],
    bookmarked: false,
    updatedAt: Date.now(),
  }
  return {
    label: `plan "${base.title}"`,
    content,
    comments: base.comments ?? [],
    save: async (comments) => {
      await saveAnnotations({ ...base, comments, updatedAt: Date.now() })
      controller.invalidatePlanCaches(sessionId)
      notifyAnnotationsChanged({ kind: 'plan', targetId })
    },
  }
}

// ─── Anchoring ───

const INLINE_MARKUP: Array<[RegExp, string]> = [
  [/!\[([^\]]*)\]\([^)]*\)/g, '$1'],
  [/\[([^\]]*)\]\([^)]*\)/g, '$1'],
  [/(\*\*|__)(.+?)\1/g, '$2'],
  [/(\*|_)(.+?)\1/g, '$2'],
  [/~~(.+?)~~/g, '$1'],
  [/`([^`]+)`/g, '$1'],
]

/**
 * Approximates what the editor actually searches: ProseMirror's
 * `doc.textBetween(0, size, ' ')` over the parsed markdown — RENDERED text, with
 * blocks joined by a single space. A quote carrying `**`, `#` or a list marker
 * can therefore never anchor, which is why validation runs against this rather
 * than against the raw source.
 */
export function renderedText(markdown: string): string {
  const lines: string[] = []
  for (const raw of markdown.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(raw)) continue
    let line = raw
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^\s*>\s?/, '')
      .replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')
      .replace(/^\s*(?:[-*_]\s*){3,}$/, '')
    for (const [pattern, replacement] of INLINE_MARKUP) line = line.replace(pattern, replacement)
    const trimmed = line.trim()
    if (trimmed) lines.push(trimmed)
  }
  return lines.join(' ')
}

type AnchorResult =
  | { ok: true; textOffset: number }
  | { ok: false; reason: 'not-found' | 'ambiguous' }

export function anchorQuote(content: string, quote: string): AnchorResult {
  const haystack = renderedText(content)
  const needle = quote.replace(/\s+/g, ' ').trim()
  const first = haystack.indexOf(needle)
  if (first === -1) return { ok: false, reason: 'not-found' }
  if (haystack.indexOf(needle, first + 1) !== -1) return { ok: false, reason: 'ambiguous' }
  return { ok: true, textOffset: first }
}

// ─── Thread rendering (shared with read_work) ───

/** The open-threads block appended to a document an agent reads back, so
 *  `read_work` and `read_plan` render feedback identically. Resolved threads are
 *  left out — they have been dealt with, and re-serving them reads as a fresh
 *  request. */
export function formatOpenThreads(comments: readonly PlanComment[]): string {
  const open = comments.filter((c) => !c.resolvedAt)
  if (!open.length) return ''
  const lines = open.map((c) => {
    const anchor = c.nodeId
      ? `On node "${c.selectedText}" (node id: ${c.nodeId})`
      : c.edgeId
        ? `On edge "${c.selectedText}" (edge id: ${c.edgeId})`
        : `On "${c.selectedText}"`
    const head = `- [${c.id}] ${anchor} — ${threadAuthor(c)}: ${c.comment}`
    const replies = (c.replies ?? []).map((r) => `  - ${threadAuthor(r)}: ${r.text}`)
    return [head, ...replies].join('\n')
  })
  return `\n\nOpen threads on this document (${lines.length}) — address them when revising, then resolve_comment each one:\n${lines.join('\n')}`
}

function threadAuthor(message: Pick<PlanComment, 'author' | 'authorAgent'>): string {
  if ((message.author ?? 'you') !== 'solus') return 'User'
  return message.authorAgent?.title ?? 'Solus'
}

/** Who a thread message written by a tool is attributed to. `CommentAuthor`
 *  alone can only say "solus", which is useless once several agents are
 *  reviewing the same document. */
export async function callerAgent(ctx: SessionToolCtx | undefined): Promise<CommentAgentAuthor | undefined> {
  if (!ctx?.sessionId) return undefined
  const meta = await findSession(ctx.sessionId)
  const author: CommentAgentAuthor = {
    sessionId: ctx.sessionId,
    // The slug only — never `peerTitle`'s first-message fallback. A session is
    // usually still unnamed when its agent writes the first comment, and that
    // fallback would sign the thread with the user's raw prompt. No slug, no
    // session to name: the thread signs as plain "Solus".
    provider: ctx.agentProvider,
  }
  if (meta?.slug) author.title = meta.slug
  return author
}

// ─── Schemas ───

const readPlanFields = {
  session_id: z.string().describe('The session that produced the plan.'),
  plan_tool_use_id: z.string().optional().describe("The specific plan revision to read. Omit for the session's latest plan."),
}

const commentDocumentFields = {
  target_id: z.string().describe('What to comment on: a work id (from list_works) or a plan id shaped `<sessionId>__<planToolUseId>` (from read_plan).'),
  comments: z
    .array(
      z.object({
        quote: z.string().describe('The exact passage to anchor to, copied verbatim from the document as it READS — plain text only. Markdown syntax (**, #, list markers) is not part of the rendered text and can never anchor. Quote enough words to be unique.'),
        comment: z.string().describe('The note itself: what is wrong or what to change.'),
        node_id: z.string().optional().describe('For diagram works: anchor to this node instead of to a text quote. Pass the node label as `quote`.'),
        edge_id: z.string().optional().describe('For diagram works: anchor to this edge instead of to a text quote. Pass the edge label as `quote`.'),
      }),
    )
    .min(1)
    .describe('All the comments to leave in one pass — a review is several notes at once.'),
}

const replyCommentFields = {
  target_id: z.string().describe('The work id or plan id the thread lives on.'),
  comment_id: z.string().describe('The thread id, shown in brackets by read_work / read_plan.'),
  text: z.string().describe('Your reply.'),
}

const resolveCommentFields = {
  target_id: z.string().describe('The work id or plan id the thread lives on.'),
  comment_id: z.string().describe('The thread id, shown in brackets by read_work / read_plan.'),
}

const READ_PLAN_DESC =
  'Read a plan a Solus session wrote, plus every open comment thread on it. Use it before reviewing a plan (review_plan rules on one that is still awaiting approval) or before commenting on it. Returns the plan id you pass to comment_document.'
const COMMENT_DOCUMENT_DESC =
  "Leave anchored comment threads on a plan or a work, exactly where the user leaves theirs — they appear in the document's margin, attributed to you. Anchor each one by quoting the passage verbatim as it reads on screen; a quote that is not found, or found more than once, is refused rather than left floating. Use this to review a document instead of describing your notes in chat."
const REPLY_COMMENT_DESC =
  'Reply in an existing comment thread on a plan or a work. Use it to answer a thread the user opened rather than opening a new one beside it.'
const RESOLVE_COMMENT_DESC =
  'Resolve a comment thread on a plan or a work, once you have actually acted on it. A resolved thread stops being served back by read_work / read_plan.'

// ─── Executor (shared by the Claude SDK tool + the Codex handler) ───

export interface CommentToolResult {
  ok: boolean
  text: string
}

export interface CommentToolDeps {
  ctx?: SessionToolCtx
}

interface CommentRequest {
  quote?: string
  comment?: string
  node_id?: string
  edge_id?: string
}

interface CommentToolArgs {
  session_id?: string
  plan_tool_use_id?: string
  target_id?: string
  comments?: CommentRequest[]
  comment_id?: string
  text?: string
}

export async function executeCommentTool(
  name: string,
  args: CommentToolArgs,
  deps: CommentToolDeps = {},
): Promise<CommentToolResult> {
  try {
    if (name === 'read_plan') return await readPlan(args, deps)
    if (name === 'comment_document') return await commentDocument(args, deps)
    if (name === 'reply_comment') return await replyComment(args, deps)
    if (name === 'resolve_comment') return await resolveComment(args)
    return { ok: false, text: `Unknown comment tool: ${name}` }
  } catch (err: any) {
    log.error('comment_tool_failed', { tool: name, error: err instanceof Error ? err.message : String(err) })
    return { ok: false, text: `Comment tool error: ${String(err?.message ?? err)}` }
  }
}

async function readPlan(args: CommentToolArgs, deps: CommentToolDeps = {}): Promise<CommentToolResult> {
  const sessionId = String(args.session_id ?? '').trim()
  if (!sessionId) return { ok: false, text: 'read_plan requires session_id.' }
  const requestedPlanId = args.plan_tool_use_id?.trim() || null

  const controller = getSessionController()
  const meta = controller ? await findSession(sessionId) : null
  if (!controller || !meta) {
    // The plan's session is not on this host. A dispatched session may still
    // hold a shipped copy of the task's linked plan — serve that, read-only.
    const foreign = foreignLinkedItemsFor(deps.ctx?.solusSessionId).find(
      (item) => item.kind === 'plan' && item.scope === sessionId
        && (requestedPlanId === null || item.key === requestedPlanId),
    )
    if (foreign) {
      return {
        ok: true,
        text: `Plan "${foreign.title}" (id: ${foreign.scope}__${foreign.key}) — a read-only copy shipped from the task's host; its comment threads are not available here:\n\n${foreign.content}`,
      }
    }
    if (!controller) return { ok: false, text: 'read_plan is unavailable — no session controller is wired.' }
    return { ok: false, text: `Session ${sessionId} not found.` }
  }

  const planToolUseId = requestedPlanId ?? await latestPlanToolUseId(controller, meta)
  if (!planToolUseId) return { ok: true, text: `Session ${sessionId} has no plan.` }

  const content = await controller.loadPlanContent(meta.provider, sessionId, meta.projectPath || meta.cwd, planToolUseId)
  if (content === null) return { ok: false, text: `Plan ${planToolUseId} could not be read for session ${sessionId}.` }

  const annotations = await loadAnnotations(sessionId, planToolUseId)
  const title = annotations?.title || extractPlanTitle(content)
  const status = annotations?.status ?? 'pending'
  return {
    ok: true,
    text: `Plan "${title}" (${status}, id: ${sessionId}__${planToolUseId}):\n\n${content}${formatOpenThreads(annotations?.comments ?? [])}`,
  }
}

/** Whether a comment target the local stores cannot resolve names a shipped
 *  linked item — a work id, or a plan id shaped `<sessionId>__<planToolUseId>`. */
function isForeignCommentTarget(solusSessionId: string | undefined, targetId: string): boolean {
  const items = foreignLinkedItemsFor(solusSessionId)
  if (!isPlanTarget(targetId)) return items.some((item) => item.kind === 'work' && item.key === targetId)
  const separator = targetId.indexOf('__')
  const scope = targetId.slice(0, separator)
  const key = targetId.slice(separator + 2)
  return items.some((item) => item.kind === 'plan' && item.scope === scope && item.key === key)
}

async function latestPlanToolUseId(
  controller: NonNullable<ReturnType<typeof getSessionController>>,
  meta: SessionMeta,
): Promise<string | null> {
  const plans = await controller.listPlans(meta.provider, meta.projectPath || meta.cwd, false)
  const mine = plans.filter((plan) => plan.sessionId === meta.sessionId)
  if (!mine.length) return null
  return mine.reduce((latest, plan) => (plan.timestamp > latest.timestamp ? plan : latest)).planToolUseId
}

async function commentDocument(args: CommentToolArgs, deps: CommentToolDeps): Promise<CommentToolResult> {
  const targetId = String(args.target_id ?? '').trim()
  if (!targetId) return { ok: false, text: 'comment_document requires target_id.' }
  const requested = Array.isArray(args.comments) ? args.comments : []
  if (!requested.length) return { ok: false, text: 'comment_document requires at least one comment.' }

  const target = await resolveTarget(targetId)
  if (!target) {
    if (isForeignCommentTarget(deps.ctx?.solusSessionId, targetId)) {
      return {
        ok: false,
        text: `"${targetId}" is a read-only copy shipped from the task's host (this session was dispatched); its comment threads live there and cannot be written from here. Put the feedback in a comment_task instead.`,
      }
    }
    return { ok: false, text: `No plan or work found with id "${targetId}".` }
  }

  const author = await callerAgent(deps.ctx)
  const created: PlanComment[] = []
  for (const raw of requested) {
    const quote = String(raw.quote ?? '').trim()
    const comment = String(raw.comment ?? '').trim()
    if (!quote) return { ok: false, text: 'Every comment needs a `quote` naming what it is about.' }
    if (!comment) return { ok: false, text: `The comment on "${quote}" is empty.` }
    const nodeId = raw.node_id?.trim() || undefined
    const edgeId = raw.edge_id?.trim() || undefined

    // A diagram comment anchors to a node/edge id, so there is no text to find.
    let textOffset: number | undefined
    if (!nodeId && !edgeId) {
      if (target.content === null) return { ok: false, text: `The content of "${targetId}" could not be read, so no quote can be anchored.` }
      const anchor = anchorQuote(target.content, quote)
      if (!anchor.ok) {
        return anchor.reason === 'not-found'
          ? { ok: false, text: `"${quote}" is not in the document as it reads. Quote the RENDERED text exactly — no **, #, or list markers, and no paraphrase. Nothing was written.` }
          : { ok: false, text: `"${quote}" appears more than once, so the comment would anchor to the wrong place. Quote a longer, unique passage. Nothing was written.` }
      }
      textOffset = anchor.textOffset
    }

    const createdComment: PlanComment = {
      id: randomUUID(),
      selectedText: quote,
      comment,
      author: 'solus',
      createdAt: Date.now(),
    }
    if (textOffset !== undefined) createdComment.textOffset = textOffset
    if (nodeId) createdComment.nodeId = nodeId
    if (edgeId) createdComment.edgeId = edgeId
    if (author) createdComment.authorAgent = author
    created.push(createdComment)
  }

  await target.save([...target.comments, ...created])
  log.info('agent_comments_written', { targetId, count: created.length })
  return { ok: true, text: `Left ${created.length} comment${created.length === 1 ? '' : 's'} on ${target.label}.` }
}

async function replyComment(args: CommentToolArgs, deps: CommentToolDeps): Promise<CommentToolResult> {
  const targetId = String(args.target_id ?? '').trim()
  const commentId = String(args.comment_id ?? '').trim()
  const text = args.text?.trim() ?? ''
  if (!targetId || !commentId) return { ok: false, text: 'reply_comment requires target_id and comment_id.' }
  if (!text) return { ok: false, text: 'reply_comment requires non-empty text.' }

  const target = await resolveTarget(targetId)
  if (!target) return { ok: false, text: `No plan or work found with id "${targetId}".` }
  const thread = target.comments.find((c) => c.id === commentId)
  if (!thread) return { ok: false, text: `No thread "${commentId}" on ${target.label}.` }

  const author = await callerAgent(deps.ctx)
  const reply: NonNullable<PlanComment['replies']>[number] = {
    id: randomUUID(),
    author: 'solus',
    text,
    createdAt: Date.now(),
  }
  if (author) reply.authorAgent = author
  const replies = [...(thread.replies ?? []), reply]
  await target.save(target.comments.map((c) => (c.id === commentId ? { ...c, replies } : c)))
  return { ok: true, text: `Replied in thread "${thread.selectedText}" on ${target.label}.` }
}

async function resolveComment(args: CommentToolArgs): Promise<CommentToolResult> {
  const targetId = String(args.target_id ?? '').trim()
  const commentId = String(args.comment_id ?? '').trim()
  if (!targetId || !commentId) return { ok: false, text: 'resolve_comment requires target_id and comment_id.' }

  const target = await resolveTarget(targetId)
  if (!target) return { ok: false, text: `No plan or work found with id "${targetId}".` }
  const thread = target.comments.find((c) => c.id === commentId)
  if (!thread) return { ok: false, text: `No thread "${commentId}" on ${target.label}.` }
  if (thread.resolvedAt) return { ok: true, text: `Thread "${thread.selectedText}" was already resolved.` }

  await target.save(target.comments.map((comment) => {
    if (comment.id !== commentId) return comment
    return { ...comment, resolvedAt: Date.now(), resolvedBy: 'solus' }
  }))
  return { ok: true, text: `Resolved thread "${thread.selectedText}" on ${target.label}.` }
}

// ─── Tool definitions ───

function commentAgentTool(name: string, description: string, inputFields: AgentTool['inputFields'], requiresApproval: boolean): AgentTool {
  return {
    name,
    description,
    inputFields,
    requiresApproval,
    execute: async (args, context) => executeCommentTool(name, args, {
      ctx: {
        agentProvider: context.provider,
        cwd: context.cwd,
        sessionId: context.sessionId(),
        solusSessionId: context.solusSessionId(),
      },
    }),
  }
}

export const readPlanAgentTool = commentAgentTool('read_plan', READ_PLAN_DESC, readPlanFields, false)
export const commentDocumentAgentTool = commentAgentTool('comment_document', COMMENT_DOCUMENT_DESC, commentDocumentFields, false)
export const replyCommentAgentTool = commentAgentTool('reply_comment', REPLY_COMMENT_DESC, replyCommentFields, false)
export const resolveCommentAgentTool = commentAgentTool('resolve_comment', RESOLVE_COMMENT_DESC, resolveCommentFields, false)
