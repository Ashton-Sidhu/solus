import { createContext } from 'svelte'
import type { AgentId, NormalizedEvent, EnrichedError, Message, Tab, InputState, Session, DiffCommentDraft, DiffComment, Attachment, PlanDescriptor, SessionCtx, IpcContext, TurnSnapshot, QueuedPromptSnapshot, ModelConfig, SessionMeta, TabGitContext, Work } from '../../shared/types'
import { branchKeyFor } from '../lib/sessionUtils'
import { uuid } from '../../shared/uuid'
import { workPreview } from '../../shared/work-preview'
import notificationSrc from '../../../resources/notification.mp3'
import { sendRateLimitedNow } from '../lib/rate-limit-actions'
import { type PlanStore } from './plan.store.svelte'
import { WorksStore } from './works.store.svelte'
import { AutomationsStore } from './automations.store.svelte'
import { TasksStore } from './tasks.store.svelte'
import { PrsStore } from './prs.store.svelte'
import { MergeQueueStore } from './merge-queue.store.svelte'
import { type Task } from '../../shared/task-types'
import { toasts } from './toast.store.svelte'
import { PaneViewStore, type SplitOpenOptions } from './pane-view.store.svelte'
import { WorkStreamTracker } from './work-stream-tracker.svelte'
import { WorkspaceUiStore, type SettingsTab } from './workspace-ui.store.svelte'
import { IpcContextBuilder } from './ipc-context'
import { PromptComposer } from './prompt-composer'
import { TabRegistry } from './tab-registry.svelte'
import { SessionConfigController } from './session-config.svelte'
import { EnvironmentStore, type StaticInfo } from './environment.store.svelte'
import { SessionEventReducer } from './session-event-reducer.svelte'
import { type SettingsContext, type TabGroupMode } from './settings.context.svelte'
import { type WindowContext } from './window.context.svelte'
import { type StatusBarContext } from './status-bar.context.svelte'
import { type AgentContext } from './agent.context.svelte'
import { type GitStatusStore } from './git-status.store.svelte'
import { makeSession, makeTab, makeInputState } from './session.factories'
import { removeDraft } from './tab-persistence'
import { nextMsgId } from './session.utils'
import { isSolusWorktreePath, tabGitContextFromStatus, worktreeProjectRoot } from '../../shared/types'
import { syncPendingInputFromEvent, loadSessionTranscript } from './session-transcript'
import { addDiffComment, updateDiffComment, removeDiffComment, restoreDiffComment, clearDiffComments, setDiffCommentDraft, updateDiffCommentDraftValue, setDiffGeneralComment, submitDiffFeedback, submitDiffFeedbackToNewSession } from './session-diff-feedback'
import { clearPlanWaiting, openPlanModal, closePlanModal, requestConversationScrollToBottom, approvePlanWithModel, rejectPlan, openPlanFromDescriptor, closePlanPreview, resumeSessionFromDescriptor } from './session-plan-operations'
import { analytics } from '../lib/analytics'
import { requestInputFocus } from '../lib/inputFocus'
import { disposeGitActions } from '../lib/git-actions.svelte'

const devSessionLogging = Boolean((import.meta as any).env?.DEV)

function logDevSessionState(tab: Tab, eventType: string, session: Session, _streamingText?: string): void {
  if (!devSessionLogging) return
  const state = $state.snapshot(session) as Session
  const tabState = $state.snapshot(tab)
  console.debug('[Solus][SessionState]', {
    tab: tabState,
    sessionId: state.agentSessionId,
    provider: state.provider,
    eventType,
    state,
  })
}

export type SessionFields = {
  isExpanded: boolean
  staticInfo: StaticInfo | null
  pendingInput: string | null
}

const notificationAudio = new Audio(notificationSrc)
notificationAudio.volume = 1.0

