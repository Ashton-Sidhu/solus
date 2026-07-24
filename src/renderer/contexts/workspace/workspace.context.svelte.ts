import { createContext } from 'svelte'
import type { AgentId, NormalizedEvent, EnrichedError, Message, Tab, InputState, Session, DiffCommentDraft, DiffComment, Attachment, PlanDescriptor, SessionCtx, IpcContext, TurnSnapshot, QueuedPromptSnapshot, ModelConfig, SessionMeta, GitCheckout, Work, StatusCardState, PrReviewContext } from '../../../shared/types'
import type { PullRequestSummary } from '../../../shared/providers'
import { buildConflictResolutionPrompt, buildConflictResolverCard, buildConflictResolverErrorCard } from '../../lib/pr-conflict-resolution'
import { adjacentTabAfterClose, branchKeyFor, buildTabSections, findOpenTabForSession } from '../../lib/sessionUtils'
import { uuid } from '../../../shared/uuid'
import { workPreview } from '../../../shared/work-preview'
import notificationSrc from '../../../../resources/notification.mp3'
import { sendRateLimitedNow } from '../../lib/rate-limit-actions'
import { type PlanStore } from '../plans/plan.store.svelte'
import { WorksStore } from '../works/works.store.svelte'
import { AutomationsStore } from '../automations/automations.store.svelte'
import { TasksStore } from '../tasks/tasks.store.svelte'
import { PrsStore } from '../prs/prs.store.svelte'
import { StacksStore } from '../prs/stacks.store.svelte'
import { type Task } from '../../../shared/task-types'
import { writeSessionHandoff } from './active-session-pointer'
import { toasts } from '../app/toast.store.svelte'
import { PaneViewStore, type SplitOpenOptions } from './pane-view.store.svelte'
import { WorkStreamTracker } from './work-stream-tracker.svelte'
import { WorkspaceUiStore, type SettingsTab } from './workspace-ui.store.svelte'
import { IpcContextBuilder } from './ipc-context'
import { PromptComposer } from './prompt-composer'
import { TabRegistry } from './tab-registry.svelte'
import { SessionConfigController } from './session-config.svelte'
import { WorkspaceLifecycleStore, type StaticInfo } from './workspace-lifecycle.store.svelte'
import { SessionEventReducer } from './session-event-reducer.svelte'
import { type SettingsContext, type TabGroupMode } from '../app/settings.context.svelte'
import { type WindowContext } from '../app/window.context.svelte'
import { type StatusBarContext } from '../app/status-bar.context.svelte'
import { type AgentContext } from '../app/agent.context.svelte'
import { type GitRefreshResult, type SessionEnvironmentStore } from '../git/session-environment.store.svelte'
import { makeSession, makeTab, makeInputState } from './session.factories'
import { removeDraft } from './tab-persistence'
import { nextMsgId } from './session.utils'
import { gitCheckoutFromState, isSolusWorktreePath, worktreeProjectRoot } from '../../../shared/types'
import { syncPendingInputFromEvent, loadSessionTranscript } from './session-transcript'
import { addDiffComment, updateDiffComment, removeDiffComment, restoreDiffComment, clearDiffComments, setDiffCommentDraft, updateDiffCommentDraftValue, setDiffGeneralComment, submitDiffFeedback, submitDiffFeedbackToNewSession } from './session-diff-feedback'
import { clearPlanWaiting, openPlanModal, closePlanModal, requestConversationScrollToBottom, approvePlanWithModel, rejectPlan, openPlanFromDescriptor, closePlanPreview, resumeSessionFromDescriptor, type ApprovePlanOptions } from './session-plan-operations'
import { analytics } from '../../lib/analytics'
import { requestInputFocus } from '../../lib/inputFocus'
import { disposeGitActions } from '../../lib/git-actions.svelte'
import { prioritizeTabHydration } from './session-bootstrap'
import { buildPrCommentsFixPrompt, type PrFixFeedback } from './pr-fix-session'
import { isPristineSplitTab } from '../../lib/split-chat'
import {
  beginPrReviewProfile,
  markPrReviewProfile,
  settlePrReviewProfile,
} from '../../components/pr-review/lib/pr-review-profiler'

const devSessionLogging = Boolean((import.meta as any).env?.DEV)

function logDevSessionState(tab: Tab, eventType: string, session: Session): void {
  if (!devSessionLogging) return
  // Log a shallow summary only — never $state.snapshot(session), which deep-clones
  // every message on each event and dominates the reducer's per-event cost.
  console.debug('[Solus][SessionState]', {
    tabId: tab.id,
    sessionId: session.agentSessionId,
    provider: session.provider,
    status: session.status,
    eventType,
    messageCount: session.messages.length,
  })
}

export type SessionFields = {
  isExpanded: boolean
  staticInfo: StaticInfo | null
  pendingInput: string | null
}

interface CreateTabOptions {
  activate?: boolean
  gitContext?: GitCheckout | null
  gitInitialization?: 'blocking' | 'background'
  worktreeRequested?: boolean
}

const notificationAudio = new Audio(notificationSrc)
notificationAudio.volume = 1.0

export class WorkspaceContext {
  registry = new TabRegistry()
  lifecycle: WorkspaceLifecycleStore
  pendingInput = $state<string | null>(null)
  eventReducer: SessionEventReducer

  planStore: PlanStore
  worksStore: WorksStore
  automationsStore = new AutomationsStore()
  tasksStore = new TasksStore()
  prsStore = new PrsStore()
  stacksStore = new StacksStore()
  /** Global two-pane view state — not per-tab. */
  panes = new PaneViewStore()
  ui: WorkspaceUiStore
  config: SessionConfigController
  onTurnSettled?: (tabId: string, cwd: string | null) => void

  settings: SettingsContext
  private window: WindowContext
  private statusBar: StatusBarContext
  private agent?: AgentContext
  private workStreamTracker: WorkStreamTracker
  private ipcContextBuilder: IpcContextBuilder
  private promptComposer: PromptComposer
  environment: SessionEnvironmentStore

  constructor(settings: SettingsContext, windowCtx: WindowContext, statusBar: StatusBarContext, planStore: PlanStore, environment: SessionEnvironmentStore, agent?: AgentContext) {
    this.settings = settings
    this.window = windowCtx
    this.statusBar = statusBar
    this.agent = agent
    this.planStore = planStore
    this.environment = environment
    this.environment.bindWorkspace(this)
    this.worksStore = new WorksStore()
    this.config = new SessionConfigController({
      settings: this.settings,
      registry: this.registry,
      statusBar: this.statusBar,
      setPluginCommands: (commands) => { this.pluginCommands = commands },
      createTab: (cwd) => this.createTab(cwd),
      ctx: (tabId) => tabId ? this.ctxFor(tabId) : this.ctx,
      ctxForDirectory: (dir) => this.ctxForDirectory(dir),
      refreshPluginCommands: (dir, tabId) => { void this.refreshPluginCommands(dir, tabId) },
      refreshGitRefs: (projectRoot, ctx) => { void this.environment.refreshRefs(projectRoot, ctx, { force: true }) },
      refreshGitState: (opts) => this.environment.refreshTab(this, opts),
    })
    this.lifecycle = new WorkspaceLifecycleStore({
      registry: this.registry,
      settings: this.settings,
      config: this.config,
      planStore: this.planStore,
      agent: this.agent,
      refreshGitState: (opts) => this.environment.refreshTab(this, opts),
      ctxFor: (tabId) => this.ctxFor(tabId),
      loadTranscript: (args) => loadSessionTranscript(this, args),
    })
    this.ui = new WorkspaceUiStore(this.panes, this.planStore)
    this.workStreamTracker = new WorkStreamTracker(this.worksStore, this.panes)
    this.eventReducer = new SessionEventReducer({
      registry: this.registry,
      settings: this.settings,
      planStore: this.planStore,
      worksStore: this.worksStore,
      tasksStore: this.tasksStore,
      automationsStore: this.automationsStore,
      workStreamTracker: this.workStreamTracker,
      isTabVisible: (tabId) => this.isTabVisible(tabId),
      addChangedFilesFromMessage: (tabId, message) => this.lifecycle.addChangedFilesFromMessage(tabId, message),
      refreshTurnSnapshots: (tabId) => { void this.refreshTurnSnapshots(tabId) },
      setGitStatus: (cwd, status) => this.environment.set(cwd, status),
      playNotificationIfHidden: () => { void this.playNotificationIfHidden() },
      closePlanModal: () => this.closePlanModal(),
      onTurnSettled: (tabId, cwd) => this.onTurnSettled?.(tabId, cwd),
      handlePendingInputSync: (session, events) => syncPendingInputFromEvent(this, session, events),
      log: (tab, eventType, session) => logDevSessionState(tab, eventType, session),
    })
    this.promptComposer = new PromptComposer(this.planStore, this.worksStore, this.tasksStore)
    this.ipcContextBuilder = new IpcContextBuilder({
      tabs: () => this.tabs,
      sessionFor: (tabId) => this.sessionFor(tabId),
      globalDefaults: this.globalDefaults,
      staticInfo: () => this.staticInfo,
      window: this.window,
      settings: this.settings,
      statusBar: this.statusBar,
    })

    // Start with no tabs — first tab is auto-created on prompt submission or snapshot hydration
    this.registry.sessions = {}
    this.registry.tabs = {}
    this.registry.tabOrder = []
    this.registry.activeTabId = ''
  }

