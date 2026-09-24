import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  ORCHESTRATION_LIMITS,
  clip,
  permissionRequestFrom,
  promptTitle,
  questionRequestFrom,
  type ExchangeOutcome,
  type ExchangePlan,
  type ExchangeRequest,
  type OrchestrationItem,
  type SessionNotice,
  type SessionOutput,
} from '@solus/contracts/session-exchange'
import type {
  AgentConversationUpdate,
  AgentId,
  GitCheckout,
  NormalizedEvent,
  PromptDelivery,
  ReasoningEffort,
  SentSessionMessage,
  SessionMeta,
} from '@solus/contracts/types'
import type { SessionLoadMessage } from '@solus/contracts/session-history'
import { extractPlanTitle } from '../agents/plan-text'
import { createLogger } from '../logger'
import { describePendingInput, type PendingInputDescription } from '../sessions/pending-input'
import { applyExchangeEvent, isOpenExchange, type Exchange, type ExchangeEvent } from './exchange'
import { recordPlanDecision } from './plan-decisions'
import { addOutput, answerText, outputFromEvent, outputsFromAnswer, unansweredOutputs, type ResolvedInput } from './session-outputs'
import { ParentDelivery } from './parent-delivery'

const log = createLogger('orchestration', 'session-orchestrator.ts')

type PendingPlan = Extract<PendingInputDescription, { kind: 'plan' }>

/**
 * The session orchestration layer: one session starting another, sending it
 * messages, hearing its results, and a person answering what it asks along the
 * way. It owns every exchange from accept to settle and is the only thing that
 * emits `agent_conversation_update`.
 *
 * The control plane runs turns and knows nothing about exchanges beyond the
 * opaque ids a run carries. It reports what happens to those runs through the
 * hooks at the bottom of this class; the orchestrator calls back into it only
 * through `SessionRuntime`.
 *
 * All state is in memory. No provider turn outlives the host, so a restart ends
 * every open exchange; the one thing boot can still do is tell the parent of a
 * delegated child that its child's turn is gone.
 */

const IMPLEMENT_PREFIX = 'Implement this plan:\n\n'
// The same copy a person's Revise sends in the session's own tab, so a decision
// taken in either place reads identically in the target's transcript.
const REVISION_PREFIX = 'Please revise the plan with these comments:\n\n'
export const CHILD_INTERRUPTED_BY_RESTART = 'The host restarted while this session was running. Its turn ended without a reply. Use read_session to see how far it got, and send_session to continue it.'
const NO_REPLY = '(no final assistant reply available)'

/** A run of the control plane and the exchanges it answers. */
export interface RunExchanges {
  runId: string
  /** Solus id of the session the run belongs to. */
  sessionId: string
  /** The run's provider thread, once the provider named one. */
  agentSessionId?: string | null
  exchangeIds: readonly string[]
}

export interface SettledRun extends RunExchanges {
  outcome: ExchangeOutcome
  resultText?: string
  durationMs?: number
  toolCallCount?: number
  provider: AgentId
  projectScope?: string
  gitContext?: GitCheckout | null
}

export interface CreateSessionOrder {
  prompt: string
  provider: AgentId
  modelId: string
  reasoningEffort: ReasoningEffort
  contextWindow: number | null
  cwd: string
  worktreeBaseBranch?: string | null
  taskId?: string | null
  parentTaskId?: string | null
  exchangeIds?: string[]
  delegation?: { parentAgentSessionId: string; messageId: string; intent: 'delegate' | 'fire_and_forget'; createdAt: number }
}

export interface PromptOrder {
  exchangeIds?: string[]
  permissionMode?: 'ask' | 'auto' | 'plan'
  via?: 'session-report'
  agentSessionId?: string
  agentMessageId?: string
}

/** What the orchestrator needs from the control plane that runs the turns. */
export interface SessionRuntime {
  /** Solus's id for a session named by either id, while this process knows it. */
  sessionIdFor(id: string): string | undefined
  /** The provider thread a live session runs on. */
  agentSessionIdFor(sessionId: string): string | undefined
  sessionMeta(agentSessionId: string): SessionMeta | null
  createSession(order: CreateSessionOrder): Promise<{ agentSessionId: string; taskId?: string }>
  promptSession(agentSessionId: string, prompt: string, delivery: PromptDelivery, order: PromptOrder): Promise<{ disposition: 'started' | 'steered' | 'queued'; queueId?: string }>
  stopSession(id: string): boolean
  /** Answers a permission the asking session is waiting on; false when it is not. */
  respondToPermission(askingSessionId: string, questionId: string, optionId: string, updatedPlan?: string): boolean
  pendingInputEvents(agentSessionId: string): NormalizedEvent[]
  replaceQueuedPrompt(sessionId: string, queueId: string, text: string): boolean
  hasQueuedPrompt(sessionId: string, queueId: string): boolean
  cancelQueuedPrompt(agentSessionId: string, queueId: string): boolean
  /** How the session's last turn ended, read from its transcript. */
  turnEnding(provider: AgentId, agentSessionId: string, projectScope: string | undefined): Promise<TurnEnding>
  /** The task a session works on, by its Solus id. */
  taskIdFor(sessionId: string): Promise<string | undefined>
  emit(sessionId: string, event: NormalizedEvent): void
  invalidatePlanCaches(agentSessionId: string): void
  /** Holds a host update until the work settles. */
  trackWork<T>(work: Promise<T>): Promise<T>
}

