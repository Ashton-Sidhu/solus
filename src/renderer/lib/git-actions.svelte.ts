import type {
  GitAction,
  GitActionPhase,
  GitActionProgressEvent,
  GitActionResult,
} from '../../shared/types'
import {
  type WorkspaceContext,
  type SessionEnvironmentStore,
} from '../contexts'
import { connectionsStore } from '../contexts/connections/connections.store.svelte'
import { toasts } from './toasts'
import { requestInputFocus } from './inputFocus'
import type { HostApi } from '@client-core/host-api'
import { hostPolicy } from '@client-core/host-policy'
import { serverConnections } from '@client-core/server-connections'

export class GitActions {
  running = $state(false)
  activeAction = $state<GitAction | null>(null)
  activePhase = $state<GitActionPhase | null>(null)
  activeLabel = $state<string | null>(null)
  lastResult = $state<GitActionResult | null>(null)
  actionError = $state<string | null>(null)
  discarding = $state(false)
  syncing = $state(false)
  synced = $state(false)
  syncError = $state<string | null>(null)
  prUrl = $state<string | null>(null)
  private syncTimer: ReturnType<typeof setTimeout> | null = null
  private resultTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private session: WorkspaceContext,
    private sourceId: string,
    private environmentStore: SessionEnvironmentStore,
  ) {}

  private target() {
    const environment = this.environmentStore.environmentFor(this.session.runFor(this.sourceId))
    return {
      cwd: environment.cwd,
      gitContext: environment.checkout,
      ctx: this.session.ctxForEnvironment(environment.cwd, environment.checkout, this.sourceId),
    }
  }

  private api(): HostApi {
    return this.session.apiFor(this.sourceId)
  }

  async run(action: GitAction, options: { createFeatureBranch?: boolean } = {}): Promise<void> {
    const target = this.target()
    if (this.running || !target.gitContext || !target.cwd || target.cwd === '~') return
    const api = this.api()
    const actionId = globalThis.crypto?.randomUUID?.()
      ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
    this.running = true
    this.activeAction = action
    this.activePhase = null
    this.activeLabel = null
    if (this.resultTimer) {
      clearTimeout(this.resultTimer)
      this.resultTimer = null
    }
    this.lastResult = null
    this.actionError = null
    const unsubscribe = serverConnections.eventsForApi(api).subscribe(
      'git.actionProgressed',
      (event: GitActionProgressEvent) => {
        if (event.actionId !== actionId) return
        if (event.kind === 'phase_started') {
          this.activePhase = event.phase
          this.activeLabel = event.label
        } else if (event.kind === 'failed') {
          this.actionError = event.message
        }
      },
    )
    try {
      const request: Parameters<typeof api.gitRunAction>[1] = {
        actionId,
        action,
      }
      if (options.createFeatureBranch) request.createFeatureBranch = true
      const result = await api.gitRunAction($state.snapshot(target.ctx), request)
      this.lastResult = result
      const pullRequest = result.pullRequest
      if (pullRequest.status !== 'skipped') {
        this.prUrl = pullRequest.url
        toasts.success(pullRequest.status === 'created' ? 'Pull request created' : 'Pull request is ready')
      } else if (result.push.status === 'pushed') {
        toasts.success(result.commit.status === 'created' ? 'Committed and pushed' : 'Pushed')
      } else if (result.commit.status === 'created') {
        toasts.success('Committed')
      } else if (result.commit.status === 'skipped_no_changes') {
        toasts.info('Nothing to commit.')
      }
    } catch (error) {
      this.actionError = error instanceof Error ? error.message : String(error)
      toasts.error('Git action failed', { description: this.actionError })
    } finally {
      unsubscribe()
      await this.environmentStore.refreshEnvironment(this.session, {
        sourceId: this.sourceId,
        cwd: target.cwd,
        level: 'details',
      }).catch(() => null)
      this.prUrl = this.environmentStore.statusFor(target.cwd)?.prUrl || this.prUrl
      this.running = false
      this.activeAction = null
      this.activePhase = null
      this.activeLabel = null
      if (this.lastResult) {
        this.resultTimer = setTimeout(() => {
          this.lastResult = null
          this.resultTimer = null
        }, 1800)
      }
      requestInputFocus()
    }
  }

  async discard(): Promise<void> {
    const target = this.target()
    if (this.discarding || !target.gitContext) return
    this.discarding = true
    try {
      const result = await this.api().gitDiscard(target.ctx)
      if (result.success) {
        toasts.success(result.discarded === 0
          ? 'Nothing to discard.'
          : `Discarded ${result.discarded} change${result.discarded === 1 ? '' : 's'}.`)
      } else {
        toasts.error("Couldn't discard changes", { description: result.error || 'Discard failed' })
      }
    } catch (error) {
      toasts.error("Couldn't discard changes", {
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      if (target.cwd) {
        await this.environmentStore.refreshEnvironment(this.session, {
          sourceId: this.sourceId,
          cwd: target.cwd,
          level: 'details',
        }).catch(() => null)
      }
      this.discarding = false
      requestInputFocus()
    }
  }

  async sync(): Promise<void> {
    const target = this.target()
    if (this.syncing || !target.gitContext) return
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
        toasts.error("Couldn't sync with remote", { description: this.syncError })
      }
    } catch (error) {
      this.syncError = error instanceof Error ? error.message : String(error)
      toasts.error("Couldn't sync with remote", { description: this.syncError })
    } finally {
      if (target.cwd) {
        await this.environmentStore.refreshEnvironment(this.session, {
          sourceId: this.sourceId,
          cwd: target.cwd,
          level: 'details',
        }).catch(() => null)
      }
      this.syncing = false
      requestInputFocus()
    }
  }

  openTerminal(): void {
    if (!connectionsStore.desktopHandlersAvailable || !hostPolicy.isClientMachine(this.session.runFor(this.sourceId)?.serverId)) return
    void this.api().openWorktreeTerminal(this.target().ctx)
    requestInputFocus()
  }
}

const actions = new Map<string, GitActions>()

export function gitActionsFor(
  sourceId: string,
  session: WorkspaceContext,
  environmentStore: SessionEnvironmentStore,
): GitActions {
  let existing = actions.get(sourceId)
  if (!existing) {
    existing = new GitActions(session, sourceId, environmentStore)
    actions.set(sourceId, existing)
  }
  return existing
}

export function disposeGitActions(sourceId: string): void {
  actions.delete(sourceId)
}