  get globalDefaults(): {
    permissionMode: 'ask' | 'auto' | 'plan'
    workingDirectory: string
    gitContext: GitCheckout | null
    worktreeBaseBranch: string | null
    modelConfig: ModelConfig
  } { return this.config.globalDefaults }
  get tabGroupMode(): TabGroupMode { return this.config.tabGroupMode }
  set tabGroupMode(value: TabGroupMode) { this.config.tabGroupMode = value }
  get handoffInProgress(): boolean { return this.config.handoffInProgress }
  get staticInfo(): StaticInfo | null { return this.lifecycle.staticInfo }
  set staticInfo(value: StaticInfo | null) { this.lifecycle.staticInfo = value }
  get pluginCommands(): Session['pluginCommands'] { return this.lifecycle.pluginCommands }
  set pluginCommands(value: Session['pluginCommands']) { this.lifecycle.pluginCommands = value }
  get turnSnapshots(): Record<string, TurnSnapshot[]> { return this.lifecycle.turnSnapshots }
  set turnSnapshots(value: Record<string, TurnSnapshot[]>) { this.lifecycle.turnSnapshots = value }
  get hydrating(): boolean { return this.lifecycle.hydrating }
  set hydrating(value: boolean) { this.lifecycle.hydrating = value }
  get runtimeSyncing(): boolean { return this.lifecycle.runtimeSyncing }
  set runtimeSyncing(value: boolean) { this.lifecycle.runtimeSyncing = value }
  get streaming(): { text: Record<string, string> } { return this.eventReducer.streaming }
  set streaming(value: { text: Record<string, string> }) { this.eventReducer.streaming = value }
  get tabs(): Record<string, Tab> { return this.registry.tabs }
  set tabs(value: Record<string, Tab>) { this.registry.tabs = value }
  get sessions(): Record<string, Session> { return this.registry.sessions }
  set sessions(value: Record<string, Session>) { this.registry.sessions = value }
  get tabOrder(): string[] { return this.registry.tabOrder }
  set tabOrder(value: string[]) { this.registry.tabOrder = value }
  get activeTabId(): string { return this.registry.activeTabId }
  set activeTabId(value: string) { this.registry.activeTabId = value }
  get focusedChatTabId(): string | null {
    return this.panes.chatTabIn(this.panes.focusedPane, this.activeTabId)
  }
  get activeInput(): InputState { return this.registry.activeInput }
  set activeInput(value: InputState) { this.registry.activeInput = value }
  get lastActiveTabByBranch() { return this.registry.lastActiveTabByBranch }
  get isExpanded(): boolean { return this.ui.isExpanded }
  set isExpanded(value: boolean) { this.ui.isExpanded = value }
  get plansGalleryOpen(): boolean { return this.ui.plansGalleryOpen }
  set plansGalleryOpen(value: boolean) { this.ui.plansGalleryOpen = value }
  get sessionPickerOpen(): boolean { return this.ui.sessionPickerOpen }
  set sessionPickerOpen(value: boolean) { this.ui.sessionPickerOpen = value }
  get settingsOpen(): boolean { return this.ui.settingsOpen }
  set settingsOpen(value: boolean) { this.ui.settingsOpen = value }
  get settingsTab(): SettingsTab { return this.ui.settingsTab }
  set settingsTab(value: SettingsTab) { this.ui.settingsTab = value }
  get settingsProjectCwd(): string | null { return this.ui.settingsProjectCwd }
  set settingsProjectCwd(value: string | null) { this.ui.settingsProjectCwd = value }
  get folioGalleryOpen(): boolean { return this.ui.folioGalleryOpen }
  set folioGalleryOpen(value: boolean) { this.ui.folioGalleryOpen = value }
  get automationsOpen(): boolean { return this.ui.automationsOpen }
  set automationsOpen(value: boolean) { this.ui.automationsOpen = value }
  get automationsFocusId(): string | null { return this.ui.automationsFocusId }
  set automationsFocusId(value: string | null) { this.ui.automationsFocusId = value }
  get tasksOpen(): boolean { return this.ui.tasksOpen }
  set tasksOpen(value: boolean) { this.ui.tasksOpen = value }
  get prsOpen(): boolean { return this.ui.prsOpen }
  set prsOpen(value: boolean) { this.ui.prsOpen = value }
  get prsProjectTarget(): { path: string; requestId: number } | null { return this.ui.prsProjectTarget }
  get reviewModeOpen(): boolean { return this.ui.reviewModeOpen }
  /** The project the tasks page lists tickets for — the project shown in the
   *  status bar: the active session's cwd, or the global default when no session
   *  is active (e.g. a new-tab home with a project selected). Only one project's
   *  tasks show at a time, mirroring the status bar's single project path. */
  get tasksProjectCwd(): string | null {
    const cwd = this.activeSession?.workingDirectory ?? this.globalDefaults.workingDirectory
    return cwd && cwd !== '~' ? cwd : null
  }

  private defaultModelConfigFor(agentId: AgentId): ModelConfig {
    return this.config.defaultModelConfigFor(agentId)
  }

  private defaultReasoningEffortFor(agentId: AgentId, modelId: string | null) {
    return this.config.defaultReasoningEffortFor(agentId, modelId)
  }

  toggleTabGroupMode(): void {
    this.config.toggleTabGroupMode()
  }

  /** Resolve a tab id to its tab + session, or null if either is missing — the
   *  shared adapter for grouping helpers so the strip and keyboard nav agree. */
  resolveTab(tabId: string): { sess: Session; tab: Tab } | null {
    return this.registry.resolveTab(tabId)
  }

  private setActiveTab(tabId: string): void {
    this.registry.setActiveTab(tabId)
    prioritizeTabHydration(this, tabId)
    if (this.panes.primaryContent.kind === 'review') {
      this.panes.primaryContent = { kind: 'conversation' }
    }
  }

  private isTabVisible(tabId: string): boolean {
    const editorLike = this.window.viewMode === 'editor' || this.window.isWeb
    // A chat pinned in the split pane is on screen too — but only in editor/web,
    // where the secondary pane actually renders.
    const secondary = this.panes.secondaryContent
    if (editorLike && secondary.kind === 'conversation' && secondary.tabId === tabId) return true
    return tabId === this.activeTabId && (editorLike || this.isExpanded)
  }

  private resetOverlays(opts: { closeArtifact?: boolean } = {}): void {
    this.ui.resetOverlays(opts)
  }

  lastActiveTabForBranch(branchKey: string): string | null {
    return this.registry.lastActiveTabForBranch(branchKey)
  }

  /** Returns the Session for a given tab, or undefined. */
  sessionFor(tabId: string): Session | undefined {
    return this.registry.sessionFor(tabId)
  }

  get activeTab(): Tab | undefined {
    return this.registry.activeTab
  }

  /** The composer the input bar reads/writes: the active tab's, or the tab-less one. */
  get currentInput(): InputState {
    return this.registry.currentInput
  }

  inputFor(tabId: string): InputState {
    return this.tabs[tabId]?.input ?? this.currentInput
  }

  get activeSession(): Session | undefined {
    return this.registry.activeSession
  }

  get galleryProjectPath(): string {
    return this.activeSession?.workingDirectory ?? this.globalDefaults.workingDirectory ?? '~'
  }

  /** Distinct project keys across all open tabs — repo root when git, else the
   *  working directory. Mirrors how the sidebar groups sessions into projects;
   *  its length drives whether galleries show a per-item project badge. */
  get openProjectKeys(): string[] {
    const keys = new Set<string>()
    for (const tabId of this.tabOrder) {
      const sess = this.sessionFor(tabId)
      if (!sess) continue
      keys.add(sess.gitContext?.repoRoot ?? sess.workingDirectory ?? '~')
    }
    if (keys.size === 0) keys.add(this.galleryProjectPath)
    return [...keys]
  }

  /** Path roots used to scope plans/works to the open projects. Includes each
   *  open tab's repo root, worktree path, and working directory so an item
   *  created in any branch/worktree/subfolder of an open repo still matches. */
  get openProjectScopeRoots(): string[] {
    const roots = new Set<string>()
    for (const tabId of this.tabOrder) {
      const sess = this.sessionFor(tabId)
      if (!sess) continue
      if (sess.gitContext?.repoRoot) roots.add(sess.gitContext.repoRoot)
      if (sess.gitContext?.worktreePath) roots.add(sess.gitContext.worktreePath)
      if (sess.workingDirectory) roots.add(sess.workingDirectory)
    }
    if (roots.size === 0) roots.add(this.galleryProjectPath)
    return [...roots]
  }

  addTabToOrder(tabId: string): void {
    this.registry.addTabToOrder(tabId)
  }

  /** Move `tabId` to sit immediately before `targetTabId` (drag-to-reorder).
   *  Splices in place so the $state array stays the same reference and only the
   *  moved indices invalidate — never reassign tabOrder for a reorder. */
  reorderTab(tabId: string, targetTabId: string): void {
    this.registry.reorderTab(tabId, targetTabId)
  }

  pruneTabOrder(): void {
    this.registry.pruneTabOrder()
  }

  /** Snapshot the active tab as a SessionCtx payload. */
  get tabCtx(): SessionCtx {
    return this.ipcContextBuilder.sessionCtx(this.activeTabId)
  }

  /** Full IpcContext for the active tab — passed into every stateful IPC call. */
  get ctx(): IpcContext {
    return this.ipcContextBuilder.forActive(this.activeTabId)
  }

  /** IpcContext for a specific tab (used when a non-active tab must drive a call). */
  ctxFor(tabId: string): IpcContext {
    return this.ipcContextBuilder.forTab(tabId)
  }

  /** IpcContext scoped to a bare directory — no session or tab coupling. */
  ctxForDirectory(workingDirectory: string): IpcContext {
    return this.ipcContextBuilder.forDirectory(this.activeTabId, workingDirectory)
  }

  /** Context scoped to an environment checkout, independent of chat-tab existence. */
  ctxForEnvironment(workingDirectory: string, gitContext: GitCheckout | null, tabId = ''): IpcContext {
    return this.ipcContextBuilder.forEnvironment(tabId, workingDirectory, gitContext)
  }

