import { HandoffCarryStore } from '../../data/sessions/handoff-carry-store'
import { buildHandoff } from '../agents/session-handoff'
import { getIndexedSession } from '../../db/session-indexer'
import { withAsyncTx } from '../../db'
import { beginSessionHandoff, cancelProvisionalSessionHandoff, resolveSessionLineageById } from '../../data/sessions/session-lineage'
import type { AgentId, SessionProviderSwitchResult, SessionRunInput, SessionStatus } from '@solus/contracts/types'
import { isSessionBusyStatus } from '@solus/contracts/types'
import { DEFAULT_EXECUTION_PREFERENCES } from '@solus/contracts/settings'
import { AUTO_MODEL_ID } from '@solus/contracts/model-routing'
import { type Actor } from '../../admission/actor'
import type { ActivityKind } from '@solus/contracts/activity'
import type { SessionRuntime, SessionRunRequest } from '../session-runtime'

export interface PendingSessionHandoff {
  fromProvider: AgentId
  fromSessionId: string
}

/**
 * A session moving from one provider to another: the provisional handoff
 * and the public text an incomplete turn carries into it.
 */
export class ProviderHandoffs {
  /** Sessions whose durable lineage showed no provisional handoff. Only this plane begins one, and it records it in `pendingHandoffs` first. */
  private sessionsWithoutPendingHandoff = new Set<string>()
  readonly handoffCarry: HandoffCarryStore
  pendingHandoffs = new Map<string, PendingSessionHandoff>()
  readonly handoffBuilder: typeof buildHandoff

  constructor(private readonly rt: SessionRuntime, handoffBuilder: typeof buildHandoff, carryDirectory: string | undefined) {
    this.handoffBuilder = handoffBuilder
    this.handoffCarry = new HandoffCarryStore(carryDirectory)
  }

  /** Restore a provisional handoff after a server restart. The SQLite chain is
   * authoritative; the map only avoids repeating the lookup while this host runs. */
  pendingHandoffFor(sessionId: string): PendingSessionHandoff | undefined {
    const inMemory = this.pendingHandoffs.get(sessionId)
    if (inMemory) return inMemory
    if (this.sessionsWithoutPendingHandoff.has(sessionId)) return undefined
    const handoff = resolveSessionLineageById(sessionId)
    const activeMember = handoff?.active
    const previousMember = handoff?.members.at(-2)
    if (activeMember?.providerSessionId !== null || !previousMember?.providerSessionId) {
      this.sessionsWithoutPendingHandoff.add(sessionId)
      return undefined
    }
    const restored = {
      fromProvider: previousMember.provider,
      fromSessionId: previousMember.providerSessionId,
    }
    this.pendingHandoffs.set(sessionId, restored)
    return restored
  }

  /**
   * The send-time handoff (plans/021): a prompt whose provider differs from the
   * thread provider hands the session to that provider right before the prompt
   * runs, so no provisional member waits between a pick and a send. A prompt on
   * the thread provider, a model change inside one provider, a fork, and a
   * session with no provider thread change nothing here.
   */
  async handOffForPrompt(request: SessionRunRequest, actor: Actor): Promise<void> {
    const { sessionId, input } = request
    // Auto selects a model only for a new session; a fork has its own source check.
    if (input.forked || input.preferredModel === AUTO_MODEL_ID) return
    const pending = this.pendingHandoffFor(sessionId)
    if (pending) return this.continueProvisionalHandoff(request, pending, actor)
    const thread = this.threadOf(sessionId, input.agentSessionId)
    if (!thread || thread.provider === input.provider) return
    const { threadId } = thread
    await this.assertHandoffFits(threadId, thread.provider, input, request.options.prompt, this.rt.activeSessions.get(sessionId)?.status)
    // A session record write still open on the connection (its status just
    // changed) would refuse the lineage's own transaction. Let it finish first.
    await withAsyncTx(async () => {})
    await this.switchSessionProvider(sessionId, input.provider, threadId, actor, { atSend: true, model: input.model || undefined })
  }

