import { questionReply } from '@solus/contracts/question-history'
import { createLogger } from '../../logger'
import { captureServerEvent } from '../../analytics'
import { claimAsyncQuestion, pendingAsyncQuestions, saveAsyncAnswer, settleAsyncQuestion } from '../../data/sessions/async-questions'
import type { ResolvedInput } from '../orchestration/session-outputs'
import type { AgentBackend } from '../agents/agent-backend'
import type { NormalizedEvent, PermissionDecision } from '@solus/contracts/types'
import { type Actor } from '../../admission/actor'
import type { SessionRuntime } from '../session-runtime'

const log = createLogger('SessionRuntime', 'input-requests.ts')

/** What a person's answer to a permission or a plan was, for the senders waiting on it. */
function permissionAnswer(
  pendingEvent: NormalizedEvent | undefined,
  toolName: string | undefined,
  optionId: string,
  updatedPlan: string | undefined,
): ResolvedInput {
  const options = pendingEvent?.type === 'permission_request' || pendingEvent?.type === 'plan' ? pendingEvent.options : []
  const allowed = options.find((option) => option.id === optionId)?.kind === 'allow'
  return toolName === 'ExitPlanMode' || pendingEvent?.type === 'plan'
    ? { kind: 'plan', allowed, edited: !!updatedPlan }
    : { kind: 'permission', toolName, allowed }
}

/**
 * What a person chose on a permission or a plan, as every client reads it on the
 * resolution (plan 004 F4). Read from the option's kind, never its label alone;
 * an option the request did not offer names no decision.
 */
export function permissionDecisionFor(pendingEvent: NormalizedEvent | undefined, optionId: string): PermissionDecision | undefined {
  const options = pendingEvent?.type === 'permission_request' || pendingEvent?.type === 'plan' ? pendingEvent.options : []
  const option = options.find((candidate) => candidate.id === optionId)
  if (option?.kind === 'deny') return 'denied'
  if (option?.kind !== 'allow') return undefined
  return /session|always/i.test(`${option.id} ${option.label}`) ? 'approved_for_session' : 'approved'
}

export function eventHasQuestionId(event: NormalizedEvent, questionId: string): boolean {
  return 'questionId' in event && event.questionId === questionId
}

/**
 * Questions a Solus agent tool raised itself, such as an integration's MCP
 * elicitation (integrations/gateway.ts). The tool emits the `question_request`
 * through its context like a provider does; the answer comes back here, not to
 * the provider's permission responder, which never saw the question.
 */
const toolQuestionAnswerers = new Map<string, (answers: Record<string, string>) => void>()

/** Sends the answer to `questionId` to `answer`. Call the returned function when the tool stops waiting. */
export function answerToolQuestionWith(questionId: string, answer: (answers: Record<string, string>) => void): () => void {
  toolQuestionAnswerers.set(questionId, answer)
  return () => { if (toolQuestionAnswerers.get(questionId) === answer) toolQuestionAnswerers.delete(questionId) }
}

function answerToolQuestion(questionId: string, answers: Record<string, string>): boolean {
  const answer = toolQuestionAnswerers.get(questionId)
  if (!answer) return false
  toolQuestionAnswerers.delete(questionId)
  answer(answers)
  return true
}

/**
 * Permissions, questions, and plans a run waits on: who holds each request,
 * the answers to them, and the cards that close when a run ends.
 */
export class InputRequests {
  /** What was chosen for a permission whose resolution the provider has yet to report, by question id. */
  private permissionAnswers = new Map<string, PermissionDecision>()
  /** questionId → sessionId index so we can resolve which backend owns a question without iterating all backends. */
  questionIdToSession = new Map<string, string>()

  constructor(private readonly rt: SessionRuntime) {}

  pendingInputEventsForSession(sessionId: string): NormalizedEvent[] {
    return [...(this.rt.activeSessions.get(sessionId)?.pendingInputEvents ?? []), ...pendingAsyncQuestions(sessionId)]
  }

  /** Attention entries are keyed by the provider's thread id (seam (b)). */
  isPendingAttentionLive(agentSessionId: string): boolean {
    const sessionId = this.rt.agentSessionToSession.get(agentSessionId)
    if (!sessionId) return false
    const session = this.rt.activeSessions.get(sessionId)
    if (!session?.pendingInputEvents.some(
      (event) => event.type === 'permission_request' || event.type === 'question_request',
    )) return false
    return !!this.rt.watchers.watches.get(sessionId)?.size
  }