  update(patch: Partial<SessionFields>): void {
    if (patch.isExpanded !== undefined) this.isExpanded = patch.isExpanded
    if (patch.staticInfo !== undefined) this.staticInfo = patch.staticInfo
    if (patch.pendingInput !== undefined) this.pendingInput = patch.pendingInput
  }

  private async playNotificationIfHidden(): Promise<void> {
    if (!this.settings.soundEnabled) return
    const visible = await window.solus.isVisible()
    if (!visible) {
      notificationAudio.currentTime = 0
      notificationAudio.play().catch(() => {})
    }
  }

  // ─── Static info ───

  async initStaticInfo(): Promise<void> {
    return this.lifecycle.initStaticInfo()
  }

  /** Synchronously apply the cached start() payload so staticInfo/agents are ready
   *  before first paint. Reconciled with fresh data by initStaticInfo. */
  hydrateStaticInfoFromCache(): void {
    this.lifecycle.hydrateStaticInfoFromCache()
  }

  async refreshPluginCommands(workingDirectory: string, tabId?: string): Promise<void> {
    return this.lifecycle.refreshPluginCommands(workingDirectory, tabId)
  }

  async switchToBranch(branch: string, tabId?: string): Promise<boolean> {
    return this.config.switchToBranch(branch, tabId)
  }

  recomputeChangedFiles(tabId: string): void {
    this.lifecycle.recomputeChangedFiles(tabId)
  }

  /**
   * Replace a tab's windowed transcript with the full history. Startup hydration
   * only loads the most recent messages (see HISTORY_WINDOW); this pulls in the
   * rest when the user scrolls back to the top.
   */
  async expandHistory(tabId: string): Promise<void> {
    return this.lifecycle.expandHistory(tabId)
  }

  async hydrateChangedFilesFromDiff(tabId: string): Promise<void> {
    return this.lifecycle.hydrateChangedFilesFromDiff(tabId)
  }

  async refreshTurnSnapshots(tabId: string): Promise<void> {
    return this.lifecycle.refreshTurnSnapshots(tabId)
  }

  reconcileQueuedPrompts(tabId: string, queuedPrompts: QueuedPromptSnapshot[]): void {
    this.lifecycle.reconcileQueuedPrompts(tabId, queuedPrompts)
  }

  private forEachSiblingTab(tabId: string, fn: (siblingId: string) => void): void {
    this.registry.forEachSiblingTab(tabId, fn)
  }

  private resetSessionRunState(session: Session): void {
    this.eventReducer.resetSessionRunState(session)
  }

  private async attachRuntimeSession(tabId: string): Promise<void> {
    const session = this.sessionFor(tabId)
    if (!session?.agentSessionId) return
    const info = await window.solus.bindRuntimeSession(this.ctxFor(tabId))
    if (info && session) {
      session.modelConfig.modelId = info.modelConfig.modelId
      session.modelConfig.reasoningEffort = info.modelConfig.reasoningEffort
      session.modelConfig.contextWindow = info.modelConfig.contextWindow
      session.modelConfig.fastMode = info.modelConfig.fastMode
      session.permissionMode = info.permissionMode
      session.status = info.status
      session.rateLimitInfo = info.rateLimitInfo
      this.reconcileQueuedPrompts(tabId, info.queuedPrompts)
    }
  }

  // ─── Tab management ───

  async createTab(cwd?: string, options: CreateTabOptions = {}): Promise<string> {
    const defaultDir = this.staticInfo?.projectPath || this.staticInfo?.workspacePath || '~'
    const activeSession = this.activeSession
    const inheritedDir = cwd ?? (activeSession?.workingDirectory || this.globalDefaults.workingDirectory || defaultDir)
    const sourceConfig = activeSession?.modelConfig ?? this.globalDefaults.modelConfig
    const provider = (activeSession?.provider ?? this.settings.activeAgent) as AgentId
    const inheritedModelConfig = {
      ...sourceConfig,
      reasoningEffort: this.defaultReasoningEffortFor(provider, sourceConfig.modelId),
    }
    const inheritedPermissionMode = this.globalDefaults.permissionMode
    const inheritedGitContext = options.gitContext === undefined
      ? cwd === undefined
        ? activeSession?.gitContext ?? this.globalDefaults.gitContext
        : null
      : options.gitContext
    // A fresh tab follows the saved default. Per-session toggles belong only to
    // that session and must not silently override where the next session starts.
    const worktreeRequested = options.worktreeRequested
      ?? (!inheritedGitContext?.worktreePath && this.settings.worktreeEnabled)
    const { tabId } = await window.solus.createTab()
    const session = makeSession(this.settings, {
      workingDirectory: inheritedDir,
      gitContext: inheritedGitContext ? { ...inheritedGitContext } : null,
      worktreeBaseBranch: worktreeRequested ? inheritedGitContext?.targetBranch ?? null : null,
      modelConfig: inheritedModelConfig,
      permissionMode: inheritedPermissionMode,
      sessionSkills: activeSession?.sessionSkills ?? [],
      pluginCommands: this.pluginCommands,
    })
    const tab = makeTab(session.id, { id: tabId })
    this.sessions[session.id] = session
    this.tabs[tab.id] = tab
    this.addTabToOrder(tab.id)
    if (options.activate !== false) {
      this.setActiveTab(tab.id)
      this.resetOverlays({ closeArtifact: true })
    }
    if (options.activate !== false && !activeSession?.gitContext && inheritedGitContext) {
      this.config.applyGlobalStartTarget({ gitContext: null, worktreeBaseBranch: null })
    }
    const gitInitialization = this.environment.refreshTab(this, { tabId, worktreeRequested })
    if (options.gitInitialization === 'background') void gitInitialization
    else await gitInitialization
    void this.refreshPluginCommands(inheritedDir)
    if (options.activate !== false) requestInputFocus()
    return tabId
  }

  /**
   * Open a new tab set to materialize a fresh worktree on its first prompt.
   * Mirrors how worktrees are created everywhere else in Solus (lazy, with an
   * AI-generated branch name) rather than creating one on disk immediately.
   */
  async createWorktreeTab(): Promise<void> {
    const src = this.activeSession
    const projectRoot = src?.gitContext?.repoRoot
      ?? (src?.workingDirectory && src.workingDirectory !== '~' ? worktreeProjectRoot(src.workingDirectory) : undefined)
    const tabId = await this.createTab(projectRoot)
    const session = this.sessionFor(tabId)
    if (!session) return
    // Always branch off the project root, even when the source tab was itself
    // inside a worktree (whose context createTab would otherwise inherit).
    session.gitContext = null
    const dir = session.workingDirectory
    if (!dir || dir === '~') return
    await this.environment.refreshTab(this, { tabId, cwd: dir })
    const refreshedContext = this.sessionFor(tabId)?.gitContext
    if (refreshedContext?.targetBranch) session.worktreeBaseBranch = refreshedContext.targetBranch
  }

  /** Fork a session into a new tab. The fork inherits all messages and resumes on first prompt. */
  async forkTab(sourceTabId: string): Promise<string | null> {
    const sourceTab = this.tabs[sourceTabId]
    const sourceSession = this.sessionFor(sourceTabId)
    if (!sourceSession?.agentSessionId) return null

    const { tabId } = await window.solus.createTab()

    const originalTitle = sourceTab?.title || 'session'
    const copiedMessages: Message[] = sourceSession.messages.map((m) => ({ ...m, id: uuid() }))
    const forkInfoMsg: Message = {
      id: uuid(),
      role: 'system',
      content: '',
      timestamp: Date.now(),
      forkSourceSessionId: sourceSession.agentSessionId,
      forkSourceTitle: originalTitle,
    }

    const forkedSession = makeSession(this.settings, {
      agentSessionId: sourceSession.agentSessionId,
      forked: true,
      forkedFromSessionId: sourceSession.agentSessionId,
      messages: [...copiedMessages, forkInfoMsg],
      workingDirectory: sourceSession.workingDirectory,
      additionalDirs: [...sourceSession.additionalDirs],
      modelConfig: { ...sourceSession.modelConfig },
      permissionMode: sourceSession.permissionMode,
      provider: sourceSession.provider,
      gitContext: sourceSession.gitContext ? { ...sourceSession.gitContext } : null,
      worktreeBaseBranch: sourceSession.worktreeBaseBranch,
      sessionSkills: [...sourceSession.sessionSkills],
      pluginCommands: this.pluginCommands,
    })

    const forkTab = makeTab(forkedSession.id, { id: tabId, title: `Fork: ${originalTitle}` })

    this.sessions[forkedSession.id] = forkedSession
    this.tabs[forkTab.id] = forkTab
    this.addTabToOrder(forkTab.id)
    this.setActiveTab(forkTab.id)
    this.resetOverlays()
    await this.environment.refreshTab(this, { tabId })
    requestInputFocus()
    return tabId
  }

