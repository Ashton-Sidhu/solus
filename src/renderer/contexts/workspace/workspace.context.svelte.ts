import { createAppContext } from '../app/create-app-context'
import type { AgentId, NormalizedEvent, EnrichedError, Message, Tab, InputState, Session, DiffCommentDraft, DiffComment, Attachment, PlanDescriptor, SessionCtx, IpcContext, TurnSnapshot, QueuedPromptSnapshot, ModelConfig, SessionMeta, SessionTitleChangedEvent, GitCheckout, Work, StatusCardState, PrReviewContext, PromptDelivery, ThreadGoal, ThreadGoalSetRequest } from '../../../shared/types'
import type { PullRequestSummary } from '../../../shared/providers'
import type { Via } from '../../../shared/analytics-events'
import { buildConflictResolutionPrompt, buildConflictResolverCard, buildConflictResolverErrorCard } from '../../lib/pr-conflict-resolution'
import { adjacentTabAfterClose, branchKeyFor, buildTabSections, findOpenTabForSession } from '../../lib/sessionUtils'
import { uuid } from '../../../shared/uuid'
import { workPreview } from '../../../shared/work-preview'
import notificationSrc from '../../../../resources/notification.mp3'
import { sendRateLimitedNow } from '../../lib/rate-limit-actions'
import { type PlanStore } from '../plans/plan.store.svelte'
import { WorksStore } from '../works/works.store.svelte'
import { AutomationsStore } from '../automations/automations.store.svelte'
import { automationDraftSessionRequest } from '../automations/automation-draft-session'
import { TasksStore } from '../tasks/tasks.store.svelte'
import { PrsStore, type PrReviewTab } from '../prs/prs.store.svelte'
import { StacksStore } from '../prs/stacks.store.svelte'
import { type Task } from '../../../shared/task-types'
import { writeSessionHandoff } from './active-session-pointer'
import { toasts } from '../../lib/toasts'
import { RouterStore } from './routing/router.store.svelte'
import { PaneGeometryStore } from './routing/pane-geometry.store.svelte'
import { visibleRef, type NavTarget, type PaneId } from './routing/location'
import { CHAT_ROUTE, chatRoute, type RouteRef, type SettingsTab } from './routing/route-registry'
import { WorkStreamTracker } from './work-stream-tracker.svelte'
import { WorkspaceUiStore } from './workspace-ui.store.svelte'
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
import { removeDraft, removePersistedTab } from './tab-persistence'
import { applySessionTitleChange } from './session-title-change'
import { applyRuntimeConfig, findLastUserIndex, nextMsgId } from './session.utils'
import type { DiffScope } from '../../../shared/git-types'
import type { FilePreviewRequest } from '../../lib/filePreview'
import { gitCheckoutFromState, isSessionBusyStatus, isSolusWorktreePath, isSteerableStatus, worktreeProjectRoot } from '../../../shared/types'
import { syncPendingInputFromEvent, loadSessionTranscript, RESTORED_TRANSCRIPT_LIMIT } from './session-transcript'
import { addDiffComment, updateDiffComment, removeDiffComment, restoreDiffComment, clearDiffComments, setDiffCommentDraft, updateDiffCommentDraftValue, setDiffGeneralComment, submitDiffFeedback, submitDiffFeedbackToNewSession } from './session-diff-feedback'
import { clearPlanWaiting, openPlanModal, closePlanModal, requestConversationScrollToBottom, approvePlanWithModel, rejectPlan, openPlanFromDescriptor, closePlanPreview, resumeSessionFromDescriptor, loadPlanContent, type ApprovePlanOptions } from './session-plan-operations'
import { track } from '../../lib/analytics'
import { requestInputFocus } from '../../lib/inputFocus'
import { projectDirLabel } from '../../lib/paths'
import { disposeGitActions } from '../../lib/git-actions.svelte'
import { prioritizeTabHydration } from './session-bootstrap'
import { serverConnections } from '@client-core/server-connections'
import { LOCAL_SERVER_ID } from '@client-core/server-registry'
import { buildPrCommentsFixPrompt, type PrFixFeedback } from './pr-fix-session'
import { isPristineSplitTab } from '../../lib/split-chat'
import {
  beginPrReviewProfile,
  markPrReviewProfile,
  settlePrReviewProfile,
} from '../../components/pr-review/lib/pr-review-profiler'
import { prepareHostCheckout, retargetSessionHost } from '../../components/servers/run-on'
import { buildRemoteDispatchCard } from '../../lib/remote-dispatch-card'
import { quotedReplyDraft } from '../../lib/quoted-reply'
import { GoalSync } from './goal-sync'
import { taskCreationContextFor, type TaskCreationContext } from '../../components/tasks/lib/task-creation-context'
import {
  reviewGuideStore,
  sessionGuideIdentity,
} from '../../components/review/review-guide.store.svelte'

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

/** An open project and every path root that belongs to it. */
export type OpenProject = {
  /** Repo root when git, else the working directory. Identifies the project. */
  key: string
  label: string
  roots: string[]
}

export type SessionFields = {
  isExpanded: boolean
  staticInfo: StaticInfo | null
  pendingInput: string | null
}

interface CreateTabOptions {
  activate?: boolean
  freshTask?: boolean
  withoutTask?: boolean
  taskId?: string
  gitContext?: GitCheckout | null
  gitInitialization?: 'blocking' | 'background'
  worktreeRequested?: boolean
  via?: Via
}

interface ForkTabOptions {
  activate?: boolean
}

const notificationAudio = new Audio(notificationSrc)
notificationAudio.volume = 1.0

export class WorkspaceContext {
  registry = new TabRegistry()
  /** A local-only new-tab composer. It deliberately stays out of tabOrder and
   *  the server registry until the first prompt is submitted. */
  draftTabId = $state<string | null>(null)
  private draftSourceTabId: string | null = null
  private draftTabVia: Via = 'click'
  lifecycle: WorkspaceLifecycleStore
  pendingInput = $state<string | null>(null)
  eventReducer: SessionEventReducer

  planStore: PlanStore
  worksStore: WorksStore
  automationsStore = new AutomationsStore()
  tasksStore = new TasksStore()
  prsStore = new PrsStore()
  stacksStore = new StacksStore()
  /** Where the workspace is: which routes are in which panes, plus history.
   *  Global — not per-tab. */
  router = new RouterStore()
  /** How wide those panes are, and whether one is maximized. */
  geometry = new PaneGeometryStore()
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
  private goalSync: GoalSync
  private hostDispatchAttempts = new Map<string, number>()
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
    this.goalSync = new GoalSync({
      sessionFor: (tabId) => this.sessionFor(tabId),
      apiFor: (tabId) => this.apiFor(tabId),
      ctxFor: (tabId) => this.ctxFor(tabId),
    })
    this.config = new SessionConfigController({
      settings: this.settings,
      registry: this.registry,
      statusBar: this.statusBar,
      setPluginCommands: (commands) => { this.pluginCommands = commands },
      createDraftTab: (cwd) => this.createDraftTab(cwd),
      ctx: (tabId) => tabId ? this.ctxFor(tabId) : this.ctx,
      ctxForDirectory: (dir) => this.ctxForDirectory(dir),
      apiFor: (tabId) => tabId ? this.apiFor(tabId) : window.solus,
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
      apiFor: (tabId) => this.apiFor(tabId),
      loadTranscript: (args) => loadSessionTranscript(this, args),
      rebuildAgentConversations: (session) => this.eventReducer.rebuildAgentConversations(session),
    })
    this.ui = new WorkspaceUiStore()
    this.workStreamTracker = new WorkStreamTracker(this.worksStore, this.router)
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
      onGoalDefined: (tabId) => this.revealGoal(tabId),
      applyGoalUpdated: (tabId, goal) => this.goalSync.applyUpdated(tabId, goal),
      applyGoalCleared: (tabId, threadId) => this.goalSync.applyCleared(tabId, threadId),
      onSessionInitialized: (tabId) => {
        void this.definePendingGoal(tabId)
        void this.generateSessionMetadata(tabId)
      },
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
  streamingTextFor(tabId: string, isVisible: boolean): string {
    return this.eventReducer.streamingTextFor(tabId, isVisible)
  }
  clearStreamingText(tabId: string): void {
    if (typeof this.eventReducer.clearStreamingText === 'function') {
      this.eventReducer.clearStreamingText(tabId)
      return
    }
    // Structural test doubles and restored legacy contexts only expose the
    // original reactive text bag.
    delete this.eventReducer.streaming.text[tabId]
  }
  get tabs(): Record<string, Tab> { return this.registry.tabs }
  set tabs(value: Record<string, Tab>) { this.registry.tabs = value }
  get sessions(): Record<string, Session> { return this.registry.sessions }
  set sessions(value: Record<string, Session>) { this.registry.sessions = value }
  get tabOrder(): string[] { return this.registry.tabOrder }
  set tabOrder(value: string[]) { this.registry.tabOrder = value }
  get activeTabId(): string { return this.registry.activeTabId }
  set activeTabId(value: string) { this.registry.setActiveTab(value) }
  /** The selected real tab for persistence while a local-only draft is open. */
  get durableActiveTabId(): string {
    if (!this.draftTabId) return this.activeTabId
    return this.draftSourceTabId && this.tabs[this.draftSourceTabId]
      ? this.draftSourceTabId
      : this.tabOrder.at(-1) ?? ''
  }
  get focusedChatTabId(): string | null {
    return this.router.chatTabIn(this.router.focusedPaneId, this.activeTabId)
  }

  /** The chat pinned into a companion pane, if any — the "split chat". */
  get splitChatTabId(): string | null {
    for (const pane of this.router.asidePanes) {
      const tabId = this.router.chatTabIn(pane.id, this.activeTabId)
      if (tabId) return tabId
    }
    return null
  }