  /**
   * Names whose turn raised a request or reached a limit (plan 004 F2): the
   * running turn's actor. The pending copy is the same object, so a client that
   * joins later reads the name on the replay too. Live only; the host's own work
   * names no one.
   */
  stampTurnAuthor(sessionId: string, event: NormalizedEvent): void {
    if (event.type !== 'permission_request' && event.type !== 'question_request' && event.type !== 'rate_limit') return
    const author = this.rt.activeRunRequests.get(sessionId)?.actor?.user
    if (author) event.turnAuthor = author
  }

  /** Says what was chosen on the provider's report of the answer. Who chose it is an activity of its own. */
  nameDecision(event: Extract<NormalizedEvent, { type: 'permission_resolved' }>): void {
    const decision = this.permissionAnswers.get(event.questionId)
    this.permissionAnswers.delete(event.questionId)
    event.decision ??= decision
  }

  /** Answers a permission `askingSessionId` is waiting on. The answer goes to
   *  that session only: a question id that session is not waiting on — another
   *  session's, one already answered, or one from a turn that ended — is refused. */
  respondToPermission(askingSessionId: string, questionId: string, optionId: string, updatedPlan: string | undefined, actor: Actor): boolean {
    const pending = this.pendingQuestion(askingSessionId, questionId)
    if (!pending) return false
    const { sessionId, backend: b, event: pendingEvent } = pending
    const pendingInfo = b.permissions.getPendingInfo(questionId)
    if (!b.permissions.respondToPermission(questionId, optionId, updatedPlan)) return false
    // Codex reports the resolution later (`serverRequest/resolved`); it carries
    // what was chosen. Claude reports none, so the host says it now. Who decided
    // is recorded once, as activity every client reads (plan 004 F4, plans/012 §5).
    const decision = permissionDecisionFor(pendingEvent, optionId)
    if (b.id === 'codex') { if (decision) this.permissionAnswers.set(questionId, decision) }
    else this.rt.publish(sessionId, { type: 'permission_resolved', questionId, decision })
    if (decision && actor.user) {
      const tool = pendingInfo?.toolName ?? (pendingEvent.type === 'permission_request' ? pendingEvent.toolName : 'a permission request')
      void this.rt.recordActivity({ kind: 'session', id: sessionId }, actor, { kind: 'permission_decided', questionId, tool, decision })
    }
    this.rt.sessionEmitter.resolvePermission(sessionId, questionId, optionId)
    // Before a rejection cancels the run and its exchanges settle.
    const resolved = permissionAnswer(pendingEvent, pendingInfo?.toolName, optionId, updatedPlan)
    this.rt.reportToActiveRun(sessionId, (run) => this.rt.orchestration?.inputResolved(run, resolved))
    this.clearPendingInputEvent(questionId)
    this.questionIdToSession.delete(questionId)
    const analytics = { decision: optionId, tool_name: pendingInfo?.toolName }
    captureServerEvent('permission_responded', analytics)
    if (pendingInfo?.toolName === 'ExitPlanMode') {
      captureServerEvent('plan_responded', { approved: optionId === 'allow' })
    }
    if (pendingInfo?.toolName === 'ExitPlanMode' && optionId === 'deny') {
      // The permission responder only knows the provider's thread id.
      const agentSessionId = pendingInfo.sessionId
      if (agentSessionId) b.cancelSession(agentSessionId)
      // A rejected plan is not a stop, so the status names no stopper.
      this.rt.statuses.setStatus(sessionId, 'interrupted')
    }
    return true
  }