  /** Move a live session into a fresh git worktree. Creates the worktree now (so
   *  the branch name and git panel update immediately), then flags the session to
   *  fork on its next prompt — that fork re-homes the conversation's transcript
   *  under the worktree, so the session truly lives there. Same tab, same history. */
  async continueInWorktree(tabId: string): Promise<void> {
    const session = this.sessionFor(tabId)
    if (!session?.agentSessionId || session.gitContext?.worktreePath || this.ui.isContinuingInWorktree(tabId)) return

    const firstUser = session.messages.find((m) => m.role === 'user')
    const namePrompt = typeof firstUser?.content === 'string' ? firstUser.content.slice(0, 200) : ''

    this.ui.beginContinueInWorktree(tabId)
    // Live status card while the (eager, ~1-2s) worktree setup runs — branch-name
    // generation + `git worktree add` — mirroring the backend's new-session card
    // so the wait shows progress instead of a bare "Creating Worktree…" label.
    session.statusCard = {
      id: `continue-worktree-${tabId}`,
      title: 'Moving into a new worktree…',
      icon: 'git-branch',
      status: 'active',
      steps: [
        { id: 'worktree', label: 'Naming & creating the worktree', status: 'active' },
        { id: 'session', label: 'Moving this session in', status: 'pending' },
      ],
    }
    try {
      const result = await window.solus.continueInWorktree(this.ctxFor(tabId), namePrompt)
      if (!result.success || !result.gitContext) {
        toasts.error(result.error ? `Couldn't create worktree: ${result.error}` : "Couldn't create worktree")
        return
      }

      // Keep agentSessionId as the fork source; forked=true makes the next run resume
      // it with --fork-session in the worktree cwd (see control-plane dispatch).
      session.gitContext = result.gitContext
      session.worktreeBaseBranch = null
      const projectRoot = worktreeProjectRoot(result.gitContext.worktreePath ?? session.workingDirectory)
      void this.environment.refreshRefs(projectRoot, this.ctxForDirectory(projectRoot), { force: true })
      session.forkedFromSessionId = session.agentSessionId
      session.forked = true
      session.messages.push({
        id: uuid(),
        role: 'system',
        content: '',
        timestamp: Date.now(),
        worktreeMovedTo: result.gitContext.branch ?? result.gitContext.detachedHeadSha ?? 'detached HEAD',
      })
      requestInputFocus()
    } finally {
      // Clear the setup card whether we succeeded (the "Continued in worktree"
      // divider now marks completion) or failed (toast already shown). Nothing
      // runs here, so no status_change will clear it for us.
      if (session.statusCard?.id === `continue-worktree-${tabId}`) session.statusCard = null
      this.ui.endContinueInWorktree(tabId)
    }
  }

  isContinuingInWorktree(tabId: string | null | undefined): boolean {
    return this.ui.isContinuingInWorktree(tabId)
  }

  selectTab(tabId: string): void {
    if (tabId === this.panes.chatTabIn('secondary', this.activeTabId)) {
      this.panes.focusPane('secondary')
      requestInputFocus({ tabId })
      return
    }
    const tab = this.tabs[tabId]
    const session = this.sessionFor(tabId)
    const previousTabId = this.activeTabId
    if (tabId === this.activeTabId) {
      const willExpand = !this.isExpanded
      this.isExpanded = willExpand
      if (willExpand && tab) {
        tab.hasUnread = false
      }
    } else {
      this.setActiveTab(tabId)
      this.isExpanded = true
      this.resetOverlays({ closeArtifact: true })
      if (tab) {
        tab.hasUnread = false
      }
      if (session) {
        logDevSessionState(tab, `tab-switch:${previousTabId}->${tabId}`, session)
      }
    }
    if (session?.provider && this.settings.activeAgent !== session.provider) {
      this.settings.update({ activeAgent: session.provider })
    }
  }

  toggleExpanded(): void {
    const willExpand = !this.isExpanded
    const { activeTabId } = this
    this.isExpanded = willExpand
    if (willExpand && this.tabs[activeTabId]) {
      this.tabs[activeTabId].hasUnread = false
    }
  }

  /**
   * Pin a chat into the secondary pane beside the primary conversation.
   * Splitting the active tab first activates its nearest neighbour (or a fresh
   * tab when it's the only one) so the same chat isn't rendered twice — the
   * pool and the split pane are separate ConversationView instances.
   */
  openTabInSplit(tabId: string): void {
    const tab = this.tabs[tabId]
    if (!tab) return
    if (tabId === this.activeTabId) {
      const others = this.tabOrder.filter((id) => id !== tabId && this.tabs[id])
      if (others.length === 0) {
        this.createTabFromDefaults()
      } else {
        const splitIdx = this.tabOrder.indexOf(tabId)
        this.selectTab(others.reduce((best, id) => {
          const idxA = this.tabOrder.indexOf(id)
          const idxB = this.tabOrder.indexOf(best)
          return Math.abs(idxA - splitIdx) < Math.abs(idxB - splitIdx) ? id : best
        }))
      }
    }
    tab.hasUnread = false
    this.panes.openSplitChat(tabId)
    requestInputFocus({ tabId })
  }

  /** Move the split chat back into the primary tab pool. */
  promoteSplitToMainTab(): void {
    const splitTabId = this.panes.chatTabIn('secondary', this.activeTabId)
    if (!splitTabId) return
    const splitTab = this.tabs[splitTabId]
    const splitSession = this.sessionFor(splitTabId)
    if (!splitTab || !splitSession) return

    this.setActiveTab(splitTabId)
    this.isExpanded = true
    splitTab.hasUnread = false
    this.panes.closeSecondary()
    if (splitSession.provider && this.settings.activeAgent !== splitSession.provider) {
      this.settings.update({ activeAgent: splitSession.provider })
    }
    requestInputFocus({ tabId: splitTabId })
  }

  /** Close the pinned chat, discarding only a never-used split-created tab. */
  closeSplitChat(): void {
    const splitTabId = this.panes.chatTabIn('secondary', this.activeTabId)
    if (!splitTabId) {
      this.panes.closeSecondary()
      return
    }
    const splitTab = this.tabs[splitTabId]
    const splitSession = this.sessionFor(splitTabId)
    const shouldCloseTab = splitTabId !== this.activeTabId
      && !!splitTab
      && !!splitSession
      && isPristineSplitTab(splitTab, splitSession)

    this.panes.closeSecondary()
    if (shouldCloseTab) this.closeTab(splitTabId)
  }

  /** ⌥⇧E: continue the active session in the other mode's window. Writes a
   *  handoff addressed to that mode (when a session has started — otherwise
   *  this is a bare window switch) and surfaces its window; main hides this
   *  one per switchMode's asymmetric visibility rules. */
  async continueInOtherMode(): Promise<void> {
    const target = this.window.viewMode === 'pill' ? 'editor' : 'pill'
    const sess = this.activeSession
    if (sess?.agentSessionId) {
      writeSessionHandoff({
        sessionId: sess.agentSessionId,
        provider: sess.provider ?? this.settings.activeAgent,
        cwd: sess.workingDirectory,
        title: this.activeTab?.title ?? null,
        target,
      })
    }
    analytics.modeToggled({ mode: target })
    await this.window.setViewMode(target)
  }


  private createTabFromDefaults(): string {
    const workingDirectory = this.globalDefaults.workingDirectory
    const inheritedWorktreePath = this.globalDefaults.gitContext?.worktreePath
    const inheritedGitContext = gitCheckoutFromState(
      this.environment.statusFor(inheritedWorktreePath ?? workingDirectory),
      inheritedWorktreePath,
    )
    const inheritedWorktreeBaseBranch = inheritedGitContext?.worktreePath
      ? null
      : this.globalDefaults.worktreeBaseBranch
    const session = makeSession(this.settings, {
      workingDirectory,
      gitContext: inheritedGitContext ? { ...inheritedGitContext } : null,
      worktreeBaseBranch: inheritedWorktreeBaseBranch,
      modelConfig: { ...this.globalDefaults.modelConfig },
      permissionMode: this.globalDefaults.permissionMode,
    })
    const tabId = uuid()
    // Hand the tab-less composer off to the first tab, then reset it.
    const tab = makeTab(session.id, { id: tabId, input: this.activeInput })
    this.activeInput = makeInputState()
    this.sessions[session.id] = session
    this.tabs[tab.id] = tab
    this.addTabToOrder(tab.id)
    this.setActiveTab(tab.id)
    this.resetOverlays()
    if (inheritedGitContext) {
      this.config.applyGlobalStartTarget({ gitContext: null, worktreeBaseBranch: null })
    }
    void this.environment.refreshTab(this, {
      tabId,
      worktreeRequested: !!inheritedWorktreeBaseBranch || this.settings.worktreeEnabled,
    })
    void this.refreshPluginCommands(workingDirectory)
    return tabId
  }

  closeTab(tabId: string): void {
    window.solus.closeTab(this.ctxFor(tabId))
    const splitContent = this.panes.secondaryContent
    if (splitContent.kind === 'conversation' && splitContent.tabId === tabId) {
      this.panes.closeSecondary()
    }
    const tab = this.tabs[tabId]
    const sessionId = tab?.sessionId
    const closedBranchKey = branchKeyFor(this.sessionFor(tabId))
    const openTabIds = this.tabOrder.filter((id) => this.tabs[id])
    const editorLike = this.window.viewMode === 'editor' || this.window.isWeb
    const displayedTabIds = editorLike
      ? openTabIds.filter((id) => branchKeyFor(this.sessionFor(id)) === closedBranchKey)
      : openTabIds
    const visualTabIds = buildTabSections(
      displayedTabIds,
      this.tabGroupMode,
      (id) => this.resolveTab(id),
      this.planStore.plans,
    ).flatMap((section) => section.tabIds)
    const adjacentDisplayedTabId = adjacentTabAfterClose(visualTabIds, tabId)
    const newOrder = this.tabOrder.filter((id) => id !== tabId)
    delete this.tabs[tabId]
    // Purge the closed tab's persisted input draft so the drafts map can't grow
    // unbounded (patchActiveDraft only ever adds/updates, never removes).
    removeDraft(tabId)
    disposeGitActions(tabId)
    this.lifecycle.disposeTab(tabId)

    // Clean up session if no other tabs point to it
    if (sessionId && !Object.values(this.tabs).some((t) => t.sessionId === sessionId)) {
      delete this.sessions[sessionId]
    }

    if (this.activeTabId === tabId) {
      if (newOrder.length === 0) {
        this.activeTabId = ''
      } else {
        // Follow the order the strip actually displayed. In editor/web this
        // keeps navigation within the visible branch; if it was the branch's
        // final tab, fall back to the adjacent tab in the underlying order.
        const fallbackTabId = adjacentTabAfterClose(this.tabOrder, tabId) ?? newOrder[0]
        this.setActiveTab(adjacentDisplayedTabId ?? fallbackTabId)
      }
    }
    this.tabOrder = newOrder
  }