export interface OrchestratorDeps {
  /** The pull request opened from a checkout's branch, if any. */
  findPullRequest(checkout: GitCheckout, projectScope: string): Promise<{ number: number; url: string } | null>
}

export interface SpawnedSession {
  exchangeId: string
  agentSessionId: string
  taskId?: string
  /** With a wait: the report or notice that arrived in time, or null when none did. */
  waited?: OrchestrationItem | null
}

/** The longest a tool call may wait on a session, in milliseconds. */
export const MAX_WAIT_MS = 600_000

/** The system instruction for a turn that answers another session's message:
 *  its last message is the reply that session reads. */
export const ANSWERING_ANOTHER_SESSION = 'Another Solus session sent you this work, and your last message is the reply it reads. '
  + 'End your turn with a short summary: what you did, what you produced (files and branch, plans, works, sessions you started), and what is still open.'

/** The last plan a session's turn wrote. */
interface OpenPlan {
  planToolUseId?: string
  planContent: string
}

export class SessionOrchestrator {
  private readonly exchanges = new Map<string, Exchange>()
  /** Sender Solus id → target Solus ids it has sent a message to. Authorizes a
   *  person's answer from the sender's conversation. */
  private readonly contacts = new Map<string, Set<string>>()
  private readonly delivery: ParentDelivery
  /** Notices a parent was sent and that may still wait in its queue, by key. */
  private readonly openNotices = new Set<string>()
  /** Exchanges whose sender stopped the target itself: its own action needs no report. */
  private readonly stoppedBySender = new Set<string>()
  /** Target Solus id → the last plan its turn wrote, until its next turn starts.
   *  A plan whose turn already ended (Codex) holds nothing open to answer, so a
   *  person's decision on it comes from here. */
  private readonly openPlans = new Map<string, OpenPlan>()

  constructor(
    private readonly runtime: SessionRuntime,
    private readonly deps: OrchestratorDeps,
  ) {
    this.delivery = new ParentDelivery(runtime)
  }

  // ─── Commands ───

  /** Starts a new session running `order.prompt`. With a sender, the message is
   *  an exchange and the child is recorded as the sender's delegate; with
   *  `report`, the sender hears its notices and its result. */
  async spawn(
    senderAgentSessionId: string | undefined,
    order: Omit<CreateSessionOrder, 'exchangeIds' | 'delegation'>,
    report: boolean,
    waitMs = 0,
  ): Promise<SpawnedSession> {
    // The stored delegation keeps the intent names it has always had.
    const intent = report ? 'delegate' : 'fire_and_forget'
    const exchangeId = randomUUID()
    const dispatchedAt = Date.now()
    const senderSessionId = senderAgentSessionId ? this.runtime.sessionIdFor(senderAgentSessionId) : undefined
    const exchange = senderAgentSessionId && senderSessionId
      ? this.open({
          exchangeId,
          kind: 'create',
          senderSessionId,
          senderAgentSessionId,
          targetSessionId: '',
          targetAgentSessionId: `pending:${exchangeId}`,
          provider: order.provider,
          notify: report,
          dispatchedAt,
        })
      : null
    const waited = exchange && waitMs > 0 ? this.waitOn(exchange, waitMs) : undefined
    if (exchange) {
      this.publish(exchange, {
        phase: 'dispatched',
        agentSessionId: exchange.targetAgentSessionId,
        messageId: exchangeId,
        origin: 'created',
        prompt: order.prompt,
        provider: order.provider,
        title: promptTitle(order.prompt),
        cwd: order.cwd,
        model: order.modelId,
        reasoningEffort: order.reasoningEffort,
        fireAndForget: !report,
        dispatchedAt,
      })
    }
    try {
      const started = await this.runtime.createSession({
        ...order,
        exchangeIds: exchange ? [exchangeId] : undefined,
        delegation: senderAgentSessionId
          ? { parentAgentSessionId: senderAgentSessionId, messageId: exchangeId, intent, createdAt: dispatchedAt }
          : undefined,
      })
      if (exchange) this.bindStarted(exchange, started.agentSessionId, this.runtime.sessionMeta(started.agentSessionId)?.cwd)
      if (senderSessionId) this.recordStartedSession(senderSessionId, order.prompt, started)
      const created: SpawnedSession = { exchangeId, agentSessionId: started.agentSessionId }
      if (started.taskId) created.taskId = started.taskId
      if (waited) created.waited = await waited
      return created
    } catch (error) {
      if (exchange) this.settleUnaccepted(exchange)
      throw error
    }
  }

