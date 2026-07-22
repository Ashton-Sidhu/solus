import { type AgentId, type IpcContext, type Message, type QueuedPromptSnapshot, type Session, type StartInfo, type TurnSnapshot } from '../../shared/types'
import type { GitRefreshResult } from './session-environment.store.svelte'
import { loadCachedStart, saveCachedStart } from './tab-persistence'
import { extractChangedFilePaths, extractChangedFilePathsFromMessage } from '../lib/changedFiles'
import type { AgentContext } from './agent.context.svelte'
import type { PlanStore } from './plan.store.svelte'
import type { SessionConfigController } from './session-config.svelte'
import { reconcileQueuedPromptsForSession } from './session-transcript'
import type { SettingsContext } from './settings.context.svelte'
import type { TabRegistry } from './tab-registry.svelte'
import { TransportDisconnectedError } from '@client-core/ws-transport'

export interface StaticInfo {
  version: string
  email: string | null
  subscriptionType: string | null
  projectPath: string
  homePath: string
  workspacePath: string
}

export interface WorkspaceLifecycleStoreDeps {
  registry: TabRegistry
  settings: SettingsContext
  config: SessionConfigController
  planStore: PlanStore
  agent?: AgentContext
  refreshGitState(opts?: { tabId?: string; cwd?: string }): Promise<GitRefreshResult>
  ctxFor(tabId: string): IpcContext
  loadTranscript(args: {
    sessionId: string
    loadPath: string
    displayCwd: string
    provider: AgentId
    ctx: IpcContext
  }): Promise<{ messages: Session['messages']; progress: Session['progress']; planIds: string[] }>
}

export class WorkspaceLifecycleStore {
  staticInfo = $state<StaticInfo | null>(null)
  pluginCommands = $state<Session['pluginCommands']>({ global: [], project: [] })
  turnSnapshots = $state<Record<string, TurnSnapshot[]>>({})

  // Non-reactive guards: callers share an in-flight initialization, and a failed
  // connection attempt remains retryable after the transport reconnects.
  private staticInfoInitialized = false
  private staticInfoInitialization: Promise<void> | null = null
  private appliedStartDirectory: string | null = null

  constructor(private deps: WorkspaceLifecycleStoreDeps) {}

  /**
   * Apply a start() payload to staticInfo + agent metadata + the workingDirectory
   * default. The active-agent availability demotion is FRESH-only: a stale cache
   * could wrongly demote an agent whose availability has since recovered, so the
   * optimistic path never touches the active agent.
   */
  private applyStartInfo(result: StartInfo, opts: { fresh: boolean }): void {
    const startDirectory = result.projectPath || result.workspacePath || '~'
    const currentDirectory = this.deps.config.globalDefaults.workingDirectory
    const canReconcileCachedDefault = this.deps.registry.tabOrder.length === 0
      && currentDirectory === this.appliedStartDirectory
    this.staticInfo = {
      version: result.version || 'unknown',
      email: result.auth?.email || null,
      subscriptionType: result.auth?.subscriptionType || null,
      projectPath: result.projectPath || '~',
      homePath: result.homePath || '~',
      workspacePath: result.workspacePath || '~',
    }
    if (currentDirectory === '~' || canReconcileCachedDefault) {
      this.deps.config.globalDefaults.workingDirectory = startDirectory
    }
    this.appliedStartDirectory = startDirectory
    this.deps.agent?.hydrate(result.agents ?? [])
    if (opts.fresh && !this.deps.agent?.metadata[this.deps.settings.activeAgent]?.available) {
      const fallback = result.agents?.find((agent) => agent.available)
      if (fallback) this.deps.settings.update({ activeAgent: fallback.id })
    }
  }

  /**
   * Optimistically apply the last cached start() payload so staticInfo, agent
   * metadata, and the workingDirectory default are ready before first paint —
   * no server round trip. Idempotent: once staticInfo exists (cache or fresh)
   * this is a no-op. Fresh reconciliation happens in initStaticInfo.
   */
  hydrateStaticInfoFromCache(): void {
    if (this.staticInfo) return
    const cached = loadCachedStart()
    if (cached) this.applyStartInfo(cached, { fresh: false })
  }