  clearTab(tabId?: string): void {
    const targetTabId = tabId ?? this.activeTabId
    window.solus.resetTabSession(this.ctxFor(targetTabId))
    const session = this.sessionFor(targetTabId)
    if (!session) return
    session.agentSessionId = null
    session.provider = null
    session.messages = []
    session.sessionChangedFiles = []
    session.lastResult = null
    session.sessionUsage = null
    session.isStreamingText = false
    session.isReconnecting = false
    session.permissionQueue = []
    session.questionQueue = []
    session.permissionDenied = null
    session.serverQueuedPrompts.splice(0, session.serverQueuedPrompts.length)
    session.status = 'idle'
    session.progress = null
    session.readOnlyReason = null
    session.worktreeBaseBranch = session.gitContext?.worktreePath ? null : session.worktreeBaseBranch
    // Reset tab title
    const tab = this.tabs[targetTabId]
    if (tab) tab.title = 'New Tab'
    delete this.streaming.text[targetTabId]
    if (session.workingDirectory && !session.gitContext) {
      void this.environment.refreshTab(this, { tabId: targetTabId })
    }
  }

  async resumeSession(
    meta: SessionMeta,
    opts?: { background?: boolean; intoTabId?: string },
  ): Promise<string> {
    const background = opts?.background ?? false
    const intoTabId = opts?.intoTabId
    const provider = meta.provider ?? this.settings.activeAgent
    if (!intoTabId) {
      const openTabId = findOpenTabForSession(
        meta.sessionId,
        this.tabs,
        this.sessions,
        this.tabOrder,
        provider,
      )
      if (openTabId) {
        if (!background) {
          if (openTabId === this.activeTabId) this.isExpanded = true
          else this.selectTab(openTabId)
        }
        return openTabId
      }
    }
    const defaultDir = meta.cwd || this.staticInfo?.homePath || '~'
    const workingDirectory = worktreeProjectRoot(defaultDir)
    const title = meta.customTitle
      ? meta.customTitle
      : meta.firstMessage
        ? meta.firstMessage.length > 80 ? meta.firstMessage.substring(0, 80) : meta.firstMessage
        : meta.slug || 'Resumed'

    const hadActiveTab = !!this.activeTab
    let tabId = intoTabId ?? this.activeTabId
    const targetTab = intoTabId ? this.tabs[intoTabId] : this.activeTab
    const targetSession = intoTabId ? this.sessionFor(intoTabId) : this.activeSession
    const canTakeOver = targetTab && targetSession && !targetSession.agentSessionId
      && targetSession.status !== 'connecting' && targetSession.status !== 'running'
      && targetSession.messages.length === 0
    if (intoTabId && !canTakeOver) {
      throw new Error('A session can only resume into an empty, idle tab')
    }
    const shouldCreateNewTab = !intoTabId && (background || !canTakeOver)
    if (shouldCreateNewTab) {
      const shouldActivate = !background || !hadActiveTab
      tabId = await this.createTab(workingDirectory, {
        activate: shouldActivate,
        gitContext: null,
        gitInitialization: 'background',
        worktreeRequested: false,
      })
      const session = this.sessionFor(tabId)
      const tab = this.tabs[tabId]
      if (!session || !tab) throw new Error('The resumed session tab was not created')
      session.provider = provider
      session.agentSessionId = meta.sessionId
      session.readOnlyReason = null
      session.loadingHistory = true
      tab.title = title
      if (shouldActivate) {
        if (!background) this.isExpanded = true
        if (this.settings.activeAgent !== provider) {
          this.settings.update({ activeAgent: provider })
        }
      }
    } else {
      const session = targetSession!
      session.provider = provider
      session.agentSessionId = meta.sessionId
      session.workingDirectory = workingDirectory
      session.messages.splice(0, session.messages.length)
      session.readOnlyReason = null
      session.gitContext = null
      session.loadingHistory = true
      targetTab!.title = title

      if (!background && !intoTabId) {
        this.setActiveTab(targetTab!.id)
        this.isExpanded = true
        if (this.settings.activeAgent !== provider) {
          this.settings.update({ activeAgent: provider })
        }
      }
    }
    if (!background && !intoTabId) {
      this.resetOverlays()
    }

    // The session must appear correctly grouped in the sidebar the moment the
    // spinner clears, so land git identity (repoRoot + branch + worktree flag)
    // and the transcript on the critical path — everything heavier streams in
    // afterward without gating `loadingHistory`.
    const worktreePath = isSolusWorktreePath(defaultDir) ? defaultDir : undefined
    const resumingSession = this.sessionFor(tabId)
    // Re-read the tab's session before applying anything: a concurrent resume
    // could have taken over this tab while our IPC was in flight.
    const currentResumeTarget = (): Session | null => {
      const s = this.sessionFor(tabId)
      return s && s === resumingSession && s.agentSessionId === meta.sessionId ? s : null
    }

    try {
      const [identity, transcript] = await Promise.all([
        window.solus.gitIdentity(defaultDir).catch(() => null),
        loadSessionTranscript(this, {
          sessionId: meta.sessionId,
          loadPath: meta.projectPath || defaultDir,
          displayCwd: workingDirectory,
          provider,
          ctx: this.ctxFor(tabId),
        }),
        this.attachRuntimeSession(tabId),
      ])

      const session = currentResumeTarget()
      if (session) {
        // `gitIdentity` returning null means non-git dir (or a worktree whose
        // checkout is gone); `gitCheckoutFromState` yields null and the
        // background worktree restore below applies the read-only fallback.
        const gitContext = gitCheckoutFromState(identity, worktreePath)
        session.gitContext = gitContext
        if (gitContext) session.readOnlyReason = null
        try {
          await window.solus.gitRegisterEnvironment(
            $state.snapshot(this.ctxFor(tabId)),
            worktreePath ?? workingDirectory,
            $state.snapshot(gitContext),
          )
        } catch {
          // A failed environment registration only delays cwd/git wiring for an
          // immediate prompt; the background refresh re-registers it.
        }
        session.messages.splice(0, session.messages.length, ...transcript.messages)
        session.progress = transcript.progress

        // Everything below is off the critical path — a stale/failed step only
        // means the git panel / changed files / plugins catch up a beat later.
        void (async () => {
          const restoredGitContext = await window.solus.worktreeRestore(this.ctxFor(tabId), defaultDir)
          if (!currentResumeTarget()) return
          const restoredSession = this.sessionFor(tabId)!
          let environmentRefresh: Promise<GitRefreshResult> | null = null
          if (restoredGitContext) {
            restoredSession.gitContext = restoredGitContext
            restoredSession.readOnlyReason = null
            environmentRefresh = this.environment.refreshTab(this, { tabId, level: 'full' })
          } else if (isSolusWorktreePath(defaultDir)) {
            restoredSession.gitContext = null
            restoredSession.readOnlyReason = 'This session is read-only because its worktree no longer exists.'
          } else {
            environmentRefresh = this.environment.refreshTab(this, { tabId, level: 'full' })
          }

          this.recomputeChangedFiles(tabId)
          this.onTurnSettled?.(tabId, this.sessionFor(tabId)?.workingDirectory ?? null)
          void this.refreshPluginCommands(workingDirectory, tabId)
          await Promise.all(transcript.planIds.map((planId) => this.planStore.hydrateAnnotations(planId)))

          if (environmentRefresh) await environmentRefresh
          if (restoredGitContext) {
            await this.hydrateChangedFilesFromDiff(tabId)
          }
        })()
      }
    } finally {
      const session = currentResumeTarget()
      if (session) session.loadingHistory = false
    }

    requestConversationScrollToBottom(tabId)
    if (intoTabId) requestInputFocus({ tabId })
    return tabId
  }

  // ─── Tab configuration ───

  updateModelConfig(patch: Partial<import('../../../shared/types').ModelConfig>, tabId?: string): void {
    this.config.updateModelConfig(patch, tabId)
  }

  switchActiveAgent(agentId: AgentId): Promise<void> {
    return this.config.switchActiveAgent(agentId)
  }

  setPermissionMode(mode: 'ask' | 'auto' | 'plan', tabId?: string): void {
    this.config.setPermissionMode(mode, tabId)
  }

  setWorktreeBaseBranch(branch: string | null): void {
    this.config.setWorktreeBaseBranch(branch)
  }

  syncWorktreeDefault(enabled: boolean): void {
    this.config.syncWorktreeDefault(enabled)
  }

  toggleWorktreeMode(tabId?: string): void {
    this.config.toggleWorktreeMode(tabId)
  }

  async switchToWorktree(worktreePath: string, tabId?: string): Promise<void> {
    return this.config.switchToWorktree(worktreePath, tabId)
  }

  async setBaseDirectory(dir: string, tabId?: string): Promise<void> {
    return this.config.setBaseDirectory(dir, tabId)
  }

  addDirectory(dir: string): void {
    this.config.addDirectory(dir)
  }

  removeDirectory(dir: string): void {
    this.config.removeDirectory(dir)
  }

  // ─── Attachments (UI-only, on the current input state) ───

  addAttachments(attachments: Attachment[], tabId?: string): void {
    const input = tabId === undefined ? this.currentInput : this.inputFor(tabId)
    input.attachments.push(...attachments)
  }

  removeAttachment(attachmentId: string, tabId?: string): void {
    const input = tabId === undefined ? this.currentInput : this.inputFor(tabId)
    const index = input.attachments.findIndex((attachment) => attachment.id === attachmentId)
    if (index !== -1) input.attachments.splice(index, 1)
  }

  clearAttachments(): void {
    this.currentInput.attachments = []
  }

  // ─── Messaging ───