  /** Answers a question `askingSessionId` is waiting on; refused like a permission. */
  async respondToQuestion(askingSessionId: string, questionId: string, answers: Record<string, string>, actor: Actor): Promise<boolean> {
    const sessionId = askingSessionId
    const asyncQuestion = claimAsyncQuestion(sessionId, questionId)
    if (asyncQuestion) {
      const answer = { questionId, questions: asyncQuestion.questions, answers }
      const reply = questionReply(answer)
      if (!reply) {
        settleAsyncQuestion(questionId, 'dismissed')
        this.rt.publish(sessionId, { type: 'permission_resolved', questionId })
        const agentSessionId = asyncQuestion.agentSessionId
        this.rt.statuses.syncAttention(agentSessionId, sessionId, this.rt.activeSessions.get(sessionId)?.status ?? 'completed')
        return true
      }
      try {
        saveAsyncAnswer(questionId, answers)
        await this.rt.dispatch.promptSession(sessionId, reply, 'steer', { actor, via: 'question-answer' })
      } catch (error) {
        settleAsyncQuestion(questionId, 'pending')
        throw error
      }
      settleAsyncQuestion(questionId, 'answered')
      this.rt.statuses.syncAttention(asyncQuestion.agentSessionId, sessionId, this.rt.activeSessions.get(sessionId)?.status ?? 'completed')
      this.rt.publish(sessionId, {
        type: 'question_answered',
        answer,
        timestamp: Date.now(),
      })
      if (actor.user) void this.rt.recordActivity({ kind: 'session', id: sessionId }, actor, { kind: 'question_answered', questionId })
      return true
    }
    const pending = this.pendingQuestion(askingSessionId, questionId)
    if (!pending || pending.event.type !== 'question_request') return false
    const { sessionId: pendingSessionId, backend: b, event: question } = pending
    if (!answerToolQuestion(questionId, answers) && !b.permissions.respondToQuestion(questionId, answers)) return false
    this.rt.reportToActiveRun(pendingSessionId, (run) => this.rt.orchestration?.inputResolved(run, { kind: 'question', questions: question.questions, answers }))
    this.rt.sessionEmitter.resolveQuestion(pendingSessionId, questionId)
    if (!question.kind || question.kind === 'standard') {
      this.rt.publish(pendingSessionId, {
        type: 'question_answered',
        answer: { questionId, questions: question.questions, answers },
        timestamp: Date.now(),
      })
      if (actor.user) void this.rt.recordActivity({ kind: 'session', id: pendingSessionId }, actor, { kind: 'question_answered', questionId })
    }
    this.clearPendingInputEvent(questionId)
    this.questionIdToSession.delete(questionId)
    return true
  }

  /** The request `askingSessionId` is waiting on under `questionId`, with the
   *  backend that answers it. Null unless that live session holds it now. */
  private pendingQuestion(
    askingSessionId: string,
    questionId: string,
  ): { sessionId: string; backend: AgentBackend; event: NormalizedEvent } | null {
    const sessionId = askingSessionId
    const owner = this.questionIdToSession.get(questionId)
    if (owner !== sessionId) {
      log.warn('answer_refused', { askingSessionId, questionId, ownerSessionId: owner ?? null, reason: owner ? 'other_session' : 'not_pending' })
      return null
    }
    const session = this.rt.activeSessions.get(sessionId)
    const event = session?.pendingInputEvents.find((pendingEvent) => eventHasQuestionId(pendingEvent, questionId))
    const backend = session ? this.rt.backends.get(session.backendId) : undefined
    if (!event || !backend) {
      log.warn('answer_refused', { askingSessionId, questionId, ownerSessionId: owner, reason: 'not_pending' })
      return null
    }
    return { sessionId, backend, event }
  }

  /**
   * Closes every blocking request a run holds without an answer, when the run
   * exits, stops, or dies. The provider is told no, and every client learns
   * that the card can no longer be answered. Async questions are kept in SQLite,
   * not here, so they stay open after the provider exits.
   */
  expirePendingInput(backend: AgentBackend, agentSessionId: string): void {
    backend.permissions.clearPendingForSession(agentSessionId)
    const sessionId = this.rt.agentSessionToSession.get(agentSessionId)
    const session = sessionId ? this.rt.activeSessions.get(sessionId) : undefined
    if (!sessionId || !session) return
    const expired = session.pendingInputEvents.filter((event) => event.type === 'permission_request' || event.type === 'question_request')
    if (!expired.length) return
    session.pendingInputEvents = session.pendingInputEvents.filter((event) => event.type !== 'permission_request' && event.type !== 'question_request')
    session.hasPendingInput = session.pendingInputEvents.length > 0
    for (const event of expired) {
      this.questionIdToSession.delete(event.questionId)
      this.rt.publish(sessionId, { type: 'permission_resolved', questionId: event.questionId, expired: 'run_ended' })
    }
    log.info('pending_input_expired', { sessionId, agentSessionId, count: expired.length })
  }

  private clearPendingInputEvent(questionId: string): void {
    const match = (event: NormalizedEvent) => eventHasQuestionId(event, questionId)

    for (const session of this.rt.activeSessions.values()) {
      if (!session.pendingInputEvents.length) continue
      const before = session.pendingInputEvents.length
      session.pendingInputEvents = session.pendingInputEvents.filter((e) => !match(e))
      session.hasPendingInput = session.pendingInputEvents.length > 0

      if (session.pendingInputEvents.length !== before) {
        this.rt.statuses.setStatus(session.sessionId, this.rt.statuses.pendingInputStatus(session))
        this.rt.publish(session.sessionId, {
          type: 'pending_input_sync',
          pendingInputEvents: [...session.pendingInputEvents],
        })
      }
    }
  }
}