  /** Sends one message to an existing session. The sender's card shows it before
   *  the target can answer, and the result comes back under the same id. */
  async send(
    senderAgentSessionId: string,
    targetAgentSessionId: string,
    message: { prompt: string; delivery: PromptDelivery; notify: boolean; permissionMode?: 'ask' | 'auto' | 'plan'; waitMs?: number },
  ): Promise<{ exchangeId: string; disposition: 'started' | 'steered' | 'queued'; waited?: OrchestrationItem | null }> {
    const senderSessionId = this.runtime.sessionIdFor(senderAgentSessionId)
    if (!senderSessionId) throw new Error('The calling session is not live.')
    const targetSessionId = this.runtime.sessionIdFor(targetAgentSessionId)
    if (targetAgentSessionId === senderAgentSessionId || targetSessionId === senderSessionId) {
      throw new Error('Cannot message your own session.')
    }
    const meta = this.runtime.sessionMeta(targetAgentSessionId)
    // Refused before the card shows it: there is nothing to send it to.
    if (!meta && !targetSessionId) throw new Error(`Session ${targetAgentSessionId} not found.`)
    const exchangeId = randomUUID()
    const dispatchedAt = Date.now()
    const exchange = this.open({
      exchangeId,
      kind: 'prompt',
      senderSessionId,
      senderAgentSessionId,
      targetSessionId: targetSessionId ?? '',
      targetAgentSessionId,
      provider: meta?.provider ?? 'claude-code',
      notify: message.notify,
      dispatchedAt,
    })
    const waited = message.waitMs && message.waitMs > 0 ? this.waitOn(exchange, message.waitMs) : undefined
    this.publish(exchange, promptedUpdate(exchange, meta, message))
    const order: PromptOrder = { exchangeIds: [exchangeId] }
    if (message.permissionMode) order.permissionMode = message.permissionMode
    try {
      const result = await this.runtime.promptSession(targetAgentSessionId, message.prompt, message.delivery, order)
      return waited
        ? { exchangeId, disposition: result.disposition, waited: await waited }
        : { exchangeId, disposition: result.disposition }
    } catch (error) {
      this.settleUnaccepted(exchange)
      throw error
    }
  }

  /** Stops the target for the sender. The sender's own messages to it settle
   *  without a report — it asked for the stop — and its card closes. */
  stop(senderAgentSessionId: string | undefined, targetAgentSessionId: string): boolean {
    const senderSessionId = senderAgentSessionId ? this.runtime.sessionIdFor(senderAgentSessionId) : undefined
    const targetSessionId = this.runtime.sessionIdFor(targetAgentSessionId)
    const marked: string[] = []
    if (senderSessionId && targetSessionId) {
      for (const exchange of this.exchanges.values()) {
        if (exchange.senderSessionId === senderSessionId && exchange.targetSessionId === targetSessionId) marked.push(exchange.exchangeId)
      }
    }
    for (const exchangeId of marked) this.stoppedBySender.add(exchangeId)
    const stopped = this.runtime.stopSession(targetAgentSessionId)
    // Nothing stopped: a later result is not the sender's own doing.
    if (!stopped) for (const exchangeId of marked) this.stoppedBySender.delete(exchangeId)
    return stopped
  }

  /** A person's decision on a plan a target session wrote, from the conversation
   *  that sent it work. A plan still holding the target's turn open is answered
   *  in place; one whose turn ended is carried on by a new message. */
  async decidePlan(
    senderSessionId: string,
    targetAgentSessionId: string,
    decision: 'approve' | 'request_changes',
    comment?: string,
  ): Promise<boolean> {
    const senderAgentSessionId = this.agentSessionIdOf(senderSessionId)
    const targetSessionId = this.runtime.sessionIdFor(targetAgentSessionId)
    if (!senderAgentSessionId || !targetSessionId || !this.contacts.get(senderSessionId)?.has(targetSessionId)) return false
    const pending = this.pendingPlan(targetSessionId, targetAgentSessionId)
    if (!pending) return false
    const note = comment?.trim() ?? ''
    if (decision === 'request_changes' && !note) return false
    const decided = decision === 'approve'
      ? await this.approvePlan(pending, senderAgentSessionId, targetSessionId, targetAgentSessionId)
      : await this.requestPlanChanges(pending, note, senderAgentSessionId, targetSessionId, targetAgentSessionId)
    if (!decided) return false
    this.openPlans.delete(targetSessionId)
    const meta = this.runtime.sessionMeta(targetAgentSessionId)
    if (meta && await recordPlanDecision(meta, pending, decision === 'approve' ? 'accepted' : 'rejected', note || undefined)) {
      this.runtime.invalidatePlanCaches(meta.sessionId)
    }
    return true
  }

  /** The plan the target is waiting on, held open or already reported. */
  private pendingPlan(targetSessionId: string, targetAgentSessionId: string): PendingPlan | null {
    const held = describePendingInput(this.runtime.pendingInputEvents(targetAgentSessionId))
    if (held?.kind === 'plan') return held
    const ended = this.openPlans.get(targetSessionId)
    if (!ended) return null
    const plan: PendingPlan = { kind: 'plan', questionId: '', planContent: ended.planContent, blocking: false }
    if (ended.planToolUseId) plan.planToolUseId = ended.planToolUseId
    return plan
  }