  addSystemMessage(content: string, tabId?: string): void {
    const session = tabId === undefined ? this.activeSession : this.sessionFor(tabId)
    if (!session) return
    session.messages.push({ id: nextMsgId(), role: 'system' as const, content, timestamp: Date.now() })
  }

  private promptTab(tabId: string, options: { prompt: string; displayPrompt: string; imageAttachments?: Array<{ mimeType: string; dataUrl: string }>; taskId?: string }): void {
    window.solus.createTab(tabId)
      .then(() => this.config.pendingSessionStartTarget(tabId))
      .then(() => {
        // Guard: user may have interrupted between createTab resolving and this tick.
        // If so, stopTab already fired before prompt — skip submission to avoid a
        // phantom run that can never be cancelled.
        const session = this.sessionFor(tabId)
        if (!session) return
        return window.solus.prompt(this.ctxFor(tabId), options)
      })
      .catch((err: Error) => {
        this.handleError(tabId, { message: err.message, stderrTail: [], exitCode: null, elapsedMs: 0, toolCallCount: 0 })
      })
  }

  /** Sends to the active tab unless `tabId` targets another one (the split
   *  conversation pane's composer). */
  sendMessage(prompt: string, projectPath?: string, tabId?: string): void {
    if (!tabId && this.tabOrder.length === 0) {
      const sessionStartTargetResolution = this.config.pendingSessionStartTarget()
      if (sessionStartTargetResolution) {
        void sessionStartTargetResolution.then(() => this.sendMessage(prompt, projectPath, tabId))
        return
      }
      this.createTabFromDefaults()
    }
    const targetTabId = tabId ?? this.activeTabId
    const tab = this.tabs[targetTabId]
    const session = this.sessionFor(targetTabId)
    if (!tab || !session) return
    if (session.status === 'connecting') return
    if (session.readOnlyReason) return

    const resolvedPath = projectPath || session.workingDirectory
    const isBusy = session.status === 'running'
    const input = tab.input

    const fullPrompt = this.promptComposer.compose(prompt, input, session)
    // Capture image blocks before the input's attachments are cleared below.
    const imageAttachments = this.promptComposer.composeImages(input)

    const title = session.messages.length === 0
      ? (prompt.length > 80 ? prompt.substring(0, 80) : prompt)
      : tab.title

    if (resolvedPath !== session.workingDirectory) {
      session.workingDirectory = resolvedPath
    }
    if (session.messages.length === 0 && resolvedPath && resolvedPath !== '~') {
      void window.solus.trackRecentProject(resolvedPath)
    }

    session.provider = session.provider ?? this.settings.activeAgent

    const isFirstMessage = session.messages.length === 0
    const agent = session.provider ?? this.settings.activeAgent
    if (isFirstMessage) analytics.conversationStarted({ agent })
    analytics.messageSent({ agent, isFirstMessage })

    if (session.status === 'rate_limited' && (session.rateLimitStrategy === 'ask' || session.rateLimitStrategy === 'queue')) {
      tab.title = title
      input.attachments = []
      input.planRefs = []
      input.workRefs = []
      this.promptTab(targetTabId, { prompt: fullPrompt, displayPrompt: prompt, imageAttachments, taskId: session.boundTaskId ?? undefined })
      requestConversationScrollToBottom(targetTabId)
      return
    }

    if (isBusy) {
      tab.title = title
      input.attachments = []
      input.planRefs = []
      input.workRefs = []
    } else {
      const userMsg: Message = {
        id: nextMsgId(),
        role: 'user' as const,
        content: prompt,
        timestamp: Date.now(),
        attachments: input.attachments.length > 0
          ? input.attachments.map((a) => ({ name: a.name, dataUrl: a.dataUrl, mimeType: a.mimeType, type: a.type }))
          : undefined,
        planRefs: input.planRefs.length > 0 ? [...input.planRefs] : undefined,
        workRefs: input.workRefs.length > 0 ? [...input.workRefs] : undefined,
      }
      session.status = 'connecting'
      tab.title = title
      input.attachments = []
      input.planRefs = []
      input.workRefs = []
      session.latestCheckpointId = null
      session.progress = null
      session.messages.push(userMsg)
    }

    this.promptTab(targetTabId, { prompt: fullPrompt, displayPrompt: prompt, imageAttachments, taskId: session.boundTaskId ?? undefined })
    requestConversationScrollToBottom(targetTabId)
  }

  retryLastMessage(tabId: string): void {
    const session = this.sessionFor(tabId)
    if (!session) return
    if (session.status === 'connecting') return
    if (session.readOnlyReason) return

    if (session.status === 'rate_limited' && session.serverQueuedPrompts.some((prompt) => prompt.reason === 'rate_limit')) {
      sendRateLimitedNow(this.ctxFor(tabId), true, (err) => this.handleError(tabId, err))
      return
    }

    const lastUserMsg = [...session.messages].reverse().find((m) => m.role === 'user')
    if (!lastUserMsg) return

    const lastMsg = session.messages[session.messages.length - 1]
    if (lastMsg?.role === 'system' && lastMsg.content.startsWith('Error:')) {
      session.messages.splice(session.messages.length - 1, 1)
    }

    session.status = 'connecting'
    session.provider = session.provider ?? this.settings.activeAgent
    session.latestCheckpointId = null
    session.progress = null

    const retry = window.solus.retry(this.ctxFor(tabId), { prompt: lastUserMsg.content })

    retry.catch((err: Error) => {
      this.handleError(tabId, { message: err.message, stderrTail: [], exitCode: null, elapsedMs: 0, toolCallCount: 0 })
    })
  }

  // ─── Permissions & questions ───

  respondPermission(tabId: string, questionId: string, optionId: string): void {
    window.solus.respondPermission(this.ctxFor(tabId), questionId, optionId)
    const session = this.sessionFor(tabId)
    if (!session) return
    const idx = session.permissionQueue.findIndex((p) => p.questionId === questionId)
    if (idx !== -1) session.permissionQueue.splice(idx, 1)
  }

  respondQuestion(tabId: string, questionId: string, answers: Record<string, string>): void {
    window.solus.respondQuestion(this.ctxFor(tabId), questionId, answers)
    const session = this.sessionFor(tabId)
    if (!session) return
    const idx = session.questionQueue.findIndex((q) => q.questionId === questionId)
    if (idx !== -1) session.questionQueue.splice(idx, 1)
  }

  // ─── Event handlers ───

  handleNormalizedEvent(tabId: string, event: NormalizedEvent): void {
    this.eventReducer.apply(tabId, event)
  }

  interruptTab(tabId: string): void {
    this.eventReducer.interruptTab(tabId)
  }

  handleError(tabId: string, error: EnrichedError): void {
    this.eventReducer.handleError(tabId, error)
  }

  // ─── File checkpointing ───

  async revertChanges(tabId: string): Promise<void> {
    const session = this.sessionFor(tabId)
    if (!session?.latestCheckpointId) return
    const checkpointId = session.latestCheckpointId
    await window.solus.rewindFiles(this.ctxFor(tabId), checkpointId)
    const sessionAfter = this.sessionFor(tabId)
    if (sessionAfter) sessionAfter.latestCheckpointId = null
  }

  // ─── Plans (open state lives in panes, not on Tab) ───

  clearPlanWaiting(sessionId: string): void { clearPlanWaiting(this, sessionId) }
  async openPlanModal(planId: string, ref?: { sessionId?: string; planToolUseId?: string; status?: 'pending' | 'accepted' | 'rejected' }, opts: { secondary?: boolean } = {}): Promise<void> {
    return openPlanModal(this, planId, ref, opts)
  }
  closePlanModal(): void { closePlanModal(this) }

  async approvePlanWithModel(planId: string, mode: 'ask' | 'auto', opts: ApprovePlanOptions = {}): Promise<void> {
    return approvePlanWithModel(this, planId, mode, opts)
  }

  async rejectPlan(planId: string, comment?: string): Promise<void> {
    return rejectPlan(this, planId, comment)
  }

  async openPlanFromDescriptor(d: PlanDescriptor): Promise<void> { return openPlanFromDescriptor(this, d) }
  closePlanPreview(): void { closePlanPreview(this) }
  async resumeSessionFromDescriptor(d: PlanDescriptor): Promise<void> { return resumeSessionFromDescriptor(this, d) }

  /** Open a work as an artifact. By default it takes the Focus pane (or the
   *  secondary slot if one is already open); `secondary: true` forces it beside
   *  the conversation in the secondary pane (used by the project panel). */
  async openWorkModal(workId: string, title?: string, opts: { secondary?: boolean } = {}): Promise<void> {
    const cwd = this.sessionFor(this.activeTabId)?.workingDirectory
    let resolvedId = workId
    if (workId) {
      if (!(await this.worksStore.ensureContent(workId, 'open-work-modal', cwd))) return
    } else {
      if (!title) return
      // workId not yet resolved (historical message) — load manifest once, find by title
      await this.worksStore.loadAll(cwd)
      const entry = Object.entries(this.worksStore.works).find(([, w]) => w.title === title)
      if (!entry) return
      if (!(await this.worksStore.ensureContent(entry[0], 'open-work-modal-title-fallback', cwd))) return
      resolvedId = entry[0]
    }
    this.folioGalleryOpen = false
    if (opts.secondary) this.panes.moveToSecondary({ kind: 'work', workId: resolvedId })
    else this.panes.openWork(resolvedId)
  }

  closeWorkModal(): void {
    this.panes.close()
  }

