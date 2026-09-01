import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { createLogger } from '../logger'
import type { AgentTool } from '../agents/tools/agent-tool'
import { formatAnswer } from '../../shared/question-answer'
import { extractPlanTitle } from '../agents/plan-text'
import { loadAnnotations, saveAnnotations } from '../plans/annotations'
import { describePendingInput, type PendingInputDescription } from './pending-input'
import {
  findSession,
  getSessionController,
  peerTitle,
  sessionLink,
  type SessionToolDeps,
} from './session-tools'
import { notifyAnnotationsChanged } from '../annotations/annotation-events'
import { callerAgent } from '../annotations/comment-tools'
import type { PlanAnnotations, PlanComment, SessionMeta } from '../../shared/types'

const log = createLogger('sessions', 'session-review-tools.ts')

/**
 * The tools that let one agent RESOLVE another's pause rather than only observe
 * it: answering a peer's question, and ruling on a peer's plan.
 *
 * Everything structural comes from `describePendingInput` — never from the
 * `[session report]` prose. Each tool is self-describing: called with only
 * `session_id` it reports what the peer is waiting on and changes nothing, so
 * the agent never has to parse an injected turn to learn what it is answering.
 *
 * Tool *permission* requests are deliberately out of scope: an agent granting a
 * peer Bash/Write/MCP access is a privilege escalation with no human in the
 * loop, so both tools refuse them by name.
 */

// The same copy the human Revise button sends (`session-plan-operations.rejectPlan`),
// so an agent rejection and a human one read identically in the peer's transcript.
const REVISION_PREFIX = 'Please revise the plan with these comments:\n\n'
const IMPLEMENT_PREFIX = 'Implement this plan:\n\n'

const PERMISSION_BOUNDARY =
  'is waiting on a TOOL PERMISSION request, which only a human can grant. Agents cannot approve another agent\'s Bash/Write/MCP access. Ask the user to answer it in that session, or use stop_session.'

const answerSessionShape = {
  session_id: z.string().describe('The paused session to answer. Cannot be your own session.'),
  answers: z
    .array(
      z.object({
        key: z.string().describe('The question key, exactly as returned by calling this tool without `answers`.'),
        choice: z.string().describe('One of that question\'s option labels, verbatim. For a multi-select question pass the labels comma-separated. Free text is allowed only when the question offers no options.'),
        comment: z.string().optional().describe('Optional remark sent alongside the choice.'),
      }),
    )
    .optional()
    .describe('Omit to READ the pending questions (their keys, text and valid option labels) without answering. Pass them to answer.'),
}

const reviewPlanShape = {
  session_id: z.string().describe('The session whose plan you are reviewing. Cannot be your own session.'),
  decision: z
    .enum(['approve', 'request_changes'])
    .optional()
    .describe('Omit to READ the pending plan without ruling on it. `approve` lets the peer implement it; `request_changes` sends it back to planning.'),
  comment: z.string().optional().describe('Your review note. Required for request_changes; it is what the peer revises against.'),
  revised_plan: z.string().optional().describe('With `approve`: the full plan text to implement INSTEAD of the one the peer wrote. Use it to edit rather than to re-litigate.'),
}

const ANSWER_SESSION_DESC =
  "Answer a question another Solus session is parked on, so it can continue without a human. Call it with only session_id first: that returns each pending question's key, text and valid option labels and changes nothing. Then call it again with `answers` to send them. Use this whenever an agent-conversation card shows a peer waiting on a question. Plans go to review_plan instead; tool permission requests are human-only and are refused."
const REVIEW_PLAN_DESC =
  "Approve, edit, or send back a plan another Solus session is waiting on. Call it with only session_id first: that returns the plan text and changes nothing. Then call again with decision='approve' (optionally with revised_plan to implement an edited version) or decision='request_changes' plus a comment saying what to change. The decision is recorded on the plan, so it shows in the plans gallery exactly as a human ruling would."

// ─── Shared plumbing ───

interface Peer {
  meta: SessionMeta
  pending: PendingInputDescription | null
}

async function resolvePeer(
  tool: string,
  sessionId: string,
  deps: SessionToolDeps,
): Promise<{ ok: false; text: string } | { ok: true; peer: Peer }> {
  const controller = getSessionController()
  if (!controller) return { ok: false, text: `${tool} is unavailable — no session controller is wired.` }
  if (!sessionId) return { ok: false, text: `${tool} requires session_id.` }
  if (sessionId === deps.ctx?.sessionId) return { ok: false, text: `Cannot ${tool === 'review_plan' ? 'review your own plan' : 'answer your own question'}.` }
  const meta = await findSession(sessionId)
  if (!meta) return { ok: false, text: `Session ${sessionId} not found.` }
  return { ok: true, peer: { meta, pending: describePendingInput(controller.pendingInputEvents(sessionId)) } }
}

