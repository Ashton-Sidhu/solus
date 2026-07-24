import type { AgentId, GitCheckout, IpcContext, ModelConfig, ModelProfile, ReasoningEffort, Session } from '../../../shared/types'
import { MODEL_PROFILES, gitCheckoutFromState, isSolusWorktreePath, worktreeProjectRoot } from '../../../shared/types'
import { analytics } from '../../lib/analytics'
import { TAB_GROUP_MODES, type SettingsContext, type TabGroupMode } from '../app/settings.context.svelte'
import type { GitRefreshResult } from '../git/session-environment.store.svelte'
import type { StatusBarContext } from '../app/status-bar.context.svelte'
import type { TabRegistry } from './tab-registry.svelte'
import { toasts } from '../app/toast.store.svelte'
import { buildHandoffDividerMessage } from './session-transcript'

export interface SessionConfigControllerDeps {
  settings: SettingsContext
  registry: TabRegistry
  statusBar: StatusBarContext
  setPluginCommands(commands: Session['pluginCommands']): void
  createTab(cwd?: string): Promise<string>
  ctx(tabId?: string): IpcContext
  ctxForDirectory(dir: string): IpcContext
  apiFor?(tabId?: string): typeof window.solus
  refreshPluginCommands(dir: string, tabId?: string): void
  refreshGitRefs(projectRoot: string, ctx: IpcContext): void
  refreshGitState(opts: { tabId?: string; cwd?: string; worktreeRequested?: boolean }): Promise<GitRefreshResult>
}

export class SessionConfigController {
  globalDefaults = $state<{
    permissionMode: 'ask' | 'auto' | 'plan'
    workingDirectory: string
    gitContext: GitCheckout | null
    worktreeBaseBranch: string | null
    modelConfig: ModelConfig
  }>({
    permissionMode: 'auto',
    workingDirectory: '~',
    gitContext: null,
    worktreeBaseBranch: null,
    modelConfig: { modelId: null, reasoningEffort: 'high', contextWindow: null, fastMode: false },
  })
  tabGroupMode = $state<TabGroupMode>('flat')
  handoffInProgress = $state(false)
  private switchingBranch = false
  private sessionStartTargetResolutions = new Map<string, Promise<void>>()

  constructor(private deps: SessionConfigControllerDeps) {
    this.globalDefaults.modelConfig = this.defaultModelConfigFor(deps.settings.activeAgent as AgentId)
    this.tabGroupMode = deps.settings.tabGroupMode
  }

  private apiFor(tabId?: string): typeof window.solus {
    return this.deps.apiFor?.(tabId) ?? window.solus
  }

  /** Single write path for the global Git start target: environment resolution
   * applies a resolved target, and tab creation clears a consumed one. */
  applyGlobalStartTarget(target: {
    gitContext: GitCheckout | null
    worktreeBaseBranch: string | null
  }): void {
    this.globalDefaults.gitContext = target.gitContext
    this.globalDefaults.worktreeBaseBranch = target.worktreeBaseBranch
  }

  toggleTabGroupMode(): void {
    const i = TAB_GROUP_MODES.indexOf(this.tabGroupMode)
    const tabGroupMode = TAB_GROUP_MODES[(i + 1) % TAB_GROUP_MODES.length]
    this.tabGroupMode = tabGroupMode
    this.deps.settings.update({ tabGroupMode })
  }

  updateModelConfig(patch: Partial<ModelConfig>, tabId?: string): void {
    const session = tabId ? this.deps.registry.sessionFor(tabId) : this.deps.registry.activeSession
    const mc = session ? session.modelConfig : this.globalDefaults.modelConfig

    if ('modelId' in patch && patch.modelId !== mc.modelId) {
      const provider = session?.provider ?? (this.deps.settings.activeAgent as string)
      const profile = MODEL_PROFILES[provider as keyof typeof MODEL_PROFILES]?.[patch.modelId ?? '']
      mc.modelId = patch.modelId!
      mc.reasoningEffort = patch.reasoningEffort ?? profile?.defaultReasoningEffort ?? 'high'
      mc.contextWindow = patch.contextWindow ?? null
      mc.fastMode = patch.fastMode ?? (profile?.supportsFastMode ? mc.fastMode : false)
      return
    }

    if ('reasoningEffort' in patch) mc.reasoningEffort = patch.reasoningEffort!
    if ('contextWindow' in patch) mc.contextWindow = patch.contextWindow!
    if ('fastMode' in patch) mc.fastMode = patch.fastMode!
  }