  /** Delete a work with a brief undo window: close its pane, offer the undo, and
   *  open the store's undo window. The on-disk delete is deferred until the toast
   *  commits — undo is a no-op restore, commit is permanent. */
  requestWorkDelete(work: Work): void {
    if (this.panes.activeWorkId === work.id) this.panes.close()
    // Show the toast before recording the pending delete: showing commits any
    // toast it replaces (permanently deleting the *previous* pendingWorkDelete),
    // so record ours afterwards to avoid it being wiped by that commit.
    toasts.undo('Document deleted', () => this.worksStore.undoWorkDelete(), {
      onDismiss: () => this.worksStore.commitWorkDelete(),
    })
    this.worksStore.beginWorkDelete(work)
  }

  /** Create an empty user-authored work and open it. Persisted immediately so it
   *  behaves like any other work; the editor opens focused for typing. */
  async createBlankWork(type: 'doc' | 'slides' | 'diagram'): Promise<void> {
    const title = type === 'diagram' ? 'Untitled diagram' : 'Untitled document'
    const content = type === 'diagram' ? '{"nodes":[],"edges":[]}' : ''
    await this.createWorkFromContent(title, type, content)
  }

  /** Create a user-authored work from existing content (blank or imported) and
   *  open it. Uses the active session's cwd/provider for origin context. */
  async createWorkFromContent(title: string, type: 'doc' | 'slides' | 'diagram', content: string): Promise<void> {
    const sess = this.sessionFor(this.activeTabId)
    const cwd = sess?.workingDirectory ?? this.globalDefaults.workingDirectory ?? '~'
    const provider: AgentId = sess?.provider ?? 'claude-code'
    const work = await window.solus.createWork(title, type, content, workPreview(type, content), undefined, provider, cwd)
    this.worksStore.works[work.id] = work
    this.folioGalleryOpen = false
    this.panes.openWork(work.id)
  }

  async openChatForWork(workId: string, mode: 'resume' | 'new'): Promise<void> {
    const work = this.worksStore.get(workId)
    if (!work) return
    this.folioGalleryOpen = false
    this.settingsOpen = false

    // Resume targets the most recently linked session (newest in sessionIds),
    // falling back to the legacy origin session.
    const resumeSid = work.sessionIds?.[work.sessionIds.length - 1] ?? work.sessionId

    let targetTabId: string | null = null
    let resumed = false
    this.panes.moveToSecondary({ kind: 'work', workId })
    void this.worksStore.ensureContent(workId, 'open-chat-for-work', this.sessionFor(this.activeTabId)?.workingDirectory)
    if (mode === 'resume' && resumeSid) {
      // find an open tab with this session, else resume from history
      const openTab = this.tabOrder.find((t) => {
        const s = this.sessionFor(t)
        return s?.agentSessionId === resumeSid || s?.forkedFromSessionId === resumeSid
      })
      if (openTab) { this.selectTab(openTab); targetTabId = openTab; resumed = true }
      else {
        targetTabId = await this.resumeSession({
          provider: work.agentProvider,
          sessionId: resumeSid,
          slug: null,
          firstMessage: work.title,
          lastTimestamp: work.updatedAt,
          size: 0,
          cwd: work.cwd,
          projectPath: '',
        })
        resumed = true
      }
    }

    if (!resumed) {
      // New chat opens clean; the boundWorkId binding below attaches the work
      // (shows the "Working on:" chip and injects its content on send).
      targetTabId = await this.createTab(work.cwd)
    }

    // Bind the target session to this work. If its agent session already exists
    // (resume), link the back-reference now; the 'new' path links in session_init.
    if (targetTabId) {
      const s = this.sessionFor(targetTabId)
      if (s) {
        s.boundWorkId = workId
        if (s.agentSessionId) {
          this.worksStore.linkSession(s.workingDirectory, workId, s.agentSessionId)
        }
      }
    }

    requestInputFocus()
  }

  // ─── Folio gallery ───

  toggleFolioGallery(): void {
    this.ui.toggleFolioGallery()
  }

  // ─── Tasks page ───

  toggleTasks(): void {
    this.ui.toggleTasks()
    // The page's own $effect loads on open (it needs the active project's cwd),
    // so there's nothing to kick off here — toggling just flips the overlay.
  }

  /** Start a fresh session bound to a task. Mirrors openWorkAndStartSession: open
   *  a clean tab in the task's project, attach `boundTaskId` (shows the chip and
   *  makes the first send carry `taskId`, which the main process hydrates +
   *  injects), and focus the input so the user can type their first message. */
  async openTaskSession(task: Task): Promise<void> {
    const cwd = this.tasksProjectCwd ?? this.staticInfo?.workspacePath ?? '~'
    const tabId = await this.createTab(cwd)
    const s = this.sessionFor(tabId)
    if (s) s.boundTaskId = task.id
    this.ui.tasksOpen = false
    requestInputFocus()
  }

  /** Jump back to the work happening on a task: focus the most-recently-linked
   *  session if it's open, else resume it from history. The back-link counterpart
   *  to openTaskSession, driven by the persisted task↔session map. */
  async openTaskLinkedSession(task: Task): Promise<void> {
    const links = this.tasksStore.sessionsByTask.get(task.id)
    const resumeSid = links?.[links.length - 1]?.sessionId
    if (!resumeSid) return void this.openTaskSession(task)

    const cwd = this.tasksProjectCwd ?? this.staticInfo?.workspacePath ?? '~'
    const openTab = this.tabOrder.find((t) => {
      const s = this.sessionFor(t)
      return s?.agentSessionId === resumeSid || s?.forkedFromSessionId === resumeSid
    })
    if (openTab) this.selectTab(openTab)
    else {
      await this.resumeSession({
        provider: this.settings.activeAgent,
        sessionId: resumeSid,
        slug: null,
        firstMessage: task.title,
        lastTimestamp: task.updatedAt,
        size: 0,
        cwd,
        projectPath: cwd,
      })
    }
    // Re-attach the binding so the chip + follow-up taskId injection come back
    // even though boundTaskId is renderer-only and resets across reloads.
    const s = this.sessionFor(this.activeTabId)
    if (s) s.boundTaskId = task.id
    this.ui.tasksOpen = false
    requestInputFocus()
  }

  /** Jump to a task from the command palette: open the Tasks page and let it
   *  open the task's detail once its list is loaded. */
  goToTask(task: Task): void {
    this.ui.openTasksToTask(task.id)
  }

  // ─── Pull Requests page ───

  // Opening the page is enough; PrsPage's open-effect resets filters and loads
  // once. Loading here too would double every `pulls.list` on open (and race the
  // filter reset), so leave the fetch to the page.
  togglePrs(): void {
    if (this.ui.togglePrs()) this.prsStore.needsReviewOnly = false
  }

  openPrs(projectPath: string | null = null): void {
    this.prsStore.needsReviewOnly = false
    this.ui.openPrs(projectPath)
  }

  async openReviewMode(
    items: Array<Pick<PullRequestSummary, 'number'>>,
    ctx: IpcContext = this.ctx,
  ): Promise<void> {
    if (this.window.viewMode !== 'editor') await this.window.setViewMode('editor')
    this.prsStore.beginReviewMode(items.map((item) => item.number), ctx)
    this.panes.openPage('review-mode')
    this.isExpanded = true
  }