export class WorkspaceContext {
  registry = new TabRegistry()
  env: EnvironmentStore
  pendingInput = $state<string | null>(null)
  continuingWorktreeTabs = $state<Record<string, boolean>>({})
  eventReducer: SessionEventReducer

  /** True while bootstrapRuntimeTabs is running; prevents persist effect from clobbering saved snapshot. */
  hydrating = $state(true)

  planStore: PlanStore
  worksStore: WorksStore
  automationsStore = new AutomationsStore()
  tasksStore = new TasksStore()
  prsStore = new PrsStore()
  mergeQueueStore = new MergeQueueStore()
  /** Global two-pane view state — not per-tab. */
  artifactViewer = new PaneViewStore()
  ui: WorkspaceUiStore
  /** A work pending deletion from the open-work view, held while the undo toast
   *  is visible. The work is removed from disk only on commit (toast dismiss). */
  pendingWorkDelete = $state<Work | null>(null)
  config: SessionConfigController
  onTurnSettled?: (tabId: string, cwd: string | null) => void

  settings: SettingsContext
  private window: WindowContext
  private statusBar: StatusBarContext
  private agent?: AgentContext
  private workStreamTracker: WorkStreamTracker
  private ipcContextBuilder: IpcContextBuilder
  private promptComposer: PromptComposer
  private gitStatus: GitStatusStore
  lastSnapshotAt = $state(0)

