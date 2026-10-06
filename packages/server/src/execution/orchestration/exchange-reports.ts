import { z } from 'zod'
import { permissionRequestFrom, promptTitle, questionRequestFrom, type ExchangeOutcome, type ExchangePlan, type ExchangeRequest, type SessionNotice, type SessionOutput } from '@solus/contracts/session-exchange'
import type { AgentConversationUpdate, NormalizedEvent, PromptDelivery, SessionMeta } from '@solus/contracts/types'
import type { SessionLoadMessage } from '@solus/contracts/session-history'
import { extractPlanTitle } from '../agents/plan-text'
import { describePendingInput } from '../sessions/pending-input'
import { addOutput, unansweredOutputs } from './session-outputs'
import type { Exchange } from './exchange'

export const CHILD_INTERRUPTED_BY_RESTART = 'The host restarted while this session was running. Its turn ended without a reply. Use read_session to see how far it got, and send_session to continue it.'

/** The client result retains output paths and metrics; the model report is bounded separately. */
export function settledUpdate(
  exchange: Exchange, outcome: ExchangeOutcome, reply: string,
  metrics: { durationMs?: number; toolCallCount?: number } | undefined, taskId: string | undefined,
): Extract<AgentConversationUpdate, { phase: 'settled' }> {
  const update: Extract<AgentConversationUpdate, { phase: 'settled' }> = {
    phase: 'settled', sessionId: exchange.targetSessionId,
    messageId: exchange.exchangeId, status: outcome, replyText: reply, settledAt: Date.now(),
  }
  if (exchange.outputs.length) update.outputs = exchange.outputs
  if (taskId) update.taskId = taskId
  if (metrics?.durationMs !== undefined) update.durationMs = metrics.durationMs
  if (metrics?.toolCallCount !== undefined) update.toolCallCount = metrics.toolCallCount
  return update
}

export function promptedUpdate(exchange: Exchange, meta: SessionMeta | null, message: { prompt: string; delivery: PromptDelivery }): AgentConversationUpdate {
  const dispatched: AgentConversationUpdate = {
    phase: 'dispatched',
    sessionId: exchange.targetSessionId,
    messageId: exchange.exchangeId,
    origin: 'prompted',
    prompt: message.prompt,
    delivery: message.delivery,
    provider: exchange.provider,
    title: meta ? sessionTitle(meta) : exchange.targetSessionId.slice(0, 8),
    cwd: meta?.cwd ?? '',
    dispatchedAt: exchange.dispatchedAt,
  }
  if (meta?.model) dispatched.model = meta.model
  if (meta?.reasoningEffort) dispatched.reasoningEffort = meta.reasoningEffort
  return dispatched
}

function sessionTitle(meta: SessionMeta): string {
  return meta.customTitle || meta.slug || (meta.firstMessage ? promptTitle(meta.firstMessage) : '') || meta.sessionId.slice(0, 8)
}

export function exchangeRequestFrom(event: NormalizedEvent): ExchangeRequest | null {
  if (event.type === 'question_request') return { kind: 'question', question: questionRequestFrom(event) }
  if (event.type === 'permission_request') return { kind: 'permission', permission: permissionRequestFrom(event) }
  if (event.type === 'plan') {
    const pending = describePendingInput([event])
    const blocking = pending?.kind === 'plan' && pending.blocking
    const plan: ExchangePlan = { title: extractPlanTitle(event.planContent), content: event.planContent, blocking }
    if (blocking) plan.questionId = event.questionId
    if (event.planToolUseId) plan.planToolUseId = event.planToolUseId
    return { kind: 'plan', plan }
  }
  return null
}

/** How a turn ended: its last top-level reply, or the error it stopped on. */
export interface TurnEnding {
  reply?: string
  error?: string
}

/** The last turn of a transcript: the messages after the last prompt. A reply
 *  from an earlier turn is not this turn's reply. */
export function turnEnding(messages: readonly SessionLoadMessage[]): TurnEnding {
  const lastPrompt = messages.findLastIndex((message) => message.role === 'user')
  const turn = messages.slice(lastPrompt + 1)
  const reply = turn.findLast((message) => message.role === 'assistant' && !message.parentToolUseId && message.content.trim())?.content
  const error = turn.findLast((message) => message.role === 'system' && /^error\b/i.test(message.content.trim()))?.content
  const ending: TurnEnding = {}
  if (reply) ending.reply = reply
  if (error) ending.error = error.trim()
  return ending
}

/** The outputs a settling turn adds: the branch its changed files are on, the
 *  questions it ended without an answer to, and its branch's pull request. */
export function finishOutputs(exchange: Exchange, branch: string | undefined, pullRequest: SessionOutput | null): void {
  // The files are the session's; the branch they are on is the run's.
  for (const output of exchange.outputs) {
    if (output.kind === 'changed_files' && branch) output.branch = branch
  }
  if (exchange.state === 'awaiting_input') for (const output of unansweredOutputs(exchange.request)) addOutput(exchange.outputs, output)
  if (pullRequest) addOutput(exchange.outputs, pullRequest)
}

/** The id a person's answer names: the question, permission or held plan. */
export function requestId(request: ExchangeRequest): string {
  if (request.kind === 'question') return request.question.questionId
  if (request.kind === 'permission') return request.permission.questionId
  return request.plan.questionId ?? request.plan.planToolUseId ?? request.plan.title
}

/** The short notice a sender reads about a request: never a plan's text. */
export function requestNotice(exchange: Exchange, request: ExchangeRequest): SessionNotice {
  const target = { messageId: exchange.exchangeId, sessionId: exchange.targetSessionId, provider: exchange.provider }
  if (request.kind === 'question') {
    return {
      ...target,
      kind: 'question',
      questionId: request.question.questionId,
      questions: request.question.questions.map((question) => ({ question: question.question, options: (question.options ?? []).map((option) => option.label) })),
    }
  }
  if (request.kind === 'permission') {
    const command = z.string().safeParse(request.permission.toolInput?.command)
    const summary = request.permission.toolDescription ?? (command.success ? command.data : undefined)
    const notice: SessionNotice = { ...target, kind: 'permission', questionId: request.permission.questionId, tool: request.permission.toolTitle }
    if (summary) notice.summary = summary
    return notice
  }
  const notice: SessionNotice = { ...target, kind: 'plan', title: request.plan.title }
  if (request.plan.planToolUseId) notice.planToolUseId = request.plan.planToolUseId
  if (request.plan.questionId) notice.questionId = request.plan.questionId
  return notice
}