  private async approvePlan(pending: PendingPlan, senderAgentSessionId: string, targetSessionId: string, targetAgentSessionId: string): Promise<boolean> {
    if (pending.blocking) {
      return !!pending.allowOptionId && this.runtime.respondToPermission(targetSessionId, pending.questionId, pending.allowOptionId)
    }
    await this.send(senderAgentSessionId, targetAgentSessionId, {
      prompt: `${IMPLEMENT_PREFIX}${pending.planContent}`,
      delivery: 'queue',
      notify: true,
      permissionMode: 'auto',
    })
    return true
  }

  private async requestPlanChanges(
    pending: PendingPlan,
    note: string,
    senderAgentSessionId: string,
    targetSessionId: string,
    targetAgentSessionId: string,
  ): Promise<boolean> {
    const waiting = [...this.exchanges.values()].filter((exchange) =>
      exchange.targetSessionId === targetSessionId && exchange.state === 'awaiting_input' && exchange.request?.kind === 'plan')
    if (pending.blocking && waiting.length) return this.reviseInPlace(pending, note, waiting, targetSessionId, targetAgentSessionId)
    if (pending.blocking && pending.denyOptionId) this.runtime.respondToPermission(targetSessionId, pending.questionId, pending.denyOptionId)
    await this.send(senderAgentSessionId, targetAgentSessionId, {
      prompt: `${REVISION_PREFIX}${note}`,
      delivery: 'queue',
      notify: true,
      permissionMode: 'plan',
    })
    return true
  }

  /** The deny ends the run holding the plan. The revision continues the same
   *  exchanges on the run that follows, so the sender hears the revised plan as
   *  the answer to what it asked — not an interruption and a new message. */
  private async reviseInPlace(pending: PendingPlan, note: string, waiting: Exchange[], targetSessionId: string, targetAgentSessionId: string): Promise<boolean> {
    if (!pending.denyOptionId) return false
    const answer = `Asked for changes to the plan: ${note}`
    for (const exchange of waiting) {
      this.apply(exchange, { type: 'revision_requested' })
      if (this.apply(exchange, { type: 'input_resolved', outputs: [] })) {
        this.publish(exchange, { phase: 'answered', agentSessionId: exchange.targetAgentSessionId, messageId: exchange.exchangeId, answerText: answer })
      }
    }
    if (!this.runtime.respondToPermission(targetSessionId, pending.questionId, pending.denyOptionId)) {
      for (const exchange of waiting) exchange.revising = false
      return false
    }
    try {
      await this.runtime.promptSession(targetAgentSessionId, `${REVISION_PREFIX}${note}`, 'queue', {
        exchangeIds: waiting.map((exchange) => exchange.exchangeId),
        permissionMode: 'plan',
      })
    } catch (error) {
      for (const exchange of waiting) {
        exchange.revising = false
        this.settle(exchange, 'failed', '')
      }
      throw error
    }
    return true
  }

  /** Whether the conversation `callerSessionId` may answer what `askingSessionId`
   *  is waiting on: its own session's request, or one a session it sent work to
   *  is waiting on. The control plane then checks the request is that session's. */
  mayAnswer(callerSessionId: string, askingSessionId: string): boolean {
    const caller = this.runtime.sessionIdFor(callerSessionId) ?? callerSessionId
    const asking = this.runtime.sessionIdFor(askingSessionId) ?? askingSessionId
    if (caller === asking) return true
    for (const exchange of this.exchanges.values()) {
      if (exchange.senderSessionId === caller && exchange.targetSessionId === asking && exchange.state === 'awaiting_input') return true
    }
    return false
  }

  /** The messages a session sent that this process still carries, for a card
   *  rebuilt from the transcript. What is missing has finished or was lost. */
  exchangesSentBy(senderId: string): SentSessionMessage[] {
    const senderSessionId = this.runtime.sessionIdFor(senderId) ?? senderId
    const sent: SentSessionMessage[] = []
    for (const exchange of this.exchanges.values()) {
      if (exchange.senderSessionId !== senderSessionId) continue
      const state = exchange.state === 'awaiting_input' || exchange.state === 'rate_limited'
        ? exchange.state
        : exchange.state === 'running' ? 'running' : 'queued'
      const message: SentSessionMessage = { messageId: exchange.exchangeId, targetAgentSessionId: exchange.targetAgentSessionId, state }
      if (exchange.request && exchange.state === 'awaiting_input') message.request = exchange.request
      if (exchange.state === 'rate_limited' && exchange.rateLimitResetsAt) message.resetsAt = exchange.rateLimitResetsAt
      sent.push(message)
    }
    const senderAgentSessionId = this.agentSessionIdOf(senderSessionId)
    for (const waiting of senderAgentSessionId ? this.delivery.waitingReports(senderAgentSessionId) : []) {
      sent.push({ messageId: waiting.exchangeId, targetAgentSessionId: waiting.targetAgentSessionId, state: 'reply_queued' })
    }
    return sent
  }

