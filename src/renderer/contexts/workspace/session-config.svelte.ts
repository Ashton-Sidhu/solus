import type { AgentId, GitCheckout, IpcContext, ModelConfig, ReasoningEffort, RunConfig, Session, WorktreeEntry } from '../../../shared/types'
import type { Via } from '../../../shared/analytics-events'
import { MODEL_PROFILES, gitCheckoutFromState, isSolusWorktreePath, worktreeProjectRoot } from '../../../shared/types'
import { track } from '../../lib/analytics'
import { TAB_GROUP_MODES, type SettingsContext, type TabGroupMode } from '../app/settings.context.svelte'
import type { GitRefreshResult } from '../git/session-environment.store.svelte'
import type { StatusBarContext } from '../app/status-bar.context.svelte'
import type { TabRegistry } from './tab-registry.svelte'
import type { SessionDraft } from './session-draft.svelte'
import { toasts } from '../../lib/toasts'
import { isDispatch, startsWorktree, withCheckout, withDispatchBaseBranch, withDispatchWorktree, withWorktreeToggled } from './run-config'
import { nextMsgId } from './session.utils'
import type { HostApi } from '@client-core/host-api'
import { serverConnections } from '@client-core/server-connections'

/** What a destination command edits: the run a source owns, and the started
 *  session behind it when there is one. A draft resolves to a run with no
 *  session; a tab to its session's run. `apply` writes the run back onto
 *  whichever owns it, so the caller never learns which of the two it holds. */
interface RunOwner {
  /** The source id the run is reached by — a draft id, or a started session's
   *  tab id. What the environment refresh and the first-prompt gate key on, and
   *  the tab a session reset clears. A draft never reaches the reset path, so
   *  this is only ever read as a tab id where one genuinely exists. */
  id: string
  run: RunConfig
  session?: Session
  apply(next: RunConfig): void
}

const AGENT_LABELS = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
} satisfies Record<AgentId, string>