  /** The session's provider thread and its provider: the live one, else the lineage's, else the one the sender knew. */
  private threadOf(sessionId: string, knownThreadId: string | null): { threadId: string; provider: AgentId } | null {
    const session = this.rt.activeSessions.get(sessionId)
    if (session?.agentSessionId) return { threadId: session.agentSessionId, provider: session.backendId }
    const lineage = resolveSessionLineageById(sessionId)?.active
    if (lineage?.providerSessionId) return { threadId: lineage.providerSessionId, provider: lineage.provider }
    const provider = knownThreadId ? getIndexedSession(knownThreadId)?.provider : undefined
    return knownThreadId && provider ? { threadId: knownThreadId, provider } : null
  }

  /**
   * A provisional member from before plans/021 (or a plan acceptance). A prompt
   * on its provider starts it as before; a prompt on the provider it left takes
   * the session back. Any other provider is refused at launch.
   */
  private async continueProvisionalHandoff(request: SessionRunRequest, pending: PendingSessionHandoff, actor: Actor): Promise<void> {
    const { sessionId, input } = request
    if (input.provider !== pending.fromProvider) return
    await withAsyncTx(async () => {})
    const restored = await this.switchSessionProvider(sessionId, input.provider, pending.fromSessionId, actor, { atSend: true })
    // The prompt continues the thread it was handed back, even when its sender knew no thread.
    request.input = { ...input, agentSessionId: restored.restoredSessionId ?? pending.fromSessionId }
    request.target = { kind: 'session', sessionId }
  }

  /** Builds the handoff once to check that it fits the incoming model before the switch is committed. */
  async assertHandoffFits(threadId: string, sourceProvider: AgentId, target: SessionRunInput, nextPrompt: string, status: SessionStatus | undefined): Promise<void> {
    await this.handoffBuilder(threadId, target.projectPath, {
      loadSession: async (id, path) => this.handoffCarry.merge(id, await this.rt.history.loadSession(sourceProvider, id, path)),
      fromProvider: sourceProvider, targetProvider: target.provider, targetModel: target.model,
      contextWindow: target.contextWindow, nextPrompt: nextPrompt + target.extraInstructions,
      historyTokens: target.executionPreferences?.handoffHistoryTokens ?? DEFAULT_EXECUTION_PREFERENCES.handoffHistoryTokens,
      sourceStatus: this.handoffCarry.get(threadId)?.status ?? status,
    })
  }

