import type { WorkspaceContext } from '../contexts/workspace.context.svelte'
import type { SessionEnvironmentStore } from '../contexts/session-environment.store.svelte'
import { connectionsStore } from '../contexts/connections.store.svelte'
import { toasts } from '../contexts/toast.store.svelte'
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
    private environmentStore: SessionEnvironmentStore,
  ) {}

  async commitPush(): Promise<void> {
    const sess = this.session.sessionFor(this.tabId)
    if (this.commitPushing || !sess?.gitContext) return
    const gitCwd = sess.gitContext.worktreePath ?? sess.workingDirectory
    this.commitPushing = true
    this.commitPushed = false
    this.commitPushError = null
    try {
      const result = await window.solus.gitCommitPush(this.session.ctxFor(this.tabId))
      if (result.success) {
        this.commitPushed = true
        if (this.commitTimer) clearTimeout(this.commitTimer)
        this.commitTimer = setTimeout(() => {
          this.commitPushed = false
          this.commitTimer = null
        }, 1800)
      } else {
        this.commitPushError = result.error || 'Commit & push failed'
        toasts.error(result.outcome === 'committed-only'
          ? `Committed locally, but couldn't push: ${this.commitPushError}`
          : `Couldn't commit and push: ${this.commitPushError}`)
      }
    } catch (error) {
      this.commitPushError = error instanceof Error ? error.message : String(error)
      toasts.error(`Couldn't commit and push: ${this.commitPushError}`)
    } finally {
      if (gitCwd) {
        await this.environmentStore.refreshTab(this.session, { tabId: this.tabId, cwd: gitCwd, level: 'details' })
          .catch(() => null)
        this.prUrl = this.environmentStore.statusFor(gitCwd)?.prUrl || null
      }
      this.commitPushing = false
      requestInputFocus()
    }
  }

  async sync(): Promise<void> {
    const sess = this.session.sessionFor(this.tabId)
    if (this.syncing || !sess?.gitContext) return
    const gitCwd = sess.gitContext.worktreePath ?? sess.workingDirectory
    this.syncing = true
    this.synced = false
    this.syncError = null
    try {
      const result = await window.solus.gitSync(this.session.ctxFor(this.tabId))
      if (result.success) {
        this.synced = true
        if (this.syncTimer) clearTimeout(this.syncTimer)
        this.syncTimer = setTimeout(() => {
          this.synced = false
          this.syncTimer = null
        }, 1800)
      } else {
        this.syncError = result.error || 'Sync failed'
        toasts.error(`Couldn't sync with remote: ${this.syncError}`)
      }
    } catch (error) {
      this.syncError = error instanceof Error ? error.message : String(error)
      toasts.error(`Couldn't sync with remote: ${this.syncError}`)
    } finally {
      if (gitCwd) {
        await this.environmentStore.refreshTab(this.session, { tabId: this.tabId, cwd: gitCwd, level: 'details' })
          .catch(() => null)
      }
      this.syncing = false
      requestInputFocus()
    }
  }

  openTerminal(): void {
    if (!connectionsStore.desktopHandlersAvailable) return
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
      else {
        this.prError = result.error || 'Create pull request failed'
        toasts.error(`Couldn't create pull request: ${this.prError}`)
      }
    } catch (err) {
      this.prError = err instanceof Error ? err.message : String(err)
      toasts.error(`Couldn't create pull request: ${this.prError}`)
    } finally {
      this.creatingPR = false
      if (sess.workingDirectory) {
        const gitCwd = sess.gitContext?.worktreePath ?? sess.workingDirectory
        void this.environmentStore.refreshTab(this.session, { tabId: this.tabId, cwd: gitCwd, level: 'details' })
      }
      requestInputFocus()
    }
  }
}

const actions = new Map<string, GitActions>()

export function gitActionsFor(tabId: string, session: WorkspaceContext, environmentStore: SessionEnvironmentStore): GitActions {
  let existing = actions.get(tabId)
  if (!existing) {
    existing = new GitActions(session, tabId, environmentStore)
    actions.set(tabId, existing)
  }
  return existing
}

/** Drop the cached instance when a tab closes so it doesn't outlive the tab. */
export function disposeGitActions(tabId: string): void {
  actions.delete(tabId)
}
