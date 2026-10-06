import type { Activity, ActivityKind, ActivitySubject } from '@solus/contracts/activity'
import { randomUUID } from 'node:crypto'
import { recoverExchanges } from './recover-exchanges'
import { ExchangeLedger, type ExchangeIdentity } from './exchange-ledger'
import type { RunLedger } from '../../data/sessions/run-ledger'
import { promptedUpdate, settledUpdate, exchangeRequestFrom, finishOutputs, requestId, requestNotice, type TurnEnding } from './exchange-reports'
export { turnEnding } from './exchange-reports'
import {
  ORCHESTRATION_LIMITS,
  clip,
  promptTitle,
  type ExchangeOutcome,
  type OrchestrationItem,
  type SessionNotice,
  type SessionOutput,
  type SessionReport,
} from '@solus/contracts/session-exchange'
import type {
  AgentConversationUpdate,
  AgentId,
  ExchangeProgress,
  GitCheckout,
  NormalizedEvent,
  PermissionMode,
  PromptDelivery,
  ReasoningEffort,
  SessionMeta,
} from '@solus/contracts/types'
import { planKey } from '@solus/contracts/types'
import { attributionOf, type Actor } from '../../admission/actor'
import { createLogger } from '../../logger'
import { describePendingInput, type PendingInputDescription } from '../sessions/pending-input'
import { applyExchangeEvent, isOpenExchange, type Exchange, type ExchangeEvent } from './exchange'
import { recordPlanDecision } from './plan-decisions'
import { addOutput, answerText, outputFromEvent, outputsFromAnswer, type ResolvedInput } from './session-outputs'
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
 * through `OrchestratedRuntime`.
 *
 * Host-local receipts preserve exchanges, results, and report delivery. A
 * restart restores queued work as held and marks uncertain running work
 * interrupted; it never repeats provider execution automatically.
 */

const IMPLEMENT_PREFIX = 'Implement this plan:\n\n'
// The same copy a person's Revise sends in the session's own tab, so a decision
// taken in either place reads identically in the target's transcript.
const REVISION_PREFIX = 'Please revise the plan with these comments:\n\n'
export { CHILD_INTERRUPTED_BY_RESTART } from './exchange-reports'
import { CHILD_INTERRUPTED_BY_RESTART } from './exchange-reports'
const NO_REPLY = '(no final assistant reply available)'

/** A run of the control plane and the exchanges it answers. */
export interface RunExchanges {
  runId: string
  /** The session the run belongs to. */
  sessionId: string
  exchangeIds: readonly string[]
}

export interface SettledRun extends RunExchanges {
  outcome: ExchangeOutcome
  resultText?: string
  /** Why a failed run ended, when the provider said. */
  error?: string
  durationMs?: number
  toolCallCount?: number
  provider: AgentId
  projectScope?: string
  gitContext?: GitCheckout | null
}

export interface CreateSessionOrder {
  sessionId?: string
  permissionMode?: PermissionMode
  prompt: string
  provider: AgentId
  modelId: string
  reasoningEffort: ReasoningEffort
  contextWindow: number | null
  cwd: string
  worktreeBaseBranch?: string | null
  taskId?: string | null
  exchangeIds?: string[]
  delegation?: { parentSessionId: string; messageId: string; intent: 'delegate' | 'fire_and_forget'; createdAt: number }
}

export interface PromptOrder {
  reportExchangeIds?: string[]
  exchangeIds?: string[]
  permissionMode?: PermissionMode
  via?: 'session-report'
}

/** What the orchestrator needs from the control plane that runs the turns.
 *  Every session is named by its session id (docs/plans/session-identity.md). */
