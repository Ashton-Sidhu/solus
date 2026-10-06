import { createLogger } from '../../logger'
import { contextPreferences } from '../agents/run-input'
import { taskIdForSession } from '../../data/tasks/task-sessions'
import { pendingAsyncQuestions } from '../../data/sessions/async-questions'
import { DEFAULT_EXECUTION_PREFERENCES } from '@solus/contracts/settings'
import { ANY_ORGANIZATION } from '../../admission/principal'
import { getIndexedSession } from '../../db/session-indexer'
import { resolveSessionLineage, resolveSessionLineageById } from '../../data/sessions/session-lineage'
import type { NormalizedEvent, IpcContext, SessionRunInput, RuntimeSessionInfo, WatchSessionInput, WatchSessionResult } from '@solus/contracts/types'
import { sessionActivityStateOf, type SessionActiveTurn, type SessionActivity } from '@solus/contracts/presence'
import { activeTurnFor } from '../../presence/presence-manager'
import type { SessionRuntime } from '../session-runtime'

const log = createLogger('SessionRuntime', 'session-watchers.ts')

/**
 * The clients watching each session, and a client joining a live turn.
 */
export class SessionWatchers {
  /** sessionId → the clients listening to it. A watch has no other fields:
   *  status belongs to the session, and with one id space there is nothing
   *  else left for it to carry. */
  watches = new Map<string, Set<string>>()

  constructor(private readonly rt: SessionRuntime) {}

  /**
   * Resolve identity, then subscribe. `sessionId` is the client's own id for a
   * session it is starting; `agentSessionId` is set when the client is resuming
   * a provider thread it read off disk and does not yet know Solus's id for.
   * Returns the authoritative id — which may not be the one passed in.
   */
  watchSession(input: WatchSessionInput, clientId: string): WatchSessionResult {
    // Main resolves; the client asserts nothing. Two clients resuming one live
    // session must land on one id, or "one id" is only true within a client.
    const handoff = input.agentSessionId && input.provider
      ? resolveSessionLineage(input.provider, input.agentSessionId)
      : null
    const sessionId = handoff?.sessionId
      ?? (input.agentSessionId ? this.rt.agentSessionToSession.get(input.agentSessionId) : undefined)
      ?? input.sessionId
      ?? crypto.randomUUID()
    if (handoff) {
      for (const member of handoff.members) {
        if (member.providerSessionId) this.rt.agentSessionToSession.set(member.providerSessionId, sessionId)
      }
    } else if (input.agentSessionId) this.rt.agentSessionToSession.set(input.agentSessionId, sessionId)

    // Drain what is already buffered to the clients that were here first: the
    // Buffered mode drains before joining. Paragraph mode leaves its unfinished
    // tail on the host and replays only blocks that have already been published.
    this.rt.flushPendingSession(sessionId, true)

    let clients = this.watches.get(sessionId)
    if (!clients) {
      clients = new Set()
      this.watches.set(sessionId, clients)
    }
    if (!clients.has(clientId)) {
      clients.add(clientId)
      this.rt.emit('watchers-changed', sessionId)
    }
    log.info('session_watched', { sessionId, clientId, watchers: clients.size })
    const pendingQuestions = pendingAsyncQuestions(sessionId).map(({ questionId, questions, responseMode }) => ({ questionId, questions, responseMode }))
    const pending = pendingQuestions.length ? { pendingQuestions } : {}
    if (!input.attachRuntime || !input.agentSessionId) return { sessionId, ...pending }
    // Same order a separate bind would follow: drained, joined, then replayed.
    return { sessionId, runtime: this.attachRuntime(sessionId, input.agentSessionId, clientId), ...pending }
  }

  unwatchSession(sessionId: string, clientId: string): void {
    this.dropWatch(sessionId, clientId)
    // Only an explicit unwatch — the user closed the last view — resolves
    // attention. A dropped socket means the laptop shut, not that the session
    // stopped needing you.
    if (this.watches.has(sessionId)) return
    const agentSessionId = this.rt.agentSessionIdFor(sessionId)
    if (agentSessionId) this.rt.attention.resolve(agentSessionId)
  }

