import type { AgentId, IpcContext, Session, ThreadGoal, ThreadGoalSetRequest } from '../../../shared/types'

interface GoalApi {
  getThreadGoal(threadId: string, ctx?: IpcContext, provider?: AgentId): Promise<ThreadGoal | null>
  setThreadGoal(request: ThreadGoalSetRequest, ctx?: IpcContext, provider?: AgentId): Promise<ThreadGoal>
  clearThreadGoal(threadId: string, ctx?: IpcContext, provider?: AgentId): Promise<boolean>
}

interface GoalSyncDeps {
  sessionFor(tabId: string): Session | undefined
  apiFor(tabId: string): GoalApi
  ctxFor(tabId: string): IpcContext
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

  async refresh(tabId: string): Promise<void> {
    const session = this.goalSession(tabId)
    if (!session?.agentSessionId || !session.provider) return
    const threadId = session.agentSessionId
    const state = this.stateFor(session)
    const revision = state.revision

    try {
      const goal = await this.deps.apiFor(tabId).getThreadGoal(threadId, this.deps.ctxFor(tabId), session.provider)
      if (this.isCurrent(tabId, session, threadId) && state.revision === revision) {
        session.goal = goal
      }
    } catch {
      // Goal support is additive across host/provider versions. A host that
      // predates it should leave the existing renderer snapshot untouched.
    }
  }

  create(tabId: string, objective: string): Promise<ThreadGoal> {
    const session = this.requireGoalSession(tabId)
    const threadId = session.agentSessionId as string
    const state = this.stateFor(session)
    const revision = ++state.revision

    return this.enqueue(state, async () => {
      try {
        const goal = await this.deps.apiFor(tabId).setThreadGoal(
          { threadId, objective, status: 'active' },
          this.deps.ctxFor(tabId),
          session.provider as AgentId,
        )
        if (this.isCurrent(tabId, session, threadId) && state.revision === revision) {
          session.goal = goal
        }
        return goal
      } catch (error) {
        await this.refresh(tabId)
        throw error
      }
    })
  }

  set(tabId: string, update: Omit<ThreadGoalSetRequest, 'threadId'>): Promise<ThreadGoal> {
    const session = this.requireCodexSession(tabId)
    const threadId = session.agentSessionId as string
    const state = this.stateFor(session)
    const revision = ++state.revision

    return this.enqueue(state, async () => {
      try {
        const goal = await this.deps.apiFor(tabId).setThreadGoal(
          { threadId, ...update },
          this.deps.ctxFor(tabId),
          'codex',
        )
        if (this.isCurrent(tabId, session, threadId) && state.revision === revision) {
          session.goal = goal
        }
        return goal
      } catch (error) {
        await this.refresh(tabId)
        throw error
      }
    })
  }

  pauseForInterrupt(tabId: string): void {
    const session = this.codexSession(tabId)
    if (!session?.goal || session.goal.status !== 'active') return

    // Stopping the turn must stay responsive even if goal persistence fails.
    // `set` refreshes the authoritative state on failure; the interrupt itself
    // remains independent and must not produce an unhandled rejection.
    void this.set(tabId, { status: 'paused' }).catch(() => {})
  }

  clear(tabId: string): Promise<void> {
    const session = this.requireCodexSession(tabId)
    const threadId = session.agentSessionId as string
    const state = this.stateFor(session)
    const revision = ++state.revision

    return this.enqueue(state, async () => {
      try {
        const cleared = await this.deps.apiFor(tabId).clearThreadGoal(
          threadId,
          this.deps.ctxFor(tabId),
          'codex',
        )
        if (!cleared) {
          await this.refresh(tabId)
          return
        }
        if (this.isCurrent(tabId, session, threadId) && state.revision === revision) {
          session.goal = null
        }
      } catch (error) {
        await this.refresh(tabId)
        throw error
      }
    })
  }

  applyUpdated(tabId: string, goal: ThreadGoal): boolean {
    const session = this.goalSession(tabId)
    if (!session?.agentSessionId || session.agentSessionId !== goal.threadId) return false
    this.stateFor(session).revision++
    const isNewGoal = !session.goal
    session.goal = goal
    return isNewGoal
  }

  applyCleared(tabId: string, threadId: string): void {
    const session = this.codexSession(tabId)
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

  private codexSession(tabId: string): Session | undefined {
    const session = this.deps.sessionFor(tabId)
    return session?.provider === 'codex' ? session : undefined
  }

  private goalSession(tabId: string): Session | undefined {
    const session = this.deps.sessionFor(tabId)
    return session?.provider === 'codex' || session?.provider === 'claude-code' ? session : undefined
  }

  private requireGoalSession(tabId: string): Session {
    const session = this.goalSession(tabId)
    if (!session?.agentSessionId) throw new Error('This tab does not have an active agent session')
    return session
  }

  private requireCodexSession(tabId: string): Session {
    const session = this.codexSession(tabId)
    if (!session?.agentSessionId) throw new Error('This tab does not have an active Codex thread')
    return session
  }

  private isCurrent(tabId: string, session: Session, threadId: string): boolean {
    return this.deps.sessionFor(tabId) === session && session.agentSessionId === threadId
  }
}