  constructor(settings: SettingsContext, windowCtx: WindowContext, statusBar: StatusBarContext, planStore: PlanStore, gitStatus: GitStatusStore, agent?: AgentContext) {
    this.settings = settings
    this.window = windowCtx
    this.statusBar = statusBar
    this.agent = agent
    this.planStore = planStore
    this.gitStatus = gitStatus
    this.worksStore = new WorksStore()
    this.config = new SessionConfigController({
      settings: this.settings,
      registry: this.registry,
      statusBar: this.statusBar,
      planStore: this.planStore,
      setPluginCommands: (commands) => { this.pluginCommands = commands },
      createTab: () => this.createTab(),
      ctx: () => this.ctx,
      ctxForDirectory: (dir) => this.ctxForDirectory(dir),
      refreshPluginCommands: (dir, tabId) => { void this.refreshPluginCommands(dir, tabId) },
      fetchGitContext: (tabId, dir) => { void this.fetchGitContext(tabId, dir) },
    })
    this.env = new EnvironmentStore({
      registry: this.registry,
      settings: this.settings,
      config: this.config,
      planStore: this.planStore,
      agent: this.agent,
      setGitStatus: (cwd, status) => this.gitStatus.set(cwd, status),
      ctxFor: (tabId) => this.ctxFor(tabId),
      loadTranscript: (args) => loadSessionTranscript(this, args),
    })
    this.ui = new WorkspaceUiStore(this.artifactViewer, this.planStore)
    this.workStreamTracker = new WorkStreamTracker(this.worksStore, this.artifactViewer)
    this.eventReducer = new SessionEventReducer({
      registry: this.registry,
      settings: this.settings,
      planStore: this.planStore,
      worksStore: this.worksStore,
      tasksStore: this.tasksStore,
      automationsStore: this.automationsStore,
      workStreamTracker: this.workStreamTracker,
      isTabVisible: (tabId) => this.isTabVisible(tabId),
      recomputeChangedFiles: (tabId) => this.recomputeChangedFiles(tabId),
      refreshTurnSnapshots: (tabId) => { void this.refreshTurnSnapshots(tabId) },
      setGitStatus: (cwd, status) => this.gitStatus.set(cwd, status),
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
    gitContext: TabGitContext | null
    modelConfig: ModelConfig
  } { return this.config.globalDefaults }
  set globalDefaults(value: {
    permissionMode: 'ask' | 'auto' | 'plan'
    workingDirectory: string
    gitContext: TabGitContext | null
    modelConfig: ModelConfig
  }) { this.config.globalDefaults = value }
  get tabGroupMode(): TabGroupMode { return this.config.tabGroupMode }
  set tabGroupMode(value: TabGroupMode) { this.config.tabGroupMode = value }
  get staticInfo(): StaticInfo | null { return this.env.staticInfo }
  set staticInfo(value: StaticInfo | null) { this.env.staticInfo = value }
  get pluginCommands(): Session['pluginCommands'] { return this.env.pluginCommands }
  set pluginCommands(value: Session['pluginCommands']) { this.env.pluginCommands = value }
  get turnSnapshots(): Record<string, TurnSnapshot[]> { return this.env.turnSnapshots }
  set turnSnapshots(value: Record<string, TurnSnapshot[]>) { this.env.turnSnapshots = value }
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
    if (this.artifactViewer.primary.kind === 'review') {
      this.artifactViewer.primary = { kind: 'conversation' }
    }
  }

  private isTabVisible(tabId: string): boolean {
    return tabId === this.activeTabId && (this.window.viewMode === 'editor' || this.window.isWeb || this.isExpanded)
  }

  private resetOverlays(opts: { closeArtifactViewer?: boolean } = {}): void {
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
    return this.env.initStaticInfo()
  }

  async refreshPluginCommands(workingDirectory: string, tabId?: string): Promise<void> {
    return this.env.refreshPluginCommands(workingDirectory, tabId)
  }

  async fetchGitContext(tabId: string, dir: string): Promise<void> {
    return this.env.fetchGitContext(tabId, dir)
  }

  async switchToBranch(branch: string): Promise<boolean> {
    return this.config.switchToBranch(branch)
  }

  recomputeChangedFiles(tabId: string): void {
    this.env.recomputeChangedFiles(tabId)
  }

  /**
   * Replace a tab's windowed transcript with the full history. Startup hydration
   * only loads the most recent messages (see HISTORY_WINDOW); this pulls in the
   * rest when the user scrolls back to the top.
   */
  async expandHistory(tabId: string): Promise<void> {
    return this.env.expandHistory(tabId)
  }

  async hydrateChangedFilesFromDiff(tabId: string): Promise<void> {
    return this.env.hydrateChangedFilesFromDiff(tabId)
  }

  async refreshTurnSnapshots(tabId: string): Promise<void> {
    return this.env.refreshTurnSnapshots(tabId)
  }

  reconcileQueuedPrompts(tabId: string, queuedPrompts: QueuedPromptSnapshot[]): void {
    this.env.reconcileQueuedPrompts(tabId, queuedPrompts)
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

  async createTab(cwd?: string): Promise<string> {
    const defaultDir = this.staticInfo?.workspacePath || '~'
    const activeSession = this.activeSession
    const inheritedDir = cwd ?? (activeSession?.workingDirectory || this.globalDefaults.workingDirectory || defaultDir)
    const sourceConfig = activeSession?.modelConfig ?? this.globalDefaults.modelConfig
    const provider = (activeSession?.provider ?? this.settings.activeAgent) as AgentId
    const inheritedModelConfig = {
      ...sourceConfig,
      reasoningEffort: this.defaultReasoningEffortFor(provider, sourceConfig.modelId),
    }
    const inheritedPermissionMode = this.globalDefaults.permissionMode
    const inheritedGitContext = activeSession?.gitContext ?? this.globalDefaults.gitContext
    const { tabId } = await window.solus.createTab()
    const session = makeSession(this.settings, {
      workingDirectory: inheritedDir,
      gitContext: inheritedGitContext ? { ...inheritedGitContext } : null,
      ...(inheritedGitContext?.worktreePath ? { worktreeBaseBranch: null } : {}),
      modelConfig: inheritedModelConfig,
      permissionMode: inheritedPermissionMode,
      sessionSkills: activeSession?.sessionSkills ?? [],
      pluginCommands: this.pluginCommands,
    })
    const tab = makeTab(session.id, { id: tabId })
    this.sessions[session.id] = session
    this.tabs[tab.id] = tab
    this.addTabToOrder(tab.id)
    this.setActiveTab(tab.id)
    this.resetOverlays({ closeArtifactViewer: true })
    if (!activeSession?.gitContext && inheritedGitContext) this.globalDefaults.gitContext = null
    if (!inheritedGitContext?.worktreePath) void this.fetchGitContext(tabId, inheritedDir)
    void this.refreshPluginCommands(inheritedDir)
    requestInputFocus()
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
    if (session.gitContext?.worktreePath) session.gitContext = null
    const dir = session.workingDirectory
    if (!dir || dir === '~') return
    const status = await window.solus.gitProjectStatus(dir).catch(() => null)
    this.gitStatus.set(dir, status)
    session.gitContext = tabGitContextFromStatus(status)
    if (status?.targetBranch) session.worktreeBaseBranch = status.targetBranch
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
    // If the source had a worktree, the inherited gitContext is already correct.
    // fetchGitContext would overwrite it with a non-worktree context (no worktreePath).
    if (!sourceSession.gitContext?.worktreePath) {
      void this.fetchGitContext(tabId, sourceSession.workingDirectory)
    }
    requestInputFocus()
    return tabId
  }

  /** Move a live session into a fresh git worktree. Creates the worktree now (so
   *  the branch name and git panel update immediately), then flags the session to
   *  fork on its next prompt — that fork re-homes the conversation's transcript
   *  under the worktree, so the session truly lives there. Same tab, same history. */
  async continueInWorktree(tabId: string): Promise<void> {
    const session = this.sessionFor(tabId)
    if (!session?.agentSessionId || session.gitContext?.worktreePath || this.continuingWorktreeTabs[tabId]) return

    const firstUser = session.messages.find((m) => m.role === 'user')
    const namePrompt = typeof firstUser?.content === 'string' ? firstUser.content.slice(0, 200) : ''

    this.continuingWorktreeTabs[tabId] = true
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
      session.forkedFromSessionId = session.agentSessionId
      session.forked = true
      session.messages.push({
        id: uuid(),
        role: 'system',
        content: '',
        timestamp: Date.now(),
        worktreeMovedTo: result.gitContext.branch,
      })
      requestInputFocus()
    } finally {
      this.continuingWorktreeTabs[tabId] = false
    }
  }

  isContinuingInWorktree(tabId: string | null | undefined): boolean {
    return !!tabId && !!this.continuingWorktreeTabs[tabId]
  }

  selectTab(tabId: string): void {
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
      this.resetOverlays({ closeArtifactViewer: true })
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
    if (session) {
      this.planStore.preloadDescriptors(session.workingDirectory, this.ctx)
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

  async toggleViewMode(): Promise<void> {
    const currentMode = this.window.viewMode
    const newMode = currentMode === 'pill' ? 'editor' : 'pill'
    if (newMode === 'editor') {
      this.isExpanded = true
      const { activeTabId } = this
      if (this.tabs[activeTabId]) {
        this.tabs[activeTabId].hasUnread = false
      }
    }
    analytics.modeToggled({ mode: newMode })
    await this.window.setViewMode(newMode)
  }

  private createTabFromDefaults(): string {
    const inheritedGitContext = this.globalDefaults.gitContext
    const session = makeSession(this.settings, {
      workingDirectory: this.globalDefaults.workingDirectory,
      gitContext: inheritedGitContext ? { ...inheritedGitContext } : null,
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
    if (inheritedGitContext) this.globalDefaults.gitContext = null
    if (!inheritedGitContext?.worktreePath) void this.fetchGitContext(tabId, this.globalDefaults.workingDirectory)
    void this.refreshPluginCommands(this.globalDefaults.workingDirectory)
    return tabId
  }

  closeTab(tabId: string): void {
    window.solus.closeTab(this.ctxFor(tabId))
    const tab = this.tabs[tabId]
    const sessionId = tab?.sessionId
    const closedBranchKey = branchKeyFor(this.sessionFor(tabId))
    const newOrder = this.tabOrder.filter((id) => id !== tabId)
    delete this.tabs[tabId]
    // Purge the closed tab's persisted input draft so the drafts map can't grow
    // unbounded (patchActiveDraft only ever adds/updates, never removes).
    removeDraft(tabId)
    disposeGitActions(tabId)

    // Clean up session if no other tabs point to it
    if (sessionId && !Object.values(this.tabs).some((t) => t.sessionId === sessionId)) {
      delete this.sessions[sessionId]
    }

    if (this.activeTabId === tabId) {
      if (newOrder.length === 0) {
        this.activeTabId = ''
      } else {
        const closedIdx = this.tabOrder.indexOf(tabId)
        // Prefer a tab on the same branch; fall back to positional neighbour
        const sameBranch = newOrder.filter((id) => branchKeyFor(this.sessionFor(id)) === closedBranchKey)
        if (sameBranch.length > 0) {
          this.setActiveTab(sameBranch.reduce((best, id) => {
            const idxA = this.tabOrder.indexOf(id)
            const idxB = this.tabOrder.indexOf(best)
            return Math.abs(idxA - closedIdx) < Math.abs(idxB - closedIdx) ? id : best
          }))
        } else {
          this.setActiveTab(newOrder[Math.min(closedIdx, newOrder.length - 1)])
        }
      }
    }
    this.tabOrder = newOrder
  }

  clearTab(): void {
    const { activeTabId } = this
    window.solus.resetTabSession(this.ctx)
    const session = this.sessionFor(activeTabId)
    if (!session) return
    session.agentSessionId = null
    session.provider = null
    session.messages = []
    session.changedFiles = []
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
    const tab = this.tabs[activeTabId]
    if (tab) tab.title = 'New Tab'
    delete this.streaming.text[activeTabId]
    if (session.workingDirectory && !session.gitContext) {
      void this.fetchGitContext(activeTabId, session.workingDirectory)
    }
  }

  async resumeSession(meta: SessionMeta, opts?: { background?: boolean }): Promise<string> {
    const background = opts?.background ?? false
    const provider = meta.provider ?? this.settings.activeAgent
    const defaultDir = meta.cwd || this.staticInfo?.homePath || '~'
    const workingDirectory = worktreeProjectRoot(defaultDir)
    const title = meta.customTitle
      ? meta.customTitle
      : meta.firstMessage
        ? meta.firstMessage.length > 80 ? meta.firstMessage.substring(0, 80) : meta.firstMessage
        : meta.slug || 'Resumed'

    const hadActiveTab = !!this.activeTab
    let tabId = this.activeTabId
    const activeTab = this.activeTab
    const activeSession = this.activeSession
    const canTakeOver = activeTab && activeSession && !activeSession.agentSessionId
      && activeSession.status !== 'connecting' && activeSession.status !== 'running'
      && activeSession.messages.length === 0
    const shouldCreateNewTab = background || !canTakeOver
    if (shouldCreateNewTab) {
      const newTab = await window.solus.createTab()
      tabId = newTab.tabId
      const session = makeSession(this.settings, {
        provider,
        agentSessionId: meta.sessionId,
        title,
        workingDirectory,
        modelConfig: { ...this.globalDefaults.modelConfig },
        readOnlyReason: null,
        loadingHistory: true,
      } as any)
      const tab = makeTab(session.id, { id: tabId, title })
      this.sessions[session.id] = session
      this.tabs[tab.id] = tab
      this.addTabToOrder(tab.id)
      if (!background || !hadActiveTab) {
        this.setActiveTab(tab.id)
        if (!background) this.isExpanded = true
        if (this.settings.activeAgent !== provider) {
          this.settings.update({ activeAgent: provider })
        }
      }
    } else {
      const session = this.sessions[activeTab!.sessionId]
      session.provider = provider
      session.agentSessionId = meta.sessionId
      session.workingDirectory = workingDirectory
      session.messages.splice(0, session.messages.length)
      session.readOnlyReason = null
      session.gitContext = null
      session.loadingHistory = true
      activeTab!.title = title

      if (!background) {
        this.setActiveTab(activeTab!.id)
        this.isExpanded = true
        if (this.settings.activeAgent !== provider) {
          this.settings.update({ activeAgent: provider })
        }
      }
    }
    if (!background) {
      this.resetOverlays()
    }

    try {
      const [transcript, restoredGitContext] = await Promise.all([
        loadSessionTranscript(this, {
          sessionId: meta.sessionId,
          loadPath: meta.projectPath || defaultDir,
          displayCwd: workingDirectory,
          provider,
          ctx: this.ctxFor(tabId),
        }),
        window.solus.worktreeRestore(this.ctxFor(tabId), defaultDir),
        this.attachRuntimeSession(tabId),
      ])

      const session = this.sessionFor(tabId)
      const messages = transcript.messages
      if (session) session.messages.splice(0, session.messages.length, ...messages)
      if (session) {
        session.progress = transcript.progress
      }

      this.recomputeChangedFiles(tabId)
      this.onTurnSettled?.(tabId, this.sessionFor(tabId)?.workingDirectory ?? null)
      void this.refreshPluginCommands(workingDirectory, tabId)
      await Promise.all(transcript.planIds.map((planId) => this.planStore.hydrateAnnotations(planId)))

      if (restoredGitContext) {
        if (session) {
          session.gitContext = restoredGitContext
          session.readOnlyReason = null
        }
        await this.hydrateChangedFilesFromDiff(tabId)
      } else if (isSolusWorktreePath(defaultDir)) {
        if (session) {
          session.gitContext = null
          session.readOnlyReason = 'This session is read-only because its worktree no longer exists.'
        }
      } else {
        void this.fetchGitContext(tabId, workingDirectory)
      }

    } finally {
      const session = this.sessionFor(tabId)
      if (session) session.loadingHistory = false
    }

    requestConversationScrollToBottom(tabId)
    return tabId
  }

  // ─── Tab configuration ───

  updateModelConfig(patch: Partial<import('../../shared/types').ModelConfig>): void {
    this.config.updateModelConfig(patch)
  }

  switchActiveAgent(agentId: AgentId): void {
    this.config.switchActiveAgent(agentId)
  }

  setPermissionMode(mode: 'ask' | 'auto' | 'plan'): void {
    this.config.setPermissionMode(mode)
  }

  setWorktreeBaseBranch(branch: string | null): void {
    this.config.setWorktreeBaseBranch(branch)
  }

  syncWorktreeDefault(enabled: boolean): void {
    this.config.syncWorktreeDefault(enabled)
  }

  toggleWorktreeMode(): void {
    this.config.toggleWorktreeMode()
  }

  async switchToWorktree(worktreePath: string): Promise<void> {
    return this.config.switchToWorktree(worktreePath)
  }

  async setBaseDirectory(dir: string): Promise<void> {
    return this.config.setBaseDirectory(dir)
  }

  addDirectory(dir: string): void {
    this.config.addDirectory(dir)
  }

  removeDirectory(dir: string): void {
    this.config.removeDirectory(dir)
  }

  // ─── Attachments (UI-only, on the current input state) ───

  addAttachments(attachments: Attachment[]): void {
    this.currentInput.attachments.push(...attachments)
  }

  removeAttachment(attachmentId: string): void {
    const input = this.currentInput
    input.attachments = input.attachments.filter((a) => a.id !== attachmentId)
  }

  clearAttachments(): void {
    this.currentInput.attachments = []
  }

  // ─── Messaging ───

  addSystemMessage(content: string): void {
    const session = this.activeSession
    if (!session) return
    session.messages.push({ id: nextMsgId(), role: 'system' as const, content, timestamp: Date.now() })
  }

  private promptTab(tabId: string, options: { prompt: string; displayPrompt: string; imageAttachments?: Array<{ mimeType: string; dataUrl: string }>; taskId?: string }): void {
    window.solus.createTab(tabId)
      .then(() => {
        // Guard: user may have interrupted between createTab resolving and this tick.
        // If so, stopTab already fired before prompt — skip submission to avoid a
        // phantom run that can never be cancelled.
        const session = this.sessionFor(tabId)
        if (!session) return
        if (session.agentSessionId) {
          return window.solus.dispatchToAgentSession(this.ctxFor(tabId), session.agentSessionId, options)
        }
        return window.solus.startAgentSession(this.ctxFor(tabId), options).then(({ agentSessionId }) => {
          const current = this.sessionFor(tabId)
          if (current && !current.agentSessionId) current.agentSessionId = agentSessionId
        })
      })
      .catch((err: Error) => {
        // A queued prompt the user removed from the queue rejects with this
        // sentinel. The dequeue is intentional and already reflected in the UI
        // via the prompt_dequeued event, so don't surface it as an error.
        if (err.message.endsWith('Cancelled by user')) return
        this.handleError(tabId, { message: err.message, stderrTail: [], exitCode: null, elapsedMs: 0, toolCallCount: 0 })
      })
  }

  sendMessage(prompt: string, projectPath?: string): void {
    if (this.tabOrder.length === 0) {
      this.createTabFromDefaults()
    }
    const { activeTabId } = this
    const tab = this.tabs[activeTabId]
    const session = this.sessionFor(activeTabId)
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
      this.planStore.preloadDescriptors(resolvedPath, this.ctx)
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
      this.promptTab(activeTabId, { prompt: fullPrompt, displayPrompt: prompt, imageAttachments, taskId: session.boundTaskId ?? undefined })
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

    this.promptTab(activeTabId, { prompt: fullPrompt, displayPrompt: prompt, imageAttachments, taskId: session.boundTaskId ?? undefined })
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

    const retry = session.agentSessionId
      ? window.solus.dispatchToAgentSession(this.ctxFor(tabId), session.agentSessionId, { prompt: lastUserMsg.content })
      : window.solus.startAgentSession(this.ctxFor(tabId), { prompt: lastUserMsg.content }).then(({ agentSessionId }) => {
        const current = this.sessionFor(tabId)
        if (current && !current.agentSessionId) current.agentSessionId = agentSessionId
      })

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

  // ─── Plans (open state lives in artifactViewer, not on Tab) ───

  clearPlanWaiting(sessionId: string): void { clearPlanWaiting(this, sessionId) }
  async openPlanModal(planId: string, ref?: { sessionId?: string; planToolUseId?: string; status?: 'pending' | 'accepted' | 'rejected' }, opts: { secondary?: boolean } = {}): Promise<void> {
    return openPlanModal(this, planId, ref, opts)
  }
  closePlanModal(): void { closePlanModal(this) }

  async approvePlanWithModel(planId: string, mode: 'ask' | 'auto', provider?: AgentId, modelId?: string, generalComment?: string, useWorktree?: boolean): Promise<void> {
    return approvePlanWithModel(this, planId, mode, provider, modelId, generalComment, useWorktree)
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
    if (opts.secondary) this.artifactViewer.moveToSecondary({ kind: 'work', workId: resolvedId })
    else this.artifactViewer.openWork(resolvedId)
  }

  closeWorkModal(): void {
    this.artifactViewer.close()
  }

  /** Delete a work with a brief undo window. The on-disk delete is deferred until
   *  the toast commits, so the work just hides from the gallery (filtered out via
   *  pendingWorkDelete) until then — undo is a no-op restore, commit is permanent. */
  requestWorkDelete(work: Work): void {
    if (this.artifactViewer.activeWorkId === work.id) this.artifactViewer.close()
    // Show the toast before recording the pending delete: showing commits any
    // toast it replaces (permanently deleting the *previous* pendingWorkDelete),
    // so set ours afterwards to avoid it being wiped by that commit.
    toasts.undo('Document deleted', () => this.undoWorkDelete(), {
      onDismiss: () => this.commitWorkDelete(),
    })
    this.pendingWorkDelete = work
  }

  /** Toast dismissed — permanently delete the work from disk. */
  commitWorkDelete(): void {
    const work = this.pendingWorkDelete
    this.pendingWorkDelete = null
    if (work) void this.worksStore.remove(work.id)
  }

  /** Toast undo — keep the work; clearing the pending state un-hides it. */
  undoWorkDelete(): void {
    this.pendingWorkDelete = null
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
    this.artifactViewer.openWork(work.id)
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
    this.artifactViewer.moveToSecondary({ kind: 'work', workId })
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
          this.worksStore.linkSessionLocal(workId, s.agentSessionId)
          void window.solus.linkWorkSession(workId, s.agentSessionId, s.workingDirectory)
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
    this.ui.togglePrs()
  }

  openPrs(): void {
    this.ui.openPrs()
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

  async startNewSessionWithPrompt(prompt: string, workingDirectory: string, gitContext?: TabGitContext | null): Promise<void> {
    const tabId = await this.createTab(workingDirectory)
    const session = this.sessionFor(tabId)
    if (session && gitContext !== undefined) {
      session.gitContext = gitContext ? { ...gitContext } : null
      session.worktreeBaseBranch = null
    }
    this.sendMessage(prompt)
  }

  /**
   * Enter PR review: check out the PR's worktree, open a worktree-rooted chat
   * session with full powers, and arrange the panes (M3: review surface maximized
   * in the secondary pane, the chat as the primary conversation). The checked-out
   * worktree IS the PR head, so the agent's reads see the real post-change files
   * and the diff renders the PR change set.
   */
  async enterPrReview(number: number, title?: string): Promise<void> {
    // Switch to the editor layout up front so the click registers immediately,
    // then mount the review surface skeleton BEFORE the (slow) PR fetch/checkout
    // so the click gets instant feedback instead of a blank pane. The real
    // surface swaps in below once the worktree is ready.
    if (this.window.viewMode !== 'editor') await this.window.setViewMode('editor')
    this.artifactViewer.enterPrReviewLoading(number, title)
    try {
      const pr = await window.solus.prOpenReview(this.ctx, number)
      const tabId = await this.createTab(pr.worktreePath)
      const session = this.sessionFor(tabId)
      if (session) {
        session.gitContext = { branch: pr.branch, targetBranch: pr.baseRef, worktreePath: pr.worktreePath }
        session.worktreeBaseBranch = null
        // Full powers in the PR worktree (edit/run/push) per the spec.
        session.permissionMode = 'auto'
        session.prReview = pr
      }
      const tab = this.tabs[tabId]
      if (tab) tab.title = `PR #${pr.number}`
      this.artifactViewer.enterPrReview(pr, tabId)
      requestInputFocus()
    } catch (err) {
      // Tear down the skeleton so a failed open doesn't strand the user on it.
      this.artifactViewer.closeSlot('secondary')
      toasts.error(`Couldn't open PR #${number}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * Exit PR review: tear down the maximized review surface AND close its
   * worktree-rooted chat tab. The chat exists only to work alongside the review,
   * so leaving it behind strands the user in an empty `PR #N` tab — closing it
   * instead drops focus back onto the neighbour tab they came from (see closeTab).
   */
  exitPrReview(chatTabId: string): void {
    this.artifactViewer.closeSlot('secondary')
    this.closeTab(chatTabId)
  }

  // ─── Settings page ───

  showSettings(tab: 'general' | 'api-access' | 'tools' | 'skills' | 'voice' | 'git-providers' = 'general') {
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
