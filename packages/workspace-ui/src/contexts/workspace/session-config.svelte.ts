import type { AgentId, GitCheckout, IpcContext, ModelConfig, ReasoningEffort, RunConfig, Session, WorktreeEntry } from '@solus/contracts/types'
import type { Via } from '@solus/contracts/analytics-events'
import { MODEL_PROFILES, gitCheckoutFromState, isSolusWorktreePath, worktreeProjectRoot } from '@solus/contracts/types'
import { track } from '../../lib/analytics'
import { TAB_GROUP_MODES, type SettingsContext, type TabGroupMode } from '../app/settings.context.svelte'
import type { GitRefreshResult } from '../git/session-environment.store.svelte'
import type { StatusBarContext } from '../app/status-bar.context.svelte'
import type { TabRegistry } from './tab-registry.svelte'
import type { SessionDraft } from './session-draft.svelte'
import { toasts } from '../../lib/toasts'
import { isDispatch, startsWorktree, withCheckout, withDispatchBaseBranch, withDispatchWorktree, withWorktreeToggled } from './run-config'
import { nextMsgId } from './session.utils'
import type { HostApi } from '@solus/client-core/host-api'

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
  startNewTask(): void
}

/**
 * The model settings a patch produces. Naming a different model resets the three
 * values that belong to a model rather than to the composer: each model carries
 * its own window and effort, and keeping the outgoing model's would run the new
 * one against limits it never agreed to. Every other patch edits one field.
 */
function nextModelConfig(
  current: ModelConfig,
  patch: Partial<ModelConfig>,
  provider: AgentId,
): ModelConfig {
  const modelId = patch.modelId ?? null
  if ('modelId' in patch && modelId !== current.modelId) {
    const profile = MODEL_PROFILES[provider]?.[modelId ?? '']
    return {
      modelId,
      reasoningEffort: patch.reasoningEffort ?? profile?.defaultReasoningEffort ?? 'high',
      contextWindow: patch.contextWindow ?? profile?.defaultContextWindow ?? null,
      fastMode: patch.fastMode ?? (profile?.supportsFastMode ? current.fastMode : false),
    }
  }
  return {
    modelId: current.modelId,
    reasoningEffort: patch.reasoningEffort ?? current.reasoningEffort,
    contextWindow: patch.contextWindow !== undefined ? patch.contextWindow : current.contextWindow,
    fastMode: patch.fastMode ?? current.fastMode,
  }
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
  openSessionDraft(cwd?: string, freshTask?: boolean, gitContext?: GitCheckout | null): void
  /** The draft a source id names, when it names one rather than a tab. */
  draftFor(sourceId: string): SessionDraft | undefined
  ctx(tabId?: string): IpcContext
  ctxForDirectory(dir: string): IpcContext
  apiFor(tabId?: string): HostApi
  /** The RPC surface for the host a run names — the machine work happens on.
   *  Where a destination command talks to, resolved from the run rather than a
   *  tab, so a draft on a remote host reaches that host with no session. */
  apiForRun(run: RunConfig | undefined): HostApi
  refreshPluginCommands(dir: string, tabId?: string): void
  rekeyTaskSessionBinding(sourceSessionId: string, targetSessionId: string, serverId?: string): void
  refreshGitRefs(projectRoot: string, ctx: IpcContext): void
  refreshGitState(opts: { sourceId?: string; cwd?: string; worktreeRequested?: boolean }): Promise<GitRefreshResult>
  /** Bring an already-open tab to the front — the "matching tab" half of
   *  activating a checkout. */
  selectTab?(tabId: string): void
}

export class SessionConfigController {
  globalDefaults = $state<{
    permissionMode: 'ask' | 'auto' | 'plan'
    workingDirectory: string
    gitContext: GitCheckout | null
    modelConfig: ModelConfig
  }>({
    permissionMode: 'auto',
    workingDirectory: '~',
    gitContext: null,
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
      if (session) return {
        id: sourceId,
        run: session.run,
        session,
        apply: (next) => { session.run = next },
        startNewTask: () => { session.task = { kind: 'new' } },
      }
      const draft = this.deps.draftFor(sourceId)
      if (draft) return {
        id: sourceId,
        run: draft.run,
        apply: (next) => { draft.run = next },
        startNewTask: () => { draft.task = { kind: 'new' } },
      }
      return null
    }
    const session = this.deps.registry.activeSession
    if (!session || session.agentSessionId) return null
    return {
      id: this.deps.registry.activeTabId,
      run: session.run,
      session,
      apply: (next) => { session.run = next },
      startNewTask: () => { session.task = { kind: 'new' } },
    }
  }