  /** `knownAgentSessionId` is the client's view of the provider thread. A
   *  session only has a record here while a runtime is attached, so an idle
   *  conversation — one whose process exited, or one restored after a restart —
   *  has none, and the caller is the only holder of the thread to hand off.
   *  The switch is recorded as `agent_switched` activity (plans/012 §5), at the
   *  lineage member's start so the lineage read shows it once.
   *  `atSend` is the send-time handoff: the prompt that asks for it is already
   *  past the queue, and on a rate-limited session it abandons the parked prompt. */
  async switchSessionProvider(sessionId: string, newProvider: AgentId, knownAgentSessionId: string | null | undefined, actor: Actor,
    options: { atSend?: boolean; model?: string } = {}): Promise<SessionProviderSwitchResult> {
    const session = this.rt.activeSessions.get(sessionId)

    const pendingHandoff = this.pendingHandoffFor(sessionId)
    if (pendingHandoff && newProvider === pendingHandoff.fromProvider) {
      const fromProvider = session?.backendId ?? newProvider
      cancelProvisionalSessionHandoff(sessionId)
      this.pendingHandoffs.delete(sessionId)
      if (session) {
        session.backendId = newProvider
        session.agentSessionId = pendingHandoff.fromSessionId
      }
      this.rt.agentSessionToSession.set(pendingHandoff.fromSessionId, sessionId)
      this.rt.statuses.setStatus(sessionId, 'idle')
      const result: SessionProviderSwitchResult = {
        fromProvider,
        fromSessionId: pendingHandoff.fromSessionId,
        restoredSessionId: pendingHandoff.fromSessionId,
        handoffFrom: session?.handoffFrom,
      }
      await this.rt.recordActivity({ kind: 'session', id: sessionId }, actor, { kind: 'agent_switched', provider: newProvider, fromProvider })
      return result
    }

    const oldAgentSessionId = session?.agentSessionId ?? knownAgentSessionId
    if (!oldAgentSessionId) throw new Error(`Session ${sessionId} has no provider thread to switch`)

    const indexedSession = getIndexedSession(oldAgentSessionId)
    const fromProvider = session?.backendId ?? indexedSession?.provider
    if (!fromProvider) {
      throw new Error(`Session ${oldAgentSessionId} has no provider information for a handoff`)
    }
    if (fromProvider === newProvider) {
      throw new Error(`Session ${oldAgentSessionId} already uses ${newProvider}`)
    }
    this.rt.backendFor(newProvider)
    const status = session?.status ?? 'idle'
    const isRateLimited = status === 'rate_limited'
    if (isSessionBusyStatus(status) && !isRateLimited) {
      throw new Error(`Session ${oldAgentSessionId} must be idle before switching providers (current status: ${status})`)
    }
    const queuedRequests = this.rt.scheduler.requestQueue.get(sessionId) ?? []
    const hasNonRateLimitedQueue = queuedRequests.some(
      (request) => request.rateLimitSessionId !== sessionId,
    )
    if (!options.atSend && !this.rt.scheduler.applyingQueuedSwitch.has(sessionId) && (hasNonRateLimitedQueue || (!isRateLimited && queuedRequests.length > 0))) {
      throw new Error(`Session ${oldAgentSessionId} has queued prompts and cannot switch providers`)
    }

    if (isRateLimited) {
      // Switching providers abandons only the prompt parked by the exhausted
      // provider. Clear that provider's reset state before detaching the session
      // so the renderer sees the card and queued prompt disappear.
      this.rt.rateLimitPark.clearRateLimitTimer(sessionId)
      this.rt.rateLimitPark.rateLimits.clear(sessionId)
      if (!this.rt.scheduler.applyingQueuedSwitch.has(sessionId)) this.rt.rateLimitPark.rejectRateLimitQueue(sessionId, new Error('Provider switched'))
      else {
        for (const entry of this.rt.scheduler.requestQueue.get(sessionId) ?? []) {
          if (entry.reason !== 'rate_limit') continue
          entry.reason = 'busy'
          entry.rateLimitSessionId = undefined
          entry.releaseAt = undefined
          entry.rateLimitType = undefined
          entry.revision = (entry.revision ?? 0) + 1
        }
        this.rt.scheduler.requestQueue.save(sessionId)
      }
      this.rt.activeRunRequests.delete(sessionId)
      this.rt.rateLimitPark.broadcastRateLimitResolved(sessionId, 'stop')
      this.rt.statuses.setStatus(sessionId, 'idle')
    }

    // Swap the session over immediately — the actual transcript/summary handoff
    // is built lazily in launchRun, right before the next prompt starts the new
    // provider's session, so the switch itself never blocks on an LLM call.
    const handoff = beginSessionHandoff({
      sessionId,
      sourceProvider: fromProvider,
      sourceProviderSessionId: oldAgentSessionId,
      targetProvider: newProvider,
      cwd: session?.runInput?.workingDirectory ?? indexedSession?.cwd ?? '~',
    })
    this.pendingHandoffs.set(sessionId, { fromProvider, fromSessionId: oldAgentSessionId })
    // Clear the sidebar's view of the old thread before replacing the provider endpoint.
    this.rt.emit('session-status', {
      sessionId,
      agentSessionId: oldAgentSessionId,
      status: 'idle',
      at: Date.now(),
    })
    if (session) {
      this.rt.statuses.setStatus(sessionId, 'idle')
      session.backendId = newProvider
      session.agentSessionId = null
    }
    const switched: Extract<ActivityKind, { kind: 'agent_switched' }> = { kind: 'agent_switched', provider: newProvider, fromProvider }
    if (options.model) switched.model = options.model
    const fromModel = indexedSession?.model ?? session?.runInput?.preferredModel
    if (fromModel) switched.fromModel = fromModel
    await this.rt.recordActivity({ kind: 'session', id: sessionId }, actor, switched, handoff.active.startedAt)

    return {
      fromProvider,
      fromSessionId: oldAgentSessionId,
    }
  }
}