  async initStaticInfo(): Promise<void> {
    if (this.staticInfoInitialized) return
    if (this.staticInfoInitialization) return this.staticInfoInitialization

    const initialization = (async () => {
      // Paint from cache first (safety net if setup didn't already), then reconcile.
      this.hydrateStaticInfoFromCache()
      const result = await window.solus.start()
      this.applyStartInfo(result, { fresh: true })
      saveCachedStart(result)
      if (this.deps.registry.tabOrder.length === 0) {
        await this.deps.refreshGitState()
      }
      void this.refreshPluginCommands(this.deps.config.globalDefaults.workingDirectory).catch((error) => {
        if (!(error instanceof TransportDisconnectedError)) {
          console.error('getPluginCommands failed', error)
        }
      })
    })()
    this.staticInfoInitialization = initialization

    try {
      await initialization
      this.staticInfoInitialized = true
    } finally {
      if (this.staticInfoInitialization === initialization) this.staticInfoInitialization = null
    }
  }

  async refreshPluginCommands(workingDirectory: string, tabId?: string): Promise<void> {
    const targetTabId = tabId ?? this.deps.registry.activeTabId
    const ctx = this.deps.ctxFor(targetTabId)
    ctx.session.provider = this.deps.settings.activeAgent as AgentId
    const result = await window.solus.getPluginCommands(workingDirectory, $state.snapshot(ctx))
    this.pluginCommands = result
    const session = this.deps.registry.sessionFor(targetTabId)
    if (session) session.pluginCommands = result
  }

  recomputeChangedFiles(tabId: string): void {
    const session = this.deps.registry.sessionFor(tabId)
    if (!session) return
    session.sessionChangedFiles.splice(0, session.sessionChangedFiles.length, ...extractChangedFilePaths(session.messages))
  }

  /**
   * Incremental changed-files update for a single just-completed tool message.
   * Unions its paths into the session's existing list instead of rescanning and
   * re-parsing every historical Write/Edit body. Transcript hydration still uses
   * the full scan; the backend publishes authoritative net paths at turn completion.
   */
  addChangedFilesFromMessage(tabId: string, message: Message): void {
    const session = this.deps.registry.sessionFor(tabId)
    if (!session) return
    for (const path of extractChangedFilePathsFromMessage(message)) {
      if (!session.sessionChangedFiles.includes(path)) session.sessionChangedFiles.push(path)
    }
  }

  async expandHistory(tabId: string): Promise<void> {
    const session = this.deps.registry.sessionFor(tabId)
    if (!session?.agentSessionId || !session.historyTruncated) return
    const displayCwd = session.workingDirectory
    const loadPath = session.gitContext?.worktreePath || displayCwd
    const provider = (session.provider ?? this.deps.settings.activeAgent) as AgentId
    const transcript = await this.deps.loadTranscript({
      sessionId: session.agentSessionId,
      loadPath,
      displayCwd,
      provider,
      ctx: this.deps.ctxFor(tabId),
    })
    const s = this.deps.registry.sessionFor(tabId)
    if (!s || transcript.messages.length === 0) return
    s.messages.splice(0, s.messages.length, ...transcript.messages)
    s.progress = transcript.progress
    s.historyTruncated = false
    this.recomputeChangedFiles(tabId)
    for (const planId of transcript.planIds) void this.deps.planStore.hydrateAnnotations(planId)
  }

  async hydrateChangedFilesFromDiff(tabId: string): Promise<void> {
    const session = this.deps.registry.sessionFor(tabId)
    if (!session?.agentSessionId || session.sessionChangedFiles.length > 0) return
    try {
      const stats = await window.solus.diffStats(this.deps.ctxFor(tabId), { scope: { kind: 'session' } })
      const files = stats.map((file) => file.path)
      if (files.length === 0) return
      session.sessionChangedFiles.splice(0, session.sessionChangedFiles.length, ...files)
    } catch {
      /* best-effort; transcript-derived changed files remain the source of truth */
    }
  }

  async refreshTurnSnapshots(tabId: string): Promise<void> {
    const session = this.deps.registry.sessionFor(tabId)
    if (!session?.agentSessionId) return
    try {
      const snaps = await window.solus.listTurnSnapshots(this.deps.ctxFor(tabId))
      this.turnSnapshots[tabId] = snaps
    } catch {
      /* best-effort */
    }
  }

  reconcileQueuedPrompts(tabId: string, queuedPrompts: QueuedPromptSnapshot[]): void {
    const session = this.deps.registry.sessionFor(tabId)
    if (!session) return
    reconcileQueuedPromptsForSession(session, queuedPrompts)
  }

  /** Drop a closed tab's cached turn snapshots so the map can't grow unbounded. */
  disposeTab(tabId: string): void {
    if (tabId in this.turnSnapshots) delete this.turnSnapshots[tabId]
  }
}