/** Sends a prompt into the peer AND re-arms the exchange, because every path
 *  that gets here has already consumed the caller's live watch: a Codex plan
 *  arrives after its turn ended, and a denied plan permission cancels the run.
 *  Without this the revised plan never comes back to the reviewer. */
async function dispatchToPeer(meta: SessionMeta, prompt: string, permissionMode: 'ask' | 'plan', deps: SessionToolDeps): Promise<void> {
  const controller = getSessionController()!
  const result = await controller.promptSession(meta.sessionId, prompt, 'queue', { permissionMode })
  const exchangeId = randomUUID()
  const dispatchedAt = Date.now()
  const callerSessionId = deps.ctx?.sessionId
  if (callerSessionId) {
    controller.watchSessionSettled(meta.sessionId, callerSessionId, {
      exchangeId,
      dispatchedAt,
      notifyModel: true,
      runKey: result.disposition === 'queued' && result.queueId ? result.queueId : 'active',
    })
  }
  deps.onAgentConversationUpdate?.({
    phase: 'dispatched',
    agentSessionId: meta.sessionId,
    exchangeId,
    origin: 'prompted',
    prompt,
    delivery: 'queue',
    provider: meta.provider,
    title: peerTitle(meta),
    cwd: meta.cwd,
    model: meta.model,
    reasoningEffort: meta.reasoningEffort,
    dispatchedAt,
  })
}

/** Files the ruling on the plan itself, so `request_changes` from an agent shows
 *  in the plans gallery exactly as a human rejection does. Plans that carry no
 *  tool-use id (nothing to key on) are simply not annotated. */
async function recordPlanDecision(
  meta: SessionMeta,
  plan: Extract<PendingInputDescription, { kind: 'plan' }>,
  status: 'accepted' | 'rejected',
  comment: string | undefined,
  deps: SessionToolDeps,
): Promise<void> {
  if (!plan.planToolUseId) return
  const existing = await loadAnnotations(meta.sessionId, plan.planToolUseId)
  const title = extractPlanTitle(plan.planContent)
  const author = await callerAgent(deps.ctx)
  const thread: PlanComment[] = comment
    ? [{
        // Anchored on the plan's own title line so the note lands somewhere real
        // in the rail; a review of the whole plan has no quoted selection.
        id: randomUUID(),
        selectedText: title,
        comment,
        author: 'solus',
        ...(author ? { authorAgent: author } : {}),
        createdAt: Date.now(),
      }]
    : []
  const annotations: PlanAnnotations = {
    version: 1,
    sessionId: meta.sessionId,
    projectPath: existing?.projectPath || meta.projectPath || meta.cwd,
    cwd: existing?.cwd || meta.cwd,
    planToolUseId: plan.planToolUseId,
    title: existing?.title || title,
    status,
    comments: [...(existing?.comments ?? []), ...thread],
    bookmarked: existing?.bookmarked ?? false,
    ...(existing?.bookmarkedAt === undefined ? {} : { bookmarkedAt: existing.bookmarkedAt }),
    updatedAt: Date.now(),
  }
  await saveAnnotations(annotations)
  getSessionController()?.invalidatePlanCaches(meta.sessionId)
  notifyAnnotationsChanged({ kind: 'plan', targetId: `${meta.sessionId}__${plan.planToolUseId}` })
}

// ─── Executor (shared by the Claude SDK tool + the Codex handler) ───

export interface SessionReviewToolResult {
  ok: boolean
  text: string
}

interface SessionAnswerInput {
  key?: unknown
  choice?: unknown
  comment?: unknown
}

interface SessionReviewToolArgs {
  session_id?: unknown
  answers?: SessionAnswerInput[]
  decision?: unknown
  comment?: unknown
  revised_plan?: unknown
}

export async function executeSessionReviewTool(
  name: string,
  args: SessionReviewToolArgs,
  deps: SessionToolDeps = {},
): Promise<SessionReviewToolResult> {
  try {
    if (name === 'answer_session') return await answerSession(args, deps)
    if (name === 'review_plan') return await reviewPlan(args, deps)
    return { ok: false, text: `Unknown session review tool: ${name}` }
  } catch (err: any) {
    log.error('session_review_tool_failed', { tool: name, error: err instanceof Error ? err.message : String(err) })
    return { ok: false, text: `Session review tool error: ${String(err?.message ?? err)}` }
  }
}

