import { hostPolicies } from '../../host/policy/host-policy-store'
import { organizationOfSession } from '../../data/sessions/session-records'
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
import type { DelegatedRequest } from '@solus/contracts/session-execution'
import type {
  AgentConversationUpdate,
  AgentId,
  ExchangeProgress,
  HeadlessPromptRequest,
  HeadlessSessionRequest,
  NormalizedEvent,
  SessionMeta,
} from '@solus/contracts/types'
import { planKey } from '@solus/contracts/types'
import { attributionOf, type Actor } from '../../admission/actor'
import { createLogger } from '../../logger'
import { describePendingInput, type PendingInputDescription } from '../sessions/pending-input'
import { applyExchangeEvent, isOpenExchange, senderSessionOf, type Exchange, type ExchangeEvent } from './exchange'
import { recordPlanDecision } from './plan-decisions'
import { addOutput, answerText, outputFromEvent, outputsFromAnswer, type ResolvedInput } from './session-outputs'
import { ParentDelivery } from './parent-delivery'
import type { RemoteHost } from './remote-hosts'
import { followRemoteRun } from './remote-runs'
import { attachToPrompt, uploadTo } from './prompt-attachments'
import { storeAttachment } from '../../data/assets/attachment-store'

const log = createLogger('orchestration', 'session-orchestrator.ts')

type PendingPlan = Extract<PendingInputDescription, { kind: 'plan' }>

const IMPLEMENT_PREFIX = 'Implement this plan:\n\n'
// The same copy a person's Revise sends in the session's own tab, so a decision
// taken in either place reads identically in the target's transcript.
const REVISION_PREFIX = 'Please revise the plan with these comments:\n\n'
export { CHILD_INTERRUPTED_BY_RESTART } from './exchange-reports'
import { CHILD_INTERRUPTED_BY_RESTART } from './exchange-reports'
import { copyRemoteSessionTree } from './remote-session-copies'
import { getSessionRecord } from '../../data/sessions/session-records'
import { ANY_ORGANIZATION } from '../../admission/principal'
const NO_REPLY = '(no final assistant reply available)'

import { MAX_WAIT_MS, type RunExchanges, type SettledRun, type SpawnOrder, type SendOrder, type PromptOrder, type OrchestratedRuntime, type OrchestratorDeps, type SpawnedSession, type RemoteTarget, type PromptDisposition, type SentMessage } from './session-orders'
export * from './session-orders'

/** What a send tells its sender: what the message became, and why it waits. */
function sentMessage(exchangeId: string, result: PromptDisposition, rateLimitReleased: boolean | undefined, waited: OrchestrationItem | null | undefined): SentMessage {
  const sent: SentMessage = { exchangeId, disposition: result.disposition }
  if (result.rateLimitHold) sent.rateLimitHold = result.rateLimitHold
  if (rateLimitReleased !== undefined) sent.rateLimitReleased = rateLimitReleased
  if (waited !== undefined) sent.waited = waited
  return sent
}

/** The sidebar's order for what waits on the person: lower is louder. */
const REQUEST_RANK: Record<DelegatedRequest, number> = { permission: 0, question: 1, plan: 2 }

/** What the exchange's target turn waits on the person for, while it waits.
 *  An independent session has its own row, so its request is never its sender's. */