export interface SessionConfigControllerDeps {
  settings: SettingsContext
  registry: TabRegistry
  statusBar: StatusBarContext
  setPluginCommands(commands: Session['pluginCommands']): void
  /** Start a new prompt pointed at `cwd`. No session and no tab exist until it
   *  is sent, which is what makes "change where work happens" free when the
   *  conversation on screen has already started. */
  openSessionDraft(cwd?: string): void
  /** The draft a source id names, when it names one rather than a tab. */
  draftFor(sourceId: string): SessionDraft | undefined
  ctx(tabId?: string): IpcContext
  ctxForDirectory(dir: string): IpcContext
  apiFor?(tabId?: string): HostApi
  /** The RPC surface for the host a run names — the machine work happens on.
   *  Where a destination command talks to, resolved from the run rather than a
   *  tab, so a draft on a remote host reaches that host with no session. */
  apiForRun(run: RunConfig | undefined): HostApi
  refreshPluginCommands(dir: string, tabId?: string): void
  rekeyTaskSessionBinding(sourceSessionId: string, targetSessionId: string, serverId?: string): void
  refreshGitRefs(projectRoot: string, ctx: IpcContext): void
  refreshGitState(opts: { sourceId?: string; cwd?: string; worktreeRequested?: boolean }): Promise<GitRefreshResult>
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
    this.globalDefaults.modelConfig = this.defaultModelConfigFor(deps.settings.activeAgent)
    this.tabGroupMode = deps.settings.tabGroupMode
  }

  private apiFor(tabId?: string): HostApi {
    return this.deps.apiFor?.(tabId) ?? serverConnections.primaryApi()
  }

  /**
   * The run a destination command edits in place. A source names a tab or a
   * draft; without one it is the active conversation. Returns null when there is
   * nothing pre-flight to edit — a running conversation or an empty workspace —
   * so the caller opens a fresh draft there rather than moving work beneath the
   * user. An explicit source is always something pointed at on purpose, so it
   * resolves even when its session has started; only the active fallback guards.
   */
  private ownerFor(sourceId?: string): RunOwner | null {
    if (sourceId) {
      const session = this.deps.registry.sessionFor(sourceId)
      if (session) return { id: sourceId, run: session.run, session, apply: (next) => { session.run = next } }
      const draft = this.deps.draftFor(sourceId)
      if (draft) return { id: sourceId, run: draft.run, apply: (next) => { draft.run = next } }
      return null
    }
    const session = this.deps.registry.activeSession
    if (!session || session.agentSessionId) return null
    return { id: this.deps.registry.activeTabId, run: session.run, session, apply: (next) => { session.run = next } }
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
    const mc = session ? session.run.modelConfig : this.globalDefaults.modelConfig

    const nextModelId = patch.modelId ?? null
    if ('modelId' in patch && nextModelId !== mc.modelId) {
      const provider = session?.run.provider ?? this.deps.settings.activeAgent
      const profile = MODEL_PROFILES[provider]?.[nextModelId ?? '']
      mc.modelId = nextModelId
      mc.reasoningEffort = patch.reasoningEffort ?? profile?.defaultReasoningEffort ?? 'high'
      // Each model carries its own window; keeping the outgoing model's value
      // would run the new one against a limit it never agreed to.
      mc.contextWindow = patch.contextWindow ?? profile?.defaultContextWindow ?? null
      mc.fastMode = patch.fastMode ?? (profile?.supportsFastMode ? mc.fastMode : false)
      return
    }

    if (patch.reasoningEffort !== undefined) mc.reasoningEffort = patch.reasoningEffort
    if (patch.contextWindow !== undefined) mc.contextWindow = patch.contextWindow
    if (patch.fastMode !== undefined) mc.fastMode = patch.fastMode
  }

  /** The agent new sessions start on. It is a preference, so it never rewrites
   *  the provider of a conversation already on screen — handing a session over
   *  is `switchActiveAgent`, and only an action aimed at that session may do it. */
  setDefaultAgent(agentId: AgentId, via: Via = 'click'): void {
    if (this.deps.settings.activeAgent === agentId) return
    track('agent_switched', { from: this.deps.settings.activeAgent, to: agentId, via })
    this.deps.settings.update({ activeAgent: agentId })
    this.globalDefaults.modelConfig = this.defaultModelConfigFor(agentId)
    this.deps.setPluginCommands({ global: [], project: [] })
    this.deps.refreshPluginCommands(this.globalDefaults.workingDirectory)
  }

  /** Keep the next-session defaults aligned with the session brought to the
   *  foreground. Selecting a tab already makes its agent the saved default;
   *  its model default must move with it or a fresh draft can pair a Claude
   *  provider glyph with a Codex model (or the reverse). */
  followActiveSessionAgent(agentId: AgentId): void {
    if (this.deps.settings.activeAgent === agentId) return
    this.deps.settings.update({ activeAgent: agentId })
    this.globalDefaults.modelConfig = this.defaultModelConfigFor(agentId)
  }

  async switchActiveAgent(agentId: AgentId, tabId?: string, via: Via = 'click'): Promise<void> {
    const targetTabId = tabId ?? this.deps.registry.activeTabId
    const session = tabId ? this.deps.registry.sessionFor(tabId) : this.deps.registry.activeSession
    if (this.handoffInProgress) return
    if (session) {
      if (session.run.provider === agentId) return
      if (session.status === 'connecting' || session.status === 'running') return
    }

    const newModelConfig = this.defaultModelConfigFor(agentId)
    if (!session?.agentSessionId && !session?.handoffId) {
      track('agent_switched', { from: this.deps.settings.activeAgent, to: agentId, via })
      this.deps.settings.update({ activeAgent: agentId })
      this.globalDefaults.modelConfig = newModelConfig
      this.deps.setPluginCommands({ global: [], project: [] })
      if (!session) {
        this.deps.refreshPluginCommands(this.globalDefaults.workingDirectory)
        return
      }
      session.run.provider = agentId
      session.agentSessionId = null
      session.run.modelConfig = { ...newModelConfig }
      session.sessionModel = null
      session.run.sessionSkills = []
      session.pluginCommands = { global: [], project: [] }
      this.deps.refreshPluginCommands(session.run.workingDirectory, this.deps.registry.activeTabId)
      return
    }

    this.handoffInProgress = true
    try {
      // The server keeps a session record only while a runtime is attached, so an
      // idle conversation must carry its own provider thread into the handoff.
      const result = await this.apiFor(targetTabId).switchSessionAgent(session.id, agentId, session.agentSessionId)
      track('agent_switched', { from: result.fromProvider, to: agentId, via })
      this.deps.settings.update({ activeAgent: agentId })
      this.globalDefaults.modelConfig = newModelConfig
      this.deps.setPluginCommands({ global: [], project: [] })
      session.run.provider = agentId
      session.agentSessionId = result.restoredSessionId ?? null
      session.run.modelConfig = { ...newModelConfig }
      session.sessionModel = null
      session.run.sessionSkills = []
      session.pluginCommands = { global: [], project: [] }
      session.handoffId = result.handoffId
      session.handoffFrom = undefined
      session.status = 'idle'
      session.currentTurnStartedAt = null
      session.rateLimitInfo = null
      this.deps.rekeyTaskSessionBinding(
        result.taskSessionMove.sourceSessionId,
        result.taskSessionMove.targetSessionId,
        session.run.taskServerId,
      )
      const agentChangedTo = AGENT_LABELS[agentId]
      if (result.restoredSessionId) {
        const pendingDivider = session.messages.findLastIndex((message) => !!message.agentChangedTo)
        if (pendingDivider !== -1) session.messages.splice(pendingDivider, 1)
      } else {
        session.messages.push({
          id: nextMsgId(),
          role: 'system',
          content: `Switched to ${agentChangedTo}`,
          timestamp: Date.now(),
          agentChangedTo,
        })
      }
      this.deps.refreshPluginCommands(session.run.workingDirectory, targetTabId)
    } catch (error) {
      toasts.error("Couldn't hand off session", {
        description: error instanceof Error ? error.message : String(error),
      })
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
    session.run.permissionMode = mode
  }

  setWorktreeBaseBranch(branch: string | null): void {
    const session = this.deps.registry.activeSession
    if (!session) return
    session.run.worktree = branch ? { baseBranch: branch } : null
  }

  setDispatchWorktree(worktree: WorktreeEntry | null, sourceId?: string): void {
    const owner = this.ownerFor(sourceId)
    if (!owner) return
    owner.apply(withDispatchWorktree(owner.run, worktree))
  }

  setDispatchBaseBranch(branch: string, sourceId?: string): void {
    const owner = this.ownerFor(sourceId)
    if (!owner) return
    owner.apply(withDispatchBaseBranch(owner.run, branch))
  }

  syncWorktreeDefault(enabled: boolean): void {
    this.globalDefaults.worktreeBaseBranch = enabled
      ? this.globalDefaults.gitContext?.targetBranch ?? null
      : null
    for (const tabId of this.deps.registry.tabOrder) {
      const session = this.deps.registry.sessionFor(tabId)
      if (!session || session.agentSessionId || session.run.gitContext?.worktreePath) continue
      if (session.status === 'connecting' || session.status === 'running') continue
      // A dispatched session's checkout choice is not the global default's to revoke.
      if (isDispatch(session.run)) continue
      session.run.worktree = enabled ? { baseBranch: session.run.gitContext?.targetBranch ?? null } : null
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
    // Worktree mode only chooses where a new session starts. A running session
    // moves through continueInWorktree instead; this guard also keeps the global
    // shortcut from changing where an existing conversation runs.
    if (session.agentSessionId) return
    // A dispatched session's checkout was settled before Send. Do not let the
    // global shortcut change it after the host move.
    if (isDispatch(session.run)) return
    const next = withWorktreeToggled(session.run)
    const reanchored = next.workingDirectory !== session.run.workingDirectory
    session.run = next
    if (reanchored) {
      this.deps.refreshPluginCommands(next.workingDirectory, tabId ?? this.deps.registry.activeTabId)
    }
  }

  async switchToWorktree(worktreePath: string, sourceId?: string): Promise<void> {
    const isSolusWorktree = isSolusWorktreePath(worktreePath)
    const projectRoot = isSolusWorktree ? worktreeProjectRoot(worktreePath) : worktreePath
    const owner = this.ownerFor(sourceId)
    // The conversation on screen has already started, or there is none. Either
    // way there is nothing here to point somewhere else: entering a worktree is
    // a new piece of work, so it opens a draft there and leaves the running
    // session where it is.
    if (!owner) {
      this.deps.openSessionDraft(worktreePath)
      return
    }
    const repoCtx = this.deps.ctxForDirectory(projectRoot)
    const api = this.deps.apiForRun(owner.run)
    if (owner.session) api.resetSession(this.deps.ctx(owner.id))
    const restored: GitCheckout | null = isSolusWorktree
      ? await api.worktreeRestore(repoCtx, worktreePath, { includePr: false })
      : gitCheckoutFromState(await api.gitRefreshState(worktreePath).catch(() => null))
    owner.apply(withCheckout(owner.run, projectRoot, restored))
    // Plugin commands and the reset scan belong to a started session; a draft
    // resolves its checkout through refreshGitRefs alone.
    if (owner.session) {
      this.deps.refreshPluginCommands(projectRoot, owner.id)
      if (!restored) this.deps.refreshGitState({ sourceId: owner.id })
    }
    this.deps.refreshGitRefs(projectRoot, repoCtx)
  }

  async switchToBranch(branch: string, sourceId?: string): Promise<boolean> {
    if (this.switchingBranch) return false
    this.switchingBranch = true
    try {
      const owner = this.ownerFor(sourceId)
      if (owner?.run.pendingHostDispatch?.intent === 'dispatch') {
        return false
      }
      // With no pre-flight owner the branch still checks out on disk against the
      // conversation on screen — its run names the repo and the host to do it on.
      const contextRun = owner?.run ?? this.deps.registry.activeSession?.run
      const baseDir = contextRun?.gitContext?.repoRoot ?? contextRun?.workingDirectory ?? this.globalDefaults.gitContext?.repoRoot ?? this.globalDefaults.workingDirectory
      if (!baseDir || baseDir === '~') {
        toasts.error("Couldn't switch branch", { description: "No active Git repository" })
        return false
      }
      const projectRoot = worktreeProjectRoot(baseDir)
      const ctx = this.deps.ctxForDirectory(projectRoot)
      const api = this.deps.apiForRun(contextRun)
      const result = await api.gitCheckoutBranch(ctx, branch)
      if (!result.success || !result.gitContext) {
        toasts.error("Couldn't switch branch", { description: result.error })
        return false
      }
      // A source pointed at on purpose — a draft or a pre-flight tab — takes the
      // checkout in place. With no pre-flight owner the conversation on screen
      // has started: the checkout still happens on disk, and the next session
      // starts there instead rather than switching beneath the user.
      if (owner) {
        owner.apply(withCheckout(owner.run, projectRoot, result.gitContext))
        // Detaching from the provider thread is session reset, not run config:
        // a draft has neither, so it never reaches this branch.
        if (owner.session) {
          owner.session.agentSessionId = null
          owner.session.run.provider = null
          owner.session.sessionChangedFiles.splice(0, owner.session.sessionChangedFiles.length)
          owner.session.pluginCommands = { global: [], project: [] }
          this.deps.refreshPluginCommands(projectRoot, owner.id)
          try {
            await api.resetSession(this.deps.ctx(owner.id))
          } catch (error) {
            toasts.error("Switched branch, but couldn't reset the tab session", {
              description: error instanceof Error ? error.message : String(error),
            })
          }
        }
      } else {
        this.globalDefaults.workingDirectory = projectRoot
        this.globalDefaults.gitContext = result.gitContext
        this.deps.refreshPluginCommands(projectRoot)
        this.deps.openSessionDraft(projectRoot)
      }
      this.deps.refreshGitRefs(projectRoot, this.deps.ctxForDirectory(projectRoot))
      return true
    } catch (error) {
      toasts.error("Couldn't switch branch", {
        description: error instanceof Error ? error.message : String(error),
      })
      return false
    } finally {
      this.switchingBranch = false
    }
  }

  async setBaseDirectory(dir: string, sourceId?: string): Promise<void> {
    const owner = this.ownerFor(sourceId)
    // Same rule as the worktree switch: a conversation already under way does
    // not get moved to a different project beneath the user, and with no source
    // at all there is nothing to move.
    if (!owner) {
      this.deps.openSessionDraft(dir)
      void this.deps.apiForRun(undefined).trackRecentProject(dir)
      return
    }
    const api = this.deps.apiForRun(owner.run)
    owner.apply(withCheckout(owner.run, dir, null))
    // Detaching the provider thread and its plugin commands is session reset; a
    // draft has neither, so it only re-resolves its checkout below.
    if (owner.session) {
      owner.session.agentSessionId = null
      owner.session.run.provider = null
      owner.session.additionalDirs = []
      owner.session.readOnlyReason = null
      owner.session.pluginCommands = { global: [], project: [] }
      api.resetSession(this.deps.ctx(owner.id))
      this.deps.refreshPluginCommands(dir, owner.id)
    }
    await this.trackSessionStartTargetResolution(
      owner.id,
      this.deps.refreshGitState({
        sourceId: owner.id,
        cwd: dir,
        worktreeRequested: owner.session ? this.deps.settings.worktreeEnabled : startsWorktree(owner.run),
      }),
    )
    void api.trackRecentProject(dir)
  }

  pendingSessionStartTarget(tabId?: string): Promise<void> | null {
    return this.sessionStartTargetResolutions.get(tabId ?? '') ?? null
  }

  /** Registers a host/project move on the same gate the first prompt awaits.
   *  The source is a tab or a draft: both are somewhere a session will start. */
  refreshSessionStartTarget(
    sourceId: string,
    cwd: string,
    worktreeRequested: boolean,
  ): Promise<void> {
    return this.trackSessionStartTargetResolution(
      sourceId,
      this.deps.refreshGitState({ sourceId, cwd, worktreeRequested }),
    )
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

  /** Pin the model new sessions start on for one agent. Stored per agent, so the
   *  choice survives switching the default agent away and back. */
  setDefaultModel(agentId: AgentId, modelId: string): void {
    this.deps.settings.update({ defaultModels: { ...this.deps.settings.defaultModels, [agentId]: modelId } })
    if (agentId === this.deps.settings.activeAgent) {
      this.globalDefaults.modelConfig = this.defaultModelConfigFor(agentId)
    }
  }

  /** The model a new session starts on: the user's per-agent choice from Settings
   *  when it still belongs to this agent, otherwise the agent's built-in default. */
  defaultModelConfigFor(agentId: AgentId): ModelConfig {
    const profiles = MODEL_PROFILES[agentId]
    if (!profiles) return { modelId: null, reasoningEffort: 'high', contextWindow: null, fastMode: false }
    const chosenId = this.deps.settings.defaultModels[agentId]
    const defaultEntry =
      (chosenId && profiles[chosenId] ? [chosenId, profiles[chosenId]] : null) ??
      Object.entries(profiles).find(([, profile]) => profile.isDefault)
    if (!defaultEntry) return { modelId: null, reasoningEffort: 'high', contextWindow: null, fastMode: false }
    const [modelId, profile] = defaultEntry
    return {
      modelId,
      reasoningEffort: profile.defaultReasoningEffort,
      contextWindow: profile.defaultContextWindow ?? null,
      fastMode: false,
    }
  }

  defaultReasoningEffortFor(agentId: AgentId, modelId: string | null): ReasoningEffort {
    const modelDefault = modelId
      ? MODEL_PROFILES[agentId]?.[modelId]?.defaultReasoningEffort
      : null
    return modelDefault ?? this.defaultModelConfigFor(agentId).reasoningEffort
  }
}