  /** Single destination seam for review-attention entry points. */
  openNeedsReview(): void {
    const open = () => void this.openReviewMode(this.prsStore.needsReviewItems)
    if (this.prsStore.needsReviewItems.length > 0) open()
    else void this.prsStore.refreshNeedsReview(this.ctx).then(open).catch((error) => {
      toasts.error(`Couldn't load reviews: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  // ─── Automations page ───

  toggleAutomations(): void {
    if (this.ui.toggleAutomations()) {
      void this.automationsStore.loadAll()
    }
  }

  /** Open the automations page, optionally focused on one automation. In editor
   *  mode a focused automation opens in the side-panel builder; otherwise (and
   *  for the bare list) the full-page overlay is shown. */
  openAutomations(focusId?: string | null): void {
    if (focusId && this.window.viewMode === 'editor') {
      this.ui.openAutomationBuilder(focusId)
    } else {
      this.ui.openAutomations(focusId)
    }
    void this.automationsStore.loadAll()
  }

  /** Open one automation directly in the side-panel builder (editor mode). */
  openAutomationBuilder(automationId: string | null): void {
    this.ui.openAutomationBuilder(automationId)
    void this.automationsStore.loadAll()
  }

  /** Open an automation from a chat card in the secondary pane. */
  openAutomationBuilderSecondary(automationId: string, opts: SplitOpenOptions = {}): void {
    this.ui.openAutomationBuilderSecondary(automationId, opts)
    void this.automationsStore.loadAll()
    requestInputFocus()
  }

  // ─── Diff comments (on Tab — UI-only) ───

  addDiffComment(comment: DiffComment): void { addDiffComment(this, comment) }
  updateDiffComment(commentId: string, newText: string): void { updateDiffComment(this, commentId, newText) }
  removeDiffComment(commentId: string): void { removeDiffComment(this, commentId) }
  restoreDiffComment(comment: DiffComment, index: number): void { restoreDiffComment(this, comment, index) }
  clearDiffComments(): void { clearDiffComments(this) }
  setDiffCommentDraft(draft: DiffCommentDraft | null): void { setDiffCommentDraft(this, draft) }
  updateDiffCommentDraftValue(value: string): void { updateDiffCommentDraftValue(this, value) }
  setDiffGeneralComment(value: string): void { setDiffGeneralComment(this, value) }
  submitDiffFeedback(generalComment: string): boolean { return submitDiffFeedback(this, generalComment) }
  async submitDiffFeedbackToNewSession(opts: { generalComment: string; filePath: string | null; diffText: string; branchContext?: string }): Promise<boolean> {
    return submitDiffFeedbackToNewSession(this, opts)
  }

  async startNewSessionWithPrompt(
    prompt: string,
    workingDirectory: string,
    gitContext?: GitCheckout | null,
    statusCard?: StatusCardState | null,
  ): Promise<void> {
    const tabId = await this.createTab(workingDirectory)
    const session = this.sessionFor(tabId)
    if (session && gitContext !== undefined) {
      session.gitContext = gitContext ? { ...gitContext } : null
      session.worktreeBaseBranch = null
    }
    if (session && statusCard) session.statusCard = statusCard
    this.sendMessage(prompt)
  }

  /** Hand request-changes feedback to a normal agent session in the PR's
   *  existing review worktree. prOpenReview created this checkout before the
   *  modal became available, so the new tab can bind to it directly and follow
   *  the same create-tab -> git-context -> prompt path as conflict resolution. */
  async startPrCommentsFixSession(pr: PrReviewContext, feedback?: PrFixFeedback): Promise<void> {
    const tabId = await this.createTab(worktreeProjectRoot(pr.worktreePath))
    const session = this.sessionFor(tabId)
    if (!session) return
    session.gitContext = { branch: pr.branch, targetBranch: pr.baseRef, worktreePath: pr.worktreePath }
    session.worktreeBaseBranch = null
    session.permissionMode = 'auto'
    session.prReview = pr

    const prompt = buildPrCommentsFixPrompt(pr, feedback)
    this.sendMessage(prompt, undefined, tabId)
    const tab = this.tabs[tabId]
    if (tab) tab.title = `Fix PR #${pr.number}`
    requestInputFocus()
  }

  /**
   * Resolve a PR's merge conflicts in a fresh agent session. Opens the session
   * tab immediately — the click lands in a new window right away — then prepares
   * the conflict worktree behind a live status card and, once it's ready, sends
   * the resolution prompt. Agents bind their cwd at prompt time (see promptTab),
   * so we can re-point this tab to the worktree before the first message.
   */
  async startConflictResolverSession(
    pr: { number: number; title: string },
    opts: { ctx?: IpcContext } = {},
  ): Promise<void> {
    const actionCtx = opts.ctx ?? this.ctx
    const placeholderDir = actionCtx.session.projectPath
      ?? actionCtx.session.workingDirectory
      ?? this.activeSession?.gitContext?.repoRoot
      ?? (this.activeSession?.workingDirectory && this.activeSession.workingDirectory !== '~'
        ? worktreeProjectRoot(this.activeSession.workingDirectory)
        : undefined)
    const tabId = await this.createTab(placeholderDir)
    const session = this.sessionFor(tabId)
    if (!session) return
    const tab = this.tabs[tabId]
    if (tab) tab.title = `Resolve #${pr.number}`
    session.statusCard = buildConflictResolverCard(pr.number, 'worktree')

    const promptMsgId = nextMsgId()
    session.messages.push({
      id: promptMsgId,
      role: 'user',
      content: buildConflictResolutionPrompt({ number: pr.number, title: pr.title }),
      timestamp: Date.now(),
    })
    session.status = 'connecting'
    session.latestCheckpointId = null
    session.progress = null
    const abandonPrompt = () => {
      const idx = session.messages.findIndex((m) => m.id === promptMsgId)
      if (idx >= 0) session.messages.splice(idx, 1)
      session.status = 'idle'
    }

    session.statusCard = buildConflictResolverCard(pr.number, 'merge')
    const prepared = await window.solus.prPrepareConflictResolution(actionCtx, pr.number).catch((err) => ({
      success: false as const,
      error: err instanceof Error ? err.message : String(err),
    }))
    if (!prepared.success || !prepared.review) {
      abandonPrompt()
      session.statusCard = buildConflictResolverErrorCard(
        pr.number,
        prepared.error ?? 'The conflict-resolution worktree could not be prepared.',
      )
      return
    }

    const review = prepared.review
    session.workingDirectory = worktreeProjectRoot(review.worktreePath)
    session.gitContext = { branch: review.branch, targetBranch: review.baseRef, worktreePath: review.worktreePath }
    session.worktreeBaseBranch = null
    session.permissionMode = 'auto'
    session.statusCard = buildConflictResolverCard(pr.number, 'session')
    const prompt = buildConflictResolutionPrompt({
      number: review.number,
      title: review.title,
      baseRef: review.baseRef,
      headRef: prepared.headRef,
      conflictFiles: prepared.conflictFiles,
    })
    const promptMsg = session.messages.find((m) => m.id === promptMsgId)
    if (promptMsg) promptMsg.content = prompt
    this.promptTab(tabId, { prompt, displayPrompt: prompt })
    requestInputFocus()
  }

  /** Enter PR review without creating a chat. The checked-out worktree supplies
   *  the review context; a worktree-rooted chat is created only on demand. */
  async enterPrReview(
    number: number,
    title?: string,
    opts: { openChat?: boolean; ctx?: IpcContext } = {},
  ): Promise<void> {
    beginPrReviewProfile(number)
    // Switch to the editor layout up front so the click registers immediately,
    // then mount the review surface skeleton BEFORE the (slow) PR fetch/checkout
    // so the click gets instant feedback instead of a blank pane. The real
    // surface swaps in below once the worktree is ready.
    if (this.window.viewMode !== 'editor') await this.window.setViewMode('editor')
    this.prsStore.prReviewTab = 'activity'
    this.panes.enterPrReviewLoading(number, title)
    try {
      const pr = await window.solus.prOpenReview(opts.ctx ?? this.ctx, number)
      markPrReviewProfile('review-worktree-ready')
      this.panes.enterPrReview(pr)
      if (opts.openChat) {
        await this.openPrReviewChat(pr)
      }
    } catch (err) {
      // Tear down the skeleton so a failed open doesn't strand the user on it.
      this.panes.closeSlot('secondary')
      toasts.error(`Couldn't open PR #${number}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Prepare one review without changing pane placement. Review Mode uses this
   * seam to warm the next item in its queue. */
  async preparePrReview(number: number, opts: { ctx?: IpcContext } = {}): Promise<{ pr: PrReviewContext }> {
    const pr = await window.solus.prOpenReview(opts.ctx ?? this.ctx, number)
    return { pr }
  }

  /** Dock a PR selected from the PR inbox. Preparation may be slow, but it never
   * replaces the primary page; stale results are ignored when selection moves. */
  async dockPrReview(number: number, title?: string, opts: { ctx?: IpcContext } = {}): Promise<void> {
    const current = this.panes.secondaryContent
    if (current.kind === 'pr-review' && current.pr.number === number) return
    if (current.kind === 'pr-review-loading' && current.number === number) return

    this.prsStore.prReviewTab = 'activity'
    beginPrReviewProfile(number)
    this.panes.dockPrReviewLoading(number, title)
    try {
      const pr = await window.solus.prOpenReview(opts.ctx ?? this.ctx, number)
      markPrReviewProfile('review-worktree-ready')
      const pending = this.panes.secondaryContent
      if (pending.kind !== 'pr-review-loading' || pending.number !== number) return
      this.panes.dockPrReview(pr)
    } catch (err) {
      const pending = this.panes.secondaryContent
      if (pending.kind === 'pr-review-loading' && pending.number === number) {
        this.panes.closeSlot('secondary')
        toasts.error(`Couldn't open PR #${number}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  /** Create (once), activate, and reveal the chat associated with a PR review. */
  async openPrReviewChat(pr: PrReviewContext, existingTabId: string | null = null): Promise<string> {
    const hasExistingChat = Boolean(existingTabId && this.tabs[existingTabId])
    beginPrReviewProfile(pr.number, { restart: true })
    markPrReviewProfile('chat-open-start', { hasExistingChat })
    if (existingTabId && this.tabs[existingTabId]) {
      this.setActiveTab(existingTabId)
      this.panes.primaryContent = { kind: 'conversation' }
      this.panes.maximized = false
      this.isExpanded = true
      this.tabs[existingTabId].hasUnread = false
      requestInputFocus()
      requestAnimationFrame(() => {
        markPrReviewProfile('chat-split-first-paint', { hasExistingChat })
        settlePrReviewProfile()
      })
      return existingTabId
    }

    const reviewGitContext: GitCheckout = {
      branch: pr.branch,
      targetBranch: pr.baseRef,
      worktreePath: pr.worktreePath,
    }
    const tabId = await this.createTab(worktreeProjectRoot(pr.worktreePath), {
      activate: false,
      gitContext: reviewGitContext,
      gitInitialization: 'background',
    })
    markPrReviewProfile('chat-tab-ready')
    const reviewSession = this.sessionFor(tabId)
    if (reviewSession) {
      reviewSession.worktreeBaseBranch = null
      reviewSession.permissionMode = 'auto'
      reviewSession.prReview = pr
    }
    this.setActiveTab(tabId)
    this.panes.primaryContent = { kind: 'conversation' }
    this.panes.maximized = false
    this.isExpanded = true
    this.panes.attachPrReviewChat(pr.number, tabId)
    requestInputFocus()
    requestAnimationFrame(() => {
      markPrReviewProfile('chat-split-first-paint', { hasExistingChat })
      settlePrReviewProfile()
    })
    return tabId
  }

  /** Close the review surface. Its agent chat remains an ordinary workspace tab. */
  exitPrReview(): void {
    this.panes.closeSlot('secondary')
  }

  // ─── Settings page ───

  showSettings(tab: 'general' | 'api-access' | 'tools' | 'skills' | 'voice' = 'general') {
    this.ui.showSettings(tab)
    analytics.settingsOpened()
  }

  /** Open the settings Projects tab with the given project preselected (from the project panel gear). */
  showProjectSettings(cwd: string) {
    this.ui.showProjectSettings(cwd)
    analytics.settingsOpened()
  }

  closeSettings() {
    this.ui.closeSettings()
  }

  // ─── Plans gallery ───

  togglePlansGallery(): void {
    if (this.ui.togglePlansGallery()) {
      analytics.planGalleryOpened()
    }
  }

}

export const [getWorkspaceContext, setWorkspaceContext] = createContext<WorkspaceContext>()