  /** Children whose turn the previous process never settled. A parent that
   *  delegated to one gets a report instead of waiting for a reply nothing will
   *  send; boot marks each record interrupted, so a child is reported once. */
  reportChildrenInterruptedByRestart(childThreadIds: readonly string[]): void {
    for (const childThreadId of childThreadIds) {
      const meta = this.runtime.sessionMeta(childThreadId)
      const delegation = meta?.delegation
      if (!meta || delegation?.intent !== 'delegate') continue
      log.info('session_child_interrupted_by_restart', { agentSessionId: childThreadId, parentAgentSessionId: delegation.parentSessionId })
      this.delivery.deliver(delegation.parentSessionId, {
        exchangeId: delegation.messageId,
        targetAgentSessionId: childThreadId,
        item: { type: 'report', report: {
          messageId: delegation.messageId,
          agentSessionId: childThreadId,
          provider: meta.provider,
          status: 'interrupted',
          outputs: [],
          reply: CHILD_INTERRUPTED_BY_RESTART,
        } },
      })
    }
  }

  // ─── Hooks from the control plane ───

  /** The run waits behind the target's current turn. */
  runQueued(run: RunExchanges): void {
    for (const exchange of this.exchangesOf(run)) {
      if (this.apply(exchange, { type: 'queued', runId: run.runId })) {
        this.publish(exchange, { phase: 'accepted', agentSessionId: exchange.targetAgentSessionId, messageId: exchange.exchangeId, state: 'queued' })
      }
    }
  }

  /** The run started, its message joined the live turn as a steer, or a run
   *  parked on a rate limit resumed. */
  runStarted(run: RunExchanges): void {
    for (const exchange of this.exchangesOf(run)) {
      const wasLimited = exchange.state === 'rate_limited'
      if (this.apply(exchange, { type: 'started', runId: run.runId })) {
        this.publish(exchange, { phase: 'accepted', agentSessionId: exchange.targetAgentSessionId, messageId: exchange.exchangeId, state: 'running' })
        if (wasLimited) {
          exchange.rateLimitResetsAt = undefined
          this.withdrawNotice(exchange, 'limit')
        }
      }
    }
  }

  /** The target's provider refused the turn on a limit. The control plane parks
   *  the run and resumes it at the reset; until then the sender's card says so,
   *  and a sender that asked to hear back is told once, so it can wait, stop the
   *  child, or move the work to another provider. */
  runRateLimited(run: RunExchanges, limit: { resetsAt?: number; limitType?: string }): void {
    for (const exchange of this.exchangesOf(run)) {
      if (!this.apply(exchange, { type: 'rate_limited' })) continue
      exchange.rateLimitResetsAt = limit.resetsAt
      const update: AgentConversationUpdate = { phase: 'rate_limited', agentSessionId: exchange.targetAgentSessionId, messageId: exchange.exchangeId }
      if (limit.resetsAt) update.resetsAt = limit.resetsAt
      if (limit.limitType) update.limitType = limit.limitType
      this.publish(exchange, update)
      const notice: SessionNotice = { messageId: exchange.exchangeId, agentSessionId: exchange.targetAgentSessionId, provider: exchange.provider, kind: 'rate_limited' }
      if (limit.resetsAt) notice.resetsAt = limit.resetsAt
      if (limit.limitType) notice.limitType = limit.limitType
      this.notify(exchange, notice, 'limit')
    }
  }

  /** A created session reported its real thread: its cards rebind to it. */
  sessionStarted(run: RunExchanges, agentSessionId: string, cwd: string | undefined): void {
    for (const exchange of this.exchangesOf(run)) this.bindStarted(exchange, agentSessionId, cwd)
  }

  /** The target's turn stopped for a person. Every sender waiting on that turn
   *  shows the request with its own question, plan or permission card, and a
   *  sender that asked to hear back is told at once with a short notice. A
   *  person answers; the sender's model does not. */
  inputRequested(run: RunExchanges, event: NormalizedEvent): void {
    const request = exchangeRequestFrom(event)
    if (!request) return
    for (const exchange of this.exchangesOf(run)) {
      if (this.apply(exchange, { type: 'input_requested', request })) {
        this.publish(exchange, { phase: 'awaiting_input', agentSessionId: exchange.targetAgentSessionId, messageId: exchange.exchangeId, request })
        this.notify(exchange, requestNotice(exchange, request), `ask:${requestId(request)}`)
      }
    }
  }

  /** A person answered what the turn waited on, from whichever surface. */
  inputResolved(run: RunExchanges, resolved: ResolvedInput): void {
    const answer = answerText(resolved)
    const outputs = outputsFromAnswer(resolved)
    for (const exchange of this.exchangesOf(run)) {
      const request = exchange.request
      if (this.apply(exchange, { type: 'input_resolved', outputs })) {
        this.publish(exchange, { phase: 'answered', agentSessionId: exchange.targetAgentSessionId, messageId: exchange.exchangeId, answerText: answer })
        if (request) this.withdrawNotice(exchange, `ask:${requestId(request)}`)
      }
    }
  }