  /** The pane holding the split chat, for focus and close operations. */
  private get splitChatPaneId(): PaneId | null {
    return this.router.asidePanes.find((pane) => pane.base?.name === 'chat')?.id ?? null
  }
  get activeInput(): InputState { return this.registry.activeInput }
  set activeInput(value: InputState) { this.registry.activeInput = value }
  get lastActiveTabByBranch() { return this.registry.lastActiveTabByBranch }
  get isExpanded(): boolean { return this.ui.isExpanded }
  set isExpanded(value: boolean) { this.ui.isExpanded = value }
  get sessionPickerOpen(): boolean { return this.ui.sessionPickerOpen }
  set sessionPickerOpen(value: boolean) { this.ui.sessionPickerOpen = value }
  /** The active tab's task environment, including its base project and checkout. */
  get taskCreationContext(): TaskCreationContext | null {
    const session = this.activeSession
    return taskCreationContextFor(
      session?.workingDirectory ?? this.globalDefaults.workingDirectory,
      session ? session.gitContext : this.globalDefaults.gitContext,
    )
  }

  /** The base project whose tasks the page lists. */
  get tasksProjectCwd(): string | null {
    return this.taskCreationContext?.projectKey ?? null
  }

  private defaultModelConfigFor(agentId: AgentId): ModelConfig {
    return this.config.defaultModelConfigFor(agentId)
  }

  private defaultReasoningEffortFor(agentId: AgentId, modelId: string | null) {
    return this.config.defaultReasoningEffortFor(agentId, modelId)
  }

  toggleTabGroupMode(via: Via = 'click'): void {
    void via
    this.config.toggleTabGroupMode()
  }

  /** Resolve a tab id to its tab + session, or null if either is missing — the
   *  shared adapter for grouping helpers so the strip and keyboard nav agree. */
  resolveTab(tabId: string): { sess: Session; tab: Tab } | null {
    return this.registry.resolveTab(tabId)
  }

  private setActiveTab(tabId: string): void {
    if (this.draftTabId && tabId !== this.draftTabId) this.discardDraftTab()
    this.registry.setActiveTab(tabId)
    prioritizeTabHydration(this, tabId)
    // A review guide belongs to the session it was generated from, so moving to
    // another tab leaves it rather than showing a stale walkthrough.
    this.router.close('review')
  }

  private isTabVisible(tabId: string): boolean {
    const editorLike = this.window.viewMode === 'editor' || this.window.isWeb
    // A chat pinned in a companion pane is on screen too — but only in
    // editor/web, where companion panes actually render.
    if (editorLike && this.router.asidePanes.some((pane) => pane.base?.name === 'chat' && pane.base.params.tabId === tabId)) {
      return true
    }
    return tabId === this.activeTabId && (editorLike || this.isExpanded)
  }

  /** Leave whatever page (and optionally artifact) is showing — what selecting
   *  another tab or creating one does, so the new conversation is what you see. */
  private resetOverlays(opts: { closeArtifact?: boolean } = {}): void {
    this.router.closeGroup('page')
    if (opts.closeArtifact) this.router.closeGroup('artifact')
    this.planStore.dismissPreview()
  }

  lastActiveTabForBranch(branchKey: string): string | null {
    return this.registry.lastActiveTabForBranch(branchKey)
  }

  /** Returns the Session for a given tab, or undefined. */
  sessionFor(tabId: string): Session | undefined {
    return this.registry.sessionFor?.(tabId)
      ?? (this.registry.tabs?.[tabId]
        ? this.registry.sessions?.[this.registry.tabs[tabId].sessionId]
        : undefined)
  }

