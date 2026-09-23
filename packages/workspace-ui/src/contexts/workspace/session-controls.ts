import { track } from '../../lib/analytics'
import { requestInputFocus } from '../../lib/inputFocus'
import type { WorkspaceContext } from './workspace.context.svelte'

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

  respondPermission(tabId: string, questionId: string, optionId: string): void {
    this.workspace.apiFor(tabId).respondPermission(this.workspace.ctxFor(tabId), questionId, optionId)
    track('permission_responded', { decision: optionId })
    const session = this.workspace.sessionFor(tabId)
    if (!session) return
    const idx = session.permissionQueue.findIndex((p) => p.questionId === questionId)
    if (idx !== -1) session.permissionQueue.splice(idx, 1)
  }

  respondQuestion(tabId: string, questionId: string, answers: Record<string, string>): void {
    this.workspace.apiFor(tabId).respondQuestion(this.workspace.ctxFor(tabId), questionId, answers)
    const session = this.workspace.sessionFor(tabId)
    if (!session) return
    const idx = session.questionQueue.findIndex((q) => q.questionId === questionId)
    if (idx !== -1) session.questionQueue.splice(idx, 1)
    requestInputFocus({ tabId })
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