  /** Plans, works and changed files the target produced while its turn answered these exchanges. */
  runEvent(run: RunExchanges, event: NormalizedEvent): void {
    if (event.type === 'plan') {
      const plan: OpenPlan = { planContent: event.planContent }
      if (event.planToolUseId) plan.planToolUseId = event.planToolUseId
      this.openPlans.set(run.sessionId, plan)
    }
    const output = outputFromEvent(event, run.agentSessionId)
    if (!output) return
    for (const exchange of this.exchangesOf(run)) addOutput(exchange.outputs, output)
  }

  /** The single settlement point: the run's turn ended. */
  runSettled(run: SettledRun): void {
    const exchanges = this.exchangesOf(run).filter((exchange) =>
      isOpenExchange(exchange) && !exchange.revising && (!exchange.runId || exchange.runId === run.runId))
    if (!exchanges.length) return
    void this.runtime.trackWork(this.settleRun(run, exchanges)).catch((error) => {
      log.warn('exchange_settle_failed', { sessionId: run.sessionId, error: String(error) })
    })
  }

  /** The run never reached a turn: its queue entry was cancelled or drained, or it failed to launch. */
  runCancelled(run: RunExchanges, outcome: 'interrupted' | 'failed' = 'interrupted'): void {
    for (const exchange of this.exchangesOf(run)) {
      if (!isOpenExchange(exchange) || exchange.revising) continue
      this.settle(exchange, outcome, '')
    }
  }

  /** Any turn of a session started: whatever plan it wrote before was acted on. */
  sessionTurnStarted(sessionId: string): void {
    this.openPlans.delete(sessionId)
  }

  /** A target was stopped, from any surface: every card talking to it closes. */
  targetStopped(targetSessionId: string): void {
    const senders = new Set<string>()
    for (const exchange of this.exchanges.values()) {
      if (exchange.targetSessionId !== targetSessionId || !isOpenExchange(exchange)) continue
      if (senders.has(exchange.senderSessionId)) continue
      senders.add(exchange.senderSessionId)
      this.publish(exchange, { phase: 'stopped', agentSessionId: exchange.targetAgentSessionId })
    }
  }

  /** A sender still waiting on a reply its model will be woken for stays running. */
  isAwaitingReplies(senderSessionId: string): boolean {
    for (const exchange of this.exchanges.values()) {
      if (exchange.senderSessionId === senderSessionId && exchange.notify && isOpenExchange(exchange)) return true
    }
    return false
  }

  /** A stopped sender stops waiting: its open messages settle, and nothing is
   *  delivered to it for them. */
  cancelSentBy(senderSessionId: string): boolean {
    let cancelled = false
    for (const exchange of this.exchanges.values()) {
      if (exchange.senderSessionId !== senderSessionId || !isOpenExchange(exchange)) continue
      exchange.notify = false
      exchange.revising = false
      this.settle(exchange, 'interrupted', '')
      cancelled = true
    }
    return cancelled
  }

  // ─── Internals ───

  private open(fields: Omit<Exchange, 'state' | 'outputs' | 'notices' | 'revising'>): Exchange {
    const exchange: Exchange = { ...fields, state: 'dispatched', outputs: [], notices: [], revising: false }
    this.exchanges.set(exchange.exchangeId, exchange)
    if (exchange.targetSessionId) this.remember(exchange.senderSessionId, exchange.targetSessionId)
    return exchange
  }

  /** Binds a created session's card to its real thread, once, from whichever
   *  point learns it first: the control plane at init, the create call's
   *  answer, or the run's settlement. */
  private bindStarted(exchange: Exchange, agentSessionId: string, cwd: string | undefined): void {
    if (!exchange.targetAgentSessionId.startsWith('pending:')) return
    exchange.targetAgentSessionId = agentSessionId
    const attached: AgentConversationUpdate = { phase: 'attached', messageId: exchange.exchangeId, agentSessionId }
    if (cwd) attached.cwd = cwd
    this.publish(exchange, attached)
  }

  /** A session a child started is something the child's open turns produced. */
  private recordStartedSession(childSessionId: string, prompt: string, started: { agentSessionId: string; taskId?: string }): void {
    const output: SessionOutput = { kind: 'session', sessionId: started.agentSessionId, title: prompt }
    if (started.taskId) output.taskId = started.taskId
    for (const exchange of this.exchanges.values()) {
      if (exchange.targetSessionId === childSessionId && isOpenExchange(exchange)) addOutput(exchange.outputs, output)
    }
  }

  private remember(senderSessionId: string, targetSessionId: string): void {
    let targets = this.contacts.get(senderSessionId)
    if (!targets) this.contacts.set(senderSessionId, targets = new Set())
    targets.add(targetSessionId)
  }