async function answerSession(args: SessionReviewToolArgs, deps: SessionToolDeps): Promise<SessionReviewToolResult> {
  const sessionId = String(args.session_id ?? '').trim()
  const resolved = await resolvePeer('answer_session', sessionId, deps)
  if (!resolved.ok) return resolved
  const { meta, pending } = resolved.peer

  if (!pending) return { ok: true, text: `Session ${sessionLink(meta)} is not waiting on any input right now.` }
  if (pending.kind === 'permission') return { ok: false, text: `Session ${sessionLink(meta)} ${PERMISSION_BOUNDARY}` }
  if (pending.kind === 'plan') {
    return { ok: false, text: `Session ${sessionLink(meta)} is waiting on plan approval, not a question. Use review_plan.` }
  }

  const raw = Array.isArray(args.answers) ? args.answers : null
  if (!raw) {
    const block = pending.questions.map((q, i) => {
      const options = q.options.length ? q.options.map((o) => `    - ${o}`).join('\n') : '    (free text — any answer)'
      return [
        `${i + 1}. key: ${q.key}`,
        `   ${q.header ? `${q.header}: ` : ''}${q.question}${q.multiSelect ? ' (select all that apply)' : ''}`,
        options,
      ].join('\n')
    }).join('\n')
    return {
      ok: true,
      text: `Session ${sessionLink(meta)} is waiting on ${pending.questions.length} question${pending.questions.length === 1 ? '' : 's'}:\n${block}\n\n→ Call answer_session again with answers: [{ key, choice, comment? }] to send them. Nothing has changed yet.`,
    }
  }

  const byKey = new Map(pending.questions.map((q) => [q.key, q]))
  const answers: Record<string, string> = {}
  for (const entry of raw) {
    const key = String(entry.key ?? '').trim()
    const question = byKey.get(key)
    if (!question) {
      return { ok: false, text: `No pending question with key "${key}". Valid keys: ${[...byKey.keys()].map((k) => `"${k}"`).join(', ')}.` }
    }
    const choice = String(entry.choice ?? '').trim()
    if (question.options.length) {
      // A label the card never offered would reach the provider as free text and
      // silently mean something else, so it is refused rather than passed on.
      const picked = choice ? choice.split(',').map((c) => c.trim()).filter(Boolean) : []
      const unknown = picked.filter((c) => !question.options.includes(c))
      if (unknown.length) {
        return { ok: false, text: `"${unknown[0]}" is not an option for question "${key}". Options: ${question.options.map((o) => `"${o}"`).join(', ')}.` }
      }
      if (!question.multiSelect && picked.length > 1) {
        return { ok: false, text: `Question "${key}" is single-select — pass one option label, not ${picked.length}.` }
      }
    }
    const comment = typeof entry.comment === 'string' ? entry.comment : undefined
    if (!choice && !comment?.trim()) {
      return { ok: false, text: `Question "${key}" needs a choice or a comment. Send an empty choice only to hand the decision back deliberately.` }
    }
    answers[key] = formatAnswer(choice, comment)
  }

  // Every pending question ships, answered or not — the card sends a complete
  // record too, and a missing key reads to the provider as a dropped question
  // rather than as "you choose".
  for (const question of pending.questions) {
    if (!(question.key in answers)) answers[question.key] = ''
  }
  // Codex's MCP elicitation form is declined outright without this.
  if (pending.isMcpElicitation) answers.__action = 'accept'

  const delivered = getSessionController()!.answerQuestion(pending.questionId, answers)
  if (!delivered) {
    return { ok: false, text: `Session ${sessionLink(meta)} is no longer waiting on that question — it was answered or cancelled. Call answer_session again to see its current state.` }
  }

  const answerText = pending.questions
    .map((q) => (answers[q.key] ? `${q.question} → ${answers[q.key]}` : null))
    .filter(Boolean)
    .join('\n') || '(handed the decision back)'
  deps.onAgentConversationUpdate?.({ phase: 'answered', agentSessionId: meta.sessionId, answerText })
  log.info('peer_question_answered', { sessionId: meta.sessionId, questionCount: pending.questions.length })
  return { ok: true, text: `Answered ${sessionLink(meta)}. It is continuing; its reply will arrive in this conversation.` }
}