export interface OrchestratedRuntime {
  activeExchangeIdsFor(sessionId: string): string[]
  queuedExchanges(): Array<{ sessionId: string; queueId: string; exchangeIds: string[]; reportExchangeIds: string[]; started: boolean }>
  sessionMeta(sessionId: string): SessionMeta | null
  createSession(order: CreateSessionOrder): Promise<{ sessionId: string; taskId?: string }>
  promptSession(sessionId: string, prompt: string, delivery: PromptDelivery, order: PromptOrder): Promise<{ disposition: 'started' | 'steered' | 'queued'; queueId?: string }>
  stopSession(id: string): boolean
  /** Answers a permission the asking session is waiting on; false when it is not. */
  respondToPermission(askingSessionId: string, questionId: string, optionId: string, updatedPlan?: string): boolean
  pendingInputEvents(sessionId: string): NormalizedEvent[]
  replaceQueuedPrompt(sessionId: string, queueId: string, text: string, reportExchangeIds?: string[], exchangeIds?: string[]): boolean
  hasQueuedPrompt(sessionId: string, queueId: string): boolean
  cancelQueuedPrompt(sessionId: string, queueId: string): boolean
  /** How the session's last turn ended, read from its transcript. */
  turnEnding(provider: AgentId, sessionId: string, projectScope: string | undefined): Promise<TurnEnding>
  /** The task a session works on. */
  taskIdFor(sessionId: string): Promise<string | undefined>
  /** Whether the session is a task's lead. */
  isLead(sessionId: string): Promise<boolean>
  emit(sessionId: string, event: NormalizedEvent): void
  invalidatePlanCaches(sessionId: string): void
  /** Record what a person did to a session as its activity (plans/012 §5). */
  recordActivity(subject: ActivitySubject & { kind: 'session' }, actor: Actor, kind: ActivityKind): Promise<Activity>
  /** Holds a host update until the work settles. */
  trackWork<T>(work: Promise<T>): Promise<T>
}

export interface OrchestratorDeps {
  /** The pull request opened from a checkout's branch, if any. */
  findPullRequest(checkout: GitCheckout, projectScope: string): Promise<{ number: number; url: string } | null>
}

export interface SpawnedSession {
  exchangeId: string
  sessionId: string
  /** The provider has not started the session's thread yet. */
  starting?: boolean
  taskId?: string
  /** With a wait: the report or notice that arrived in time, or null when none did. */
  waited?: OrchestrationItem | null
}

/** The longest a tool call may wait on a session, in milliseconds. */
export const MAX_WAIT_MS = 600_000

/** The system instruction for a turn that answers another session's message:
 *  its last message is the reply that session reads. */
export const ANSWERING_ANOTHER_SESSION = 'Another Solus session sent you this work, and your last message is the reply it reads. '
  + 'End your turn with a reply of at most five short lines: the outcome, what you produced by id or link (branch, pull request, plans, works, sessions you started), and what is still open. '
  + 'Put longer detail in a task comment or a work, not in the reply. '
  + 'For nested work, use report=true and wait_seconds=0, then end the turn while it runs. Its report wakes you. Read the result, do any required follow-up, and only then give your final reply. '
  + 'An ended turn with open child work is not a final result for the session that sent this request. '
  + 'Do not use send_session to message the session that sent you this work; your reply reaches it.'

/** The last plan a session's turn wrote. */
interface OpenPlan {
  planToolUseId?: string
  planContent: string
}

export class SessionOrchestrator {
  private readonly ledger: ExchangeLedger
  private readonly exchanges: Map<string, Exchange>
  /** Sender session → target sessions it has sent a message to. Authorizes a
   *  person's answer from the sender's conversation. */
  private readonly contacts = new Map<string, Set<string>>()
  private readonly delivery: ParentDelivery
  /** Notices a parent was sent and that may still wait in its queue, by key. */
  private readonly openNotices = new Set<string>()
  /** Exchanges whose sender stopped the target itself: its own action needs no report. */
  private readonly stoppedBySender = new Set<string>()
  /** Target session → the last plan its turn wrote, until its next turn starts.
   *  A plan whose turn already ended (Codex) holds nothing open to answer, so a
   *  person's decision on it comes from here. */
  private readonly openPlans = new Map<string, OpenPlan>()

  constructor(
    private readonly runtime: OrchestratedRuntime,
    private readonly deps: OrchestratorDeps,
    store?: RunLedger,
    schedule?: ConstructorParameters<typeof ParentDelivery>[2],
  ) {
    this.ledger = new ExchangeLedger(store)
    this.exchanges = this.ledger.exchanges
    this.delivery = new ParentDelivery(runtime, (exchangeIds, state, queueId) => this.ledger.markDelivery(exchangeIds, state, queueId), schedule)
  }

  recover(): void {
    recoverExchanges(this.runtime, this.ledger, this.delivery,
      (exchange, outcome, reply) => this.settle(exchange, outcome, reply),
      (exchange, item, hasReport) => this.deliverReport(exchange, item, hasReport))
  }

  /** Acceptance is separate from the result. Queued reports are accepted when
   * their runtime turn starts, not when they merely enter its queue. */
  reportsAccepted(exchangeIds: readonly string[]): void {
    this.ledger.markDelivery(exchangeIds, 'accepted')
  }

  reportsDisposed(exchangeIds: readonly string[]): void {
    this.ledger.markDelivery(exchangeIds, 'disposed')
  }

  readExchange(senderSessionId: string, exchangeId: string): Exchange | undefined {
    return this.ledger.read(senderSessionId, exchangeId)
  }

