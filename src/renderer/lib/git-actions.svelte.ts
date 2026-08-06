import {
  type WorkspaceContext,
  type SessionEnvironmentStore,
} from '../contexts'
// Value imports stay deep (not the barrel): workspace.context imports this
// module, so a runtime barrel import here would create a cycle.
import { connectionsStore } from '../contexts/connections/connections.store.svelte'
import { toasts } from './toasts'
import { requestInputFocus } from './inputFocus'
import { LOCAL_SERVER_ID } from '@client-core/server-registry'

export class GitActions {
  commitPushing = $state(false)
  commitPushed = $state(false)
  commitPushError = $state<string | null>(null)
  discarding = $state(false)
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
    const environment = this.environmentStore.environmentFor(this.session.sessionFor(this.tabId)?.run)
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
        this.commitPushError = result.error || 'Commit and push failed'
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

  /** Commit without publishing. Shares the commit row's phase state with
   *  `commitPush` — only one of the two can be in flight, and the row shows
   *  whichever ran. */
  async commit(): Promise<void> {
    const target = this.target()
    if (this.commitPushing || !target.gitContext) return
    const gitCwd = target.cwd
    this.commitPushing = true
    this.commitPushed = false
    this.commitPushError = null
    try {
      const result = await this.api().gitCommit(target.ctx)
      if (result.success) {
        this.commitPushed = true
        if (this.commitTimer) clearTimeout(this.commitTimer)
        this.commitTimer = setTimeout(() => {
          this.commitPushed = false
          this.commitTimer = null
        }, 1800)
        if (result.outcome === 'unchanged') toasts.info('Nothing to commit.')
      } else {
        this.commitPushError = result.error || 'Commit failed'
        toasts.error(`Couldn't commit: ${this.commitPushError}`)
      }
    } catch (error) {
      this.commitPushError = error instanceof Error ? error.message : String(error)
      toasts.error(`Couldn't commit: ${this.commitPushError}`)
    } finally {
      if (gitCwd) {
        await this.environmentStore.refreshTab(this.session, { tabId: this.tabId, cwd: gitCwd, level: 'details' })
          .catch(() => null)
      }
      this.commitPushing = false
      requestInputFocus()
    }
  }

  /** Irreversible: resets tracked files to HEAD and removes untracked ones.
   *  Callers are expected to have confirmed with the user first. */
  async discard(): Promise<void> {
    const target = this.target()
    if (this.discarding || !target.gitContext) return
    const gitCwd = target.cwd
    this.discarding = true
    try {
      const result = await this.api().gitDiscard(target.ctx)
      if (result.success) {
        toasts.success(result.discarded === 0
          ? 'Nothing to discard.'
          : `Discarded ${result.discarded} change${result.discarded === 1 ? '' : 's'}.`)
      } else {
        toasts.error(`Couldn't discard changes: ${result.error || 'Discard failed'}`)
      }
    } catch (error) {
      toasts.error(`Couldn't discard changes: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      if (gitCwd) {
        await this.environmentStore.refreshTab(this.session, { tabId: this.tabId, cwd: gitCwd, level: 'details' })
          .catch(() => null)
      }
      this.discarding = false
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
    if (!connectionsStore.desktopHandlersAvailable || this.session.sessionFor(this.tabId)?.run.serverId !== LOCAL_SERVER_ID) return
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
