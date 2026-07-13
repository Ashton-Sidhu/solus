import type { AgentId, IpcContext, ModelConfig, ModelProfile, ReasoningEffort, Session, TabGitContext } from '../../shared/types'
import { MODEL_PROFILES, isSolusWorktreePath, tabGitContextFromStatus, worktreeProjectRoot } from '../../shared/types'
import { analytics } from '../lib/analytics'
import { TAB_GROUP_MODES, type SettingsContext, type TabGroupMode } from './settings.context.svelte'
import type { StatusBarContext } from './status-bar.context.svelte'
import type { TabRegistry } from './tab-registry.svelte'
import { toasts } from './toast.store.svelte'

export interface SessionConfigControllerDeps {
  settings: SettingsContext
  registry: TabRegistry
  statusBar: StatusBarContext
  setPluginCommands(commands: Session['pluginCommands']): void
  createTab(): Promise<string>
  ctx(): IpcContext
  ctxForDirectory(dir: string): IpcContext
  refreshPluginCommands(dir: string, tabId?: string): void
  refreshGitRefs(projectRoot: string, ctx: IpcContext): void
  refreshGitEnvironment(opts: { tabId?: string; cwd?: string }): void
}

export class SessionConfigController {
  globalDefaults = $state<{
    permissionMode: 'ask' | 'auto' | 'plan'
    workingDirectory: string
    gitContext: TabGitContext | null
    modelConfig: ModelConfig
  }>({
    permissionMode: 'auto',
    workingDirectory: '~',
    gitContext: null,
    modelConfig: { modelId: null, reasoningEffort: 'high', contextWindow: null, fastMode: false },
  })
  tabGroupMode = $state<TabGroupMode>('flat')

  constructor(private deps: SessionConfigControllerDeps) {
    this.globalDefaults.modelConfig = this.defaultModelConfigFor(deps.settings.activeAgent as AgentId)
    this.tabGroupMode = deps.settings.tabGroupMode
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

  switchActiveAgent(agentId: AgentId): void {
    const session = this.deps.registry.activeSession
    if (session) {
      if (session.provider === agentId) return
      const isLocked = session.status === 'connecting' || session.status === 'running'
      const hasLiveSession = !!session.agentSessionId && session.status !== 'interrupted'
      if (isLocked || hasLiveSession) return
    }
    analytics.agentSwitched({ from: this.deps.settings.activeAgent, to: agentId })
    this.deps.settings.update({ activeAgent: agentId })
    const newModelConfig = this.defaultModelConfigFor(agentId)
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
    for (const tabId of this.deps.registry.tabOrder) {
      const session = this.deps.registry.sessionFor(tabId)
      if (!session || session.agentSessionId || session.gitContext?.worktreePath) continue
      if (session.status === 'connecting' || session.status === 'running') continue
      session.worktreeBaseBranch = enabled ? (session.gitContext?.targetBranch ?? null) : null
    }
  }

  toggleWorktreeMode(): void {
    const session = this.deps.registry.activeSession
    if (!session) {
      this.deps.settings.update({ worktreeEnabled: !this.deps.settings.worktreeEnabled })
      return
    }
    if (session.gitContext?.worktreePath) return
    if (session.worktreeBaseBranch) {
      session.worktreeBaseBranch = null
    } else {
      session.worktreeBaseBranch = session.gitContext?.targetBranch ?? null
    }
  }

  async switchToWorktree(worktreePath: string): Promise<void> {
    const workingDirectory = this.deps.statusBar.ctx.workingDirectory
    if (!workingDirectory || workingDirectory === '~') return
    if (this.deps.registry.activeSession?.agentSessionId) {
      await this.deps.createTab()
    }
    const session = this.deps.registry.activeSession
    const isSolusWorktree = isSolusWorktreePath(worktreePath)
    const projectRoot = isSolusWorktree ? worktreeProjectRoot(worktreePath) : worktreePath
    const repoCtx = this.deps.ctxForDirectory(projectRoot)
    if (session) window.solus.resetTabSession(repoCtx)
    const restored: TabGitContext | null = isSolusWorktree
      ? await window.solus.worktreeRestore(repoCtx, worktreePath, { includePr: false })
      : tabGitContextFromStatus(await window.solus.gitProjectStatus(worktreePath).catch(() => null))
    if (session) {
      session.workingDirectory = projectRoot
      session.gitContext = restored
      session.worktreeBaseBranch = null
      this.deps.refreshPluginCommands(projectRoot)
    } else if (restored) {
      this.globalDefaults.workingDirectory = projectRoot
      this.globalDefaults.gitContext = restored
      this.deps.refreshPluginCommands(projectRoot)
    }
    if (!restored && session) {
      this.deps.refreshGitEnvironment({ tabId: this.deps.registry.activeTabId })
    }
    this.deps.refreshGitRefs(projectRoot, repoCtx)
  }

  async switchToBranch(branch: string): Promise<boolean> {
    const activeSession = this.deps.registry.activeSession
    const baseDir = activeSession?.gitContext?.repoRoot ?? activeSession?.workingDirectory ?? this.globalDefaults.gitContext?.repoRoot ?? this.globalDefaults.workingDirectory
    if (!baseDir || baseDir === '~') return false
    const projectRoot = worktreeProjectRoot(baseDir)
    if (activeSession?.agentSessionId) {
      await this.deps.createTab()
    }
    const session = this.deps.registry.activeSession
    const ctx = this.deps.ctxForDirectory(projectRoot)
    if (session) window.solus.resetTabSession(ctx)
    const result = await window.solus.gitCheckoutBranch(ctx, branch)
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
      session.changedFiles = []
      session.pluginCommands = { global: [], project: [] }
      this.deps.refreshPluginCommands(projectRoot)
    } else {
      this.globalDefaults.workingDirectory = projectRoot
      this.globalDefaults.gitContext = result.gitContext
      this.deps.refreshPluginCommands(projectRoot)
    }
    this.deps.refreshGitRefs(projectRoot, ctx)
    return true
  }

  async setBaseDirectory(dir: string): Promise<void> {
    const activeSession = this.deps.registry.activeSession
    if (activeSession?.agentSessionId) {
      await this.deps.createTab()
    }
    if (this.deps.registry.tabOrder.length === 0) {
      this.globalDefaults.workingDirectory = dir
      this.globalDefaults.gitContext = null
      void window.solus.trackRecentProject(dir)
      return
    }
    const session = this.deps.registry.activeSession
    if (!session) return
    session.workingDirectory = dir
    session.agentSessionId = null
    session.provider = null
    session.additionalDirs = []
    session.gitContext = null
    session.readOnlyReason = null
    session.pluginCommands = { global: [], project: [] }
    window.solus.resetTabSession(this.deps.ctx())
    this.deps.refreshPluginCommands(dir)
    this.deps.refreshGitEnvironment({ tabId: this.deps.registry.activeTabId, cwd: dir })
    void window.solus.trackRecentProject(dir)
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