  clientsWatching(sessionId: string): readonly string[] {
    const clients = this.watches.get(sessionId)
    return clients ? [...clients] : []
  }

  /** The sessions one client has open, for the rooms to republish when it comes or goes. */
  sessionsWatchedBy(clientId: string): string[] {
    const sessionIds: string[] = []
    for (const [sessionId, clients] of this.watches) if (clients.has(clientId)) sessionIds.push(sessionId)
    return sessionIds
  }

  /** The turn in flight, as the session room reports it: whose prompt, on which provider. */
  activeTurnFor(sessionId: string): SessionActiveTurn | null {
    const run = this.rt.activeRunRequests.get(sessionId)
    return run ? activeTurnFor(run.actor, run.input.provider) : null
  }

  /**
   * What a session is doing, for the host roster: its name and task from the
   * index, its state from the live session. The index is keyed by the provider's
   * thread, so the lineage answers which thread is current; a session not yet
   * indexed has no name and rests.
   */
  async sessionActivityFor(sessionId: string): Promise<SessionActivity> {
    const providerSessionId = resolveSessionLineageById(sessionId)?.active.providerSessionId
      ?? this.rt.agentSessionIdFor(sessionId)
      ?? sessionId
    const meta = getIndexedSession(providerSessionId)
    return {
      sessionId,
      title: meta?.customTitle || meta?.firstMessage?.replace(/\s+/g, ' ') || meta?.slug || null,
      taskId: await taskIdForSession(ANY_ORGANIZATION, sessionId),
      state: sessionActivityStateOf(this.rt.activeSessions.get(sessionId)?.status),
      activeTurn: this.activeTurnFor(sessionId),
    }
  }

  private dropWatch(sessionId: string, clientId: string): void {
    const clients = this.watches.get(sessionId)
    if (!clients?.delete(clientId)) return
    this.rt.emit('watchers-changed', sessionId)
    if (clients.size) return
    this.watches.delete(sessionId)
    // Keep pending text for clients that reconnect during this turn.
    log.info('session_unwatched', { sessionId, clientId })
  }

  bindRuntimeSession(ctx: IpcContext, clientId: string): RuntimeSessionInfo | null {
    const agentSessionId = ctx.session.agentSessionId
    const restoredQueue = this.rt.scheduler.queuedPromptsForSession(ctx.session.sessionId)
    if (restoredQueue.length && !this.rt.activeSessions.has(ctx.session.sessionId)) {
      return { modelConfig: null, permissionMode: null, status: 'idle', queuedPrompts: restoredQueue, rateLimitInfo: null }
    }
    if (!agentSessionId) return null

    // Whoever is resuming may not know Solus's id for this provider thread yet;
    // the live session is authoritative for it.
    const sessionId = this.rt.sessionIdFor(ctx.session.sessionId)
      ?? this.rt.agentSessionToSession.get(agentSessionId)
      ?? ctx.session.sessionId
    if (!sessionId) return null
    // A watch is the authorization: any paired device watching a session may act
    // on it. Opening a headless session's card is watching it.
    if (!this.watches.get(sessionId)?.has(clientId)) {
      this.watchSession({ sessionId, agentSessionId }, clientId)
    }
    return this.attachRuntime(sessionId, agentSessionId, clientId, contextPreferences(ctx).rateLimitBehavior ?? DEFAULT_EXECUTION_PREFERENCES.rateLimitBehavior)
  }