  async switchActiveAgent(agentId: AgentId): Promise<void> {
    const session = this.deps.registry.activeSession
    if (this.handoffInProgress) return
    if (session) {
      if (session.provider === agentId) return
      if (session.status === 'connecting' || session.status === 'running') return
    }

    const newModelConfig = this.defaultModelConfigFor(agentId)
    if (!session?.agentSessionId) {
      analytics.agentSwitched({ from: this.deps.settings.activeAgent, to: agentId })
      this.deps.settings.update({ activeAgent: agentId })
      this.globalDefaults.modelConfig = newModelConfig
      this.deps.setPluginCommands({ global: [], project: [] })
      if (!session) {
        this.deps.refreshPluginCommands(this.globalDefaults.workingDirectory)
        return
      }
      session.provider = agentId
      session.agentSessionId = null
      session.modelConfig = { ...newModelConfig }
      session.sessionModel = null
      session.sessionSkills = []
      session.pluginCommands = { global: [], project: [] }
      this.deps.refreshPluginCommands(session.workingDirectory, this.deps.registry.activeTabId)
      return
    }

    const tabId = this.deps.registry.activeTabId
    this.handoffInProgress = true
    try {
      const result = await this.apiFor(tabId).switchSessionAgent(tabId, agentId)
      analytics.agentSwitched({ from: result.fromProvider, to: agentId })
      this.deps.settings.update({ activeAgent: agentId })
      this.globalDefaults.modelConfig = newModelConfig
      this.deps.setPluginCommands({ global: [], project: [] })
      session.provider = agentId
      session.agentSessionId = null
      session.modelConfig = { ...newModelConfig }
      session.sessionModel = null
      session.sessionSkills = []
      session.pluginCommands = { global: [], project: [] }
      session.handoffFrom = {
        provider: result.fromProvider,
        sessionId: result.fromSessionId,
      }
      session.messages.push(buildHandoffDividerMessage({
        fromProvider: result.fromProvider,
        toProvider: agentId,
      }))
      this.deps.refreshPluginCommands(session.workingDirectory, tabId)
    } catch (error) {
      toasts.error(`Couldn't hand off session: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.handoffInProgress = false
    }
  }

  setPermissionMode(mode: 'ask' | 'auto' | 'plan', tabId?: string): void {
    const session = tabId ? this.deps.registry.sessionFor(tabId) : this.deps.registry.activeSession
    if (!session) {
      this.globalDefaults.permissionMode = mode
      return
    }
    session.permissionMode = mode
  }

  setWorktreeBaseBranch(branch: string | null): void {
    const session = this.deps.registry.activeSession
    if (!session) return
    session.worktreeBaseBranch = branch
  }

  syncWorktreeDefault(enabled: boolean): void {
    this.globalDefaults.worktreeBaseBranch = enabled
      ? this.globalDefaults.gitContext?.targetBranch ?? null
      : null
    for (const tabId of this.deps.registry.tabOrder) {
      const session = this.deps.registry.sessionFor(tabId)
      if (!session || session.agentSessionId || session.gitContext?.worktreePath) continue
      if (session.status === 'connecting' || session.status === 'running') continue
      session.worktreeBaseBranch = enabled ? (session.gitContext?.targetBranch ?? null) : null
    }
  }

  toggleWorktreeMode(tabId?: string): void {
    const session = tabId
      ? this.deps.registry.sessionFor(tabId)
      : this.deps.registry.activeSession
    if (!session) {
      if (tabId) return
      const enabled = !this.deps.settings.worktreeEnabled
      this.deps.settings.update({ worktreeEnabled: enabled })
      this.globalDefaults.worktreeBaseBranch = enabled
        ? this.globalDefaults.gitContext?.targetBranch ?? null
        : null
      return
    }
    if (session.gitContext?.worktreePath) return
    if (session.worktreeBaseBranch) {
      session.worktreeBaseBranch = null
    } else {
      session.worktreeBaseBranch = session.gitContext?.targetBranch ?? null
    }
  }

  async switchToWorktree(worktreePath: string, tabId?: string): Promise<void> {
    const targetSession = tabId
      ? this.deps.registry.sessionFor(tabId)
      : this.deps.registry.activeSession
    const workingDirectory = targetSession?.workingDirectory
      ?? this.globalDefaults.workingDirectory
      ?? this.deps.statusBar.ctx.workingDirectory
    if (!workingDirectory || workingDirectory === '~') return
    if (!tabId && this.deps.registry.activeSession?.agentSessionId) {
      await this.deps.createTab()
    }
    const targetTabId = tabId ?? this.deps.registry.activeTabId
    const session = tabId
      ? this.deps.registry.sessionFor(tabId)
      : this.deps.registry.activeSession
    const isSolusWorktree = isSolusWorktreePath(worktreePath)
    const projectRoot = isSolusWorktree ? worktreeProjectRoot(worktreePath) : worktreePath
    const repoCtx = this.deps.ctxForDirectory(projectRoot)
    const api = this.apiFor(targetTabId)
    if (session) api.resetTabSession(this.deps.ctx(targetTabId))
    const restored: GitCheckout | null = isSolusWorktree
      ? await api.worktreeRestore(repoCtx, worktreePath, { includePr: false })
      : gitCheckoutFromState(await api.gitRefreshState(worktreePath).catch(() => null))
    if (session) {
      session.workingDirectory = projectRoot
      session.gitContext = restored
      session.worktreeBaseBranch = null
      this.deps.refreshPluginCommands(projectRoot, targetTabId)
    } else if (restored) {
      this.globalDefaults.workingDirectory = projectRoot
      this.globalDefaults.gitContext = restored
      this.deps.refreshPluginCommands(projectRoot)
    }
    if (!restored && session) {
      this.deps.refreshGitState({ tabId: targetTabId })
    }
    this.deps.refreshGitRefs(projectRoot, repoCtx)
  }

  async switchToBranch(branch: string, tabId?: string): Promise<boolean> {
    if (this.switchingBranch) return false
    this.switchingBranch = true
    try {
      const targetSession = tabId
        ? this.deps.registry.sessionFor(tabId)
        : this.deps.registry.activeSession
      const baseDir = targetSession?.gitContext?.repoRoot ?? targetSession?.workingDirectory ?? this.globalDefaults.gitContext?.repoRoot ?? this.globalDefaults.workingDirectory
      if (!baseDir || baseDir === '~') {
        toasts.error("Couldn't switch branch: no active Git repository")
        return false
      }
      const projectRoot = worktreeProjectRoot(baseDir)
      if (!tabId && targetSession?.agentSessionId) {
        await this.deps.createTab()
      }
      const targetTabId = tabId ?? this.deps.registry.activeTabId
      const session = tabId
        ? this.deps.registry.sessionFor(tabId)
        : this.deps.registry.activeSession
      const ctx = this.deps.ctxForDirectory(projectRoot)
      const api = this.apiFor(targetTabId)
      const result = await api.gitCheckoutBranch(ctx, branch)
      if (!result.success || !result.gitContext) {
        toasts.error(result.error ? `Couldn't switch branch: ${result.error}` : "Couldn't switch branch")
        return false
      }
      if (session) {
        session.workingDirectory = projectRoot
        session.gitContext = result.gitContext
        session.worktreeBaseBranch = null
        session.agentSessionId = null
        session.provider = null
        session.sessionChangedFiles.splice(0, session.sessionChangedFiles.length)
        session.pluginCommands = { global: [], project: [] }
        this.deps.refreshPluginCommands(projectRoot, targetTabId)
        try {
          await api.resetTabSession(this.deps.ctx(targetTabId))
        } catch (error) {
          toasts.error(`Switched branch, but couldn't reset the tab session: ${error instanceof Error ? error.message : String(error)}`)
        }
      } else {
        this.globalDefaults.workingDirectory = projectRoot
        this.globalDefaults.gitContext = result.gitContext
        this.deps.refreshPluginCommands(projectRoot)
      }
      this.deps.refreshGitRefs(projectRoot, this.deps.ctxForDirectory(projectRoot))
      return true
    } catch (error) {
      toasts.error(`Couldn't switch branch: ${error instanceof Error ? error.message : String(error)}`)
      return false
    } finally {
      this.switchingBranch = false
    }
  }