async function reviewPlan(args: SessionReviewToolArgs, deps: SessionToolDeps): Promise<SessionReviewToolResult> {
  const sessionId = String(args.session_id ?? '').trim()
  const resolved = await resolvePeer('review_plan', sessionId, deps)
  if (!resolved.ok) return resolved
  const { meta, pending } = resolved.peer

  if (!pending) return { ok: true, text: `Session ${sessionLink(meta)} has no plan awaiting review right now.` }
  if (pending.kind === 'permission') return { ok: false, text: `Session ${sessionLink(meta)} ${PERMISSION_BOUNDARY}` }
  if (pending.kind === 'question') {
    return { ok: false, text: `Session ${sessionLink(meta)} is waiting on a question, not a plan. Use answer_session.` }
  }

  const decision = args.decision === undefined ? null : String(args.decision)
  if (!decision) {
    const drive = pending.blocking
      ? 'Its run is held open on this plan, so approving lets it implement in place, keeping everything it explored.'
      : 'Its turn has already ended, so a ruling starts a fresh run rather than resuming one.'
    return {
      ok: true,
      text: `Plan awaiting review in ${sessionLink(meta)}. ${drive}\n\n${pending.planContent}\n\n→ Call review_plan again with decision='approve' (optionally revised_plan) or decision='request_changes' with a comment. Nothing has changed yet.`,
    }
  }
  if (decision !== 'approve' && decision !== 'request_changes') {
    return { ok: false, text: "review_plan decision must be 'approve' or 'request_changes'." }
  }

  const comment = typeof args.comment === 'string' ? args.comment.trim() : ''
  if (decision === 'request_changes' && !comment) {
    return { ok: false, text: 'review_plan requires a comment with request_changes — it is the only thing the peer has to revise against.' }
  }
  const revisedPlan = typeof args.revised_plan === 'string' && args.revised_plan.trim() ? args.revised_plan : undefined

  const controller = getSessionController()!
  if (decision === 'approve') {
    if (pending.blocking) {
      // Intentionally NOT the human Approve flow (`approvePlanWithModel`), which
      // resets the session and re-sends the plan as a fresh run. Answering the
      // permission is what that permission already means, and it keeps the
      // peer's exploration context. Don't "fix" this into a reset.
      if (!pending.allowOptionId) return { ok: false, text: 'That plan offers no approve option — nothing to answer.' }
      const delivered = controller.respondPermission(pending.questionId, pending.allowOptionId, revisedPlan)
      if (!delivered) return { ok: false, text: `Session ${sessionLink(meta)} is no longer holding that plan open. Call review_plan again to see its current state.` }
    } else {
      await dispatchToPeer(meta, `${IMPLEMENT_PREFIX}${revisedPlan ?? pending.planContent}`, 'ask', deps)
    }
  } else {
    const revision = `${REVISION_PREFIX}${comment}`
    if (pending.blocking) {
      if (!pending.denyOptionId) return { ok: false, text: 'That plan offers no reject option — nothing to answer.' }
      // Awaited so the deny lands before the note; otherwise the note queues
      // behind a turn that is still blocked on the unanswered permission.
      const delivered = controller.respondPermission(pending.questionId, pending.denyOptionId)
      if (!delivered) return { ok: false, text: `Session ${sessionLink(meta)} is no longer holding that plan open. Call review_plan again to see its current state.` }
    }
    await dispatchToPeer(meta, revision, 'plan', deps)
  }

  await recordPlanDecision(meta, pending, decision === 'approve' ? 'accepted' : 'rejected', comment || undefined, deps)

  const answerText = decision === 'approve'
    ? (revisedPlan ? 'Approved the plan, with edits' : 'Approved the plan')
    : `Requested changes: ${comment}`
  deps.onAgentConversationUpdate?.({ phase: 'answered', agentSessionId: meta.sessionId, answerText })
  log.info('peer_plan_reviewed', { sessionId: meta.sessionId, decision, blocking: pending.blocking })

  return {
    ok: true,
    text: decision === 'approve'
      ? `Approved the plan in ${sessionLink(meta)}${revisedPlan ? ' (implementing your revised text)' : ''}. It is implementing now; its reply will arrive in this conversation.`
      : `Sent the plan in ${sessionLink(meta)} back for revision. The revised plan will arrive in this conversation.`,
  }
}

// ─── Tool definitions ───

function reviewAgentTool(name: string, description: string, inputShape: z.ZodRawShape): AgentTool {
  return {
    name,
    description,
    inputShape,
    requiresApproval: false,
    execute: async (args, context) => executeSessionReviewTool(name, args, {
      ctx: {
        agentProvider: context.provider,
        cwd: context.cwd,
        sessionId: context.sessionId(),
      },
      onAgentConversationUpdate: (update) => context.emit({ type: 'agent_conversation_update', update }),
    }),
  }
}

export const answerSessionAgentTool = reviewAgentTool('answer_session', ANSWER_SESSION_DESC, answerSessionShape)
export const reviewPlanAgentTool = reviewAgentTool('review_plan', REVIEW_PLAN_DESC, reviewPlanShape)