  /** Join a watching client to a session's live runtime: replay the turn so far
   *  to that client alone and read the run config back. Null when nothing is
   *  running for the session any more. */
  private attachRuntime(sessionId: string, agentSessionId: string, clientId: string, rateLimitBehavior?: SessionRunInput['rateLimitBehavior']): RuntimeSessionInfo | null {
    const session = this.rt.activeSessions.get(sessionId)
    if (!session) return null

    if (rateLimitBehavior) this.rt.rateLimitPark.queueHeldRateLimitedPrompts(rateLimitBehavior, sessionId)

    const backend = this.rt.backendFor(session.backendId)
    const pendingRateLimitEvent = this.rt.rateLimitPark.currentRateLimitEvent(sessionId)
    const rateLimitInfo = pendingRateLimitEvent?.type === 'rate_limit'
      ? (pendingRateLimitEvent.info ?? null)
      : null
    const hasQueuedRateLimitRequest = (this.rt.scheduler.requestQueue.get(sessionId) ?? []).some(
      (request) => request.rateLimitSessionId === sessionId,
    )
    const isRuntimeRunning = backend.isSessionRunning(agentSessionId)
    if (!isRuntimeRunning && !pendingRateLimitEvent && !hasQueuedRateLimitRequest) {
      this.rt.activeSessions.delete(sessionId)
      return null
    }

    if (!pendingRateLimitEvent) this.rt.scheduler.processQueueForSession(sessionId)

    // The joining client alone needs the turn so far; everyone else already has it.
    // Buffered delivery drains first. Paragraph delivery replays only published
    // blocks; its pending tail is sent once when complete.
    this.rt.flushPendingSession(sessionId, true)
    const replayed = new Set<NormalizedEvent>()
    for (const event of this.rt.turnLog.get(sessionId) ?? []) {
      replayed.add(event)
      this.rt.publish(sessionId, event, { only: clientId })
    }

    // Pending input outlives the turn that raised it, so it is replayed on its own
    // — but the log holds the very same objects when the ask happened in this turn.
    // Send each one once or the client stacks duplicate permission cards.
    for (const event of session.pendingInputEvents) {
      if (replayed.has(event)) continue
      this.rt.publish(sessionId, event, { only: clientId })
    }
    // The host's list then replaces the client's: a card this client kept from
    // before it reconnected, answered or closed meanwhile, leaves.
    this.rt.publish(sessionId, { type: 'pending_input_sync', pendingInputEvents: [...session.pendingInputEvents] }, { only: clientId })

    const status = pendingRateLimitEvent
      ? 'rate_limited'
      : isRuntimeRunning && session.status === 'completed'
        ? 'running'
        : session.status
    // Keep the stored turn status intact. `completed` can arrive just before the
    // runtime exits; only the reattaching client needs the live-runtime override.
    this.rt.statuses.setStatus(sessionId, pendingRateLimitEvent ? 'rate_limited' : session.status)

    if (pendingRateLimitEvent && !replayed.has(pendingRateLimitEvent)) {
      this.rt.publish(sessionId, pendingRateLimitEvent, { only: clientId })
    }

    // The run contract is how the config is read back, but losing it must not
    // cost the client the session itself: the runtime is alive either way, and
    // returning null here strands the session at 'idle' for the rest of its life.
    const input = session.runInput
    if (!input) {
      log.warn('session_attached_no_run_input', { sessionId, agentSessionId })
    } else {
      log.info('session_attached', { sessionId, agentSessionId })
    }
    return {
      modelConfig: input
        ? { modelId: input.preferredModel, reasoningEffort: input.reasoningEffort, contextWindow: input.contextWindow, fastMode: input.fastMode }
        : null,
      permissionMode: input?.permissionMode ?? null,
      status,
      queuedPrompts: this.rt.scheduler.queuedPromptsForSession(sessionId),
      rateLimitInfo,
      handoffFrom: session.handoffFrom,
    }
  }

  /**
   * An expired client — gone long enough that the transport gave up on recovering
   * its stream — drops its watches and nothing else. It does not end the sessions
   * it was watching and — deliberately — does not resolve their attention: a
   * session awaiting input still needs you when your laptop is shut, which is
   * exactly what the offline push notification assumes.
   *
   * Deliberately not called on a bare disconnect. A phone that backgrounds for a
   * second reconnects with its stream recovered and never re-watches, so dropping
   * on the first blip would leave it silently deaf to a session it still has open.
   * Watch lifetime tracks event-delivery lifetime.
   */
  handleClientExpired(clientId: string): void {
    for (const sessionId of Array.from(this.watches.keys())) {
      this.dropWatch(sessionId, clientId)
    }
  }
}