  private async repeatedSpawn(exchange: Exchange, waitMs: number): Promise<SpawnedSession> {
    const waited = exchange.report ? { type: 'report' as const, report: exchange.report }
      : waitMs > 0 ? await this.waitOn(exchange, waitMs) : undefined
    return { exchangeId: exchange.exchangeId, sessionId: exchange.targetSessionId,
      starting: exchange.state === 'dispatched', taskId: exchange.report?.taskId, waited }
  }

  private async repeatedSend(exchange: Exchange, waitMs: number): Promise<{ exchangeId: string; disposition: 'started' | 'steered' | 'queued'; waited?: OrchestrationItem | null }> {
    return { exchangeId: exchange.exchangeId, disposition: exchange.disposition ?? 'queued',
      waited: exchange.report ? { type: 'report', report: exchange.report }
        : waitMs > 0 ? await this.waitOn(exchange, waitMs) : undefined }
  }

  // ─── Commands ───

  /** Starts a new session running `order.prompt`. With a sender, the message is
   *  an exchange and the child is recorded as the sender's delegate; with
   *  `report`, the sender hears its notices and its result. */
  async spawn(
    senderSessionId: string | undefined,
    order: Omit<CreateSessionOrder, 'exchangeIds' | 'delegation'>,
    report: boolean,
    waitMs = 0,
    requestId?: string,
  ): Promise<SpawnedSession> {
    // The stored delegation keeps the intent names it has always had.
    const intent = report ? 'delegate' : 'fire_and_forget'
    const identity = this.ledger.identify(senderSessionId, requestId, JSON.stringify({ kind: 'create', order, report }))
    if (identity.existing) return this.repeatedSpawn(identity.existing, waitMs)
    const { exchangeId } = identity
    const dispatchedAt = Date.now()
    // The new session's id is chosen now, so the sender's card names it from the start.
    const targetSessionId = order.sessionId ?? randomUUID()
    const exchange = this.openSpawn(senderSessionId, targetSessionId, order, report, identity, dispatchedAt)
    const waited = exchange && waitMs > 0 ? this.waitOn(exchange, waitMs) : undefined

    const starting = (async (): Promise<SpawnedSession> => {
      try {
        const started = await this.runtime.createSession({
          ...order,
          sessionId: targetSessionId,
          exchangeIds: exchange ? [exchangeId] : undefined,
          delegation: senderSessionId
            ? { parentSessionId: senderSessionId, messageId: exchangeId, intent, createdAt: dispatchedAt }
            : undefined,
        })
        if (exchange) this.attach(exchange, this.runtime.sessionMeta(started.sessionId)?.cwd)
        if (exchange) this.ledger.update(exchange, (draft) => { draft.disposition = 'started' })
        if (senderSessionId) this.recordStartedSession(senderSessionId, order.prompt, started)
        const created: SpawnedSession = { exchangeId, sessionId: started.sessionId }
        if (started.taskId) created.taskId = started.taskId
        return created
      } catch (error) {
        if (exchange) this.settle(exchange, 'failed', `Session startup failed: ${error instanceof Error ? error.message : String(error)}`)
        throw error
      }
    })()
    if (!exchange) return starting
    // Startup failures settle the durable exchange before this catch. The
    // host tracks setup while the caller can leave its turn immediately.
    void this.runtime.trackWork(starting.catch(() => {}))
    const result = waited ? await waited : undefined
    return { exchangeId, sessionId: exchange.targetSessionId,
      starting: exchange.state === 'dispatched', taskId: order.taskId ?? undefined, waited: result }
  }