  async setBaseDirectory(dir: string, tabId?: string): Promise<void> {
    const targetSession = tabId
      ? this.deps.registry.sessionFor(tabId)
      : this.deps.registry.activeSession
    if (!tabId && targetSession?.agentSessionId) {
      await this.deps.createTab()
    }
    if (!tabId && this.deps.registry.tabOrder.length === 0) {
      const createdTabId = await this.deps.createTab(dir)
      void this.apiFor(createdTabId).trackRecentProject(dir)
      return
    }
    const targetTabId = tabId ?? this.deps.registry.activeTabId
    const session = tabId
      ? this.deps.registry.sessionFor(tabId)
      : this.deps.registry.activeSession
    if (!session) return
    session.workingDirectory = dir
    session.agentSessionId = null
    session.provider = null
    session.additionalDirs = []
    session.gitContext = null
    session.worktreeBaseBranch = null
    session.readOnlyReason = null
    session.pluginCommands = { global: [], project: [] }
    const api = this.apiFor(targetTabId)
    api.resetTabSession(this.deps.ctx(targetTabId))
    this.deps.refreshPluginCommands(dir, targetTabId)
    await this.trackSessionStartTargetResolution(
      targetTabId,
      this.deps.refreshGitState({
        tabId: targetTabId,
        cwd: dir,
        worktreeRequested: this.deps.settings.worktreeEnabled,
      }),
    )
    void api.trackRecentProject(dir)
  }

