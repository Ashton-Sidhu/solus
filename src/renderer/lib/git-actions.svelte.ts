import {
  type WorkspaceContext,
  type SessionEnvironmentStore,
} from '../contexts'
// Value imports stay deep (not the barrel): workspace.context imports this
// module, so a runtime barrel import here would create a cycle.
import { connectionsStore } from '../contexts/connections/connections.store.svelte'
import { toasts } from '../contexts/app/toast.store.svelte'
import { requestInputFocus } from './inputFocus'
import { LOCAL_SERVER_ID } from '@client-core/server-registry'

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

  private target() {
    const environment = this.environmentStore.environmentFor(this.tabId)
    return {
      cwd: environment.cwd,
      gitContext: environment.checkout,
      ctx: this.session.ctxForEnvironment(environment.cwd, environment.checkout, this.tabId),
    }
  }

  private api(): typeof window.solus {
    return this.session.apiFor?.(this.tabId) ?? window.solus
  }

  async commitPush(): Promise<void> {
    const target = this.target()
    if (this.commitPushing || !target.gitContext) return
    const gitCwd = target.cwd
    this.commitPushing = true
    this.commitPushed = false
    this.commitPushError = null
    try {
      const result = await this.api().gitCommitPush(target.ctx)
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
    const target = this.target()
    if (this.syncing || !target.gitContext) return
    const gitCwd = target.cwd
    this.syncing = true
    this.synced = false
    this.syncError = null
    try {
      const result = await this.api().gitSync(target.ctx)
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
    if (!connectionsStore.desktopHandlersAvailable || this.session.sessionFor(this.tabId)?.serverId !== LOCAL_SERVER_ID) return
    void window.solus.openWorktreeTerminal(this.target().ctx)
    requestInputFocus()
  }

  async createPR(): Promise<void> {
    const target = this.target()
    if (!target.cwd || target.cwd === '~' || !target.gitContext || this.creatingPR) return
    this.creatingPR = true
    this.prError = null
    try {
      const result = await this.api().worktreePR(target.ctx)
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
      void this.environmentStore.refreshTab(this.session, { tabId: this.tabId, cwd: target.cwd, level: 'details' })
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
