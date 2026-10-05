import { track } from '../../lib/analytics'
import { requestInputFocus } from '../../lib/inputFocus'
import { toasts } from '../../lib/toasts'
import type { WorkspaceContext } from './workspace.context.svelte'
import { rpcErrorCode } from '@solus/client-core/rpc-error'
import { REQUEST_NOT_ANSWERABLE_CODE, requestExpiryText } from '@solus/contracts/types'
import { expireRequest } from './session.utils'

/** The workspace members this controller reads or calls, and no others. */
type SessionControlsWorkspace = Pick<WorkspaceContext,
  | 'apiFor'
  | 'ctxFor'
  | 'dispatch'
  | 'eventReducer'
  | 'goalSync'
  | 'sessionFor'
  | 'tabs'
>

/**
 * A person's answers to a running turn: stopping it, answering a permission
 * request or a question, and retrying a worktree setup that failed.
 */
export class SessionControls {
  constructor(private readonly workspace: SessionControlsWorkspace) {}

  recoverWorktreeSetup(tabId: string, workLocally: boolean): void {
    const session = this.workspace.sessionFor(tabId)
    if (!session || session.status !== 'failed' || session.statusCard?.recovery !== 'worktree') return
    if (workLocally) session.run.worktree = null
    session.statusCard = null
    this.workspace.dispatch.retryLastMessage(tabId, true)
    requestInputFocus({ tabId })
  }

  /** The card leaves only once the host took the answer: a refused answer
   *  (a viewer on a shared session) leaves the request open for someone else. */
  async respondPermission(tabId: string, questionId: string, optionId: string): Promise<boolean> {
    const ctx = this.workspace.ctxFor(tabId)
    let answered: boolean
    try {
      answered = await this.workspace.apiFor(tabId).respondPermission(ctx, ctx.session.sessionId, questionId, optionId)
    } catch (error) {
      this.refuseAnswer(tabId, questionId, error)
      return false
    }
    if (!answered) {
      toasts.error("You can't answer this request")
      return false
    }
    track('permission_responded', { decision: optionId })
    const session = this.workspace.sessionFor(tabId)
    if (!session) return true
    const idx = session.permissionQueue.findIndex((p) => p.questionId === questionId)
    if (idx !== -1) session.permissionQueue.splice(idx, 1)
    return true
  }

  async respondQuestion(tabId: string, questionId: string, answers: Record<string, string>): Promise<boolean> {
    const ctx = this.workspace.ctxFor(tabId)
    let answered: boolean
    try {
      answered = await this.workspace.apiFor(tabId).respondQuestion(ctx, ctx.session.sessionId, questionId, answers)
    } catch (error) {
      this.refuseAnswer(tabId, questionId, error)
      return false
    }
    if (!answered) {
      toasts.error("You can't answer this question")
      return false
    }
    const session = this.workspace.sessionFor(tabId)
    if (!session) return true
    const idx = session.questionQueue.findIndex((q) => q.questionId === questionId)
    if (idx !== -1) session.questionQueue.splice(idx, 1)
    requestInputFocus({ tabId })
    return true
  }

  /** An answer that did not land. When the host no longer holds the request,
   *  its card closes and says why; any other failure leaves it open to retry. */
  private refuseAnswer(tabId: string, questionId: string, error: unknown): void {
    if (error instanceof Error && rpcErrorCode(error) === REQUEST_NOT_ANSWERABLE_CODE) {
      const session = this.workspace.sessionFor(tabId)
      if (session) expireRequest(session, questionId, 'closed')
      toasts.error('This request is no longer open', { description: requestExpiryText('closed') })
      return
    }
    toasts.error("Couldn't send answer", { description: String(error) })
  }

  interruptSession(sessionId: string, opts: { notice?: boolean } = {}): void {
    // A visible stop is the user putting this goal on hold. Internal handoffs
    // pass `notice: false` because the work is continuing in another session.
    if (opts.notice !== false) this.workspace.goalSync.pauseForInterrupt(sessionId)
    this.workspace.eventReducer.interruptSession(sessionId, opts)
    track('session_interrupted', {})
  }

  /** Stop whatever conversation a tab is showing. The tab is how the user
   *  pointed at it; the session is what gets interrupted. */
  interruptTabSession(tabId: string, opts: { notice?: boolean } = {}): void {
    const sessionId = this.workspace.tabs[tabId]?.sessionId
    if (sessionId) this.interruptSession(sessionId, opts)
  }
}
