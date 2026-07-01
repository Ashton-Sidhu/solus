import type { WorkspaceContext } from '../contexts/workspace.context.svelte'
import type { GitStatusStore } from '../contexts/git-status.store.svelte'
import { requestInputFocus } from './inputFocus'

export class GitActions {
  commitPushing = $state(false)
  commitPushed = $state(false)
  commitPushError = $state<string | null>(null)
  syncing = $state(false)
  synced = $state(false)
  syncError = $state<string | null>(null)
  creatingPR = $state(false)
  prUrl = $state<string | null>(null)
  prError = $state<string | null>(null)
  private commitTimer: ReturnType<typeof setTimeout> | null = null
  private syncTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private session: WorkspaceContext,
    private tabId: string,
    private gitStatus: GitStatusStore,
  ) {}

  async commitPush(): Promise<void> {
    const sess = this.session.sessionFor(this.tabId)
    if (this.commitPushing || !sess?.gitContext) return
    const gitCwd = sess.gitContext.worktreePath ?? sess.workingDirectory
    this.commitPushing = true
    this.commitPushed = false
    this.commitPushError = null
    const result = await window.solus.gitCommitPush(this.session.ctxFor(this.tabId))
    this.commitPushing = false
    if (result.success) {
      this.commitPushed = true
      if (this.commitTimer) clearTimeout(this.commitTimer)
      this.commitTimer = setTimeout(() => {
        this.commitPushed = false
        this.commitTimer = null
      }, 1800)
      if (gitCwd) {
        await this.gitStatus.refresh(gitCwd, { force: true })
        this.prUrl = this.gitStatus.statusFor(gitCwd)?.prUrl || null
      }
    } else {
      this.commitPushError = result.error || 'Commit & push failed'
    }
    requestInputFocus()
  }

  async sync(): Promise<void> {
    const sess = this.session.sessionFor(this.tabId)
    if (this.syncing || !sess?.gitContext) return
    const gitCwd = sess.gitContext.worktreePath ?? sess.workingDirectory
    this.syncing = true
    this.synced = false
    this.syncError = null
    const result = await window.solus.gitSync(this.session.ctxFor(this.tabId))
    this.syncing = false
    if (result.success) {
      this.synced = true
      if (this.syncTimer) clearTimeout(this.syncTimer)
      this.syncTimer = setTimeout(() => {
        this.synced = false
        this.syncTimer = null
      }, 1800)
      if (sess.workingDirectory) {
        await this.session.fetchGitContext(this.tabId, sess.workingDirectory)
        void this.gitStatus.refresh(gitCwd, { force: true })
      }
    } else {
      this.syncError = result.error || 'Sync failed'
    }
    requestInputFocus()
  }

  openTerminal(): void {
    void window.solus.openWorktreeTerminal(this.session.ctxFor(this.tabId))
    requestInputFocus()
  }

  async createPR(): Promise<void> {
    const sess = this.session.sessionFor(this.tabId)
    if (!sess?.workingDirectory || this.creatingPR) return
    this.creatingPR = true
    this.prError = null
    try {
      const result = await window.solus.worktreePR(this.session.ctxFor(this.tabId))
      if (result.success) this.prUrl = result.url || null
      else this.prError = result.error || 'Failed'
    } catch (err) {
      this.prError = err instanceof Error ? err.message : 'Failed'
    } finally {
      this.creatingPR = false
      if (sess.workingDirectory) {
        const gitCwd = sess.gitContext?.worktreePath ?? sess.workingDirectory
        void this.gitStatus.refresh(gitCwd, { force: true })
      }
      requestInputFocus()
    }
  }

  dismissError(): void {
    this.commitPushError = null
    this.syncError = null
    this.prError = null
    requestInputFocus()
  }
}

const actions = new Map<string, GitActions>()

export function gitActionsFor(tabId: string, session: WorkspaceContext, gitStatus: GitStatusStore): GitActions {
  let existing = actions.get(tabId)
  if (!existing) {
    existing = new GitActions(session, tabId, gitStatus)
    actions.set(tabId, existing)
  }
  return existing
}

/** Drop the cached instance when a tab closes so it doesn't outlive the tab. */
export function disposeGitActions(tabId: string): void {
  actions.delete(tabId)
}