  private openSpawn(
    senderSessionId: string | undefined, targetSessionId: string,
    order: Omit<CreateSessionOrder, 'exchangeIds' | 'delegation'>, report: boolean,
    identity: ExchangeIdentity, dispatchedAt: number,
  ): Exchange | null {
    const { exchangeId, fingerprint } = identity
    const exchange = senderSessionId
      ? this.open({
          exchangeId,
          kind: 'create',
          senderSessionId,
          targetSessionId,
          provider: order.provider,
          notify: report,
          dispatchedAt, fingerprint,
          parentExchangeIds: report && senderSessionId ? this.runtime.activeExchangeIdsFor(senderSessionId).slice() : [],
        })
      : null
    if (exchange) {
      this.publish(exchange, {
        phase: 'dispatched',
        sessionId: exchange.targetSessionId,
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
    return exchange
  }

  /** Sends one message to an existing session. The sender's card shows it before
   *  the target can answer, and the result comes back under the same id. */
  async send(
    senderSessionId: string,
    targetSessionId: string,
    message: { prompt: string; delivery: PromptDelivery; notify: boolean; permissionMode?: PermissionMode; waitMs?: number; requestId?: string },
  ): Promise<{ exchangeId: string; disposition: 'started' | 'steered' | 'queued'; waited?: OrchestrationItem | null }> {
    if (targetSessionId === senderSessionId) throw new Error('Cannot message your own session.')
    const meta = this.runtime.sessionMeta(targetSessionId)
    // Refused before the card shows it: there is nothing to send it to.
    if (!meta) throw new Error(`Session ${targetSessionId} not found.`)
    const { waitMs: _waitMs, requestId: retryId, ...request } = message
    const identity = this.ledger.identify(senderSessionId, retryId, JSON.stringify({ kind: 'prompt', targetSessionId, request }))
    if (identity.existing) return this.repeatedSend(identity.existing, message.waitMs ?? 0)
    const { exchangeId, fingerprint } = identity
    const parentExchangeIds = message.notify ? this.runtime.activeExchangeIdsFor(senderSessionId).slice() : []
    if (this.ledger.isAncestor(parentExchangeIds, targetSessionId)) {
      throw new Error('A request cannot wait for its own ancestor. Use report=false for an update to the sender.')
    }
    const dispatchedAt = Date.now()
    const exchange = this.open({
      exchangeId,
      kind: 'prompt',
      senderSessionId,
      targetSessionId,
      provider: meta.provider,
      notify: message.notify,
      dispatchedAt, fingerprint, parentExchangeIds,
    })
    const waited = message.waitMs && message.waitMs > 0 ? this.waitOn(exchange, message.waitMs) : undefined
    this.publish(exchange, promptedUpdate(exchange, meta, message))
    const order: PromptOrder = { exchangeIds: [exchangeId] }
    if (message.permissionMode) order.permissionMode = message.permissionMode
    try {
      const result = await this.runtime.promptSession(targetSessionId, message.prompt, message.delivery, order)
      this.ledger.update(exchange, (draft) => { draft.disposition = result.disposition })
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
  stop(senderSessionId: string | undefined, targetSessionId: string): boolean {
    const marked: string[] = []
    if (senderSessionId) {
      for (const exchange of this.exchanges.values()) {
        if (exchange.senderSessionId === senderSessionId && exchange.targetSessionId === targetSessionId) marked.push(exchange.exchangeId)
      }
    }
    for (const exchangeId of marked) this.stoppedBySender.add(exchangeId)
    const stopped = this.runtime.stopSession(targetSessionId)
    // Nothing stopped: a later result is not the sender's own doing.
    if (!stopped) for (const exchangeId of marked) this.stoppedBySender.delete(exchangeId)
    return stopped
  }

  /** A person's decision on a plan a target session wrote, from the conversation
   *  that sent it work. A plan still holding the target's turn open is answered
   *  in place; one whose turn ended is carried on by a new message. */
  async decidePlan(
    senderSessionId: string,
    targetSessionId: string,
    decision: 'approve' | 'request_changes',
    /** Who decided; the note filed on the plan and the `plan_decided` activity are theirs. */
    actor: Actor,
    comment?: string,
  ): Promise<boolean> {
    if (!this.contacts.get(senderSessionId)?.has(targetSessionId)) return false
    const pending = this.pendingPlan(targetSessionId)
    if (!pending) return false
    const note = comment?.trim() ?? ''
    if (decision === 'request_changes' && !note) return false
    const decided = decision === 'approve'
      ? await this.approvePlan(pending, senderSessionId, targetSessionId)
      : await this.requestPlanChanges(pending, note, senderSessionId, targetSessionId)
    if (!decided) return false
    this.openPlans.delete(targetSessionId)
    const status = decision === 'approve' ? 'accepted' : 'rejected'
    const meta = this.runtime.sessionMeta(targetSessionId)
    if (meta && await recordPlanDecision(targetSessionId, meta, pending, status, note || undefined, attributionOf(actor))) {
      this.runtime.invalidatePlanCaches(targetSessionId)
    }
    if (pending.planToolUseId) {
      await this.runtime.recordActivity({ kind: 'session', id: targetSessionId }, actor, { kind: 'plan_decided', planId: planKey(targetSessionId, pending.planToolUseId), decision: status })
    }
    return true
  }

  /** The plan the target is waiting on, held open or already reported. */
  private pendingPlan(targetSessionId: string): PendingPlan | null {
    const held = describePendingInput(this.runtime.pendingInputEvents(targetSessionId))
    if (held?.kind === 'plan') return held
    const ended = this.openPlans.get(targetSessionId)
    if (!ended) return null
    const plan: PendingPlan = { kind: 'plan', questionId: '', planContent: ended.planContent, blocking: false }
    if (ended.planToolUseId) plan.planToolUseId = ended.planToolUseId
    return plan
  }

  private async approvePlan(pending: PendingPlan, senderSessionId: string, targetSessionId: string): Promise<boolean> {
    if (pending.blocking) {
      return !!pending.allowOptionId && this.runtime.respondToPermission(targetSessionId, pending.questionId, pending.allowOptionId)
    }
    await this.send(senderSessionId, targetSessionId, {
      prompt: `${IMPLEMENT_PREFIX}${pending.planContent}`,
      delivery: 'queue',
      notify: true,
      permissionMode: 'full-access',
    })
    return true
  }

  private async requestPlanChanges(
    pending: PendingPlan,
    note: string,
    senderSessionId: string,
    targetSessionId: string,
  ): Promise<boolean> {
    const waiting = [...this.exchanges.values()].filter((exchange) =>
      exchange.targetSessionId === targetSessionId && exchange.state === 'awaiting_input' && exchange.request?.kind === 'plan')
    if (pending.blocking && waiting.length) return this.reviseInPlace(pending, note, waiting, targetSessionId)
    if (pending.blocking && pending.denyOptionId) this.runtime.respondToPermission(targetSessionId, pending.questionId, pending.denyOptionId)
    await this.send(senderSessionId, targetSessionId, {
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
  private async reviseInPlace(pending: PendingPlan, note: string, waiting: Exchange[], targetSessionId: string): Promise<boolean> {
    if (!pending.denyOptionId) return false
    const answer = `Asked for changes to the plan: ${note}`
    for (const exchange of waiting) {
      this.apply(exchange, { type: 'revision_requested' })
      if (this.apply(exchange, { type: 'input_resolved', outputs: [] })) {
        this.publish(exchange, { phase: 'answered', sessionId: exchange.targetSessionId, messageId: exchange.exchangeId, answerText: answer })
      }
    }
    if (!this.runtime.respondToPermission(targetSessionId, pending.questionId, pending.denyOptionId)) {
      for (const exchange of waiting) exchange.revising = false
      return false
    }
    try {
      await this.runtime.promptSession(targetSessionId, `${REVISION_PREFIX}${note}`, 'queue', {
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
    if (callerSessionId === askingSessionId) return true
    for (const exchange of this.exchanges.values()) {
      if (exchange.senderSessionId === callerSessionId && exchange.targetSessionId === askingSessionId && exchange.state === 'awaiting_input') return true
    }
    return false
  }

  /** Where one exchange stands, for a card rebuilt from the transcript. An
   *  exchange this process does not carry was lost to a restart or expired. */
  progressOf(exchangeId: string): ExchangeProgress | undefined {
    const exchange = this.exchanges.get(exchangeId)
    if (!exchange) return undefined
    const state = !isOpenExchange(exchange) ? exchange.deliveryState === 'pending' || exchange.deliveryState === 'queued' ? 'reply_queued' : 'settled' : exchange.state === 'waiting_for_children' ? 'waiting_for_children' : exchange.state === 'awaiting_input' || exchange.state === 'rate_limited'
      ? exchange.state
      : exchange.state === 'running' ? 'running' : 'queued'
    const progress: ExchangeProgress = { state }
    if (state === 'settled') progress.outcome = exchange.outcome
    if (exchange.request && exchange.state === 'awaiting_input') progress.request = exchange.request
    if (exchange.state === 'rate_limited' && exchange.rateLimitResetsAt) progress.resetsAt = exchange.rateLimitResetsAt
    return progress
  }

  /** Children whose turn the previous process never settled. A parent that
   *  delegated to one gets a report instead of waiting for a reply nothing will
   *  send; boot marks each record interrupted, so a child is reported once. */
  reportChildrenInterruptedByRestart(childSessionIds: readonly string[]): void {
    for (const childSessionId of childSessionIds) {
      const meta = this.runtime.sessionMeta(childSessionId)
      const delegation = meta?.delegation
      if (!meta || delegation?.intent !== 'delegate' || this.exchanges.has(delegation.messageId)) continue
      log.info('session_child_interrupted_by_restart', { sessionId: childSessionId, parentSessionId: delegation.parentSessionId })
      this.delivery.deliver(delegation.parentSessionId, {
        exchangeId: delegation.messageId,
        targetSessionId: childSessionId,
        item: { type: 'report', report: {
          messageId: delegation.messageId,
          sessionId: childSessionId,
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
        this.publish(exchange, { phase: 'accepted', sessionId: exchange.targetSessionId, messageId: exchange.exchangeId, state: 'queued' })
      }
    }
  }

  /** The run started, its message joined the live turn as a steer, or a run
   *  parked on a rate limit resumed. */
  runStarted(run: RunExchanges): void {
    for (const exchange of this.exchangesOf(run)) {
      const wasLimited = exchange.state === 'rate_limited'
      if (this.apply(exchange, { type: 'started', runId: run.runId })) {
        this.publish(exchange, { phase: 'accepted', sessionId: exchange.targetSessionId, messageId: exchange.exchangeId, state: 'running' })
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
      const update: AgentConversationUpdate = { phase: 'rate_limited', sessionId: exchange.targetSessionId, messageId: exchange.exchangeId }
      if (limit.resetsAt) update.resetsAt = limit.resetsAt
      if (limit.limitType) update.limitType = limit.limitType
      this.publish(exchange, update)
      const notice: SessionNotice = { messageId: exchange.exchangeId, sessionId: exchange.targetSessionId, provider: exchange.provider, kind: 'rate_limited' }
      if (limit.resetsAt) notice.resetsAt = limit.resetsAt
      if (limit.limitType) notice.limitType = limit.limitType
      this.notify(exchange, notice, 'limit')
    }
  }

  /** A created session started its thread: its cards show where it runs. */
  sessionStarted(run: RunExchanges, cwd: string | undefined): void {
    for (const exchange of this.exchangesOf(run)) this.attach(exchange, cwd)
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
        this.publish(exchange, { phase: 'awaiting_input', sessionId: exchange.targetSessionId, messageId: exchange.exchangeId, request })
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
        this.publish(exchange, { phase: 'answered', sessionId: exchange.targetSessionId, messageId: exchange.exchangeId, answerText: answer })
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
    const output = outputFromEvent(event, run.sessionId)
    if (!output) return
    for (const exchange of this.exchangesOf(run)) addOutput(exchange.outputs, output)
  }

  /** The single settlement point: the run's turn ended. */
  runSettled(run: SettledRun): void {
    const exchanges = this.exchangesOf(run).filter((exchange) =>
      isOpenExchange(exchange) && !exchange.revising && (!exchange.runId || exchange.runId === run.runId))
    if (!exchanges.length) return
    const ready = exchanges.filter((exchange) => {
      if (run.outcome !== 'completed' || !this.ledger.hasChildren(exchange.exchangeId)) return true
      if (this.apply(exchange, { type: 'children_pending', runId: run.runId })) {
        this.publish(exchange, { phase: 'accepted', sessionId: exchange.targetSessionId, messageId: exchange.exchangeId, state: 'waiting_for_children' })
      }
      return false
    })
    if (!ready.length) return
    void this.runtime.trackWork(this.settleRun(run, ready)).catch((error) => {
      log.warn('exchange_settle_failed', { sessionId: run.sessionId, error: String(error) })
    })
  }

  /** The run never reached a turn: its queue entry was cancelled or drained, or it failed to launch. */
  runCancelled(run: RunExchanges, outcome: 'interrupted' | 'failed' = 'interrupted', reason = ''): void {
    for (const exchange of this.exchangesOf(run)) {
      if (!isOpenExchange(exchange) || exchange.revising) continue
      this.settle(exchange, outcome, reason)
    }
  }

  /** Any turn of a session started: whatever plan it wrote before was acted on. */
  sessionTurnStarted(sessionId: string): void {
    this.openPlans.delete(sessionId)
  }

  /** A target was stopped, from any surface: every card talking to its running turn
   *  closes. Stop keeps the queue, so a message whose run still waits in
   *  `queuedRunIds` stays open and runs next (plan 004 D12). */
  targetStopped(targetSessionId: string, queuedRunIds: ReadonlySet<string> = new Set()): void {
    const senders = new Set<string>()
    for (const exchange of this.exchanges.values()) {
      if (exchange.targetSessionId !== targetSessionId || !isOpenExchange(exchange)) continue
      if (exchange.runId && queuedRunIds.has(exchange.runId)) continue
      if (!senders.has(exchange.senderSessionId)) {
        senders.add(exchange.senderSessionId)
        this.publish(exchange, { phase: 'stopped', sessionId: exchange.targetSessionId })
      }
      if (exchange.state === 'waiting_for_children') this.settle(exchange, 'interrupted', 'Stopped while waiting for child work.')
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
      // Reports held for a stopped lead would wake it again: drop them.
      if (!cancelled) this.delivery.dropHeld(exchange.senderSessionId)
      this.settle(exchange, 'interrupted', '', { silenced: true })
      cancelled = true
    }
    return cancelled
  }

  // ─── Internals ───

  private open(fields: Omit<Exchange, 'state' | 'outputs' | 'notices' | 'revising'>): Exchange {
    const exchange: Exchange = { ...fields, state: 'dispatched', outputs: [], notices: [], revising: false }
    this.ledger.open(exchange)
    if (exchange.targetSessionId) this.remember(exchange.senderSessionId, exchange.targetSessionId)
    return exchange
  }

  /** Tells a created session's card where it runs, once its checkout is known. */
  private attach(exchange: Exchange, cwd: string | undefined): void {
    if (exchange.kind !== 'create' || !cwd) return
    this.publish(exchange, { phase: 'attached', messageId: exchange.exchangeId, sessionId: exchange.targetSessionId, cwd })
  }

  /** A session a child started is something the child's open turns produced. */
  private recordStartedSession(childSessionId: string, prompt: string, started: { sessionId: string; taskId?: string }): void {
    const output: SessionOutput = { kind: 'session', sessionId: started.sessionId, title: prompt }
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
    const changed = this.ledger.apply(exchange, event)
    if (changed) log.debug('exchange_changed', { exchangeId: exchange.exchangeId, event: event.type, state: exchange.state })
    return changed
  }

  private publish(exchange: Pick<Exchange, 'senderSessionId'>, update: AgentConversationUpdate): void {
    this.runtime.emit(exchange.senderSessionId, { type: 'agent_conversation_update', update })
  }

  /** Never accepted, so no turn will ever settle it. */
  private settleUnaccepted(exchange: Exchange): void {
    this.settle(exchange, 'failed', '')
  }

  private async settleRun(run: SettledRun, exchanges: Exchange[]): Promise<void> {
    let reply = run.resultText?.trim()
    // A run that failed before it wrote its prompt leaves the previous turn last
    // in the transcript; its own error is the only reply that is about this turn.
    if (!reply && run.outcome === 'failed' && run.error) reply = `The turn ended with an error: ${clip(run.error, ORCHESTRATION_LIMITS.questionText)}`
    if (!reply) {
      const ending = await this.runtime.turnEnding(run.provider, run.sessionId, run.projectScope).catch((): TurnEnding => ({}))
      // A turn that failed with nothing to say reports why, so the parent can act on it.
      reply = ending.reply?.trim() || (run.outcome !== 'completed' && ending.error ? `The turn ended with an error: ${clip(ending.error, ORCHESTRATION_LIMITS.questionText)}` : undefined)
    }
    const pullRequest = await this.pullRequestFor(run)
    const taskId = await this.runtime.taskIdFor(run.sessionId).catch(() => undefined)
    const open = exchanges.filter((exchange) => isOpenExchange(exchange) && !exchange.revising)
    for (const exchange of open) finishOutputs(exchange, run.gitContext?.branch ?? undefined, pullRequest)
    // One run that answers several messages from one sender is one report: the
    // first message carries it and names the others, which settle under it.
    for (const sender of new Set(open.map((exchange) => exchange.senderSessionId))) {
      const [first, ...others] = open.filter((exchange) => exchange.senderSessionId === sender)
      for (const other of others) this.settle(other, run.outcome, reply ?? '', { run, taskId, reportedBy: first!.exchangeId })
      this.settle(first!, run.outcome, reply ?? '', { run, taskId, alsoMessageIds: others.map((other) => other.exchangeId) })
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

  private settle(
    exchange: Exchange,
    outcome: ExchangeOutcome,
    reply: string,
    settledBy: {
      run?: SettledRun
      taskId?: string
      /** Other messages from the same sender this run answered; this report names them. */
      alsoMessageIds?: string[]
      /** The message whose report covers this one: none is sent for it. */
      reportedBy?: string
      /** The sender stopped waiting: nothing is delivered to it. */
      silenced?: boolean
    } = {},
  ): void {
    const { run, taskId, alsoMessageIds, reportedBy, silenced } = settledBy
    const settled: ExchangeEvent = { type: 'settled', outcome }
    if (run) settled.runId = run.runId
    const stoppedBySender = this.stoppedBySender.has(exchange.exchangeId)
    const settledAt = Date.now()
    // The result, its full reply, and its delivery state are one write.
    const changed = this.ledger.update(exchange, (draft) => {
      if (silenced) { draft.notify = false; draft.revising = false }
      if (!applyExchangeEvent(draft, settled)) return false
      const report: SessionReport = {
        messageId: draft.exchangeId,
        sessionId: draft.targetSessionId,
        taskId,
        provider: draft.provider,
        status: outcome,
        durationMs: run?.durationMs,
        outputs: draft.outputs,
        reply: reply || NO_REPLY,
      }
      if (alsoMessageIds?.length) report.alsoMessageIds = alsoMessageIds
      draft.report = report
      draft.settledAt = settledAt
      draft.deliveryState = draft.notify && !stoppedBySender && !reportedBy ? 'pending' : 'disposed'
    })
    if (!changed) return
    log.debug('exchange_changed', { exchangeId: exchange.exchangeId, event: 'settled', state: exchange.state })
    this.stoppedBySender.delete(exchange.exchangeId)
    const update = settledUpdate(exchange, outcome, reply, run, taskId)
    update.settledAt = settledAt
    // Whatever the turn was still waiting on ended with it; the report says how.
    while (exchange.notices.length) this.withdrawNotice(exchange, exchange.notices[0]!)
    this.publish(exchange, update)
    const item: OrchestrationItem = { type: 'report', report: exchange.report! }
    // A sender waiting in its tool call gets the report there, and only there.
    if (this.endWait(exchange, item)) { this.ledger.markDelivery([exchange.exchangeId], 'accepted'); return }
    if (reportedBy) return
    this.deliverReport(exchange, item, exchange.notify && !stoppedBySender)
  }

  /** Sends a settled message's report to its sender, or only wakes the sender
   *  with the reports held for it when this message has none to send. */
  private deliverReport(exchange: Exchange, item: OrchestrationItem, hasReport: boolean): void {
    const awaitingOthers = this.isAwaitingReplies(exchange.senderSessionId)
    if (!hasReport) {
      // The last message a lead waited on can end without a report of its own;
      // the reports held for it still wake it.
      if (!awaitingOthers) this.delivery.release(exchange.senderSessionId)
      return
    }
    // A lead hears nothing until every message it waits on has settled.
    const hold = awaitingOthers ? this.runtime.isLead(exchange.senderSessionId).catch(() => false) : Promise.resolve(false)
    this.delivery.deliver(exchange.senderSessionId, hold.then((held) => ({
      exchangeId: exchange.exchangeId,
      targetSessionId: exchange.targetSessionId,
      continuationExchangeIds: exchange.parentExchangeIds,
      item,
      hold: held,
    })))
  }

  /** Holds the sender's tool call until the exchange reports, a notice ends the
   *  wait, or `ms` passes. The child is never stopped by the wait ending. */
  private waitOn(exchange: Exchange, ms: number): Promise<OrchestrationItem | null> {
    if (exchange.wait) throw new Error('This request already has a waiting tool call. Read its exchange instead.')
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
   * the turn answers. A sender that did not ask to hear back, or that is a
   * task's lead, is not told.
   */
  private notify(exchange: Exchange, notice: SessionNotice, key: string): void {
    // A sender waiting in its tool call hears it there: the wait ends at once.
    if (this.endWait(exchange, { type: 'notice', notice })) return
    if (!exchange.notify) return
    exchange.notices.push(key)
    const openKey = `${exchange.senderSessionId}:${exchange.targetSessionId}:${key}`
    if (this.openNotices.has(openKey)) return
    this.openNotices.add(openKey)
    const item: Promise<OrchestrationItem> = this.runtime.taskIdFor(exchange.targetSessionId)
      .catch(() => undefined)
      .then((taskId) => ({ type: 'notice', notice: taskId ? { ...notice, taskId } : notice }))
    // A lead's person answers on the card and a limit resumes on its own: a
    // notice would only wake the lead to repeat what the card shows.
    const isLead = this.runtime.isLead(exchange.senderSessionId).catch(() => false)
    this.delivery.deliver(exchange.senderSessionId, Promise.all([item, isLead]).then(([resolved, lead]) => lead ? null : {
      item: resolved,
      exchangeId: exchange.exchangeId,
      targetSessionId: exchange.targetSessionId,
      noticeKey: openKey,
    }))
  }

  /** The notice's cause is over: take it back if the sender has not read it. */
  private withdrawNotice(exchange: Exchange, key: string): void {
    const at = exchange.notices.indexOf(key)
    if (at === -1) return
    exchange.notices.splice(at, 1)
    const openKey = `${exchange.senderSessionId}:${exchange.targetSessionId}:${key}`
    if (!this.openNotices.delete(openKey)) return
    this.delivery.withdraw(exchange.senderSessionId, openKey)
  }
}

/** The card's first sight of a message to an existing session. */