function waitingRequestOf(exchange: Exchange): DelegatedRequest | undefined {
  return exchange.kind !== 'independent' && exchange.state === 'awaiting_input' ? exchange.request?.kind : undefined
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
  /** Exchange → the target host whose session it follows, until it settles. */
  private readonly remoteFollows = new Map<string, { host: RemoteHost; stop: () => void }>()
  /** Target session → its last run that ended with background work still
   *  running. That run's exchanges stay open: the turn the finished work wakes
   *  answers them, or they settle with this run when the work ends without one. */
  private readonly backgroundRuns = new Map<string, SettledRun>()

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
      starting: exchange.state === 'dispatched', waited }
  }

  private async repeatedSend(exchange: Exchange, waitMs: number): Promise<SentMessage> {
    return { exchangeId: exchange.exchangeId, disposition: exchange.disposition ?? 'queued',
      waited: exchange.report ? { type: 'report', report: exchange.report }
        : waitMs > 0 ? await this.waitOn(exchange, waitMs) : undefined }
  }

  // ─── Commands ───

  /** Starts a new session running `order.prompt`. With a sender, the message is
   *  an exchange and the child is recorded as the sender's delegate; with
   *  `report`, the sender hears its notices and its result. An outside app's
   *  requester key is a sender with no session: the new session is nobody's
   *  delegate. With `target`, the session runs on that host instead of this one. */
  async spawn(
    sender: string | undefined,
    order: SpawnOrder,
    report: boolean,
    waitMs = 0,
    requestId?: string,
    target?: RemoteTarget,
  ): Promise<SpawnedSession> {
    // The stored delegation keeps the intent names it has always had.
    const intent = report ? 'delegate' : 'fire_and_forget'
    const identity = this.ledger.identify(sender, requestId, JSON.stringify({ kind: 'create', order, report, hostId: target?.host.hostId }))
    if (identity.existing) return this.repeatedSpawn(identity.existing, waitMs)
    const senderSessionId = sender ? senderSessionOf(sender) : undefined
    const { exchangeId } = identity
    const dispatchedAt = Date.now()
    // The new session's id is chosen now, so the sender's card names it from the start.
    const targetSessionId = order.sessionId ?? randomUUID()
    const exchange = this.openSpawn(sender, targetSessionId, order, report, identity, dispatchedAt, target?.host)
    const waited = exchange && waitMs > 0 ? this.waitOn(exchange, waitMs) : undefined

    const starting = target ? this.startRemote(target, order, exchangeId, targetSessionId, exchange, senderSessionId) : (async (): Promise<SpawnedSession> => {
      try {
        const { attachments, independent, ...rest } = order
        // Without files the start is not deferred: the session starts in this tick.
        const attached = attachments?.length ? await attachToPrompt(order.prompt, attachments, storeAttachment, exchangeId) : {}
        const started = await this.runtime.createSession({
          ...rest,
          ...attached,
          sessionId: targetSessionId,
          exchangeIds: exchange ? [exchangeId] : undefined,
          sourceSessionId: senderSessionId,
          delegation: senderSessionId && !independent
            ? { parentSessionId: senderSessionId, messageId: exchangeId, intent, createdAt: dispatchedAt }
            : undefined,
        })
        if (exchange) this.attach(exchange, this.runtime.sessionMeta(started.sessionId)?.cwd)
        if (exchange) this.ledger.update(exchange, (draft) => { draft.disposition = 'started' })
        if (senderSessionId) this.recordStartedSession(senderSessionId, order.title || order.prompt, started)
        return { exchangeId, sessionId: started.sessionId }
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
      starting: exchange.state === 'dispatched', waited: result }
  }

  /** Starts the session on another host, as its owner would from a client
   *  there, and follows its run with the hooks a local run calls. The watch
   *  comes first, so a turn that ends at once is not missed. */
  private async startRemote(
    target: RemoteTarget,
    order: SpawnOrder,
    exchangeId: string,
    targetSessionId: string,
    exchange: Exchange | null,
    senderSessionId: string | undefined,
  ): Promise<SpawnedSession> {
    const { host } = target
    const follow = exchange
      ? followRemoteRun(host, { runId: `remote:${exchangeId}`, sessionId: targetSessionId, exchangeIds: [exchangeId] }, order.provider, this)
      : null
    // A delegate is in its sender's tree, so this host keeps a copy of it.
    const stopCopy = follow && senderSessionId && !order.independent ? copyRemoteSessionTree(host, targetSessionId, senderSessionId) : null
    if (follow) this.remoteFollows.set(exchangeId, { host, stop: () => { follow.stop(); stopCopy?.() } })
    const request: HeadlessSessionRequest = {
      sessionId: targetSessionId,
      prompt: order.prompt,
      provider: order.provider,
      modelId: order.modelId,
      reasoningEffort: order.reasoningEffort,
      contextWindow: order.contextWindow,
      cwd: order.cwd,
      permissionMode: order.permissionMode,
    }
    // An outside app's work names no session: that host records the person who started it.
    if (target.origin) request.startedBy = target.origin
    if (order.worktreeBaseBranch) request.worktreeBaseBranch = order.worktreeBaseBranch
    if (order.title) request.title = order.title
    try {
      // A child works for its parent's organization; host B admits it as a prompt in that organization.
      const organizationId = senderSessionId ? await this.runtime.turnOrganization(senderSessionId) : undefined
      if (organizationId) request.organizationId = organizationId
      // The target host gets the full record of the codebase: it has no other way to read it (docs/plans/codebases.md §6).
      const codebase = order.codebaseId ? await this.runtime.codebase(order.codebaseId, senderSessionId) : null
      if (codebase) request.codebase = codebase
      await follow?.watching
      Object.assign(request, await attachToPrompt(order.prompt, order.attachments, uploadTo(host), exchangeId))
      await host.call('the session start', () => host.api.createHeadlessSession(request))
    } catch (error) {
      if (exchange) this.settle(exchange, 'failed', `Session startup on ${host.label} failed: ${error instanceof Error ? error.message : String(error)}`)
      throw error
    }
    log.info('remote_session_started', { exchangeId, sessionId: targetSessionId, hostId: host.hostId })
    if (exchange && isOpenExchange(exchange)) this.ledger.update(exchange, (draft) => { draft.disposition = 'started' })
    return { exchangeId, sessionId: targetSessionId }
  }

  private openSpawn(
    sender: string | undefined, targetSessionId: string,
    order: SpawnOrder, report: boolean,
    identity: ExchangeIdentity, dispatchedAt: number, targetHost?: RemoteHost,
  ): Exchange | null {
    const { exchangeId, fingerprint } = identity
    const exchange = sender
      ? this.open({
          exchangeId,
          kind: order.independent ? 'independent' : 'create',
          senderSessionId: sender,
          targetSessionId,
          targetHostId: targetHost?.hostId,
          provider: order.provider,
          notify: report,
          dispatchedAt, fingerprint,
          parentExchangeIds: this.parentExchangeIdsOf(sender, report && !order.independent),
        })
      : null
    if (exchange) {
      const dispatched: AgentConversationUpdate = {
        phase: 'dispatched',
        sessionId: exchange.targetSessionId,
        messageId: exchangeId,
        origin: 'created',
        prompt: order.prompt,
        provider: order.provider,
        title: order.title || promptTitle(order.prompt),
        cwd: order.cwd,
        model: order.modelId,
        reasoningEffort: order.reasoningEffort,
        fireAndForget: !report,
        dispatchedAt,
      }
      // A client opens the session on the host it runs on.
      if (targetHost) dispatched.serverId = targetHost.installationId
      this.publish(exchange, dispatched)
    }
    return exchange
  }

  /** Sends one message to an existing session. The sender's card shows it before
   *  the target can answer, and the result comes back under the same id. With
   *  `target`, the session runs on that host: one the sender started there. */
  async send(
    senderSessionId: string,
    targetSessionId: string,
    message: SendOrder,
    target?: RemoteTarget,
  ): Promise<SentMessage> {
    if (targetSessionId === senderSessionId) throw new Error('Cannot message your own session.')
    const meta = target ? null : await this.localSessionMeta(targetSessionId)
    // Refused before the card shows it: there is nothing to send it to.
    if (!target && !meta) throw new Error(`Session ${targetSessionId} not found.`)
    const provider = meta?.provider ?? this.remoteProviderOf(senderSessionId, targetSessionId, target!.host)
    const { waitMs: _waitMs, requestId: retryId, ...request } = message
    const identity = this.ledger.identify(senderSessionId, retryId, JSON.stringify({ kind: 'prompt', targetSessionId, hostId: target?.host.hostId, request }))
    if (identity.existing) return this.repeatedSend(identity.existing, message.waitMs ?? 0)
    const { exchangeId, fingerprint } = identity
    const parentExchangeIds = this.parentExchangeIdsOf(senderSessionId, message.notify)
    if (this.ledger.isAncestor(parentExchangeIds, targetSessionId)) {
      throw new Error('A request cannot wait for its own ancestor. Use report=false for an update to the sender.')
    }
    // Stopped before this message opens: the stop settles the sender's earlier
    // messages to the target, never this one, which runs when the turn exits.
    if (message.restart) this.stop(senderSessionId, targetSessionId)
    const dispatchedAt = Date.now()
    const exchange = this.open({
      exchangeId,
      kind: 'prompt',
      senderSessionId,
      targetSessionId,
      targetHostId: target?.host.hostId,
      provider,
      notify: message.notify,
      dispatchedAt, fingerprint, parentExchangeIds,
    })
    const waited = message.waitMs && message.waitMs > 0 ? this.waitOn(exchange, message.waitMs) : undefined
    this.publish(exchange, promptedUpdate(exchange, meta, message, target?.host.installationId))
    try {
      // Released first: the held prompt runs, and this message waits behind it as for any busy session.
      const rateLimitReleased = message.releaseRateLimit ? this.releaseRateLimit(senderSessionId, targetSessionId) : undefined
      const result = target ? await this.promptThere(exchange, message, target.host) : await this.promptHere(exchange, message)
      this.ledger.update(exchange, (draft) => { draft.disposition = result.disposition })
      return sentMessage(exchangeId, result, rateLimitReleased, await waited)
    } catch (error) {
      this.settleUnaccepted(exchange)
      throw error
    }
  }

  /** A session on this host: from the index, else from its record (a fork that no turn has run in). */
  private async localSessionMeta(sessionId: string): Promise<SessionMeta | null> {
    return this.runtime.sessionMeta(sessionId) ?? await this.runtime.recordedSessionMeta?.(sessionId) ?? null
  }

  /** The provider of a session the sender started on `host`; only such a session is reachable there. */
  private remoteProviderOf(senderSessionId: string, targetSessionId: string, host: RemoteHost): AgentId {
    const started = [...this.exchanges.values()].find((exchange) =>
      exchange.senderSessionId === senderSessionId && exchange.targetSessionId === targetSessionId && exchange.targetHostId === host.hostId)
    if (!started) throw new Error(`Session ${targetSessionId} was not started on ${host.label} by this session.`)
    return started.provider
  }

  private async promptHere(exchange: Exchange, message: SendOrder): Promise<PromptDisposition> {
    const order: PromptOrder = { exchangeIds: [exchange.exchangeId], senderSessionId: senderSessionOf(exchange.senderSessionId) }
    if (message.permissionMode) order.permissionMode = message.permissionMode
    if (message.model) order.model = message.model
    if (!message.attachments?.length) return this.runtime.promptSession(exchange.targetSessionId, message.prompt, message.delivery, order)
    const { prompt, imageAttachmentRefs } = await attachToPrompt(message.prompt, message.attachments, storeAttachment, exchange.exchangeId)
    if (imageAttachmentRefs) order.imageAttachmentRefs = imageAttachmentRefs
    return this.runtime.promptSession(exchange.targetSessionId, prompt, message.delivery, order)
  }

  /** Host B's events drive the hooks a local run calls, from the turn that
   *  answers this message: the follow waits for host B to echo it under the
   *  exchange id. */
  private async promptThere(exchange: Exchange, message: SendOrder, host: RemoteHost): Promise<PromptDisposition> {
    const { exchangeId, targetSessionId } = exchange
    const follow = followRemoteRun(host, { runId: `remote:${exchangeId}`, sessionId: targetSessionId, exchangeIds: [exchangeId] }, exchange.provider, this, exchangeId)
    // A delegate this host keeps a copy of stays current while the message runs.
    const parentSessionId = (await getSessionRecord(ANY_ORGANIZATION, targetSessionId))?.parentSessionId
    const stopCopy = parentSessionId ? copyRemoteSessionTree(host, targetSessionId, parentSessionId) : null
    this.remoteFollows.set(exchangeId, { host, stop: () => { follow.stop(); stopCopy?.() } })
    await follow.watching
    const request: HeadlessPromptRequest = {
      sessionId: targetSessionId,
      delivery: message.delivery,
      promptId: exchangeId,
      ...await attachToPrompt(message.prompt, message.attachments, uploadTo(host), exchangeId),
    }
    const result = await host.call('the prompt', () => host.api.promptHeadlessSession(request))
    if (result.queueId) follow.queuedAs(result.queueId)
    log.info('remote_session_prompted', { exchangeId, sessionId: targetSessionId, hostId: host.hostId, disposition: result.disposition })
    return result
  }

  /** Releases the rate-limit hold of a session on this host for the sender, as
   *  the person's Send now does: its held prompts run now. False when no limit holds it. */
  releaseRateLimit(senderSessionId: string, targetSessionId: string): boolean {
    if (targetSessionId === senderSessionId) return false
    const released = this.runtime.releaseRateLimit(targetSessionId, senderSessionOf(senderSessionId))
    log.info('session_rate_limit_released', { sessionId: targetSessionId, senderSessionId, released })
    return released
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
    const remote = marked.map((exchangeId) => this.remoteFollows.get(exchangeId)?.host).find((host) => host !== undefined)
    if (remote) {
      // The stopped turn settles through the follow, as interrupted.
      void remote.call('the stop', () => remote.api.stopSession(targetSessionId)).catch((error) => {
        for (const exchangeId of marked) this.stoppedBySender.delete(exchangeId)
        log.warn('remote_stop_failed', { sessionId: targetSessionId, hostId: remote.hostId, error: String(error) })
      })
      return true
    }
    const stopped = this.runtime.stopSession(targetSessionId, senderSessionId ? senderSessionOf(senderSessionId) : undefined)
    // Nothing stopped: a later result is not the sender's own doing.
    if (!stopped) for (const exchangeId of marked) this.stoppedBySender.delete(exchangeId)
    return stopped
  }

  /** The sessions `parentSessionId` started that still do work for it: a
   *  session it created, with a message from it still open. A child that
   *  finished its parent's work is not one, even if it runs again for a person. */
  childrenAtWork(parentSessionId: string): string[] {
    const created = new Set<string>()
    for (const exchange of this.exchanges.values()) {
      if (exchange.kind === 'create' && exchange.senderSessionId === parentSessionId) created.add(exchange.targetSessionId)
    }
    const children = new Set<string>()
    for (const exchange of this.exchanges.values()) {
      if (exchange.senderSessionId === parentSessionId && created.has(exchange.targetSessionId) && isOpenExchange(exchange)) {
        children.add(exchange.targetSessionId)
      }
    }
    return [...children]
  }

  /** A person stopped the parent: each child stops for it, and the children
   *  each one started stop in turn. A child's own children are read before
   *  its stop settles the messages that name them. */
  stopChildren(parentSessionId: string, childSessionIds: readonly string[], seen = new Set([parentSessionId])): void {
    for (const childSessionId of childSessionIds) {
      if (seen.has(childSessionId)) continue
      seen.add(childSessionId)
      const grandchildren = this.childrenAtWork(childSessionId)
      log.info('session_child_stopped_with_parent', { sessionId: childSessionId, parentSessionId })
      this.stop(parentSessionId, childSessionId)
      this.stopChildren(childSessionId, grandchildren, seen)
    }
  }

  /** The host the sender's session `targetSessionId` runs on, when it is not this host. */
  remoteHostOf(senderSessionId: string, targetSessionId: string): string | undefined {
    for (const exchange of this.exchanges.values()) {
      if (exchange.senderSessionId !== senderSessionId || exchange.targetSessionId !== targetSessionId || !exchange.targetHostId) continue
      return this.remoteFollows.get(exchange.exchangeId)?.host.label ?? exchange.targetHostId
    }
    return undefined
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
    if (!senderSessionOf(senderSessionId) || !this.contacts.get(senderSessionId)?.has(targetSessionId)) return false
    const pending = this.pendingPlan(targetSessionId)
    if (!pending) return false
    const note = comment?.trim() ?? ''
    if (decision === 'request_changes' && !note) return false
    const decided = decision === 'approve'
      ? await this.approvePlan(pending, senderSessionId, targetSessionId)
      : await this.requestPlanChanges(pending, note, senderSessionId, targetSessionId)
    if (!decided) return false
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

  /** The plan the target's turn is waiting on. */
  private pendingPlan(targetSessionId: string): PendingPlan | null {
    const held = describePendingInput(this.runtime.pendingInputEvents(targetSessionId))
    return held?.kind === 'plan' ? held : null
  }

  private async approvePlan(pending: PendingPlan, senderSessionId: string, targetSessionId: string): Promise<boolean> {
    if (pending.blocking) {
      return !!pending.allowOptionId && this.runtime.respondToPermission(targetSessionId, pending.questionId, pending.allowOptionId)
    }
    await this.send(senderSessionId, targetSessionId, {
      prompt: `${IMPLEMENT_PREFIX}${pending.planContent}`,
      delivery: 'queue',
      notify: true,
      // Implementation runs with full access, lowered to the target's policy ceiling (plans/030 §6.3).
      permissionMode: hostPolicies().forWork(await organizationOfSession(targetSessionId)).clampMode('full-access'),
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
        senderSessionId: waiting[0] && senderSessionOf(waiting[0].senderSessionId),
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
    // An outside app's requester key is never a conversation.
    if (!senderSessionOf(callerSessionId)) return false
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

  /** The model the provider reported running for the latest settled message to `targetSessionId`. */
  executedModelOf(targetSessionId: string): string | undefined {
    let latest: Exchange | undefined
    for (const exchange of this.exchanges.values()) {
      if (exchange.targetSessionId !== targetSessionId || !exchange.report?.executedModel) continue
      if (!latest || (exchange.settledAt ?? 0) > (latest.settledAt ?? 0)) latest = exchange
    }
    return latest?.report?.executedModel
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
    const output = outputFromEvent(event, run.sessionId)
    if (!output) return
    for (const exchange of this.exchangesOf(run)) addOutput(exchange.outputs, output)
  }

  /** The single settlement point: the run's turn ended. */
  runSettled(run: SettledRun): void {
    const exchanges = this.exchangesOf(run).filter((exchange) =>
      isOpenExchange(exchange) && !exchange.revising && (!exchange.runId || exchange.runId === run.runId))
    if (!exchanges.length) return
    const waitsOnBackground = run.outcome === 'completed' && !!run.hasBackgroundWork
    if (waitsOnBackground) this.backgroundRuns.set(run.sessionId, run)
    const ready = exchanges.filter((exchange) => {
      if (run.outcome !== 'completed' || (!waitsOnBackground && !this.ledger.hasChildren(exchange.exchangeId))) return true
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

  /** The exchanges a target's background work holds open, for the turn its
   *  finished work wakes: that turn's reply answers them. */
  backgroundExchangeIds(targetSessionId: string): string[] {
    const run = this.backgroundRuns.get(targetSessionId)
    return run ? this.heldForBackground(run).map((exchange) => exchange.exchangeId) : []
  }

  /** A target's background work ended and no wake turn took its exchanges:
   *  the run that left the work running answers them. */
  backgroundEnded(targetSessionId: string): void {
    const run = this.backgroundRuns.get(targetSessionId)
    if (!run) return
    this.backgroundRuns.delete(targetSessionId)
    const ready = this.heldForBackground(run).filter((exchange) => !this.ledger.hasChildren(exchange.exchangeId))
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

  /** A sender still waits on a reply its model will be woken for. After its
   *  turn ends, this holds it in 'background' (docs/background-work.md). */
  isAwaitingReplies(senderSessionId: string): boolean {
    for (const exchange of this.exchanges.values()) {
      if (exchange.kind !== 'independent' && exchange.senderSessionId === senderSessionId && exchange.notify && isOpenExchange(exchange)) return true
    }
    return false
  }

  /** What a session that `sessionId` started, at any depth, waits on the
   *  person for: the request its card in this conversation shows. A permission
   *  outranks a question, and a question a plan, as the sidebar ranks them.
   *  An independent session has its own row, so it is left out. */
  delegatedRequestOf(sessionId: string, seen = new Set([sessionId])): DelegatedRequest | undefined {
    let found: DelegatedRequest | undefined
    for (const exchange of this.exchanges.values()) {
      if (exchange.kind === 'independent' || exchange.senderSessionId !== sessionId || !isOpenExchange(exchange)) continue
      const target = exchange.targetSessionId
      let request = waitingRequestOf(exchange)
      if (!request && target && !seen.has(target)) {
        seen.add(target)
        request = this.delegatedRequestOf(target, seen)
      }
      if (request && (!found || REQUEST_RANK[request] < REQUEST_RANK[found])) found = request
      if (found === 'permission') return found
    }
    return found
  }

  /** The sender's turn ended: a tool call it left waiting has no reader now.
   *  Its waits end, so a later report goes to the sender's queue and wakes it. */
  senderTurnEnded(senderSessionId: string): void {
    for (const exchange of this.exchanges.values()) {
      if (exchange.senderSessionId === senderSessionId && exchange.wait) this.endWait(exchange, null)
    }
  }

  /** A stopped sender stops waiting: its open messages settle, and nothing is
   *  delivered to it for them. */
  cancelSentBy(senderSessionId: string): boolean {
    let cancelled = false
    for (const exchange of this.exchanges.values()) {
      if (exchange.kind === 'independent' || exchange.senderSessionId !== senderSessionId || !isOpenExchange(exchange)) continue
      this.settle(exchange, 'interrupted', '', { silenced: true })
      cancelled = true
    }
    return cancelled
  }

  // ─── Internals ───

  /** The open requests of a sender session whose work a message is part of,
   *  when the sender asked to hear back. An outside app has no session, so none. */
  private parentExchangeIdsOf(sender: string, notify: boolean): string[] {
    const senderSessionId = senderSessionOf(sender)
    return notify && senderSessionId ? this.runtime.activeExchangeIdsFor(senderSessionId).slice() : []
  }

  private open(fields: Omit<Exchange, 'state' | 'outputs' | 'notices' | 'revising'>): Exchange {
    const exchange: Exchange = { ...fields, state: 'dispatched', outputs: [], notices: [], revising: false }
    this.ledger.open(exchange)
    if (exchange.targetSessionId) this.remember(exchange.senderSessionId, exchange.targetSessionId)
    return exchange
  }

  /** Tells a created session's card where it runs, once its checkout is known. */
  private attach(exchange: Exchange, cwd: string | undefined): void {
    if (exchange.kind === 'prompt' || !cwd) return
    this.publish(exchange, { phase: 'attached', messageId: exchange.exchangeId, sessionId: exchange.targetSessionId, cwd })
  }

  /** A session a child started is something the child's open turns produced. */
  private recordStartedSession(childSessionId: string, title: string, started: { sessionId: string }): void {
    const output: SessionOutput = { kind: 'session', sessionId: started.sessionId, title }
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

  /** The run's exchanges no later turn has taken over. */
  private heldForBackground(run: SettledRun): Exchange[] {
    return this.exchangesOf(run).filter((exchange) =>
      exchange.state === 'waiting_for_children' && !exchange.revising && (!exchange.runId || exchange.runId === run.runId))
  }

  private apply(exchange: Exchange, event: ExchangeEvent): boolean {
    const waitedFor = waitingRequestOf(exchange)
    const changed = this.ledger.apply(exchange, event)
    if (changed) log.debug('exchange_changed', { exchangeId: exchange.exchangeId, event: event.type, state: exchange.state })
    if (changed && waitingRequestOf(exchange) !== waitedFor) this.delegatedRequestChanged(exchange.senderSessionId)
    return changed
  }

  /** A request of a session that `sessionId` started began or stopped waiting:
   *  `sessionId` and every session above it learn of it. */
  private delegatedRequestChanged(sessionId: string, seen = new Set<string>()): void {
    // An outside app has no session row to show the request on.
    if (seen.has(sessionId) || !senderSessionOf(sessionId)) return
    seen.add(sessionId)
    this.runtime.delegatedRequestChanged(sessionId)
    for (const exchange of this.exchanges.values()) {
      if (exchange.kind !== 'independent' && exchange.targetSessionId === sessionId && isOpenExchange(exchange)) {
        this.delegatedRequestChanged(exchange.senderSessionId, seen)
      }
    }
  }

  /** Shows a change on the sender's card. An outside app has no conversation, so no card. */
  private publish(exchange: Pick<Exchange, 'senderSessionId'>, update: AgentConversationUpdate): void {
    const senderSessionId = senderSessionOf(exchange.senderSessionId)
    if (senderSessionId) this.runtime.emit(senderSessionId, { type: 'agent_conversation_update', update })
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
    // A settle ends the wait of the target, and of every session below it.
    const waitedFor = exchange.kind !== 'independent'
      && (waitingRequestOf(exchange) ?? (exchange.targetSessionId ? this.delegatedRequestOf(exchange.targetSessionId) : undefined))
    // The result, its full reply, and its delivery state are one write.
    const changed = this.ledger.update(exchange, (draft) => {
      if (silenced) { draft.notify = false; draft.revising = false }
      if (!applyExchangeEvent(draft, settled)) return false
      const report: SessionReport = {
        messageId: draft.exchangeId,
        sessionId: draft.targetSessionId,
        issueId: taskId,
        provider: draft.provider,
        model: run?.model,
        executedModel: run?.executedModel,
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
    if (waitedFor) this.delegatedRequestChanged(exchange.senderSessionId)
    this.stoppedBySender.delete(exchange.exchangeId)
    this.remoteFollows.get(exchange.exchangeId)?.stop()
    this.remoteFollows.delete(exchange.exchangeId)
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

  /** Sends each settled report as soon as it is ready. */
  private deliverReport(exchange: Exchange, item: OrchestrationItem, hasReport: boolean): void {
    const senderSessionId = senderSessionOf(exchange.senderSessionId)
    // An outside app has no session to wake: it reads the report with read_session_exchange.
    if (!senderSessionId) {
      if (hasReport) this.ledger.markDelivery([exchange.exchangeId], 'disposed')
      return
    }
    const awaitingOthers = this.isAwaitingReplies(senderSessionId)
    if (hasReport) {
      this.delivery.deliver(senderSessionId, {
        exchangeId: exchange.exchangeId,
        targetSessionId: exchange.targetSessionId,
        continuationExchangeIds: exchange.parentExchangeIds,
        item,
      })
    }
    // Asked after the delivery, so a report that wakes the sender has started its turn.
    if (!awaitingOthers) this.delivery.afterDelivered(senderSessionId, () => this.runtime.repliesEnded(senderSessionId))
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
   * the turn answers. Only send notices when the sender asked to hear back.
   */
  private notify(exchange: Exchange, notice: SessionNotice, key: string): void {
    // A sender waiting in its tool call hears it there: the wait ends at once.
    if (this.endWait(exchange, { type: 'notice', notice })) return
    if (!exchange.notify || !senderSessionOf(exchange.senderSessionId)) return
    exchange.notices.push(key)
    const openKey = `${exchange.senderSessionId}:${exchange.targetSessionId}:${key}`
    if (this.openNotices.has(openKey)) return
    this.openNotices.add(openKey)
    const item: Promise<OrchestrationItem> = this.runtime.taskIdFor(exchange.targetSessionId)
      .catch(() => undefined)
      .then((taskId) => ({ type: 'notice', notice: taskId ? { ...notice, issueId: taskId } : notice }))
    this.delivery.deliver(exchange.senderSessionId, item.then((resolved) => ({
      item: resolved,
      exchangeId: exchange.exchangeId,
      targetSessionId: exchange.targetSessionId,
      noticeKey: openKey,
    })))
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