  private exchangesOf(run: RunExchanges): Exchange[] {
    const found: Exchange[] = []
    for (const exchangeId of run.exchangeIds) {
      const exchange = this.exchanges.get(exchangeId)
      if (!exchange) continue
      if (!exchange.targetSessionId) {
        exchange.targetSessionId = run.sessionId
        this.remember(exchange.senderSessionId, run.sessionId)
      }
      found.push(exchange)
    }
    return found
  }

  private apply(exchange: Exchange, event: ExchangeEvent): boolean {
    const changed = applyExchangeEvent(exchange, event)
    if (changed) log.debug('exchange_changed', { exchangeId: exchange.exchangeId, event: event.type, state: exchange.state })
    return changed
  }

  private publish(exchange: Pick<Exchange, 'senderSessionId'>, update: AgentConversationUpdate): void {
    this.runtime.emit(exchange.senderSessionId, { type: 'agent_conversation_update', update })
  }

  private agentSessionIdOf(sessionId: string): string | undefined {
    for (const exchange of this.exchanges.values()) {
      if (exchange.senderSessionId === sessionId) return exchange.senderAgentSessionId
    }
    return this.runtime.agentSessionIdFor(sessionId)
  }

  /** Never accepted, so no turn will ever settle it. */
  private settleUnaccepted(exchange: Exchange): void {
    this.settle(exchange, 'failed', '')
  }

  private async settleRun(run: SettledRun, exchanges: Exchange[]): Promise<void> {
    if (run.agentSessionId) for (const exchange of exchanges) this.bindStarted(exchange, run.agentSessionId, undefined)
    let reply = run.resultText?.trim()
    const targetAgentSessionId = run.agentSessionId ?? exchanges[0]!.targetAgentSessionId
    if (!reply && !targetAgentSessionId.startsWith('pending:')) {
      const ending = await this.runtime.turnEnding(run.provider, targetAgentSessionId, run.projectScope).catch((): TurnEnding => ({}))
      // A turn that failed with nothing to say reports why, so the parent can act on it.
      reply = ending.reply?.trim() || (run.outcome !== 'completed' && ending.error ? `The turn ended with an error: ${clip(ending.error, ORCHESTRATION_LIMITS.questionText)}` : undefined)
    }
    const pullRequest = await this.pullRequestFor(run)
    const taskId = await this.runtime.taskIdFor(run.sessionId).catch(() => undefined)
    for (const exchange of exchanges) {
      if (!isOpenExchange(exchange) || exchange.revising) continue
      finishOutputs(exchange, run.gitContext?.branch ?? undefined, pullRequest)
      this.settle(exchange, run.outcome, reply ?? '', { run, taskId })
    }
  }

  /** The pull request opened from the run's branch, when it works on one. */
  private async pullRequestFor(run: SettledRun): Promise<SessionOutput | null> {
    const checkout = run.gitContext
    if (!checkout?.branch || !checkout.targetBranch || checkout.branch === checkout.targetBranch || !run.projectScope) return null
    const pullRequest = await this.deps.findPullRequest(checkout, run.projectScope).catch((error) => {
      log.warn('exchange_pull_request_lookup_failed', { sessionId: run.sessionId, error: String(error) })
      return null
    })
    return pullRequest ? { kind: 'pull_request', number: pullRequest.number, url: pullRequest.url } : null
  }

  private settle(exchange: Exchange, outcome: ExchangeOutcome, reply: string, settledBy: { run?: SettledRun; taskId?: string } = {}): void {
    const { run, taskId } = settledBy
    const settled: ExchangeEvent = { type: 'settled', outcome }
    if (run) settled.runId = run.runId
    if (!this.apply(exchange, settled)) return
    const update: Extract<AgentConversationUpdate, { phase: 'settled' }> = {
      phase: 'settled',
      agentSessionId: exchange.targetAgentSessionId,
      messageId: exchange.exchangeId,
      status: outcome,
      replyText: reply,
      settledAt: Date.now(),
    }
    if (exchange.outputs.length) update.outputs = exchange.outputs
    if (taskId) update.taskId = taskId
    if (run?.durationMs !== undefined) update.durationMs = run.durationMs
    if (run?.toolCallCount !== undefined) update.toolCallCount = run.toolCallCount
    this.publish(exchange, update)
    this.exchanges.delete(exchange.exchangeId)
    const stoppedBySender = this.stoppedBySender.delete(exchange.exchangeId)
    // Whatever the turn was still waiting on ended with it; the report says how.
    while (exchange.notices.length) this.withdrawNotice(exchange, exchange.notices[0]!)
    const item: OrchestrationItem = { type: 'report', report: {
      messageId: exchange.exchangeId,
      agentSessionId: exchange.targetAgentSessionId,
      taskId,
      provider: exchange.provider,
      status: outcome,
      durationMs: run?.durationMs,
      outputs: exchange.outputs,
      reply: reply || NO_REPLY,
    } }
    // A sender waiting in its tool call gets the report there, and only there.
    if (this.endWait(exchange, item)) return
    if (!exchange.notify || stoppedBySender) return
    this.delivery.deliver(exchange.senderAgentSessionId, {
      exchangeId: exchange.exchangeId,
      targetAgentSessionId: exchange.targetAgentSessionId,
      item,
    })
  }

