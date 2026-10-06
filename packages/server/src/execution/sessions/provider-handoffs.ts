import { HandoffCarryStore } from '../../data/sessions/handoff-carry-store'
import { buildHandoff } from '../agents/session-handoff'
import { getIndexedSession } from '../../db/session-indexer'
import { beginSessionHandoff, cancelProvisionalSessionHandoff, resolveSessionLineageById } from '../../data/sessions/session-lineage'
import type { AgentId, SessionProviderSwitchResult } from '@solus/contracts/types'
import { isSessionBusyStatus } from '@solus/contracts/types'
import { type Actor } from '../../admission/actor'
import type { ActivityKind } from '@solus/contracts/activity'
import type { SessionRuntime } from '../session-runtime'

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

  /** `knownAgentSessionId` is the client's view of the provider thread. A
   *  session only has a record here while a runtime is attached, so an idle
   *  conversation — one whose process exited, or one restored after a restart —
   *  has none, and the caller is the only holder of the thread to hand off.
   *  The switch is recorded as `agent_switched` activity (plans/012 §5), at the
   *  lineage member's start so the lineage read shows it once. */
  async switchSessionProvider(sessionId: string, newProvider: AgentId, knownAgentSessionId: string | null | undefined, actor: Actor): Promise<SessionProviderSwitchResult> {
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
    if (!this.rt.scheduler.applyingQueuedSwitch.has(sessionId) && (hasNonRateLimitedQueue || (!isRateLimited && queuedRequests.length > 0))) {
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
    const fromModel = indexedSession?.model ?? session?.runInput?.preferredModel
    if (fromModel) switched.fromModel = fromModel
    await this.rt.recordActivity({ kind: 'session', id: sessionId }, actor, switched, handoff.active.startedAt)

    return {
      fromProvider,
      fromSessionId: oldAgentSessionId,
    }
  }
}