  /** Single write path for the global Git start target: environment resolution
   * applies a resolved target, and tab creation clears a consumed one. */
  applyGlobalStartTarget(target: { gitContext: GitCheckout | null }): void {
    this.globalDefaults.gitContext = target.gitContext
  }

  toggleTabGroupMode(): void {
    const i = TAB_GROUP_MODES.indexOf(this.tabGroupMode)
    const tabGroupMode = TAB_GROUP_MODES[(i + 1) % TAB_GROUP_MODES.length]
    this.tabGroupMode = tabGroupMode
    this.deps.settings.update({ tabGroupMode })
  }

  /**
   * Change the model settings of the composer `tabId` names — a started
   * session's tab, or the draft composing one.
   *
   * A draft is a composer with a run of its own, and on a phone it is the only
   * one there is before Send. Resolving sessions alone sent every draft write
   * into the global defaults while the picker above it kept reading the draft's
   * run, so choosing a model changed nothing anyone could see.
   */
  updateModelConfig(patch: Partial<ModelConfig>, tabId?: string): void {
    const session = tabId ? this.deps.registry.sessionFor(tabId) : this.deps.registry.activeSession
    const draft = session || !tabId ? undefined : this.deps.draftFor(tabId)
    const current = session?.run.modelConfig ?? draft?.run.modelConfig ?? this.globalDefaults.modelConfig
    const provider = session?.run.provider ?? draft?.run.provider ?? this.deps.settings.activeAgent
    const next = nextModelConfig(current, patch, provider)

    if (session && next.modelId !== current.modelId) {
      this.nameModelOnPendingDivider(session, provider, next.modelId)
    }

    // A draft owns its run, so it is handed a new one rather than edited in
    // place — the same write the model chip's detached selection makes.
    if (draft) draft.run = { ...draft.run, modelConfig: next }
    else Object.assign(current, next)
  }