  pendingSessionStartTarget(tabId?: string): Promise<void> | null {
    return this.sessionStartTargetResolutions.get(tabId ?? '') ?? null
  }

  private async trackSessionStartTargetResolution(
    tabId: string | undefined,
    refresh: Promise<GitRefreshResult>,
  ): Promise<void> {
    const key = tabId ?? ''
    const resolution = refresh.then(() => {})
    this.sessionStartTargetResolutions.set(key, resolution)
    try {
      await resolution
    } finally {
      if (this.sessionStartTargetResolutions.get(key) === resolution) {
        this.sessionStartTargetResolutions.delete(key)
      }
    }
  }

  addDirectory(dir: string): void {
    const session = this.deps.registry.activeSession
    if (!session) return
    if (!session.additionalDirs.includes(dir)) session.additionalDirs.push(dir)
  }

  removeDirectory(dir: string): void {
    const session = this.deps.registry.activeSession
    if (!session) return
    session.additionalDirs = session.additionalDirs.filter((d) => d !== dir)
  }

  defaultModelConfigFor(agentId: AgentId): ModelConfig {
    const profiles = MODEL_PROFILES[agentId as keyof typeof MODEL_PROFILES]
    if (!profiles) return { modelId: null, reasoningEffort: 'high', contextWindow: null, fastMode: false }
    const defaultEntry = Object.entries(profiles).find(([, p]) => (p as ModelProfile).isDefault)
    if (!defaultEntry) return { modelId: null, reasoningEffort: 'high', contextWindow: null, fastMode: false }
    const [modelId, profile] = defaultEntry
    return {
      modelId,
      reasoningEffort: (profile as ModelProfile).defaultReasoningEffort,
      contextWindow: null,
      fastMode: false,
    }
  }

  defaultReasoningEffortFor(agentId: AgentId, modelId: string | null): ReasoningEffort {
    const modelDefault = modelId
      ? MODEL_PROFILES[agentId as keyof typeof MODEL_PROFILES]?.[modelId]?.defaultReasoningEffort
      : null
    return modelDefault ?? this.defaultModelConfigFor(agentId).reasoningEffort
  }
}
