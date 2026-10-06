import { createLogger } from '../../logger'
import { type ExecutionPreferences } from '@solus/contracts/settings'
import { setSessionBranch } from '../../db/session-indexer'
import { resolveSessionLineageById } from '../../data/sessions/session-lineage'
import type { GitCheckout } from '@solus/contracts/types'
import { type Actor } from '../../admission/actor'
import type { SessionRuntime, SessionRunRequest } from '../session-runtime'

const log = createLogger('SessionRuntime', 'session-checkouts.ts')

/**
 * The checkout each session works in, and a move into another worktree.
 */
export class SessionCheckouts {
  /** A move of a session into another worktree (`WorktreeMover`) while its
   *  checkout is set up. Stop aborts it. It is kept apart from
   *  `pendingSetupControllers` because a move can run inside a live turn, and
   *  Stop must then end that turn too. */
  worktreeMoves = new Map<string, AbortController>()
  /** Sessions moved into another checkout since their last turn. The next turn
   *  forks the active thread into the new directory, as a user move does. */
  private movedCheckouts = new Set<string>()
  /** Sessions attach to a checkout path; the Git service owns its identity. */
  sessionCheckoutPaths = new Map<string, string>()

  constructor(private readonly rt: SessionRuntime) {
    rt.checkouts.onChange(({ state }) => {
      for (const [sessionId, cwd] of this.sessionCheckoutPaths) {
        if (cwd !== state.cwd) continue
        const gitContext = rt.checkouts.get(cwd)?.checkout ?? undefined
        const session = rt.activeSessions.get(sessionId)
        if (session) {
          session.gitContext = gitContext
          if (session.runInput) session.runInput.gitContext = gitContext ?? null
        }
        if (gitContext?.branch) setSessionBranch(sessionId, gitContext.branch)
        if (gitContext) rt.publish(sessionId, { type: 'git_context', gitContext })
      }
    })
    rt.checkouts.onStatus((cwd, state) => {
      for (const [sessionId, path] of this.sessionCheckoutPaths) {
        if (path === cwd) rt.publish(sessionId, { type: 'git_status', cwd, state })
      }
    })
  }

  /**
   * Replace a new worktree's temporary branch with a name generated from the
   * prompt. It runs beside the agent's first turn and only logs a failure:
   * the temporary branch is a correct branch, only a less readable one.
   */
  async nameWorktreeBranch(sessionId: string, checkout: GitCheckout, prompt: string, actor: Actor | undefined, preferences?: ExecutionPreferences): Promise<void> {
    if (!checkout.worktreePath) return
    this.setSessionGitEnvironment(sessionId, checkout.worktreePath, checkout)
    await this.rt.checkouts.name(checkout.worktreePath, prompt, this.rt, (provider) => this.rt.seatForTurn(actor, provider), preferences)
  }

  /** Register a worktree move so Stop can abort it. Call the returned
   *  function when the move ends. */
  trackWorktreeMove(sessionId: string, controller: AbortController): () => void {
    this.worktreeMoves.set(sessionId, controller)
    return () => { if (this.worktreeMoves.get(sessionId) === controller) this.worktreeMoves.delete(sessionId) }
  }

  /**
   * Bind a session to the checkout it moved into. Clients get the new checkout
   * at once, and the next turn forks the active thread into that directory: a
   * provider thread cannot change its directory in place.
   */
  moveSessionCheckout(sessionId: string, checkout: GitCheckout & { worktreePath: string }): void {
    this.setSessionGitEnvironment(sessionId, checkout.worktreePath, checkout)
    this.movedCheckouts.add(sessionId)
    this.rt.publish(sessionId, { type: 'git_context', gitContext: this.getGitContext(sessionId) ?? checkout })
  }

  /** The first turn after a move forks the active thread in the new checkout.
   *  A client that already asked for the fork keeps its own request. */
  continueInMovedCheckout(request: SessionRunRequest): SessionRunRequest {
    const { sessionId, input } = request
    if (!this.movedCheckouts.delete(sessionId) || input.forked) return request
    const active = resolveSessionLineageById(sessionId)?.active
    const checkout = this.getGitContext(sessionId)
    if (!active?.providerSessionId || !checkout?.worktreePath) return request
    log.info('moved_checkout_fork', { sessionId, worktreePath: checkout.worktreePath })
    return {
      ...request,
      target: { kind: 'new-session' },
      input: {
        ...input,
        provider: active.provider,
        agentSessionId: active.providerSessionId,
        forked: true,
        forkExcludeLatestTurn: false,
        gitContext: checkout,
        workingDirectory: checkout.worktreePath,
      },
    }
  }

  setSessionGitEnvironment(sessionId: string, cwd: string, gitContext: GitCheckout | null): void {
    if (!sessionId) return
    const session = this.rt.activeSessions.get(sessionId)
    if (!gitContext || !cwd || cwd === '~') {
      this.sessionCheckoutPaths.delete(sessionId)
      if (session) session.gitContext = undefined
      return
    }
    const checkoutCwd = gitContext.worktreePath ?? cwd
    this.sessionCheckoutPaths.set(sessionId, checkoutCwd)
    const checkout = this.rt.checkouts.attach(checkoutCwd, gitContext)
    if (session) {
      session.gitContext = checkout
      if (session.runInput) session.runInput.gitContext = checkout
    }
  }

  listGitContexts(): GitCheckout[] {
    const contexts: GitCheckout[] = []
    for (const cwd of new Set(this.sessionCheckoutPaths.values())) {
      const checkout = this.rt.checkouts.get(cwd)?.checkout
      if (checkout?.worktreePath) contexts.push({ ...checkout })
    }
    return contexts
  }

  getGitContext(sessionId: string): GitCheckout | undefined {
    const cwd = this.sessionCheckoutPaths.get(sessionId)
    return cwd ? this.rt.checkouts.get(cwd)?.checkout ?? undefined : undefined
  }
}