  /** Resolve the RPC surface that owns this tab's session. */
  apiFor(tabId: string): typeof window.solus {
    const session = this.sessionFor(tabId)
    if (!session?.serverId || (
      session.serverId === LOCAL_SERVER_ID
      && !serverConnections.connectionFor(LOCAL_SERVER_ID)
    )) {
      return window.solus
    }
    const api = serverConnections.apiFor(session?.serverId) as typeof window.solus
    if (session) {
      serverConnections.retain(session.serverId)
      this.environment.bindCwd(session.workingDirectory, api)
      this.environment.bindCwd(session.gitContext?.repoRoot, api)
      this.environment.bindCwd(session.gitContext?.worktreePath, api)
    }
    return api
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

  /** Whether this composer will mint a new task when its first prompt is sent. */
  isFreshTaskDraft(tabId: string): boolean {
    const session = this.sessionFor(tabId)
    return tabId === this.draftTabId
      && !!session
      && !session.pendingTaskId
      && !session.taskCreationDisabled
  }

  get activeSession(): Session | undefined {
    return this.registry.activeSession
  }

  get galleryProjectPath(): string {
    return this.activeSession?.workingDirectory ?? this.globalDefaults.workingDirectory ?? '~'
  }

  /** The open projects, each with the path roots that belong to it — repo root,
   *  worktree path, and working directory — so an item created in any
   *  branch/worktree/subfolder of an open repo still attributes to its project.
   *  Mirrors how the sidebar groups sessions into projects. */
  get openProjects(): OpenProject[] {
    const byKey = new Map<string, OpenProject>()
    for (const tabId of this.tabOrder) {
      const sess = this.sessionFor(tabId)
      if (!sess) continue
      const key = sess.gitContext?.repoRoot ?? sess.workingDirectory ?? '~'
      let project = byKey.get(key)
      if (!project) {
        project = { key, label: projectDirLabel(key, this.staticInfo?.workspacePath), roots: [] }
        byKey.set(key, project)
      }
      for (const root of [sess.gitContext?.repoRoot, sess.gitContext?.worktreePath, sess.workingDirectory]) {
        if (root && !project.roots.includes(root)) project.roots.push(root)
      }
      if (project.roots.length === 0) project.roots.push(key)
    }
    if (byKey.size === 0) {
      const key = this.galleryProjectPath
      return [{ key, label: projectDirLabel(key, this.staticInfo?.workspacePath), roots: [key] }]
    }
    return [...byKey.values()]
  }

  /** Distinct project keys across all open tabs. Its length drives whether
   *  galleries show a per-item project badge. */
  get openProjectKeys(): string[] {
    return this.openProjects.map((project) => project.key)
  }

  /** Path roots used to scope plans/works to the open projects. */
  get openProjectScopeRoots(): string[] {
    return [...new Set(this.openProjects.flatMap((project) => project.roots))]
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

  async switchToBranch(branch: string, tabId?: string, via: Via = 'click'): Promise<boolean> {
    const switched = await this.config.switchToBranch(branch, tabId)
    if (switched) track('branch_switched', { via })
    return switched
  }

  recomputeChangedFiles(tabId: string): void {
    this.lifecycle.recomputeChangedFiles(tabId)
  }

  /** Replace a tab's windowed transcript with the full history. */
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
    const info = await this.apiFor(tabId).bindRuntimeSession(this.ctxFor(tabId))
    if (info && session) {
      applyRuntimeConfig(session, info)
      session.status = info.status
      session.rateLimitInfo = info.rateLimitInfo
      this.reconcileQueuedPrompts(tabId, info.queuedPrompts)
    }
    void this.refreshThreadGoal(tabId)
  }

  async refreshThreadGoal(tabId: string): Promise<void> {
    await this.goalSync.refresh(tabId)
  }

  setThreadGoal(tabId: string, update: Omit<ThreadGoalSetRequest, 'threadId'>): Promise<ThreadGoal> {
    return this.goalSync.set(tabId, update)
  }

  createThreadGoal(tabId: string, objective: string): Promise<ThreadGoal> {
    return this.goalSync.create(tabId, objective)
  }

  clearThreadGoal(tabId: string): Promise<void> {
    return this.goalSync.clear(tabId)
  }

  /** Show the goal wherever this shell keeps it. Editor mode has a project-rail
   *  section, so it opens that rail and expands the section; the pill and the
   *  mobile web shell have no rail, so the goal takes the secondary pane. */
  revealGoal(tabId: string): void {
    if (this.window.viewMode !== 'editor') {
      this.router.navigate({ name: 'goal', params: { tabId } }, { target: 'aside' })
      this.geometry.open(this.router.focusedPaneId, 0.34)
      return
    }
    const isSplit = tabId === this.splitChatTabId
    const collapsed = isSplit ? this.settings.splitProjectPanelCollapsed : this.settings.projectPanelCollapsed
    collapsed.goal = false
    this.settings.update(isSplit
      ? { splitProjectPanelOpen: true, splitProjectPanelCollapsed: collapsed }
      : { projectPanelOpen: true, projectPanelCollapsed: collapsed })
  }

  private async definePendingGoal(tabId: string): Promise<void> {
    const session = this.sessionFor(tabId)
    const objective = session?.pendingGoalObjective?.trim()
    if (!session?.agentSessionId || !session.provider || !objective) return
    try {
      await this.refreshThreadGoal(tabId)
      if (session.goal) {
        session.pendingGoalObjective = null
        this.revealGoal(tabId)
        return
      }
      session.pendingGoalObjective = null
      await this.createThreadGoal(tabId, objective)
      this.revealGoal(tabId)
    } catch (error) {
      session.pendingGoalObjective = objective
      this.addSystemMessage(
        `Couldn't create goal: ${error instanceof Error ? error.message : String(error)}`,
        tabId,
      )
    }
  }

  /** Tabs whose auto-name has been attempted. Both providers can re-emit
   *  session_init for a live session (Claude does it when a background task
   *  resumes the parent), and naming is a paid round trip — once per tab. */
  private metadataFinalizedTabs = new Set<string>()

  applySessionTitleChanged(
    serverId: string,
    event: SessionTitleChangedEvent,
  ): void {
    for (const tabId of applySessionTitleChange(this, serverId, event)) {
      this.metadataFinalizedTabs.add(tabId)
    }
  }

  /**
   * Name a thread and describe its session-born ticket from the opening prompt,
   * once its agent session id exists to persist against. Silent on failure: the
   * prompt-derived title and empty ticket body are valid fallbacks.
   */
  private async generateSessionMetadata(tabId: string): Promise<void> {
    const tab = this.tabs[tabId]
    const session = this.sessionFor(tabId)
    const agentSessionId = session?.agentSessionId
    if (!tab || !session || !agentSessionId) return
    if (this.metadataFinalizedTabs.has(tabId)) return

    if (tab.titleCustom) {
      // A name typed into a tab before its session existed had nowhere to
      // persist — this is the first moment there's a session id to hang it on.
      this.metadataFinalizedTabs.add(tabId)
      await this.apiFor(tabId).setSessionTitle(agentSessionId, tab.title, 'manual').catch(() => {})
      return
    }
    if (!this.settings.autoRenameSessions) return

    // Only the opening turn names a thread — a later init is a resume, and a
    // resumed thread either has a name already or was deliberately left unnamed.
    const userMessages = session.messages.filter((message) => message.role === 'user' && message.content)
    if (userMessages.length !== 1) return
    this.metadataFinalizedTabs.add(tabId)

    const metadata = await this.apiFor(tabId)
      .generateSessionMetadata(userMessages[0].content, session.workingDirectory)
      .catch(() => null)
    if (!metadata) return

    // The tab may have been closed, reset, renamed by hand, or resumed into a
    // different session while the naming round trip was in flight.
    const currentTab = this.tabs[tabId]
    if (!currentTab || currentTab.titleCustom) return
    if (this.sessionFor(tabId)?.agentSessionId !== agentSessionId) return
    currentTab.title = metadata.title
    await this.apiFor(tabId)
      .setSessionTitle(agentSessionId, metadata.title, 'generated', metadata.description)
      .catch(() => {})
  }

  /** Rename a tab's session by hand. An empty name clears back to the derived title. */
  async renameTab(tabId: string, title: string): Promise<void> {
    const tab = this.tabs[tabId]
    if (!tab) return
    const trimmed = title.trim()
    const session = this.sessionFor(tabId)
    // 'New Tab' is what sessionTitle() reads as "unnamed", so clearing a name
    // there falls the display back to the session's first prompt.
    tab.title = trimmed || 'New Tab'
    tab.titleCustom = !!trimmed
    this.metadataFinalizedTabs.add(tabId)
    if (session?.agentSessionId) {
      await this.apiFor(tabId).setSessionTitle(session.agentSessionId, trimmed || null, 'manual')
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
    const tabApi = activeSession?.serverId && activeSession.serverId !== LOCAL_SERVER_ID
      ? serverConnections.apiFor(activeSession.serverId) as typeof window.solus
      : window.solus
    const { tabId } = await tabApi.createTab()
    const session = makeSession(this.settings, {
      serverId: activeSession?.serverId ?? serverConnections.connectionFor()?.serverId ?? LOCAL_SERVER_ID,
      workingDirectory: inheritedDir,
      gitContext: inheritedGitContext ? { ...inheritedGitContext } : null,
      worktreeBaseBranch: worktreeRequested ? inheritedGitContext?.targetBranch ?? null : null,
      modelConfig: inheritedModelConfig,
      permissionMode: inheritedPermissionMode,
      sessionSkills: activeSession?.sessionSkills ?? [],
      pluginCommands: this.pluginCommands,
      pendingTaskId: options.taskId ?? null,
    })
    const tab = makeTab(session.id, { id: tabId })
    this.sessions[session.id] = session
    this.tabs[tab.id] = tab
    this.addTabToOrder(tab.id)
    track('tab_created', { via: options.via, worktree: worktreeRequested })
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

  /** The task the session on screen belongs to. */
  get activeRootTaskId(): string | null {
    return this.tasksStore.taskForSession(this.activeSession?.agentSessionId)?.id
      ?? this.activeSession?.pendingTaskId
      ?? null
  }

  /** Open the shared new-tab home without registering a real tab yet. When the
   *  current session belongs to a task, the new session stays under that task. */
  async createDraftTab(cwd?: string, options: CreateTabOptions = {}): Promise<string> {
    let preservedInput: InputState | undefined
    const sourceTabId = this.draftTabId ? this.draftSourceTabId : this.activeTabId || null
    const sourceSessionForTask = sourceTabId ? this.sessionFor(sourceTabId) : null
    const sourceRootTaskId = this.tasksStore.taskForSession(sourceSessionForTask?.agentSessionId)?.id
      ?? sourceSessionForTask?.pendingTaskId
      ?? null
    const activeRootTaskId = sourceRootTaskId ?? this.activeRootTaskId
    const activeSession = sourceSessionForTask ?? this.activeSession
    const draftSourceTabId = this.draftTabId ? this.draftSourceTabId : this.activeTabId || null
    if (this.draftTabId) {
      const draftSession = this.sessionFor(this.draftTabId)
      const existingTaskMode = draftSession?.pendingTaskId
        ? 'existing'
        : draftSession?.taskCreationDisabled
          ? 'none'
          : 'new'
      const requestedTaskMode = options.withoutTask
        ? 'none'
        : !options.freshTask && activeRootTaskId
          ? 'existing'
          : 'new'
      if (existingTaskMode === requestedTaskMode) {
        requestInputFocus({ tabId: this.draftTabId })
        return this.draftTabId
      }
      // The task/session shortcuts retarget the local draft; they do not start a
      // new composition. Carry the whole input state so text, attachments and
      // references survive changing between those destinations.
      preservedInput = this.tabs[this.draftTabId]?.input
      this.discardDraftTab()
    }
    const sourceSession = options.freshTask ? null : activeSession
    const workingDirectory = options.freshTask
      ? activeSession?.gitContext?.repoRoot
        ?? (activeSession?.workingDirectory && activeSession.workingDirectory !== '~'
          ? activeSession.workingDirectory
          : undefined)
        ?? this.globalDefaults.workingDirectory
        ?? this.staticInfo?.projectPath
        ?? this.staticInfo?.workspacePath
        ?? '~'
      : cwd ?? sourceSession?.workingDirectory
        ?? this.globalDefaults.workingDirectory
        ?? this.staticInfo?.projectPath
        ?? this.staticInfo?.workspacePath
        ?? '~'
    const sourceConfig = sourceSession?.modelConfig ?? this.globalDefaults.modelConfig
    const provider = (sourceSession?.provider ?? this.settings.activeAgent) as AgentId
    const inheritedGitContext = options.freshTask
      ? null
      : options.gitContext === undefined
        ? cwd === undefined
          ? sourceSession?.gitContext ?? this.globalDefaults.gitContext
          : null
        : options.gitContext
    const worktreeRequested = options.worktreeRequested
      ?? (options.freshTask
        ? this.settings.worktreeEnabled
        : !inheritedGitContext?.worktreePath && this.settings.worktreeEnabled)
    const session = makeSession(this.settings, {
      serverId: sourceSession?.serverId ?? serverConnections.connectionFor()?.serverId ?? LOCAL_SERVER_ID,
      provider,
      workingDirectory,
      gitContext: inheritedGitContext ? { ...inheritedGitContext } : null,
      worktreeBaseBranch: worktreeRequested ? inheritedGitContext?.targetBranch ?? null : null,
      modelConfig: {
        ...sourceConfig,
        reasoningEffort: this.defaultReasoningEffortFor(provider, sourceConfig.modelId),
      },
      permissionMode: this.globalDefaults.permissionMode,
      sessionSkills: sourceSession?.sessionSkills ?? [],
      pluginCommands: this.pluginCommands,
      pendingTaskId: options.freshTask || options.withoutTask ? null : activeRootTaskId,
      taskCreationDisabled: options.withoutTask ?? false,
    })
    const tabId = uuid()
    this.sessions[session.id] = session
    this.tabs[tabId] = makeTab(
      session.id,
      preservedInput ? { id: tabId, input: preservedInput } : { id: tabId },
    )
    this.draftSourceTabId = draftSourceTabId
    this.draftTabVia = options.via ?? 'click'
    this.draftTabId = tabId
    if (options.activate !== false) {
      this.setActiveTab(tabId)
      this.isExpanded = true
      this.resetOverlays({ closeArtifact: true })
    }
    void this.environment.refreshTab(this, { tabId, worktreeRequested })
    void this.refreshPluginCommands(workingDirectory, tabId)
    if (options.activate !== false) requestInputFocus({ tabId })
    return tabId
  }

  private discardDraftTab(): void {
    const tabId = this.draftTabId
    if (!tabId) return
    if (this.splitChatTabId === tabId) this.closeSplitPane()
    const sessionId = this.tabs[tabId]?.sessionId
    delete this.tabs[tabId]
    if (sessionId) delete this.sessions[sessionId]
    this.draftTabId = null
    this.draftSourceTabId = null
  }

  /** Author an automation in a low-reasoning session with no tab routing state. */
  async createAutomationDraftSession(prompt: string, cwd: string): Promise<string> {
    const provider = this.settings.activeAgent as AgentId
    const modelConfig = this.defaultModelConfigFor(provider)
    const api = this.activeTabId ? this.apiFor(this.activeTabId) : window.solus
    const request = automationDraftSessionRequest(prompt, cwd, provider, modelConfig)
    const { agentSessionId } = await api.createHeadlessSession(request)
    return agentSessionId
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
    const tabId = await this.createDraftTab(projectRoot, { worktreeRequested: true })
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

  /** Fork a session into a new tab. The fork inherits the transcript through the
   *  source's last settled turn, resumes on first prompt, and lands as a subtask
   *  of whatever task the source is working. */
  async forkTab(sourceTabId: string, options: ForkTabOptions = {}): Promise<string | null> {
    const sourceTab = this.tabs[sourceTabId]
    const sourceSession = this.sessionFor(sourceTabId)
    if (!sourceSession?.agentSessionId) return null

    const tabId = uuid()
    await this.apiFor(sourceTabId).createTab(tabId)

    const originalTitle = sourceTab?.title || 'session'
    // Forking mid-turn branches from the last settled point, not from the turn
    // still being written: its messages are half-formed (tools still spinning)
    // and the fork's own first prompt lands later anyway. Cut the in-flight turn
    // out of the copy and say so on the divider.
    const sourceIsRunning = sourceSession.status === 'running' || sourceSession.status === 'connecting'
    const inFlightFrom = sourceIsRunning ? findLastUserIndex(sourceSession.messages) : -1
    const settledMessages = inFlightFrom === -1
      ? sourceSession.messages
      : sourceSession.messages.slice(0, inFlightFrom)
    const copiedMessages: Message[] = settledMessages.map((m) => ({ ...m, id: uuid() }))
    const forkInfoMsg: Message = {
      id: uuid(),
      role: 'system',
      content: '',
      timestamp: Date.now(),
      forkSourceSessionId: sourceSession.agentSessionId,
      forkSourceTitle: originalTitle,
      ...(inFlightFrom === -1 ? {} : { forkSourceRunning: true }),
    }

    // A fork is another attempt at the same goal, so it belongs under the source's
    // task rather than beside it as a loose session. Nesting is one level deep:
    // forking a subtask's session adds a sibling under their shared parent.
    const sourceTask = this.tasksStore.taskForSession(sourceSession.agentSessionId)
      ?? (sourceSession.pendingTaskId
        ? this.tasksStore.tasks.find((task) => task.id === sourceSession.pendingTaskId)
        : undefined)
      ?? (sourceSession.pendingParentTaskId
        ? this.tasksStore.tasks.find((task) => task.id === sourceSession.pendingParentTaskId)
        : undefined)

    const forkedSession = makeSession(this.settings, {
      agentSessionId: sourceSession.agentSessionId,
      serverId: sourceSession.serverId,
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
      pendingParentTaskId: sourceTask ? sourceTask.parentId ?? sourceTask.id : null,
      taskCreationDisabled: sourceSession.taskCreationDisabled,
    })

    const forkTab = makeTab(forkedSession.id, { id: tabId, title: `Fork: ${originalTitle}` })

    this.sessions[forkedSession.id] = forkedSession
    this.tabs[forkTab.id] = forkTab
    this.addTabToOrder(forkTab.id)
    if (options.activate !== false) {
      this.setActiveTab(forkTab.id)
      this.resetOverlays()
    }
    await this.environment.refreshTab(this, { tabId })
    if (options.activate !== false) requestInputFocus()
    return tabId
  }

  /**
   * Branch selected transcript text into a contextual session beside its source.
   * The provider fork remains lazy until the user sends the targeted question.
   */
  async askInNewSession(sourceTabId: string, selectedText: string): Promise<void> {
    const draft = quotedReplyDraft(selectedText)
    if (!draft || !this.sessionFor(sourceTabId)?.agentSessionId) return

    const splitTabId = this.splitChatTabId
    if (splitTabId === sourceTabId) this.promoteSplitToMainTab()
    else if (sourceTabId !== this.activeTabId) this.selectTab(sourceTabId)

    const forkTabId = await this.forkTab(sourceTabId, { activate: false })
    if (!forkTabId) return
    this.tabs[forkTabId].input.text = draft
    this.openSplitChat(forkTabId)
    requestInputFocus({ tabId: forkTabId })
  }

  /** Move a live session into a fresh git worktree. Creates the worktree now (so
   *  the branch name and git panel update immediately), then flags the session to
   *  fork on its next prompt — that fork re-homes the conversation's transcript
   *  under the worktree, so the session truly lives there. Same tab, same history. */
  async continueInWorktree(tabId: string, via: Via = 'click'): Promise<void> {
    void via
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
      const result = await this.apiFor(tabId).continueInWorktree(this.ctxFor(tabId), namePrompt)
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

  selectTab(tabId: string, via: Via = 'click'): void {
    if (tabId === this.splitChatTabId) {
      const paneId = this.splitChatPaneId
      if (paneId) this.router.focusPane(paneId)
      const secondarySession = this.sessionFor(tabId)
      if (secondarySession) void this.refreshPluginCommands(secondarySession.workingDirectory, tabId)
      requestInputFocus({ tabId })
      track('tab_selected', { via })
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
    if (session) void this.refreshPluginCommands(session.workingDirectory, tabId)
    track('tab_selected', { via })
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
    this.openSplitChat(tabId)
    track('tab_split_opened', {})
    requestInputFocus({ tabId })
  }

  /** Pin a chat into a companion pane beside the leading conversation. */
  openSplitChat(tabId: string): void {
    const pane = this.router.navigate(chatRoute(tabId), { target: 'aside' })
    this.geometry.open(pane.id)
  }

  /** Move the split chat back into the leading pane's tab pool. */
  promoteSplitToMainTab(): void {
    const splitTabId = this.splitChatTabId
    if (!splitTabId) return
    const splitTab = this.tabs[splitTabId]
    const splitSession = this.sessionFor(splitTabId)
    if (!splitTab || !splitSession) return

    this.setActiveTab(splitTabId)
    this.isExpanded = true
    splitTab.hasUnread = false
    this.closeSplitPane()
    if (splitSession.provider && this.settings.activeAgent !== splitSession.provider) {
      this.settings.update({ activeAgent: splitSession.provider })
    }
    requestInputFocus({ tabId: splitTabId })
  }

  /** Close the pinned chat, discarding only a never-used split-created tab. */
  closeSplitChat(): void {
    const splitTabId = this.splitChatTabId
    if (!splitTabId) {
      this.closeSplitPane()
      return
    }
    const splitTab = this.tabs[splitTabId]
    const splitSession = this.sessionFor(splitTabId)
    const shouldCloseTab = splitTabId !== this.activeTabId
      && !!splitTab
      && !!splitSession
      && isPristineSplitTab(splitTab, splitSession)

    this.closeSplitPane()
    if (shouldCloseTab) this.closeTab(splitTabId)
  }

  /** Close the companion pane holding the split chat, if there is one. */
  private closeSplitPane(): void {
    const paneId = this.splitChatPaneId
    if (paneId) this.router.closePane(paneId)
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
    track('mode_toggled', { mode: target })
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
      serverId: serverConnections.connectionFor()?.serverId ?? LOCAL_SERVER_ID,
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

  closeTab(tabId: string, via: Via = 'click'): void {
    if (tabId === this.draftTabId) {
      const returnTabId = this.draftSourceTabId
      this.discardDraftTab()
      const nextTabId = returnTabId && this.tabs[returnTabId] ? returnTabId : this.tabOrder.at(-1)
      if (nextTabId) this.setActiveTab(nextTabId)
      else this.activeTabId = ''
      requestInputFocus()
      return
    }
    const serverId = this.sessionFor(tabId)?.serverId
    this.apiFor(tabId).closeTab(this.ctxFor(tabId))
    if (this.splitChatTabId === tabId) this.closeSplitPane()
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
    const closedTabIndex = this.tabOrder.indexOf(tabId)
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
    if (serverId && !this.tabOrder.some((id) => id !== tabId && this.sessionFor(id)?.serverId === serverId)) {
      serverConnections.unretain(serverId)
      serverConnections.release(serverId)
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
    // Preserve the reactive array identity so closing one tab only invalidates the
    // removed index instead of rebuilding every tab-strip item.
    if (closedTabIndex !== -1) this.tabOrder.splice(closedTabIndex, 1)
    removePersistedTab(tabId, this.durableActiveTabId)
    track('tab_closed', { via })
  }

  clearTab(tabId?: string): void {
    const targetTabId = tabId ?? this.activeTabId
    this.apiFor(targetTabId).resetTabSession(this.ctxFor(targetTabId))
    const session = this.sessionFor(targetTabId)
    if (!session) return
    session.agentSessionId = null
    session.provider = null
    session.handoffFrom = undefined
    session.messages = []
    session.sessionChangedFiles = []
    session.lastResult = null
    session.contextUsage = null
    session.runUsage = null
    session.isStreamingText = false
    session.isReconnecting = false
    session.permissionQueue = []
    session.questionQueue = []
    session.permissionDenied = null
    session.outboundPrompts.splice(0, session.outboundPrompts.length)
    session.status = 'idle'
    session.progress = null
    session.readOnlyReason = null
    session.worktreeBaseBranch = session.gitContext?.worktreePath ? null : session.worktreeBaseBranch
    // Reset tab title
    const tab = this.tabs[targetTabId]
    if (tab) {
      tab.title = 'New Tab'
      tab.titleCustom = false
    }
    this.metadataFinalizedTabs.delete(targetTabId)
    this.clearStreamingText(targetTabId)
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
      tab.titleCustom = !!meta.customTitle
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
      this.eventReducer.rebuildAgentConversations(session)
      session.readOnlyReason = null
      session.gitContext = null
      session.loadingHistory = true
      targetTab!.title = title
      targetTab!.titleCustom = !!meta.customTitle

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
      const api = this.apiFor(tabId)
      const [identity, transcript] = await Promise.all([
        api.gitIdentity
          ? api.gitIdentity(defaultDir).catch(() => null)
          : Promise.resolve(null),
        loadSessionTranscript(this, {
          sessionId: meta.sessionId,
          loadPath: meta.projectPath || defaultDir,
          displayCwd: workingDirectory,
          provider,
          ctx: this.ctxFor(tabId),
          limit: RESTORED_TRANSCRIPT_LIMIT,
        }),
        this.attachRuntimeSession(tabId),
        this.tasksStore.ensureSessionBinding(meta.sessionId).catch(() => null),
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
          await api.gitRegisterEnvironment?.(
              $state.snapshot(this.ctxFor(tabId)),
              worktreePath ?? workingDirectory,
              $state.snapshot(gitContext),
            )
        } catch {
          // A failed environment registration only delays cwd/git wiring for an
          // immediate prompt; the background refresh re-registers it.
        }
        session.messages.splice(0, session.messages.length, ...transcript.messages)
        this.eventReducer.rebuildAgentConversations(session)
        session.progress = transcript.progress
        session.historyTruncated = transcript.truncated

        // Everything below is off the critical path — a stale/failed step only
        // means the git panel / changed files / plugins catch up a beat later.
        void (async () => {
          const restoredGitContext = api.worktreeRestore
            ? await api.worktreeRestore(this.ctxFor(tabId), defaultDir)
            : null
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
    track('session_resumed', {})
    return tabId
  }

  // ─── Tab configuration ───

  updateModelConfig(patch: Partial<import('../../../shared/types').ModelConfig>, tabId?: string, via: Via = 'click'): void {
    const session = tabId ? this.sessionFor(tabId) : this.activeSession
    const modelConfig = session?.modelConfig ?? this.globalDefaults.modelConfig
    const modelChanged = 'modelId' in patch && patch.modelId !== modelConfig.modelId
    this.config.updateModelConfig(patch, tabId)
    if (modelChanged) track('model_changed', { via })
  }

  switchActiveAgent(agentId: AgentId, tabId?: string, via: Via = 'click'): Promise<void> {
    return this.config.switchActiveAgent(agentId, tabId, via)
  }

  setPermissionMode(mode: 'ask' | 'auto' | 'plan', tabId?: string, via: Via = 'click'): void {
    this.config.setPermissionMode(mode, tabId)
    track('permission_mode_set', { mode, via })
  }

  setWorktreeBaseBranch(branch: string | null): void {
    this.config.setWorktreeBaseBranch(branch)
  }

  syncWorktreeDefault(enabled: boolean): void {
    this.config.syncWorktreeDefault(enabled)
  }

  toggleWorktreeMode(tabId?: string, via: Via = 'click'): void {
    const previousSession = tabId ? this.sessionFor(tabId) : this.activeSession
    const wasEnabled = previousSession ? !!previousSession.worktreeBaseBranch : this.settings.worktreeEnabled
    this.config.toggleWorktreeMode(tabId)
    const session = tabId ? this.sessionFor(tabId) : this.activeSession
    const enabled = session ? !!session.worktreeBaseBranch : this.settings.worktreeEnabled
    if (enabled !== wasEnabled) track('worktree_mode_toggled', { enabled, via })
  }

  async switchToWorktree(worktreePath: string, tabId?: string, via: Via = 'click'): Promise<void> {
    await this.config.switchToWorktree(worktreePath, tabId)
    track('worktree_switched', { via })
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

  private promptTab(tabId: string, options: { prompt: string; displayPrompt: string; clientPromptId?: string; delivery?: PromptDelivery; imageAttachments?: Array<{ mimeType: string; dataUrl: string }>; taskId?: string; parentTaskId?: string; skipTaskCreation?: boolean; goalObjective?: string }): void {
    const api = this.apiFor(tabId)
    api.createTab(tabId)
      .then(() => this.config.pendingSessionStartTarget(tabId))
      .then(() => {
        // Guard: user may have interrupted between createTab resolving and this tick.
        // If so, stopTab already fired before prompt — skip submission to avoid a
        // phantom run that can never be cancelled.
        const session = this.sessionFor(tabId)
        if (!session) return
        return api.prompt(this.ctxFor(tabId), options)
      })
      .catch((err: Error) => {
        if (options.clientPromptId) {
          const session = this.sessionFor(tabId)
          const outbound = session?.outboundPrompts.find(
            (prompt) => prompt.clientPromptId === options.clientPromptId,
          )
          if (outbound) {
            outbound.state = 'failed'
            outbound.error = err.message
          }
        }
        this.handleError(tabId, { message: err.message, stderrTail: [], exitCode: null, elapsedMs: 0, toolCallCount: 0 })
      })
  }

  /** Sends to the active tab unless `tabId` targets another one (the split
   *  conversation pane's composer). */
  sendMessage(
    prompt: string,
    projectPath?: string,
    tabId?: string,
    delivery: PromptDelivery = 'steer',
  ): boolean {
    if (!tabId && this.tabOrder.length === 0) {
      const sessionStartTargetResolution = this.config.pendingSessionStartTarget()
      if (sessionStartTargetResolution) {
        void sessionStartTargetResolution.then(() => this.sendMessage(prompt, projectPath, tabId, delivery))
        return true
      }
      this.createTabFromDefaults()
    }
    const targetTabId = tabId ?? this.activeTabId
    const tab = this.tabs[targetTabId]
    const session = this.sessionFor(targetTabId)
    if (!tab || !session) return false
    if (session.status === 'connecting') return false
    if (session.readOnlyReason) return false

    if (
      window.solus.getPlatform() === 'web'
      && !serverConnections.connectionFor()
      && !session.pendingHostDispatch
    ) {
      window.dispatchEvent(new CustomEvent('solus:open-server-connect'))
      toasts.info('Connect a host to start working')
      return false
    }

    const resolvedPath = projectPath || session.workingDirectory
    if (
      !session.pendingHostDispatch
      && session.serverId !== LOCAL_SERVER_ID
      && (!resolvedPath || resolvedPath === '~')
    ) {
      toasts.error('Choose a project on the remote host before sending')
      return false
    }

    if (targetTabId === this.draftTabId) {
      this.addTabToOrder(targetTabId)
      this.draftTabId = null
      this.draftSourceTabId = null
      track('tab_created', {
        via: this.draftTabVia,
        worktree: !!session.worktreeBaseBranch && !session.gitContext?.worktreePath,
      })
    }

    if (session.pendingHostDispatch) {
      // Host checkout can take several seconds. The turn starts when the user
      // sends, not when that preparation eventually produces a provider echo.
      session.currentTurnStartedAt = Date.now()
      session.status = 'connecting'
      void this.prepareHostDispatchAndSend(targetTabId, prompt, projectPath, delivery)
      return true
    }

    const isBusy = isSessionBusyStatus(session.status)
    const input = tab.input

    const fullPrompt = this.promptComposer.compose(prompt, input, session)
    // Capture image blocks before the input's attachments are cleared below.
    const imageAttachments = this.promptComposer.composeImages(input)
    const clientPromptId = nextMsgId()
    const attachments = input.attachments.length > 0
      ? input.attachments.map((attachment) => ({
          name: attachment.name,
          dataUrl: attachment.dataUrl,
          mimeType: attachment.mimeType,
          type: attachment.type,
        }))
      : undefined
    const planRefs = input.planRefs.length > 0 ? [...input.planRefs] : undefined
    const workRefs = input.workRefs.length > 0 ? [...input.workRefs] : undefined
    const sessionRefs = input.sessionRefs.length > 0 ? [...input.sessionRefs] : undefined

    const title = session.messages.length === 0 && !tab.titleCustom
      ? (prompt.length > 80 ? prompt.substring(0, 80) : prompt)
      : tab.title

    if (resolvedPath !== session.workingDirectory) {
      session.workingDirectory = resolvedPath
    }
    if (session.messages.length === 0 && resolvedPath && resolvedPath !== '~') {
      void this.apiFor(targetTabId).trackRecentProject(resolvedPath)
    }

    session.provider = session.provider ?? this.settings.activeAgent

    const isFirstMessage = session.messages.length === 0
    const agent = session.provider ?? this.settings.activeAgent
    if (isFirstMessage) track('conversation_started', { agent })
    track('message_sent', { agent, is_first_message: isFirstMessage, permission_mode: session.permissionMode, attachment_count: input.attachments.length, image_count: imageAttachments.length, plan_ref_count: planRefs?.length ?? 0, work_ref_count: workRefs?.length ?? 0, session_ref_count: sessionRefs?.length ?? 0, has_slash_command: prompt.startsWith('/'), delivery: isBusy ? (isSteerableStatus(session.status) && delivery === 'steer' ? 'steer' : 'queue') : 'immediate', is_remote_host: session.serverId !== LOCAL_SERVER_ID })

    if (isBusy) {
      tab.title = title
      session.outboundPrompts.push({
        clientPromptId,
        text: prompt,
        state: isSteerableStatus(session.status) && delivery === 'steer' ? 'steering' : 'queueing',
        enqueuedAt: Date.now(),
        ...(imageAttachments.length > 0 ? { images: imageAttachments } : {}),
        ...(attachments ? { attachments } : {}),
        ...(planRefs ? { planRefs } : {}),
        ...(workRefs ? { workRefs } : {}),
        ...(sessionRefs ? { sessionRefs } : {}),
      })
      input.attachments = []
      input.planRefs = []
      input.workRefs = []
      input.sessionRefs = []
    } else {
      const sentAt = session.currentTurnStartedAt ?? Date.now()
      const userMsg: Message = {
        id: clientPromptId,
        role: 'user' as const,
        content: prompt,
        timestamp: sentAt,
        clientPromptId,
        attachments,
        planRefs,
        workRefs,
        sessionRefs,
      }
      session.currentTurnStart = isFirstMessage ? 'fresh' : 'follow_up'
      session.currentTurnStartedAt = sentAt
      session.currentActivity = session.currentTurnStart === 'fresh'
        ? 'Starting session...'
        : 'Resuming...'
      session.status = 'connecting'
      tab.title = title
      input.attachments = []
      input.planRefs = []
      input.workRefs = []
      input.sessionRefs = []
      session.latestCheckpointId = null
      session.progress = null
      session.retryAttempt = 1
      session.terminalFailure = null
      session.messages.push(userMsg)
      // Main excludes this tab from the user_message broadcast (the bubble is
      // already here), so the agent-conversation turn boundary must be cut locally too.
      this.eventReducer.closeAgentConversationTurn(session)
    }

    this.promptTab(targetTabId, {
      prompt: fullPrompt,
      displayPrompt: prompt,
      clientPromptId,
      delivery,
      imageAttachments,
      taskId:
        session.pendingTaskId ??
        this.tasksStore.taskForSession(session.agentSessionId)?.id ??
        undefined,
      // Only until the fork's own subtask exists — the two are mutually exclusive.
      parentTaskId: session.pendingTaskId || this.tasksStore.taskForSession(session.agentSessionId)
        ? undefined
        : session.pendingParentTaskId ?? undefined,
      skipTaskCreation: session.taskCreationDisabled || undefined,
      goalObjective: isFirstMessage ? session.pendingGoalObjective ?? undefined : undefined,
    })
    requestConversationScrollToBottom(targetTabId)
    return true
  }

  private async prepareHostDispatchAndSend(
    tabId: string,
    prompt: string,
    projectPath?: string,
    delivery: PromptDelivery = 'steer',
  ): Promise<void> {
    const tab = this.tabs[tabId]
    const session = this.sessionFor(tabId)
    const pending = session?.pendingHostDispatch
    if (!tab || !session || !pending) return
    const attempt = (this.hostDispatchAttempts.get(tabId) ?? 0) + 1
    this.hostDispatchAttempts.set(tabId, attempt)
    const superseded = () =>
      this.hostDispatchAttempts.get(tabId) !== attempt || this.sessionFor(tabId) !== session
    const bailIfStale = (): boolean => {
      if (superseded()) return true
      if (session.status === 'connecting' && session.pendingHostDispatch === pending) return false
      // The user withdrew this send (Stop, or a replaced pick); this attempt still
      // owns the tab's dispatch UI, so it also cleans it up and returns the prompt.
      session.statusCard = null
      if (!tab.input.text) tab.input.text = prompt
      return true
    }
    let activeStep: 'connection' | 'repository' = 'connection'
    session.statusCard = buildRemoteDispatchCard({
      tabId,
      hostLabel: pending.hostLabel,
      phase: 'connecting',
    })
    requestConversationScrollToBottom(tabId)

    try {
      const connection = serverConnections.ensure(pending.serverId)
      await connection.api.connectionsGetServerInfo()
      if (bailIfStale()) return
      activeStep = 'repository'
      session.statusCard = buildRemoteDispatchCard({
        tabId,
        hostLabel: pending.hostLabel,
        phase: 'repository',
      })
      const prepared = await prepareHostCheckout(
        {
          target: connection.api,
          local: serverConnections.apiFor(LOCAL_SERVER_ID),
        },
        pending.serverId,
        pending.repoKey,
      )
      if (bailIfStale()) return
      session.statusCard = buildRemoteDispatchCard({
        tabId,
        hostLabel: pending.hostLabel,
        phase: 'ready',
      })
      const result = retargetSessionHost({
        workspace: this,
        tabId,
        serverId: pending.serverId,
        isLocalHost: pending.isLocalHost,
        path: prepared.path,
        repoKey: pending.repoKey,
        requireWorktree: true,
      })
      if (!result.ok) throw new Error('The selected host has no usable checkout.')
      session.pendingHostDispatch = null
      await result.refreshStartTarget
      if (superseded()) return
      if (session.status !== 'connecting') {
        // Interrupted after the move already landed: keep the move, drop the send.
        session.statusCard = null
        if (!tab.input.text) tab.input.text = prompt
        return
      }
      session.status = 'idle'
      this.sendMessage(prompt, projectPath, tabId, delivery)
    } catch (error) {
      if (superseded()) return
      const message = error instanceof Error ? error.message : String(error)
      session.status = 'idle'
      session.currentTurnStartedAt = null
      session.statusCard = buildRemoteDispatchCard({
        tabId,
        hostLabel: pending.hostLabel,
        phase: activeStep === 'connection' ? 'connecting' : 'repository',
        error: { step: activeStep, message },
      })
      if (!tab.input.text) tab.input.text = prompt
      requestInputFocus({ tabId })
    }
  }

  refreshStartTarget(tabId: string, path: string, worktree: boolean): Promise<void> {
    return this.config.refreshSessionStartTarget(
      tabId,
      path,
      worktree || this.settings.worktreeEnabled,
    )
  }

  retryLastMessage(tabId: string): void {
    const session = this.sessionFor(tabId)
    if (!session) return
    if (session.status === 'connecting') return
    if (session.readOnlyReason) return

    if (session.status === 'rate_limited' && session.outboundPrompts.some((prompt) => prompt.state === 'queued' && prompt.reason === 'rate_limit')) {
      sendRateLimitedNow(this.apiFor(tabId), this.ctxFor(tabId), true, (err) => this.handleError(tabId, err))
      return
    }

    const lastUserMsg = [...session.messages].reverse().find((m) => m.role === 'user')
    if (!lastUserMsg) return

    const lastMsg = session.messages[session.messages.length - 1]
    if (lastMsg?.role === 'system' && lastMsg.content.startsWith('Error:')) {
      session.messages.splice(session.messages.length - 1, 1)
    }

    session.status = 'connecting'
    session.currentTurnStart = 'follow_up'
    session.currentTurnStartedAt = Date.now()
    session.currentActivity = 'Resuming...'
    session.provider = session.provider ?? this.settings.activeAgent
    session.latestCheckpointId = null
    session.progress = null
    session.retryAttempt = (session.retryAttempt ?? 1) + 1
    session.terminalFailure = null

    const retry = this.apiFor(tabId).retry(this.ctxFor(tabId), { prompt: lastUserMsg.content })

    retry.catch((err: Error) => {
      this.handleError(tabId, { message: err.message, stderrTail: [], exitCode: null, elapsedMs: 0, toolCallCount: 0 })
    })
  }

  // ─── Permissions & questions ───

  respondPermission(tabId: string, questionId: string, optionId: string): void {
    this.apiFor(tabId).respondPermission(this.ctxFor(tabId), questionId, optionId)
    track('permission_responded', { decision: optionId })
    const session = this.sessionFor(tabId)
    if (!session) return
    const idx = session.permissionQueue.findIndex((p) => p.questionId === questionId)
    if (idx !== -1) session.permissionQueue.splice(idx, 1)
  }

  respondQuestion(tabId: string, questionId: string, answers: Record<string, string>): void {
    this.apiFor(tabId).respondQuestion(this.ctxFor(tabId), questionId, answers)
    const session = this.sessionFor(tabId)
    if (!session) return
    const idx = session.questionQueue.findIndex((q) => q.questionId === questionId)
    if (idx !== -1) session.questionQueue.splice(idx, 1)
  }

  // ─── Event handlers ───

  handleNormalizedEvent(tabId: string, event: NormalizedEvent): void {
    this.eventReducer.apply(tabId, event)
  }

  interruptTab(tabId: string, opts: { notice?: boolean } = {}): void {
    // A visible stop is the user putting this goal on hold. Internal handoffs
    // pass `notice: false` because the work is continuing in another session.
    if (opts.notice !== false) this.goalSync.pauseForInterrupt(tabId)
    this.eventReducer.interruptTab(tabId, opts)
    track('session_interrupted', {})
  }

  handleError(tabId: string, error: EnrichedError): void {
    this.eventReducer.handleError(tabId, error)
  }

  // ─── File checkpointing ───

  async revertChanges(tabId: string): Promise<void> {
    const session = this.sessionFor(tabId)
    if (!session?.latestCheckpointId) return
    const checkpointId = session.latestCheckpointId
    await this.apiFor(tabId).rewindFiles(this.ctxFor(tabId), checkpointId)
    const sessionAfter = this.sessionFor(tabId)
    if (sessionAfter) sessionAfter.latestCheckpointId = null
  }

  // ─── Plans (open state lives in panes, not on Tab) ───

  clearPlanWaiting(sessionId: string): void { clearPlanWaiting(this, sessionId) }
  async openPlanModal(planId: string, ref?: { sessionId?: string; planToolUseId?: string; status?: 'pending' | 'accepted' | 'rejected' }, opts: { secondary?: boolean } = {}): Promise<void> {
    await openPlanModal(this, planId, ref, opts)
    track('surface_viewed', { surface: 'plan_modal' })
  }
  closePlanModal(): void { closePlanModal(this) }

  async approvePlanWithModel(planId: string, mode: 'ask' | 'auto', opts: ApprovePlanOptions = {}): Promise<void> {
    return approvePlanWithModel(this, planId, mode, opts)
  }

  async rejectPlan(planId: string, comment?: string): Promise<void> {
    return rejectPlan(this, planId, comment)
  }

  async openPlanFromDescriptor(d: PlanDescriptor, via: Via = 'click'): Promise<void> {
    void via
    return openPlanFromDescriptor(this, d)
  }
  closePlanPreview(): void { closePlanPreview(this) }
  async resumeSessionFromDescriptor(d: PlanDescriptor): Promise<void> { return resumeSessionFromDescriptor(this, d) }
  async loadPlanContent(d: PlanDescriptor): Promise<string> { return loadPlanContent(this, d) }

  /** Open a work as an artifact. By default it takes the Focus pane (or the
   *  secondary slot if one is already open); `secondary: true` forces it beside
   *  the conversation in the secondary pane (used by the project panel). */
  async openWorkModal(workId: string, title?: string, opts: { secondary?: boolean; via?: Via } = {}): Promise<void> {
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
    this.router.close('folio')
    this.openWork(resolvedId, opts.secondary ? 'aside' : 'focused')
    track('surface_viewed', { surface: 'work_modal', via: opts.via })
  }

  /** Open a work as the single artifact. `aside` puts it beside the
   *  conversation; otherwise it takes the focused pane. */
  openWork(workId: string, target: 'focused' | 'aside' = 'focused'): void {
    const pane = this.router.navigate({ name: 'work', params: { workId } }, { target: this.artifactTarget(target) })
    if (target === 'aside') this.geometry.open(pane.id)
  }

  closeWorkModal(): void {
    this.router.closeGroup('artifact')
  }

  /** Delete a work with a brief undo window: close its pane, offer the undo, and
   *  open the store's undo window. The on-disk delete is deferred until the toast
   *  commits — undo is a no-op restore, commit is permanent. */
  requestWorkDelete(work: Work): void {
    if (this.router.params('work')?.workId === work.id) this.router.close('work')
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
    this.router.close('folio')
    this.openWork(work.id)
  }

  async openChatForWork(workId: string, mode: 'resume' | 'new'): Promise<void> {
    const work = this.worksStore.get(workId)
    if (!work) return
    this.router.closeGroup('page')

    // Resume targets the most recently linked session (newest in sessionIds),
    // falling back to the legacy origin session.
    const resumeSid = work.sessionIds?.[work.sessionIds.length - 1] ?? work.sessionId

    let targetTabId: string | null = null
    let resumed = false
    this.openWork(workId, 'aside')
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

  // ─── Pages ───
  //
  // A page is a route with `exclusiveGroup: 'page'`, so opening one replaces
  // whichever page is showing wherever it lives — no flag to clear, no slot to
  // pick. `showPage` adds the one thing the router does not own: the pill's
  // expansion, which is shell state rather than a location.

  private showPage(ref: RouteRef, via: Via, surface: string): void {
    // A page that is already open is replaced where it lives (exclusivity);
    // a page opening for the first time covers the conversation rather than
    // taking over whichever companion pane happens to hold focus.
    this.router.navigate(ref, { via, target: this.router.leadingPane.id })
    this.isExpanded = true
    track('surface_viewed', { surface, via })
  }

  private togglePage(ref: RouteRef, via: Via, surface: string): boolean {
    if (this.router.at(ref.name)) {
      this.router.close(ref.name)
      return false
    }
    this.showPage(ref, via, surface)
    return true
  }

  // ─── Folio (plans + docs + diagrams ledger) ───

  toggleFolio(via: Via = 'click'): void {
    this.togglePage({ name: 'folio', params: {} }, via, 'workspace')
  }

  openFolio(via: Via = 'click'): void {
    this.showPage({ name: 'folio', params: {} }, via, 'workspace')
  }

  /** Open a plan as the single artifact. */
  openPlan(planId: string, target: 'focused' | 'aside' = 'focused'): void {
    const pane = this.router.navigate({ name: 'plan', params: { planId } }, { target: this.artifactTarget(target) })
    if (target === 'aside') this.geometry.open(pane.id)
  }

  /** An artifact opening fresh covers the conversation; `aside` puts it beside
   *  one. Where an artifact is already open, exclusivity replaces it in place
   *  and this target is never consulted. */
  private artifactTarget(target: 'focused' | 'aside'): NavTarget {
    return target === 'aside' ? 'aside' : this.router.leadingPane.id
  }

  // ─── Tasks page ───

  toggleTasks(via: Via = 'click'): void {
    // The page's own $effect loads on open (it needs the active project's cwd),
    // so there's nothing to kick off here — toggling just flips the route.
    this.togglePage({ name: 'tasks', params: {} }, via, 'tasks')
  }

  /** Start a fresh session bound to a task. Mirrors openWorkAndStartSession: open
   *  a clean tab in the task's project, initialize `pendingTaskId` (shows the
   *  chip and makes the first send carry `taskId`, which the main process
   *  hydrates + injects), and focus the input for the user's first message. */
  async openTaskSession(task: Task): Promise<void> {
    // The task's own project, not the one on screen: the sidebar spans projects,
    // so the row you clicked is often not in the one the status bar names.
    const cwd = task.projectKey ?? this.tasksProjectCwd ?? this.staticInfo?.workspacePath ?? '~'
    await this.createTab(cwd, { taskId: task.id })
    // Whichever page led here — the list or one task's page — steps aside for
    // the conversation it just started.
    this.router.closeGroup('page')
    requestInputFocus()
  }

  /** Jump back to the work happening on a task: focus the most-recently-linked
   *  session if it's open, else resume it from history. The back-link counterpart
   *  to openTaskSession, driven by the persisted task↔session map. */
  async openTaskLinkedSession(task: Task): Promise<void> {
    const links = this.tasksStore.sessionsByTask.get(task.id)
    const resumeSid = links?.[links.length - 1]?.sessionId
    if (!resumeSid) return void this.openTaskSession(task)

    const openTab = this.tabOrder.find((t) => {
      const s = this.sessionFor(t)
      return s?.agentSessionId === resumeSid || s?.forkedFromSessionId === resumeSid
    })
    if (openTab) this.selectTab(openTab)
    else {
      // The task link stores a session id, not its agent backend. Resolve the
      // indexed record before resuming instead of assigning whichever provider
      // happens to be selected now; loading a Claude transcript through Codex
      // (or vice versa) returns an empty conversation.
      const meta = await window.solus.getSessionInfo(resumeSid).catch(() => null)
      if (meta) await this.resumeSession(meta)
    }
    this.router.closeGroup('page')
    requestInputFocus()
  }

  /** Open one task's page. Its own route, so it deep-links, joins history and
   *  can be opened in a split. */
  goToTask(taskId: string, via: Via = 'palette'): void {
    this.showPage({ name: 'task', params: { taskId } }, via, 'tasks')
  }

  openTasks(via: Via = 'click'): void {
    this.showPage({ name: 'tasks', params: {} }, via, 'tasks')
  }

  /** Open the standalone create-task modal. Current-project entry points may
   * preserve the active tab's branch/worktree; explicit project picks do not. */
  openTaskComposer(cwd: string, useActiveEnvironment = false): void {
    const activeContext = this.taskCreationContext
    this.ui.taskComposer = useActiveEnvironment && activeContext?.projectKey === worktreeProjectRoot(cwd)
      ? activeContext
      : taskCreationContextFor(cwd, null)
  }

  // ─── Pull Requests page ───

  // Opening the page is enough; PrsPage's open-effect resets filters and loads
  // once. Loading here too would double every `pulls.list` on open (and race the
  // filter reset), so leave the fetch to the page.
  togglePrs(via: Via = 'click'): void {
    if (this.togglePage({ name: 'prs', params: {} }, via, 'prs')) {
      this.prsStore.needsReviewOnly = false
    }
  }

  openPrs(projectPath: string | null = null, via: Via = 'click'): void {
    this.prsStore.needsReviewOnly = false
    this.showPage({ name: 'prs', params: { projectPath: projectPath ?? undefined } }, via, 'prs')
  }

  async openReviewMode(
    items: Array<Pick<PullRequestSummary, 'number'>>,
    ctx: IpcContext = this.ctx,
  ): Promise<void> {
    if (this.window.viewMode !== 'editor') await this.window.setViewMode('editor')
    this.prsStore.beginReviewMode(items.map((item) => item.number), ctx)
    this.showPage({ name: 'reviewMode', params: {} }, 'click', 'review')
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

  toggleAutomations(via: Via = 'click'): void {
    if (this.togglePage({ name: 'automations', params: {} }, via, 'automations')) {
      void this.automationsStore.loadAll()
    }
  }

  /** Open the automations page, optionally focused on one automation. In editor
   *  mode a focused automation opens in the side-panel builder; otherwise (and
   *  for the bare list) the full-page list is shown. */
  openAutomations(focusId?: string | null, via: Via = 'click'): void {
    if (focusId && this.window.viewMode === 'editor') this.openAutomationBuilder(focusId)
    else this.showPage({ name: 'automations', params: { automationId: focusId ?? undefined } }, via, 'automations')
    void this.automationsStore.loadAll()
  }

  /** Open one automation as the single artifact. `aside` puts it beside the
   *  conversation, which is what an inline chat card wants. */
  openAutomationBuilder(automationId: string | null, target: 'focused' | 'aside' = 'focused'): void {
    this.router.closeGroup('page')
    const pane = this.router.navigate(
      { name: 'automation', params: { automationId } },
      { target: this.artifactTarget(target) },
    )
    if (target === 'aside') this.geometry.open(pane.id)
    this.isExpanded = true
    void this.automationsStore.loadAll()
  }

  // ─── Diff comments (on Tab — UI-only) ───

  addDiffComment(comment: DiffComment, tabId?: string): void { addDiffComment(this, comment, tabId) }
  updateDiffComment(commentId: string, newText: string, tabId?: string): void { updateDiffComment(this, commentId, newText, tabId) }
  removeDiffComment(commentId: string, tabId?: string): void { removeDiffComment(this, commentId, tabId) }
  restoreDiffComment(comment: DiffComment, index: number, tabId?: string): void { restoreDiffComment(this, comment, index, tabId) }
  clearDiffComments(tabId?: string): void { clearDiffComments(this, tabId) }
  setDiffCommentDraft(draft: DiffCommentDraft | null, tabId?: string): void { setDiffCommentDraft(this, draft, tabId) }
  updateDiffCommentDraftValue(value: string, tabId?: string): void { updateDiffCommentDraftValue(this, value, tabId) }
  setDiffGeneralComment(value: string, tabId?: string): void { setDiffGeneralComment(this, value, tabId) }
  submitDiffFeedback(generalComment: string, tabId?: string): boolean { const submitted = submitDiffFeedback(this, generalComment, tabId); if (submitted) track('diff_feedback_submitted', {}); return submitted }
  async submitDiffFeedbackToNewSession(opts: Parameters<typeof submitDiffFeedbackToNewSession>[1]): Promise<boolean> {
    const submitted = await submitDiffFeedbackToNewSession(this, opts); if (submitted) track('diff_feedback_submitted', {}); return submitted
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

  /** The route for one PR, scoped to the project it was opened from. */
  private prReviewRef(number: number, title?: string, ctx?: IpcContext): RouteRef<'prReview'> {
    return {
      name: 'prReview',
      params: { number, title, cwd: ctx?.session.projectPath ?? undefined },
    }
  }

  /**
   * Open a PR review as the page. The route is entered before the (slow)
   * fetch/checkout so the click gets a real surface rather than a blank pane;
   * the descriptor's `resolve` fills that same mounted surface in place when the
   * worktree lands. Re-entering a PR already in the router's payload cache skips
   * the fetch entirely.
   *
   * The review replaces the list in the leading pane rather than docking beside
   * it: `prReview` shares the `page` exclusive group with `prs`, so navigating
   * here *is* leaving the list. The way back and the way sideways live in the
   * review's own chrome band (see PrDetailChrome).
   */
  private async openPrReviewRoute(
    number: number,
    title: string | undefined,
    ctx: IpcContext,
    opts: { tab?: PrReviewTab; via?: Via } = {},
  ): Promise<PrReviewContext | null> {
    // The row's verb picks the tab: an inbox row that says Review lands on the
    // diff, everything else on Activity.
    this.prsStore.prReviewTab = opts.tab ?? 'activity'
    const ref = this.prReviewRef(number, title, ctx)
    this.router.navigate(ref, { target: this.router.leadingPane.id, via: opts.via })
    this.isExpanded = true
    track('surface_viewed', { surface: 'pr_review', via: opts.via })
    this.prsStore.prefetchReview(ctx, number)
    try {
      const pr = await this.router.resolve<PrReviewContext>(ref, {
        api: window.solus,
        ipc: (cwd) => (cwd ? this.ctxForDirectory(cwd) : ctx),
      })
      markPrReviewProfile('review-worktree-ready')
      return pr
    } catch (err) {
      // Tear down the pending surface so a failed open doesn't strand the user.
      this.router.dropResolved(ref)
      if (this.router.params('prReview')?.number === number) this.exitPrReview()
      toasts.error(`Couldn't open PR #${number}: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }

  /** Enter PR review without creating a chat. The checked-out worktree supplies
   *  the review context; a worktree-rooted chat is created only on demand. */
  async enterPrReview(
    number: number,
    title?: string,
    opts: { openChat?: boolean; ctx?: IpcContext; via?: Via } = {},
  ): Promise<void> {
    beginPrReviewProfile(number)
    // Switch to the editor layout up front so the click registers immediately.
    if (this.window.viewMode !== 'editor') await this.window.setViewMode('editor')
    const ctx = opts.ctx ?? this.ctx
    const pr = await this.openPrReviewRoute(number, title, ctx, { via: opts.via })
    if (pr && opts.openChat) await this.openPrReviewChat(pr)
  }

  /** Prepare one review without changing pane placement. Review Mode uses this
   * seam to warm the next item in its queue. */
  async preparePrReview(number: number, opts: { ctx?: IpcContext } = {}): Promise<{ pr: PrReviewContext }> {
    const pr = await window.solus.prOpenReview(opts.ctx ?? this.ctx, number)
    return { pr }
  }

  /** Open a PR picked from the list. It replaces the list rather than docking
   *  beside it; `tab` is the landing tab the picked row's verb promised. */
  async openPrReview(
    number: number,
    title?: string,
    opts: { ctx?: IpcContext; tab?: PrReviewTab } = {},
  ): Promise<void> {
    if (this.router.params('prReview')?.number === number) return
    beginPrReviewProfile(number)
    await this.openPrReviewRoute(number, title, opts.ctx ?? this.ctx, { tab: opts.tab })
  }

  /** Step to the PR before or after the open one, in the list's own order —
   *  what J / K and the chrome band's stepper walk. */
  stepPrReview(delta: number, ctx: IpcContext = this.ctx): void {
    const open = this.router.params('prReview')?.number
    const order = this.prsStore.listOrder
    if (open === undefined || order.length === 0) return
    const index = order.indexOf(open)
    if (index === -1) return
    const next = order[(index + delta + order.length) % order.length]
    if (next === open) return
    void this.openPrReview(next, this.prsStore.get(next)?.title, {
      ctx,
      tab: this.prsStore.prReviewTab,
    })
  }

  /** Create (once), activate, and reveal the chat associated with a PR review. */
  async openPrReviewChat(pr: PrReviewContext, existingTabId: string | null = null): Promise<string> {
    const hasExistingChat = Boolean(existingTabId && this.tabs[existingTabId])
    beginPrReviewProfile(pr.number, { restart: true })
    markPrReviewProfile('chat-open-start', { hasExistingChat })
    if (existingTabId && this.tabs[existingTabId]) {
      this.setActiveTab(existingTabId)
      this.revealConversationBesideReview()
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
      // Also what identifies this tab as the review's chat — PrReviewPane finds
      // it by looking for the tab rooted in this PR, so nothing has to be
      // attached to the route or torn down when it closes.
      reviewSession.prReview = pr
    }
    this.setActiveTab(tabId)
    this.revealConversationBesideReview()
    requestInputFocus()
    requestAnimationFrame(() => {
      markPrReviewProfile('chat-split-first-paint', { hasExistingChat })
      settlePrReviewProfile()
    })
    return tabId
  }

  /** Split the review: it keeps leading, and its conversation opens beside it.
   *  The chat and the popped-out diff share the aside, so revealing one puts
   *  the other away — the review is what you are always looking at. */
  private revealConversationBesideReview(): void {
    this.router.close('prDiff')
    const pane = this.router.navigate(CHAT_ROUTE, { target: 'aside' })
    this.geometry.open(pane.id, 0.5)
    this.isExpanded = true
  }

  /** Pop the open review's diff out beside it, so the activity feed and the
   *  change read together. Closing it returns the review to Activity. */
  openPrDiff(number: number, ctx: IpcContext = this.ctx): void {
    const pane = this.router.navigate(
      { name: 'prDiff', params: { number, cwd: ctx.session.projectPath ?? undefined } },
      { target: 'aside' },
    )
    this.geometry.open(pane.id, 0.5)
    this.isExpanded = true
  }

  closePrDiff(): void {
    this.router.close('prDiff')
  }

  /** Leave the review for the list it was opened from. Its agent chat remains an
   *  ordinary workspace tab. */
  exitPrReview(): void {
    this.router.close('prDiff')
    this.openPrs(this.router.params('prReview')?.cwd ?? null)
  }

  // ─── Settings page ───

  /** Which settings tab is showing — a route param, so a link can name it. */
  get settingsTab(): SettingsTab {
    return this.router.params('settings')?.tab ?? 'general'
  }

  get settingsProjectCwd(): string | null {
    return this.router.params('settings')?.projectCwd ?? null
  }

  showSettings(tab: SettingsTab = 'general', via: Via = 'click') {
    this.sessionPickerOpen = false
    this.showPage({ name: 'settings', params: { tab } }, via, 'settings')
    track('settings_opened', { tab, via })
  }

  /** Open the settings Projects tab with the given project preselected (from the project panel gear). */
  showProjectSettings(cwd: string) {
    this.sessionPickerOpen = false
    this.showPage({ name: 'settings', params: { tab: 'projects', projectCwd: cwd } }, 'click', 'settings')
    track('settings_opened', { tab: 'projects' })
  }

  /** Move between settings tabs without stacking a history entry per tab. */
  selectSettingsTab(tab: SettingsTab) {
    this.router.navigate({ name: 'settings', params: { tab } }, { replace: true })
  }

  closeSettings() {
    this.router.close('settings')
  }

  // ─── Arriving from outside ───

  /**
   * Enter a route that came from somewhere other than a click in the UI: an
   * agent-emitted `plan://` link, a notification payload, a deep link. The
   * router places it; this adds whatever the destination needs on entry that a
   * bare navigation cannot know about — a plan's body off disk, a PR's worktree.
   */
  openRoute(ref: RouteRef, opts: { via?: Via } = {}): void {
    switch (ref.name) {
      case 'plan':
        if (ref.params.planId) void this.openPlanModal(ref.params.planId)
        return
      case 'work':
        void this.openWorkModal(ref.params.workId, undefined, { via: opts.via })
        return
      case 'prReview':
        void this.enterPrReview(ref.params.number, ref.params.title, { via: opts.via })
        return
      case 'chat': {
        const tabId = ref.params.tabId
          ?? (ref.params.sessionId
            ? findOpenTabForSession(ref.params.sessionId, this.tabs, this.sessions, this.tabOrder)
            : null)
        if (tabId && this.tabs[tabId]) this.selectTab(tabId)
        this.isExpanded = true
        return
      }
      default:
        this.router.navigate(ref, { via: opts.via })
        this.isExpanded = true
    }
  }

  /** Enter a whole serialized location — reload restore and window handoff. */
  enterLocation(serialized: string, opts: { via?: Via } = {}): void {
    this.router.enter(serialized, opts)
    this.isExpanded = true
  }

  // ─── Viewers ───

  /** Show a session's changes. A generic toggle closes whatever diff is open;
   *  `switchScope` is the explicit "view working tree diff" action, which
   *  switches a mismatched-scope diff instead of closing it. */
  toggleDiff(sourceTabId: string, scope: DiffScope = { kind: 'session' }, switchScope = false): void {
    const current = this.router.overlay
    if (current?.name === 'diff' && (!switchScope || current.params.scope?.kind === scope.kind)) {
      this.router.closeOverlay()
      return
    }
    if (!this.sessionFor(sourceTabId)?.workingDirectory) return
    this.showDiff(sourceTabId, scope)
  }

  showDiff(sourceTabId: string, scope: DiffScope = { kind: 'session' }, filePath?: string): void {
    this.showViewer({ name: 'diff', params: { sourceTabId, scope, filePath } })
  }

  openFiles(sourceTabId: string): void {
    this.showViewer({ name: 'files', params: { sourceTabId } })
  }

  openFilePreview(file: FilePreviewRequest, sourceTabId: string): void {
    this.showViewer({
      name: 'fileEditor',
      params: { sourceTabId, path: file.path, line: file.line },
    })
  }

  /** Pop a sub-agent's nested transcript out of its card into a companion pane. */
  openSubagent(tabId: string, messageId: string): void {
    this.showViewer({ name: 'subagent', params: { tabId, messageId } })
  }

  /** Viewers cover a companion pane and size themselves; a diff opened over a
   *  review guide splits evenly so both halves stay readable. */
  private showViewer(ref: RouteRef): void {
    const pane = this.router.navigate(ref, { target: 'aside' })
    const wideByDefault =
      ref.name === 'diff' && this.router.leadingPane.base?.name === 'review' ? 0.5 : 0.6
    this.geometry.open(pane.id, wideByDefault)
  }

  // ─── Reviews ───

  /** Show a generated review walkthrough. It takes the leading pane so a
   *  focus-hunk diff can open beside it. */
  enterReview(key: string, scope: 'branch' | 'session' = 'branch', sourceTabId?: string): void {
    if (scope === 'session' && sourceTabId) {
      reviewGuideStore.markOpened(
        this.apiFor(sourceTabId),
        sessionGuideIdentity(this.sessionFor(sourceTabId)),
      )
    }
    this.router.navigate(
      { name: 'review', params: { key, scope, sourceTabId } },
      { target: this.router.leadingPane.id },
    )
  }

}

export const [getWorkspaceContext, setWorkspaceContext] = createAppContext<WorkspaceContext>('workspace')
