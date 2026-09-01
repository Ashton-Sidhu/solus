import type { AgentId, IpcContext, Session, ThreadGoal, ThreadGoalSetRequest } from '../../../shared/types'

interface GoalApi {
  getThreadGoal(threadId: string, ctx?: IpcContext, provider?: AgentId): Promise<ThreadGoal | null>
  setThreadGoal(request: ThreadGoalSetRequest, ctx?: IpcContext, provider?: AgentId): Promise<ThreadGoal>
  clearThreadGoal(threadId: string, ctx?: IpcContext, provider?: AgentId): Promise<boolean>
}

interface GoalSyncDeps {
  sessionById(sessionId: string): Session | undefined
  apiForSession(sessionId: string): GoalApi
  ctxForSession(sessionId: string): IpcContext
}

interface GoalSyncState {
  revision: number
  mutationTail: Promise<void>
}

/** Keeps persisted goal state ordered across renderer commands, refreshes, and
 * provider notifications without replacing the owning Session object. */
export class GoalSync {
  private states = new WeakMap<Session, GoalSyncState>()

  constructor(private deps: GoalSyncDeps) {}

  async refresh(sessionId: string): Promise<void> {
    const session = this.goalSession(sessionId)
    if (!session?.agentSessionId || !session.run.provider) return
    const threadId = session.agentSessionId
    const state = this.stateFor(session)
    const revision = state.revision

    try {
      const goal = await this.deps.apiForSession(sessionId).getThreadGoal(threadId, this.deps.ctxForSession(sessionId), session.run.provider)
      if (this.isCurrent(sessionId, session, threadId) && state.revision === revision) {
        session.goal = goal
      }
    } catch {
      // Goal support is additive across host/provider versions. A host that
      // predates it should leave the existing renderer snapshot untouched.
    }
  }

  create(sessionId: string, objective: string): Promise<ThreadGoal> {
    const session = this.requireGoalSession(sessionId)
    const threadId = session.agentSessionId as string
    const state = this.stateFor(session)
    const revision = ++state.revision

    return this.enqueue(state, async () => {
      try {
        const goal = await this.deps.apiForSession(sessionId).setThreadGoal(
          { threadId, objective, status: 'active' },
          this.deps.ctxForSession(sessionId),
          session.run.provider as AgentId,
        )
        if (this.isCurrent(sessionId, session, threadId) && state.revision === revision) {
          session.goal = goal
        }
        return goal
      } catch (error) {
        await this.refresh(sessionId)
        throw error
      }
    })
  }

  set(sessionId: string, update: Omit<ThreadGoalSetRequest, 'threadId'>): Promise<ThreadGoal> {
    const session = this.requireCodexSession(sessionId)
    const threadId = session.agentSessionId as string
    const state = this.stateFor(session)
    const revision = ++state.revision

    return this.enqueue(state, async () => {
      try {
        const goal = await this.deps.apiForSession(sessionId).setThreadGoal(
          { threadId, ...update },
          this.deps.ctxForSession(sessionId),
          'codex',
        )
        if (this.isCurrent(sessionId, session, threadId) && state.revision === revision) {
          session.goal = goal
        }
        return goal
      } catch (error) {
        await this.refresh(sessionId)
        throw error
      }
    })
  }

  pauseForInterrupt(sessionId: string): void {
    const session = this.codexSession(sessionId)
    if (!session?.goal || session.goal.status !== 'active') return

    // Stopping the turn must stay responsive even if goal persistence fails.
    // `set` refreshes the authoritative state on failure; the interrupt itself
    // remains independent and must not produce an unhandled rejection.
    void this.set(sessionId, { status: 'paused' }).catch(() => {})
  }

  clear(sessionId: string): Promise<void> {
    const session = this.requireCodexSession(sessionId)
    const threadId = session.agentSessionId as string
    const state = this.stateFor(session)
    const revision = ++state.revision

    return this.enqueue(state, async () => {
      try {
        const cleared = await this.deps.apiForSession(sessionId).clearThreadGoal(
          threadId,
          this.deps.ctxForSession(sessionId),
          'codex',
        )
        if (!cleared) {
          await this.refresh(sessionId)
          return
        }
        if (this.isCurrent(sessionId, session, threadId) && state.revision === revision) {
          session.goal = null
        }
      } catch (error) {
        await this.refresh(sessionId)
        throw error
      }
    })
  }

  applyUpdated(sessionId: string, goal: ThreadGoal): boolean {
    const session = this.goalSession(sessionId)
    if (!session?.agentSessionId || session.agentSessionId !== goal.threadId) return false
    this.stateFor(session).revision++
    const isNewGoal = !session.goal
    session.goal = goal
    return isNewGoal
  }

  applyCleared(sessionId: string, threadId: string): void {
    const session = this.codexSession(sessionId)
    if (!session?.agentSessionId || session.agentSessionId !== threadId) return
    this.stateFor(session).revision++
    session.goal = null
  }

  private stateFor(session: Session): GoalSyncState {
    let state = this.states.get(session)
    if (!state) {
      state = { revision: 0, mutationTail: Promise.resolve() }
      this.states.set(session, state)
    }
    return state
  }

  private enqueue<T>(state: GoalSyncState, operation: () => Promise<T>): Promise<T> {
    const result = state.mutationTail.then(operation)
    state.mutationTail = result.then(() => undefined, () => undefined)
    return result
  }

  private codexSession(sessionId: string): Session | undefined {
    const session = this.deps.sessionById(sessionId)
    return session?.run.provider === 'codex' ? session : undefined
  }

  private goalSession(sessionId: string): Session | undefined {
    const session = this.deps.sessionById(sessionId)
    return session?.run.provider === 'codex' || session?.run.provider === 'claude-code' ? session : undefined
  }

  private requireGoalSession(sessionId: string): Session {
    const session = this.goalSession(sessionId)
    if (!session?.agentSessionId) throw new Error('This session has no active agent thread')
    return session
  }

  private requireCodexSession(sessionId: string): Session {
    const session = this.codexSession(sessionId)
    if (!session?.agentSessionId) throw new Error('This session has no active Codex thread')
    return session
  }

  private isCurrent(sessionId: string, session: Session, threadId: string): boolean {
    return this.deps.sessionById(sessionId) === session && session.agentSessionId === threadId
  }
}