  /** Holds the sender's tool call until the exchange reports, a notice ends the
   *  wait, or `ms` passes. The child is never stopped by the wait ending. */
  private waitOn(exchange: Exchange, ms: number): Promise<OrchestrationItem | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.endWait(exchange, null), Math.min(ms, MAX_WAIT_MS))
      exchange.wait = { resolve, timer }
    })
  }

  /** Ends a waiting tool call with `item`; false when nobody waits. */
  private endWait(exchange: Exchange, item: OrchestrationItem | null): boolean {
    const wait = exchange.wait
    if (!wait) return false
    exchange.wait = undefined
    clearTimeout(wait.timer)
    wait.resolve(item)
    log.info('exchange_wait_ended', { exchangeId: exchange.exchangeId, outcome: item ? item.type : 'timed_out' })
    return true
  }

  /**
   * Tells the sender's model about a child that needs a person or is blocked.
   * One notice per sender and request, however many of the sender's messages
   * the turn answers. A sender that did not ask to hear back is not told.
   */
  private notify(exchange: Exchange, notice: SessionNotice, key: string): void {
    // A sender waiting in its tool call hears it there: the wait ends at once.
    if (this.endWait(exchange, { type: 'notice', notice })) return
    if (!exchange.notify) return
    exchange.notices.push(key)
    const openKey = `${exchange.senderAgentSessionId}:${exchange.targetSessionId}:${key}`
    if (this.openNotices.has(openKey)) return
    this.openNotices.add(openKey)
    const item: Promise<OrchestrationItem> = this.runtime.taskIdFor(exchange.targetSessionId)
      .catch(() => undefined)
      .then((taskId) => ({ type: 'notice', notice: taskId ? { ...notice, taskId } : notice }))
    this.delivery.deliver(exchange.senderAgentSessionId, item.then((resolved) => ({
      item: resolved,
      exchangeId: exchange.exchangeId,
      targetAgentSessionId: exchange.targetAgentSessionId,
      noticeKey: openKey,
    })))
  }

  /** The notice's cause is over: take it back if the sender has not read it. */
  private withdrawNotice(exchange: Exchange, key: string): void {
    const at = exchange.notices.indexOf(key)
    if (at === -1) return
    exchange.notices.splice(at, 1)
    const openKey = `${exchange.senderAgentSessionId}:${exchange.targetSessionId}:${key}`
    if (!this.openNotices.delete(openKey)) return
    this.delivery.withdraw(exchange.senderAgentSessionId, openKey)
  }
}

/** The card's first sight of a message to an existing session. */
function promptedUpdate(exchange: Exchange, meta: SessionMeta | null, message: { prompt: string; delivery: PromptDelivery }): AgentConversationUpdate {
  const dispatched: AgentConversationUpdate = {
    phase: 'dispatched',
    agentSessionId: exchange.targetAgentSessionId,
    messageId: exchange.exchangeId,
    origin: 'prompted',
    prompt: message.prompt,
    delivery: message.delivery,
    provider: exchange.provider,
    title: meta ? sessionTitle(meta) : exchange.targetAgentSessionId.slice(0, 8),
    cwd: meta?.cwd ?? '',
    dispatchedAt: exchange.dispatchedAt,
  }
  if (meta?.model) dispatched.model = meta.model
  if (meta?.reasoningEffort) dispatched.reasoningEffort = meta.reasoningEffort
  return dispatched
}

function sessionTitle(meta: SessionMeta): string {
  return meta.slug || (meta.firstMessage ? promptTitle(meta.firstMessage) : '') || meta.sessionId.slice(0, 8)
}

function exchangeRequestFrom(event: NormalizedEvent): ExchangeRequest | null {
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
function finishOutputs(exchange: Exchange, branch: string | undefined, pullRequest: SessionOutput | null): void {
  // The files are the session's; the branch they are on is the run's.
  for (const output of exchange.outputs) {
    if (output.kind === 'changed_files' && branch) output.branch = branch
  }
  if (exchange.state === 'awaiting_input') for (const output of unansweredOutputs(exchange.request)) addOutput(exchange.outputs, output)
  if (pullRequest) addOutput(exchange.outputs, pullRequest)
}

/** The id a person's answer names: the question, permission or held plan. */
function requestId(request: ExchangeRequest): string {
  if (request.kind === 'question') return request.question.questionId
  if (request.kind === 'permission') return request.permission.questionId
  return request.plan.questionId ?? request.plan.planToolUseId ?? request.plan.title
}

/** The short notice a sender reads about a request: never a plan's text. */
function requestNotice(exchange: Exchange, request: ExchangeRequest): SessionNotice {
  const target = { messageId: exchange.exchangeId, agentSessionId: exchange.targetAgentSessionId, provider: exchange.provider }
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