  /** A restored or already-bound handoff target still owns its active model, so
   *  the divider that opened it follows the picker rather than freezing on the
   *  model the handoff defaulted to. */
  private nameModelOnPendingDivider(session: Session, provider: AgentId, modelId: string | null): void {
    if (!modelId) return
    const pendingDivider = session.messages.findLast(
      (message) => message.agentChangedToProvider === provider,
    )
    if (pendingDivider) {
      pendingDivider.agentChangedToModel = MODEL_PROFILES[provider]?.[modelId]?.label ?? modelId
    }
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

  /**
   * Point a draft at another agent, answering whether `sourceId` named one.
   *
   * A draft has a run of its own and no conversation to hand over, so its switch
   * is a write to that run — the same one the desktop chip's detached selection
   * makes — and takes the new agent's default model, because the outgoing one
   * belongs to a provider this composer no longer runs. It is a choice about
   * this composer, so it does not move the agent the *next* one opens on.
   */
  private switchDraftAgent(sourceId: string | undefined, agentId: AgentId, via: Via): boolean {
    const draft = sourceId ? this.deps.draftFor(sourceId) : undefined
    if (!draft) return false
    if (draft.run.provider === agentId) return true
    track('agent_switched', { from: draft.run.provider ?? this.deps.settings.activeAgent, to: agentId, via })
    draft.run = {
      ...draft.run,
      provider: agentId,
      modelConfig: this.defaultModelConfigFor(agentId),
      sessionSkills: [],
    }
    this.deps.setPluginCommands({ global: [], project: [] })
    this.deps.refreshPluginCommands(draft.run.workingDirectory)
    return true
  }

  async switchActiveAgent(agentId: AgentId, tabId?: string, via: Via = 'click'): Promise<void> {
    const targetTabId = tabId ?? this.deps.registry.activeTabId
    const session = tabId ? this.deps.registry.sessionFor(tabId) : this.deps.registry.activeSession
    if (this.handoffInProgress) return
    if (session) {
      if (session.run.provider === agentId) return
      if (session.status === 'connecting' || session.status === 'running') return
    }

    if (!session && this.switchDraftAgent(tabId, agentId, via)) return

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
    const sourceModelId = session.sessionModel ?? session.run.modelConfig.modelId
    try {
      // The server keeps a session record only while a runtime is attached, so an
      // idle conversation must carry its own provider thread into the handoff.
      const result = await this.deps.apiFor(targetTabId).switchSessionAgent(session.id, agentId, session.agentSessionId)
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
        const sourceModel = sourceModelId
          ? MODEL_PROFILES[result.fromProvider]?.[sourceModelId]?.label ?? sourceModelId
          : undefined
        const targetModelId = newModelConfig.modelId
        const targetModel = targetModelId
          ? MODEL_PROFILES[agentId]?.[targetModelId]?.label ?? targetModelId
          : undefined
        session.messages.push({
          id: nextMsgId(),
          role: 'system',
          content: `Switched to ${agentChangedTo}`,
          timestamp: Date.now(),
          agentChangedTo,
          agentChangedFromModel: sourceModel,
          agentChangedToModel: targetModel,
          agentChangedFromProvider: result.fromProvider,
          agentChangedToProvider: agentId,
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
    if (session) {
      session.run.permissionMode = mode
      return
    }
    // Same draft/global split as the model above: a named draft is a composer
    // pointed at on purpose, and the mode it starts on is its own.
    const draft = tabId ? this.deps.draftFor(tabId) : undefined
    if (draft) draft.run = { ...draft.run, permissionMode: mode }
    else this.globalDefaults.permissionMode = mode
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

  /**
   * Flip where the run on screen will start: in its checkout, or in a worktree
   * branched from it.
   *
   * Isolation is a decision about one piece of work, so it is only ever a
   * property of a run — a started session's or a draft's. With no run to edit
   * there is nothing to flip and the toggle stands down.
   */
  toggleWorktreeMode(sourceId?: string): void {
    const owner = this.ownerFor(sourceId)
    if (!owner) return
    // Worktree mode only chooses where a new session starts. A running session
    // moves through continueInWorktree instead; this guard also keeps the global
    // shortcut from changing where an existing conversation runs.
    if (owner.session?.agentSessionId) return
    // A dispatched session's checkout was settled before Send. Do not let the
    // global shortcut change it after the host move.
    if (isDispatch(owner.run)) return
    const next = withWorktreeToggled(owner.run)
    const reanchored = next.workingDirectory !== owner.run.workingDirectory
    owner.apply(next)
    // Same rule as the worktree switch: plugin commands belong to a started
    // session, so a draft's re-anchor has no tab to refresh them against.
    if (reanchored && owner.session) this.deps.refreshPluginCommands(next.workingDirectory, owner.id)
  }

  async switchToWorktree(worktreePath: string, sourceId?: string): Promise<void> {
    const isSolusWorktree = isSolusWorktreePath(worktreePath)
    const owner = this.ownerFor(sourceId)
    const contextRun = owner?.run ?? this.deps.registry.activeSession?.run
    // Worktrees can live anywhere, not only under Solus' managed directory.
    // The checkout already knows its canonical repository root, so retain that
    // identity instead of promoting an arbitrary worktree path to a project.
    const projectRoot = contextRun?.gitContext?.repoRoot
      ?? this.globalDefaults.gitContext?.repoRoot
      ?? (isSolusWorktree ? worktreeProjectRoot(worktreePath) : worktreePath)
    const repoCtx = this.deps.ctxForDirectory(projectRoot)
    const api = this.deps.apiForRun(contextRun)
    const restored: GitCheckout | null = isSolusWorktree
      ? await api.worktreeRestore(repoCtx, worktreePath)
      : gitCheckoutFromState(
          await api.gitRefreshState(worktreePath).catch(() => null),
          worktreePath,
        )
    // The conversation on screen has already started, or there is none. Either
    // way there is nothing here to point somewhere else: entering a worktree is
    // a new piece of work, so it opens a draft for that checkout and leaves the
    // running session where it is. The draft names the project root while its
    // Git context carries the selected worktree.
    if (!owner) {
      this.deps.openSessionDraft(projectRoot, false, restored)
      this.deps.refreshGitRefs(projectRoot, repoCtx)
      return
    }
    if (owner.session) api.resetSession(this.deps.ctx(owner.id))
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
      this.deps.openSessionDraft(dir, true)
      void this.deps.apiForRun(undefined).trackRecentProject(dir)
      return
    }
    const api = this.deps.apiForRun(owner.run)
    owner.startNewTask()
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
        // `withCheckout` above carried the isolation request across the move —
        // wanting a worktree is a preference about the work, not the folder.
        worktreeRequested: startsWorktree(owner.run),
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
