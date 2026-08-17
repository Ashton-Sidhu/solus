import { createAppContext } from '../app/create-app-context'
import type { AgentId, WireNormalizedEvent, EnrichedError, Message, Tab, Prompt, Session, SessionSpec, RunConfig, DiffCommentDraft, DiffComment, Attachment, PlanDescriptor, SessionCtx, IpcContext, TurnSnapshot, QueuedPromptSnapshot, OutboundPrompt, ModelConfig, SessionMeta, SessionTitleChangedEvent, GitCheckout, Work, WorktreeEntry, StatusCardState, PrReviewContext, PromptDelivery, ThreadGoal, ThreadGoalSetRequest } from '../../../shared/types'
import type { PrReviewTarget } from '../../../shared/providers'
import type { PullRequestSummary } from '../../../shared/providers'
import type { SolusEventMap, Via } from '../../../shared/analytics-events'
import { buildConflictResolutionPrompt, buildConflictResolverCard, buildConflictResolverErrorCard } from '../../lib/pr-conflict-resolution'
import { adjacentTabAfterClose, branchKeyFor, buildTabSections, findOpenTabForSession, hasSessionStarted } from '../../lib/sessionUtils'
import { SvelteMap } from 'svelte/reactivity'
import { uuid } from '../../../shared/uuid'
import { workPreview } from '../../../shared/work-preview'
import notificationSrc from '../../../../resources/notification.mp3'
import { sendRateLimitedNow } from '../../lib/rate-limit-actions'
import { type PlanStore } from '../plans/plan.store.svelte'
import { WorksStore } from '../works/works.store.svelte'
import { AutomationsStore } from '../automations/automations.store.svelte'
import { automationDraftSessionRequest } from '../automations/automation-draft-session'
import { TasksStore } from '../tasks/tasks.store.svelte'
import { OutboxStore } from '../outbox/outbox.store.svelte'
import { PrsStore, type PrReviewTab } from '../prs/prs.store.svelte'
import { PrInboxStore } from '../prs/pr-inbox.store.svelte'
import { projectCatalog } from '../projects/project-catalog.store.svelte'
import { prSurfaceError } from '../../components/prs/lib/pr-surface-error'
import { StacksStore } from '../prs/stacks.store.svelte'
import { type Task, type TaskSnapshot } from '../../../shared/task-types'
import { writeSessionHandoff } from './active-session-pointer'
import { toasts } from '../../lib/toasts'
import { RouterStore } from './routing/router.store.svelte'
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
import { environmentProjectKey, type GitRefreshResult, type SessionEnvironmentStore } from '../git/session-environment.store.svelte'
import { makeSession, makeTab, makePrompt } from './session.factories'
import {
  SessionDraft,
  existingTaskId,
  parentTaskId,
  requestedTaskTarget,
  taskBindingSessionId,
} from './session-draft.svelte'
import { isDispatch, projectRootOf, startsWorktree } from './run-config'
import { removeDraft, removePersistedTab } from './tab-persistence'
import { applySessionTitleChange } from './session-title-change'
import { applyRuntimeConfig, findLastUserIndex, nextMsgId } from './session.utils'
import type { DiffScope } from '../../../shared/git-types'
import type { FilePreviewRequest } from '../../lib/filePreview'
import { gitCheckoutFromState, isSessionBusyStatus, isSolusWorktreePath, isSteerableStatus, projectScopeOf, worktreeProjectRoot } from '../../../shared/types'
import { syncPendingInputFromEvent, loadSessionTranscript, RESTORED_TRANSCRIPT_LIMIT } from './session-transcript'
import { addDiffComment, updateDiffComment, removeDiffComment, restoreDiffComment, clearDiffComments, setDiffCommentDraft, updateDiffCommentDraftValue, setDiffGeneralComment, submitDiffFeedback, submitDiffFeedbackToNewSession } from './session-diff-feedback'
import { clearPlanWaiting, openPlanModal, closePlanModal, requestConversationScrollToBottom, approvePlanWithModel, rejectPlan, openPlanFromDescriptor, closePlanPreview, resumeSessionFromDescriptor, loadPlanContent, type ApprovePlanOptions } from './session-plan-operations'
import { SessionUnavailableError, unavailableSessionMessage } from './session-errors'
import { track } from '../../lib/analytics'
import { requestInputFocus } from '../../lib/inputFocus'
import { projectDirLabel } from '../../lib/paths'
import { disposeGitActions } from '../../lib/git-actions.svelte'
import { prioritizeTabHydration } from './session-bootstrap'
import { serverConnections } from '@client-core/server-connections'
import { LOCAL_SERVER_ID } from '@client-core/server-registry'
import type { HostApi } from '@client-core/host-api'
import { localApi } from '@client-core/local-api'
import { readSessionMeta } from '@client-core/session-meta'
import { classifySendFailure, sendOutbox, type OutboxRecord } from '@client-core/send-outbox'
import { hostKey } from '@client-core/host-key'
import { buildPrCommentsFixPrompt, type PrFixFeedback } from './pr-fix-session'
import { isPristineSplitTab } from '../../lib/split-chat'
import {
  beginPrReviewProfile,
  markPrReviewProfile,
  settlePrReviewProfile,
} from '../../components/pr-review/lib/pr-review-profiler'
import { moveTabToHost, prepareHostCheckout } from '../../components/servers/run-on'
import { buildRemoteDispatchCard } from '../../lib/remote-dispatch-card'
import { quotedReplyDraft } from '../../lib/quoted-reply'
import { GoalSync } from './goal-sync'
import { taskCreationContextFor, type TaskCreationContext } from '../../components/tasks/lib/task-creation-context'
import {
  reviewGuideStore,
  sessionGuideIdentity,
} from '../../components/review/review-guide.store.svelte'
import { z } from 'zod'

const devSessionLogging = Boolean(import.meta.env.DEV)
const outboxTaskPayloadSchema = z.object({ taskId: z.string().optional() })

interface PersistedSessionDrafts {
  version: 1
  order: string[]
  drafts: Record<string, SessionSpec>
}

function configuredAgent(value: string): AgentId {
  if (value === 'codex' || value === 'opencode') return value
  return 'claude-code'
}

function logDevSessionState(eventType: string, session: Session): void {
  if (!devSessionLogging) return
  // Log a shallow summary only — never $state.snapshot(session), which deep-clones
  // every message on each event and dominates the reducer's per-event cost.
  console.debug('[Solus][SessionState]', {
    sessionId: session.agentSessionId,
    provider: session.run.provider,
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
  /** Where a draft opens: a pane id, or `'aside'` for a new companion pane.
   *  Defaults to the focused pane. */
  target?: NavTarget
  /** Whether selecting this tab should also open the pill onto it. True for
   *  every tab a person asks for; false for the one the workspace seeds itself,
   *  which must not pop the pill open on launch. */
  reveal?: boolean
  freshTask?: boolean
  withoutTask?: boolean
  taskId?: string
  gitContext?: GitCheckout | null
  gitInitialization?: 'blocking' | 'background'
  worktreeRequested?: boolean
  /** The host this tab's session runs on. Must be set here rather than after the
   *  fact: `createTab` resolves the git environment, and a remote working
   *  directory has to be read on the machine that holds it. */
  serverId?: string
  /** The tab the gesture came from — a breadcrumb, an aside pane, an input bar.
   *  A draft inherits *that* session's run, not whichever tab happens to be
   *  active, or "new session from here" aims somewhere the user is not looking. */
  sourceTabId?: string
  via?: Via
}

interface ForkTabOptions {
  activate?: boolean
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
  prInboxStore = new PrInboxStore()
  stacksStore = new StacksStore()
  /** The outbox courier: drains cross-host writes recorded on any connected
   *  host to the host that owns each resource (ADR-0007). */
  outboxStore = new OutboxStore()
  /** Prompts being written that have no session and no tab. Keyed by the id the
   *  `draft` route carries; an entry is removed the moment it becomes a
   *  session, which is why nothing else ever lists one. */
  sessionDrafts = new SvelteMap<string, SessionDraft>()
  /** Where the workspace is: which routes are in which panes, plus history.
   *  Global — not per-tab. */
  router = new RouterStore()
  /** The one pane, if any, drawn over the whole window. Geometry rather than
   *  location: it survives navigation inside the pane and clears when the pane
   *  closes. Pane widths are PaneForge's own business — see WorkspaceBody. */
  maximizedPaneId = $state<PaneId | null>(null)
  ui: WorkspaceUiStore
  config: SessionConfigController
  onTurnSettled?: (sessionId: string, cwd: string | null) => void

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
    // The courier stays domain-blind; each domain contributes only the answer
    // to "which connected host owns this resource id".
    this.outboxStore.registerOwnerResolver('tasks', (taskId) => this.tasksStore.ownerHostForTask(taskId))
    // A dispatched session's works ops carry their task's id — the work row may
    // not exist on any host yet (a create in flight), so the task locates the
    // owner.
    this.outboxStore.registerOwnerResolver('works', (_workId, ops) => {
      const taskId = ops
        .flatMap((op) => {
          const parsed = outboxTaskPayloadSchema.safeParse(op.payload)
          return parsed.success && parsed.data.taskId ? [parsed.data.taskId] : []
        })
        .at(0)
      return taskId ? this.tasksStore.ownerHostForTask(taskId) : Promise.resolve(undefined)
    })
    // A goal belongs to a thread, so GoalSync names sessions. The RPC surface
    // and IPC context are still reached through a tab — they describe where the
    // work runs — so the resolver supplies one.
    this.goalSync = new GoalSync({
      sessionById: (sessionId) => this.sessions[sessionId],
      apiForSession: (sessionId) => this.apiForSession(sessionId),
      ctxForSession: (sessionId) => this.ctxFor(this.tabIdForSession(sessionId) ?? ''),
    })
    this.config = new SessionConfigController({
      settings: this.settings,
      registry: this.registry,
      statusBar: this.statusBar,
      setPluginCommands: (commands) => { this.pluginCommands = commands },
      openSessionDraft: (cwd) => { this.openSessionDraft({}, cwd) },
      draftFor: (sourceId) => this.sessionDrafts.get(sourceId),
      ctx: (tabId) => tabId ? this.ctxFor(tabId) : this.ctx,
      ctxForDirectory: (dir) => this.ctxForDirectory(dir),
      apiFor: (tabId) => tabId ? this.apiFor(tabId) : this.defaultHostApi(),
      apiForRun: (run) => this.apiForRun(run),
      refreshPluginCommands: (dir, tabId) => { void this.refreshPluginCommands(dir, tabId) },
      rekeyTaskSessionBinding: (sourceSessionId, targetSessionId, serverId) => {
        this.tasksStore.rekeySessionBinding(sourceSessionId, targetSessionId, serverId)
      },
      refreshGitRefs: (projectRoot, ctx) => { void this.environment.refreshRefs(projectRoot, ctx, { force: true }) },
      refreshGitState: (opts) => this.environment.refreshEnvironment(this, opts),
      selectTab: (tabId) => this.selectTab(tabId),
    })
    this.lifecycle = new WorkspaceLifecycleStore({
      registry: this.registry,
      settings: this.settings,
      config: this.config,
      planStore: this.planStore,
      agent: this.agent,
      refreshGitState: (opts) => this.environment.refreshEnvironment(this, opts),
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
      isSessionVisible: (sessionId) => this.isSessionVisible(sessionId),
      addChangedFilesFromMessage: (sessionId, message) => this.lifecycle.addChangedFilesFromMessage(sessionId, message),
      refreshTurnSnapshots: (sessionId) => { void this.refreshTurnSnapshots(sessionId) },
      setGitStatus: (cwd, status) => this.environment.set(cwd, status),
      playNotificationIfHidden: () => { void this.playNotificationIfHidden() },
      closePlanModal: () => this.closePlanModal(),
      onTurnSettled: (sessionId, cwd) => this.onTurnSettled?.(sessionId, cwd),
      // These surfaces are still addressed by tab — the goal pane is a route
      // carrying one, and metadata generation reads a tab's IPC context. The
      // reducer no longer knows that: it names the session, and the resolver
      // turns that into the tab showing it.
      onGoalDefined: (sessionId) => {
        const tabId = this.tabIdForSession(sessionId)
        if (tabId) this.revealGoal(tabId)
      },
      applyGoalUpdated: (sessionId, goal) => this.goalSync.applyUpdated(sessionId, goal),
      applyGoalCleared: (sessionId, threadId) => this.goalSync.applyCleared(sessionId, threadId),
      onSessionInitialized: (sessionId) => {
        const tabId = this.tabIdForSession(sessionId)
        if (!tabId) return
        void this.definePendingGoal(tabId)
        void this.generateSessionMetadata(tabId)
      },
      handlePendingInputSync: (session, events) => syncPendingInputFromEvent(this, session, events),
      log: (eventType, session) => logDevSessionState(eventType, session),
    })
    this.promptComposer = new PromptComposer(this.planStore, this.worksStore, this.tasksStore)
    this.ipcContextBuilder = new IpcContextBuilder({
      sessionFor: (tabId) => this.sessionFor(tabId),
      runFor: (sourceId) => this.runFor(sourceId),
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
  streamingTextFor(sessionId: string, isVisible: boolean): string {
    return this.eventReducer.streamingTextFor(sessionId, isVisible)
  }
  clearStreamingText(sessionId: string): void {
    this.eventReducer.clearStreamingText(sessionId)
  }
  get tabs(): Record<string, Tab> { return this.registry.tabs }
  set tabs(value: Record<string, Tab>) { this.registry.tabs = value }
  get sessions(): Record<string, Session> { return this.registry.sessions }
  set sessions(value: Record<string, Session>) { this.registry.sessions = value }
  get tabOrder(): string[] { return this.registry.tabOrder }
  set tabOrder(value: string[]) { this.registry.tabOrder = value }
  get activeTabId(): string { return this.registry.activeTabId }
  set activeTabId(value: string) { this.registry.setActiveTab(value) }
  /**
   * The tab a pane's chat is rendered in — the session→tab hop, and the only
   * place it happens. A pinned chat names its session and resolves through the
   * registry's index; the leading pane names none, because it renders whichever
   * conversation the pool is on, so it answers with the active tab.
   */
  chatTabIn(paneId: PaneId): string | null {
    if (!this.router.showsChat(paneId)) return null
    const sessionId = this.router.chatSessionIn(paneId)
    if (!sessionId) {
      return paneId === this.router.leadingPane.id ? this.activeTabId || null : null
    }
    return this.tabIdForSession(sessionId) ?? null
  }

  get focusedChatTabId(): string | null {
    return this.chatTabIn(this.router.focusedPaneId)
  }

  /** The chat pinned into a companion pane, if any — the "split chat". */
  get splitChatTabId(): string | null {
    for (const pane of this.router.asidePanes) {
      const tabId = this.chatTabIn(pane.id)
      if (tabId) return tabId
    }
    return null
  }

  /** The session pinned into a companion pane — what the split chat *is*, with
   *  the tab it happens to be rendered in left out of it. */
  get splitChatSessionId(): string | null {
    for (const pane of this.router.asidePanes) {
      const sessionId = this.router.chatSessionIn(pane.id)
      if (sessionId) return sessionId
    }
    return null
  }

  /** The pane holding the split chat, for focus and close operations. */
  private get splitChatPaneId(): PaneId | null {
    return this.router.asidePanes.find((pane) => pane.base?.name === 'chat')?.id ?? null
  }
  get activeInput(): Prompt { return this.registry.activeInput }
  set activeInput(value: Prompt) { this.registry.activeInput = value }
  get lastActiveTabByBranch() { return this.registry.lastActiveTabByBranch }
  get isExpanded(): boolean { return this.ui.isExpanded }
  set isExpanded(value: boolean) { this.ui.isExpanded = value }
  get sessionPickerOpen(): boolean { return this.ui.sessionPickerOpen }
  set sessionPickerOpen(value: boolean) { this.ui.sessionPickerOpen = value }
  get taskPickerOpen(): boolean { return this.ui.taskPickerOpen }
  set taskPickerOpen(value: boolean) { this.ui.taskPickerOpen = value }
  /** The active tab's task environment, including its base project and checkout. */
  get taskCreationContext(): TaskCreationContext | null {
    const session = this.activeSession
    return taskCreationContextFor(
      session?.run.workingDirectory ?? this.globalDefaults.workingDirectory,
      session ? session.run.gitContext : this.globalDefaults.gitContext,
    )
  }

  /** The base project whose tasks the page lists. */
  get tasksProjectCwd(): string | null {
    return this.taskCreationContext?.projectKey ?? null
  }

  private defaultModelConfigFor(agentId: AgentId): ModelConfig {
    return this.config.defaultModelConfigFor(agentId)
  }

  defaultReasoningEffortFor(agentId: AgentId, modelId: string | null) {
    return this.config.defaultReasoningEffortFor(agentId, modelId)
  }

  setDefaultModel(agentId: AgentId, modelId: string): void {
    this.config.setDefaultModel(agentId, modelId)
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
    this.registry.setActiveTab(tabId)
    prioritizeTabHydration(this, tabId)
    // A review guide belongs to the session it was generated from, so moving to
    // another tab leaves it rather than showing a stale walkthrough.
    this.router.close('review')
  }

  /** Is this conversation on screen anywhere? A session may be watched by
   *  several tabs; any one of them being on screen makes it visible. */
  private isSessionVisible(sessionId: string): boolean {
    const editorLike = this.window.viewMode === 'editor' || this.window.isWeb
    // A chat pinned in a companion pane is on screen too — but only in
    // editor/web, where companion panes actually render.
    if (editorLike && this.router.asidePanes.some(
      (pane) => this.router.chatSessionIn(pane.id) === sessionId,
    )) {
      return true
    }
    return this.tabs[this.activeTabId]?.sessionId === sessionId
      && (editorLike || this.isExpanded)
  }

  isSessionVisibleOnHost(serverId: string, sessionId: string): boolean {
    const tabId = findOpenTabForSession(
      sessionId,
      this.tabs,
      this.sessions,
      this.tabOrder,
      undefined,
      serverId,
    )
    if (!tabId) return false
    const editorLike = this.window.viewMode === 'editor' || this.window.isWeb
    if (editorLike && this.router.asidePanes.some((pane) => {
      if (pane.overlay || pane.base?.name !== 'chat') return false
      if (pane.base.params.sessionId !== sessionId) return false
      return pane.base.params.serverId
        ? pane.base.params.serverId === serverId
        : this.chatTabIn(pane.id) === tabId
    })) {
      return true
    }
    return this.activeTabId === tabId && (editorLike || this.isExpanded)
  }

  /** Whether the conversation pool is what the leading pane is showing. A page,
   *  an artifact or a draft sitting in it means the active tab exists but is
   *  not on screen — so selecting that tab still has somewhere to go. */
  get showsConversation(): boolean {
    return visibleRef(this.router.leadingPane)?.name === 'chat'
  }

  /** The tab whose conversation is on screen, for surfaces that mark the current
   *  session. The leading pane wins when it shows a conversation; otherwise a
   *  companion pane showing one does — so a session split alongside a draft still
   *  reads as active. Empty when neither pane shows a session (a draft, page or
   *  artifact in the lead with nothing split beside it), so the sidebar
   *  highlights nothing rather than the tab you left behind. */
  get onScreenTabId(): string {
    if (this.showsConversation) return this.activeTabId
    return this.splitChatTabId ?? ''
  }

  /** The drafts a pane is composing right now. A draft on screen is where the
   *  user is typing, not something they have set aside, so nothing lists it —
   *  moving the pane off it is the moment it becomes a draft they *have*. */
  get composingDraftIds(): Set<string> {
    const ids = new Set<string>()
    for (const pane of this.router.panes) {
      // The pane's own content, not whatever is layered over it: a settings
      // overlay is still that composer's pane, and a row appearing behind a
      // modal only to leave again when it closes is noise.
      if (pane.base?.name === 'draft') ids.add(pane.base.params.draftId)
    }
    return ids
  }

  /** Leave whatever page (and optionally artifact) is showing — what selecting
   *  another tab or creating one does, so the new conversation is what you see. */
  private resetOverlays(opts: { closeArtifact?: boolean } = {}): void {
    this.router.closeGroup('page')
    if (opts.closeArtifact) this.router.closeGroup('artifact')
    this.leaveDraftInLead()
    this.planStore.dismissPreview()
  }

  /** Hand the leading pane back to the conversation when a draft is sitting in
   *  it. */
  private leaveDraftInLead(): void {
    const pane = this.router.leadingPane
    if (pane.base?.name !== 'draft') return
    this.releaseDraftIn(pane.id)
    this.router.navigate(CHAT_ROUTE, { target: pane.id })
  }

  /** Let go of the draft a pane is showing, before it shows something else. One
   *  that was never written in is dropped rather than left in the map — and in
   *  the persisted snapshot — with nothing listing it. One that was written in
   *  keeps its row in the sidebar's drafts, which is the way back to it.
   *
   *  `keepDraftId` is the draft the pane is about to show, so re-aiming a pane
   *  at what it already holds never drops it out from under itself. */
  private releaseDraftIn(paneId: PaneId, keepDraftId?: string): void {
    const base = this.router.pane(paneId)?.base
    if (base?.name !== 'draft' || base.params.draftId === keepDraftId) return
    const draft = this.sessionDrafts.get(base.params.draftId)
    if (draft?.isEmpty) this.dropDraft(draft.id)
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

  /**
   * Where a session is showing. A surface that composes for a *session* — the
   * input bar — names the session and looks its tab up here, rather than being
   * handed a tab it may not have: a draft has none, and a session watched in a
   * split chat has two. `dockedTabId` is the one the caller is docked beside,
   * so view-routed events (quote insertion, file preview) land in the pane the
   * user is actually looking at instead of the first tab that matches.
   */
  tabIdForSession(sessionId: string, dockedTabId?: string): string | undefined {
    if (dockedTabId && this.tabs[dockedTabId]?.sessionId === sessionId) return dockedTabId
    return this.registry.tabIdsBySession.get(sessionId)?.[0]
  }

  /** Every tab watching a session, in strip order. Empty is a normal answer: a
   *  session that has not been opened, or was closed while still running. */
  tabIdsForSession(sessionId: string): string[] {
    return this.registry.tabIdsBySession.get(sessionId) ?? []
  }

  /** Where a *provider's* session is showing. A work item, a task link and a
   *  resume all name an agent session id; a fork inherits its source's, so this
   *  finds the branch too. The host is part of the question — a dispatched
   *  session's clone shares the provider id — so a caller without one gets no
   *  match rather than another host's conversation. */
  tabIdForAgentSession(agentSessionId: string, serverId: string | undefined): string | undefined {
    if (!serverId) return undefined
    return this.registry.tabIdsByAgentSession.get(hostKey(serverId, agentSessionId))?.[0]
  }

  /** The chat bound to a work item, if one is open. */
  tabIdForWork(workId: string): string | undefined {
    return this.tabOrder.find((tabId) => this.sessionFor(tabId)?.boundWorkId === workId)
  }

  /**
   * The run a surface is scoped to, named by whichever thing owns it: a started
   * conversation's tab, or a draft that has yet to become one. Every surface
   * that describes *where work happens* — the project rail, its Git actions, a
   * file tree — resolves through this and so needs to know neither which of the
   * two it was handed nor how to reach a run from it.
   */
  runFor(sourceId: string): RunConfig | undefined {
    return this.sessionFor(sourceId)?.run ?? this.sessionDrafts.get(sourceId)?.run
  }

  /** The new-work default host, for deliberately session-less operations. */
  private defaultHostApi(): HostApi {
    const serverId = serverConnections.defaultServerId()
    if (!serverId) throw new Error('Primary Solus connection has not been registered')
    return serverConnections.apiFor(serverId)
  }

  /** Resolve the RPC surface that owns a run — the machine it runs on. */
  apiForRun(run: RunConfig | undefined): HostApi {
    if (!run) return this.defaultHostApi()
    const resolvedId = serverConnections.resolveId(run.serverId)
    const api = serverConnections.apiFor(resolvedId)
    serverConnections.retain(resolvedId)
    this.environment.bindCwd(resolvedId, run.workingDirectory, api)
    this.environment.bindCwd(resolvedId, run.gitContext?.repoRoot, api)
    this.environment.bindCwd(resolvedId, run.gitContext?.worktreePath, api)
    return api
  }

  /** Resolve the RPC surface that owns this tab's — or draft's — session. */
  apiFor(sourceId: string): HostApi {
    return this.apiForRun(this.runFor(sourceId))
  }

  /** The same surface, for callers holding only the session's own id. */
  apiForSession(sessionId: string): HostApi {
    return this.apiForRun(this.sessions[sessionId]?.run)
  }

  /** Resolve a host from a stateful IPC context, or choose the new-work
   *  default host for a deliberately session-less operation. */
  apiForContext(ctx: IpcContext): HostApi {
    return ctx.session.sessionId
      ? this.apiForSession(ctx.session.sessionId)
      : this.defaultHostApi()
  }

  serverIdForContext(ctx: IpcContext): string {
    return serverConnections.serverIdForApi(this.apiForContext(ctx))
  }

  get activeTab(): Tab | undefined {
    return this.registry.activeTab
  }

  /** The composer the input bar reads/writes: the active tab's, or the tab-less one. */
  get currentInput(): Prompt {
    return this.registry.currentInput
  }

  /** The unsent message for a tab's conversation. Two tabs on one session get
   *  the same object, so what you type in either is what the other shows. */
  inputFor(tabId: string): Prompt {
    return this.sessionFor(tabId)?.prompt ?? this.currentInput
  }

  /** Whether this tab will mint a new task when its first prompt is sent. */
  willStartNewTask(tabId: string): boolean {
    const session = this.sessionFor(tabId)
    return !!this.tabs[tabId]
      && !hasSessionStarted(session)
      && !!session
      && session.task.kind === 'new'
  }

  get activeSession(): Session | undefined {
    return this.registry.activeSession
  }

  get galleryProjectPath(): string {
    return this.activeSession?.run.workingDirectory ?? this.globalDefaults.workingDirectory ?? '~'
  }

  /** The run backing the leading pane — a started session's, or a draft's when
   *  the pane is composing one. This is the run the input header names, so a
   *  surface that must agree with it (the session picker's project scope) reads
   *  it here rather than off the active tab, which a draft has none of. */
  get activeRun(): RunConfig | undefined {
    const ref = visibleRef(this.router.leadingPane)
    if (ref?.name === 'draft') {
      const draft = this.sessionDrafts.get(ref.params.draftId)
      if (draft) return draft.run
    }
    return this.activeSession?.run
  }

  /** The project the input header names, as scope roots for the session picker.
   *  One key, not every worktree path: a backend already folds a repo's worktree
   *  sessions into a query on its key, so listing each worktree separately would
   *  only refetch the same rows. */
  get activeProjectScopeRoots(): string[] {
    const key = this.activeRun?.gitContext?.repoRoot ?? this.activeRun?.workingDirectory
    return key && key !== '~' ? [key] : []
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
      const key = sess.run.gitContext?.repoRoot ?? sess.run.workingDirectory ?? '~'
      let project = byKey.get(key)
      if (!project) {
        project = { key, label: projectDirLabel(key, this.staticInfo?.workspacePath), roots: [] }
        byKey.set(key, project)
      }
      for (const root of [sess.run.gitContext?.repoRoot, sess.run.gitContext?.worktreePath, sess.run.workingDirectory]) {
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
    const visible = await localApi.isVisible()
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

  async refreshAgentAvailability(): Promise<void> {
    return this.lifecycle.refreshAgentAvailability()
  }

  async refreshPluginCommands(workingDirectory: string, tabId?: string): Promise<void> {
    return this.lifecycle.refreshPluginCommands(workingDirectory, tabId)
  }

  async switchToBranch(branch: string, sourceId?: string, via: Via = 'click'): Promise<boolean> {
    const switched = await this.config.switchToBranch(branch, sourceId)
    if (switched) track('branch_switched', { via })
    return switched
  }

  recomputeChangedFiles(tabId: string): void {
    this.lifecycle.recomputeChangedFiles(tabId)
  }

  /** Widen a tab's transcript window: one page with `paged`, the full history without. */
  async expandHistory(tabId: string, opts?: { paged?: boolean }): Promise<void> {
    return this.lifecycle.expandHistory(tabId, opts)
  }

  async hydrateChangedFilesFromDiff(tabId: string): Promise<void> {
    return this.lifecycle.hydrateChangedFilesFromDiff(tabId)
  }

  async refreshTurnSnapshots(sessionId: string): Promise<void> {
    return this.lifecycle.refreshTurnSnapshots(sessionId)
  }

  reconcileQueuedPrompts(tabId: string, queuedPrompts: QueuedPromptSnapshot[]): void {
    this.lifecycle.reconcileQueuedPrompts(tabId, queuedPrompts)
  }

  private resetSessionRunState(session: Session): void {
    this.eventReducer.resetSessionRunState(session)
  }

  /**
   * Re-key a session onto the id the host resolved for it. Every from-disk path
   * needs this — resume, restore, and reconnect alike: a fresh session's uuid has
   * never left this renderer and so cannot collide, but a provider thread read off
   * disk may already be open on another client, which named it first. Skipping the
   * adoption leaves the two clients holding different addresses for one session,
   * so each one only ever sees the turns it started.
   *
   * Safe precisely because it runs before anything is published under the local
   * id — the session is empty, unbound, and not yet streaming.
   */
  adoptSessionId(tabId: string, resolvedSessionId: string): void {
    const tab = this.tabs[tabId]
    const session = tab ? this.sessions[tab.sessionId] : undefined
    if (!tab || !session || session.id === resolvedSessionId) return
    // Another local session already answers to that id. Re-keying would evict a
    // live object out from under whichever tabs point at it, so leave both alone.
    if (this.sessions[resolvedSessionId]) return
    delete this.sessions[session.id]
    session.id = resolvedSessionId
    this.sessions[resolvedSessionId] = session
    tab.sessionId = resolvedSessionId
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
    if (session) void this.refreshThreadGoal(session.id)
  }

  async refreshThreadGoal(sessionId: string): Promise<void> {
    await this.goalSync.refresh(sessionId)
  }

  setThreadGoal(sessionId: string, update: Omit<ThreadGoalSetRequest, 'threadId'>): Promise<ThreadGoal> {
    return this.goalSync.set(sessionId, update)
  }

  createThreadGoal(sessionId: string, objective: string): Promise<ThreadGoal> {
    return this.goalSync.create(sessionId, objective)
  }

  clearThreadGoal(sessionId: string): Promise<void> {
    return this.goalSync.clear(sessionId)
  }

  /** Show the goal wherever this shell keeps it. Editor mode has a project-rail
   *  section, so it opens that rail and expands the section; the pill and the
   *  mobile web shell have no rail, so the goal takes the secondary pane. */
  revealGoal(tabId: string): void {
    const sessionId = this.tabs[tabId]?.sessionId
    if (this.window.viewMode !== 'editor') {
      if (!sessionId) return
      const pane = this.router.navigate(
        { name: 'goal', params: { sessionId, serverId: this.sessions[sessionId]?.run.serverId } },
        { target: 'aside' },
      )
      pane.defaultSize = 34
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
    if (!session?.agentSessionId || !session.run.provider || !objective) return
    try {
      await this.refreshThreadGoal(session.id)
      if (session.goal) {
        session.pendingGoalObjective = null
        this.revealGoal(tabId)
        return
      }
      session.pendingGoalObjective = null
      await this.createThreadGoal(session.id, objective)
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
    for (const { sessionId, taskServerId } of applySessionTitleChange(this, serverId, event)) {
      for (const tabId of this.tabIdsForSession(sessionId)) this.metadataFinalizedTabs.add(tabId)
      if (taskServerId === serverId) continue
      // A dispatched session is indexed on its execution host, while its task
      // host holds a lightweight proxy row for closed-attempt display. Carry
      // the authoritative rename back across that boundary; otherwise only the
      // borrowed host learns the generated name.
      void serverConnections.apiFor(taskServerId)
        .setSessionTitle(event.sessionId, event.title, event.source, event.generatedDescription, false)
        .then(() => this.tasksStore.refreshSessionBinding(event.sessionId, taskServerId))
        .catch(() => null)
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

    if (session.titleCustom) {
      // A name typed into a session before the provider knew about it had
      // nowhere to persist — this is the first moment there's an id to hang it on.
      this.metadataFinalizedTabs.add(tabId)
      await this.apiFor(tabId).setSessionTitle(agentSessionId, session.title, 'manual').catch(() => {})
      return
    }
    if (!this.settings.autoRenameSessions) return

    // Only the opening turn names a thread — a later init is a resume, and a
    // resumed thread either has a name already or was deliberately left unnamed.
    const userMessages = session.messages.filter((message) => message.role === 'user' && message.content)
    if (userMessages.length !== 1) return
    this.metadataFinalizedTabs.add(tabId)

    const metadata = await this.apiFor(tabId)
      .generateSessionMetadata(userMessages[0].content, session.run.workingDirectory)
      .catch(() => null)
    if (!metadata) return

    // The tab may have been closed, reset, renamed by hand, or resumed into a
    // different session while the naming round trip was in flight.
    const currentSession = this.sessionFor(tabId)
    if (!this.tabs[tabId] || !currentSession || currentSession.titleCustom) return
    if (currentSession.agentSessionId !== agentSessionId) return
    currentSession.title = metadata.title
    await this.apiFor(tabId)
      .setSessionTitle(agentSessionId, metadata.title, 'generated', metadata.description)
      .catch(() => {})
  }

  /** Rename a session by hand, named by a tab showing it. An empty name clears
   *  back to the derived title. Every view of the session sees the new name,
   *  because the name is the session's. */
  async renameTab(tabId: string, title: string): Promise<void> {
    const session = this.sessionFor(tabId)
    if (!session) return
    const trimmed = title.trim()
    // 'New Tab' is what sessionTitle() reads as "unnamed", so clearing a name
    // there falls the display back to the session's first prompt.
    session.title = trimmed || 'New Tab'
    session.titleCustom = !!trimmed
    this.metadataFinalizedTabs.add(tabId)
    if (session?.agentSessionId) {
      await this.apiFor(tabId).setSessionTitle(session.agentSessionId, trimmed || null, 'manual')
    }
  }

  // ─── Tab management ───

  async createTab(cwd?: string, options: CreateTabOptions = {}): Promise<string> {
    const defaultDir = this.staticInfo?.projectPath || this.staticInfo?.workspacePath || '~'
    const activeSession = this.activeSession
    const inheritedDir = cwd ?? (activeSession?.run.workingDirectory || this.globalDefaults.workingDirectory || defaultDir)
    const sourceConfig = activeSession?.run.modelConfig ?? this.globalDefaults.modelConfig
    const provider = activeSession?.run.provider ?? configuredAgent(this.settings.activeAgent)
    const inheritedModelConfig = {
      ...sourceConfig,
      reasoningEffort: this.defaultReasoningEffortFor(provider, sourceConfig.modelId),
    }
    const inheritedPermissionMode = this.globalDefaults.permissionMode
    const inheritedGitContext = options.gitContext === undefined
      ? cwd === undefined
        ? activeSession?.run.gitContext ?? this.globalDefaults.gitContext
        : null
      : options.gitContext
    // A fresh tab follows the saved default. Per-session toggles belong only to
    // that session and must not silently override where the next session starts.
    const worktreeRequested = options.worktreeRequested
      ?? (!inheritedGitContext?.worktreePath && this.settings.worktreeEnabled)
    // A tab is renderer-local now — the host only ever hears about the session,
    // and only once one is watched.
    const session = makeSession(this.settings, {
      run: {
        serverId: options.serverId ?? activeSession?.run.serverId ?? this.fallbackServerId,
        // A host named for this tab owns its project too — only a dispatch
        // splits the two, and it carries the split across from its source.
        taskServerId: options.serverId ?? activeSession?.run.taskServerId ?? this.fallbackServerId,
        // Grouping follows the run the tab was opened from, so work continued
        // from a dispatched session stays under the project the user knows.
        projectGroupPath: options.serverId ? null : activeSession?.run.projectGroupPath ?? null,
        workingDirectory: inheritedDir,
        gitContext: inheritedGitContext ? { ...inheritedGitContext } : null,
        worktree: worktreeRequested ? { baseBranch: inheritedGitContext?.targetBranch ?? null } : null,
        modelConfig: inheritedModelConfig,
        permissionMode: inheritedPermissionMode,
        sessionSkills: activeSession?.run.sessionSkills ?? [],
      },
      pluginCommands: this.pluginCommands,
      task: options.taskId ? { kind: 'existing', taskId: options.taskId } : { kind: 'new' },
    })
    const tab = makeTab(session.id)
    const tabId = tab.id
    this.sessions[session.id] = session
    this.tabs[tab.id] = tab
    this.addTabToOrder(tab.id)
    track('tab_created', { via: options.via, worktree: worktreeRequested })
    if (options.activate !== false) {
      this.setActiveTab(tab.id)
      this.resetOverlays({ closeArtifact: true })
    }
    if (options.activate !== false && !activeSession?.run.gitContext && inheritedGitContext) {
      this.config.applyGlobalStartTarget({ gitContext: null, worktreeBaseBranch: null })
    }
    const gitInitialization = this.environment.refreshEnvironment(this, { sourceId: tabId, worktreeRequested })
    if (options.gitInitialization === 'background') void gitInitialization
    else await gitInitialization
    void this.refreshPluginCommands(inheritedDir)
    if (options.activate !== false) requestInputFocus()
    return tabId
  }

  /** The task the session behind `tabId` belongs to — the anchor a new draft
   *  files under. Reads the named tab, not the active one: the gesture may come
   *  from a breadcrumb or aside pane showing a different session. */
  private rootTaskIdFor(tabId: string | undefined): string | null {
    const anchor = tabId ? this.sessionFor(tabId) : undefined
    if (!anchor) return null
    return this.tasksStore.taskForSession(anchor.agentSessionId)?.id
      ?? existingTaskId(anchor.task)
      ?? null
  }

  /** The host new sessions land on when nothing else names one. */
  get fallbackServerId(): string {
    return serverConnections.defaultServerId()
      ?? serverConnections.localServerId()
      ?? LOCAL_SERVER_ID
  }

  /**
   * Bring a session into being from a spec, and mount a tab showing it. The
   * only path from "what the user composed" to "a session exists" — every entry
   * point resolves a spec and arrives here, so there is one answer to what a new
   * session inherits and one place that answers it.
   */
  createSession(spec: SessionSpec, options: CreateTabOptions = {}): string {
    const session = makeSession(this.settings, {
      // The composer's resolved target becomes the session's live one. Copied
      // rather than aliased: the composer may be reused, and a session's run
      // config is thereafter its own to change.
      run: { ...spec.run, gitContext: spec.run.gitContext ? { ...spec.run.gitContext } : null },
      pluginCommands: this.pluginCommands,
      task: spec.task,
      // The draft's prompt becomes the session's, same object: what the composer
      // is about to clear is what the send just read.
      prompt: spec.prompt,
    })
    const tabId = uuid()
    this.sessions[session.id] = session
    this.tabs[tabId] = makeTab(session.id, { id: tabId })
    this.addTabToOrder(tabId)
    track('tab_created', {
      via: options.via,
      worktree: !!session.run.worktree && !session.run.gitContext?.worktreePath,
    })
    if (options.activate !== false) {
      this.setActiveTab(tabId)
      if (options.reveal !== false) {
        this.isExpanded = true
        this.resetOverlays({ closeArtifact: true })
      }
    }
    void this.environment.refreshEnvironment(this, { sourceId: tabId, worktreeRequested: startsWorktree(spec.run) })
    void this.refreshPluginCommands(spec.run.workingDirectory, tabId)
    if (options.activate !== false && options.reveal !== false) requestInputFocus({ tabId })
    return tabId
  }

  /** Where a session starts when nothing is carried over: the app's own saved
   *  preferences, as the same `RunConfig` a session and a draft both hold. */
  get defaultRunConfig(): RunConfig {
    const defaults = this.globalDefaults
    return {
      workingDirectory: defaults.workingDirectory
        || this.staticInfo?.projectPath
        || this.staticInfo?.workspacePath
        || '~',
      gitContext: defaults.gitContext,
      worktree: this.settings.worktreeEnabled ? { baseBranch: defaults.worktreeBaseBranch } : null,
      modelConfig: defaults.modelConfig,
      permissionMode: defaults.permissionMode,
      provider: configuredAgent(this.settings.activeAgent),
      serverId: this.fallbackServerId,
      // Nothing has dispatched yet, so a new run owns its own tasks.
      taskServerId: this.fallbackServerId,
      projectGroupPath: null,
      sessionSkills: [],
      pendingHostDispatch: null,
    }
  }

  /**
   * The run config a new draft carries over, or null when it starts clean.
   * "New task" is not a flag on the draft — it is simply having nothing to
   * inherit, anchored to the project the current session belongs to.
   */
  private runToInherit(
    anchorTabId: string | undefined,
    cwd: string | undefined,
    options: CreateTabOptions,
  ): RunConfig | null {
    const anchor = anchorTabId ? this.sessionFor(anchorTabId)?.run ?? null : null
    if (options.freshTask) {
      const projectRoot = projectRootOf(anchor)
      // The project root is a path on the anchor's host, so the new task stays
      // on that host — dropping to the local default would point a remote path
      // at this machine. Only a started session names a project root here, so
      // `anchor` is non-null whenever one is found.
      return projectRoot
        ? {
            ...this.defaultRunConfig,
            workingDirectory: projectRoot,
            gitContext: null,
            serverId: anchor?.serverId ?? this.defaultRunConfig.serverId,
            // New work on the same project keeps that project's task host, so a
            // fresh task started from a dispatched session still files here —
            // and keeps grouping under the project the user knows.
            taskServerId: anchor?.taskServerId ?? this.defaultRunConfig.taskServerId,
            projectGroupPath: anchor?.projectGroupPath ?? null,
          }
        : null
    }
    // An explicit directory may name an entirely different project, so the
    // inherited checkout is dropped rather than mislabelling it until the
    // environment refresh lands.
    if (cwd !== undefined || options.gitContext !== undefined) {
      const base = anchor ?? this.defaultRunConfig
      const inherited: RunConfig = {
        ...base,
        gitContext: options.gitContext !== undefined ? options.gitContext : null,
      }
      if (cwd !== undefined) inherited.workingDirectory = cwd
      return inherited
    }
    return anchor
  }

  /**
   * Open a prompt with nowhere to go yet, and point a pane at it. No session
   * and no tab exist until the first prompt is sent, so nothing lists it.
   */
  openSessionDraft(options: CreateTabOptions = {}, cwd?: string): SessionDraft {
    const anchorTabId = options.sourceTabId ?? (this.activeTabId || undefined)
    const draft = new SessionDraft(
      this.defaultRunConfig,
      this.runToInherit(anchorTabId, cwd, options),
      this.settings.worktreeEnabled,
    )
    draft.task = requestedTaskTarget(options, this.rootTaskIdFor(anchorTabId))
    // A pane already showing a draft lets go of it before the new one takes its
    // place. A written-in draft survives that — the sidebar lists it and can
    // bring it back — so several drafts can be open at once.
    if (!options.target) this.releaseDraftIn(this.router.focusedPaneId)
    this.sessionDrafts.set(draft.id, draft)
    this.router.navigate(
      { name: 'draft', params: { draftId: draft.id } },
      { via: options.via ?? 'click', target: options.target ?? this.router.focusedPaneId },
    )
    // Boot seeds a draft so the workspace is never empty, but must not pop the
    // pill open on launch — only a draft the user asked for reveals itself.
    if (options.reveal !== false) this.isExpanded = true
    return draft
  }

  /** Go back to a draft that was written in and left — what its sidebar row
   *  does. The pane it lands in lets go of whatever draft it was holding first,
   *  on the same rule every other route change uses. */
  openDraft(draftId: string, via: Via = 'click'): void {
    if (!this.sessionDrafts.has(draftId)) return
    const target = this.router.focusedPaneId
    this.releaseDraftIn(target, draftId)
    this.router.navigate({ name: 'draft', params: { draftId } }, { via, target })
    this.isExpanded = true
  }

  /**
   * Turn a draft into a real session and mount its tab. The draft is dropped
   * the moment the session exists — there is only ever one of the two.
   */
  startSessionDraft(draftId: string, options: CreateTabOptions = {}): string | null {
    const draft = this.sessionDrafts.get(draftId)
    if (!draft) return null
    const tabId = this.createSession(draft.spec, options)
    this.dropDraft(draftId)
    return tabId
  }

  /** Abandon a draft without starting anything, and hand back any pane that was
   *  composing it — a pane pointed at a draft that no longer exists renders
   *  nothing at all. Returns what was discarded, so the surface that asked can
   *  offer it back. */
  discardSessionDraft(draftId: string): SessionSpec | null {
    const spec = this.sessionDrafts.get(draftId)?.spec
    const discarded = spec ? $state.snapshot(spec) : null
    this.dropDraft(draftId)
    for (const pane of this.router.panes) {
      if (pane.base?.name !== 'draft' || pane.base.params.draftId !== draftId) continue
      // With nothing started, the conversation pool has nothing to show, so the
      // pane composes a fresh prompt rather than going blank.
      if (this.tabOrder.length === 0) this.openSessionDraft({ target: pane.id, reveal: false })
      else this.router.navigate(CHAT_ROUTE, { target: pane.id })
    }
    return discarded
  }

  /** The one way a draft leaves the map, so nothing keyed on it outlives it —
   *  a draft's project rail owns Git action state the same way a tab's does. */
  private dropDraft(draftId: string): void {
    this.sessionDrafts.delete(draftId)
    disposeGitActions(draftId)
  }

  /** Rebuild the open drafts from the last snapshot, keeping their ids so the
   *  restored location's `draft/<id>` route still resolves. The host only seeds
   *  the shape; every field is then overwritten by what was saved. */
  restoreSessionDrafts(snapshot: { order: string[]; drafts: Record<string, SessionSpec> }): void {
    for (const draftId of snapshot.order) {
      const spec = snapshot.drafts[draftId]
      if (!spec) continue
      const draft = new SessionDraft(this.defaultRunConfig)
      Object.assign(draft, { id: draftId })
      draft.run = spec.run
      draft.task = spec.task
      draft.prompt = spec.prompt
      // Empty drafts are disposable UI state, not user work. Older snapshots
      // persisted the foreground empty composer and could therefore restore its
      // `draft/<id>` route over a real active session after reload.
      if (draft.isEmpty) continue
      this.sessionDrafts.set(draftId, draft)
    }
  }

  /** The plain shape the drafts persist as. */
  get sessionDraftsSnapshot(): PersistedSessionDrafts {
    // The same rule used when a pane leaves a draft: only words or attachments
    // make it durable. Persisting the empty foreground composer gives reload a
    // draft route with no user state to recover and hides the active session.
    const order = [...this.sessionDrafts.entries()]
      .filter(([, draft]) => !draft.isEmpty)
      .map(([draftId]) => draftId)
    return {
      version: 1,
      order,
      drafts: Object.fromEntries(order.flatMap((draftId) => {
        const draft = this.sessionDrafts.get(draftId)
        return draft ? [[draftId, $state.snapshot(draft.spec)]] : []
      })),
    }
  }

  /** Author an automation in a low-reasoning session with no tab routing state. */
  async createAutomationDraftSession(
    prompt: string,
    cwd: string,
    serverId?: string,
  ): Promise<string> {
    const provider = configuredAgent(this.settings.activeAgent)
    const modelConfig = this.defaultModelConfigFor(provider)
    const api = serverId
      ? serverConnections.apiFor(serverId)
      : this.defaultHostApi()
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
    const projectRoot = src?.run.gitContext?.repoRoot
      ?? (src?.run.workingDirectory && src.run.workingDirectory !== '~' ? worktreeProjectRoot(src.run.workingDirectory) : undefined)
    const draft = this.openSessionDraft({ worktreeRequested: true }, projectRoot)
    // Always branch off the project root, even when the source was itself inside
    // a worktree whose checkout the draft would otherwise inherit.
    draft.run = { ...draft.run, gitContext: null }
    const dir = draft.run.workingDirectory
    if (!dir || dir === '~') return
    const refreshed = await this.environment.refresh(dir, { force: true })
    void refreshed
    const targetBranch = this.environment.statusFor(dir)?.targetBranch
    if (targetBranch) draft.run = { ...draft.run, worktree: { baseBranch: targetBranch } }
  }

  /** Fork a session into a new tab. The fork inherits the transcript through the
   *  source's last settled turn, resumes on first prompt, and lands as a subtask
   *  of whatever task the source is working. */
  async forkTab(sourceTabId: string, options: ForkTabOptions = {}): Promise<string | null> {
    const sourceSession = this.sessionFor(sourceTabId)
    if (!sourceSession?.agentSessionId) return null

    // The fork's own session is watched when it is first prompted, so nothing
    // needs to reach the host here.
    const tabId = uuid()

    const originalTitle = sourceSession.title || 'session'
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
    }
    if (inFlightFrom !== -1) forkInfoMsg.forkSourceRunning = true

    // A fork is another attempt at the same goal, so it belongs under the source's
    // task rather than beside it as a loose session. Nesting is one level deep:
    // forking a subtask's session adds a sibling under their shared parent.
    const sourceTask = this.tasksStore.taskForSession(sourceSession.agentSessionId)
      ?? (existingTaskId(sourceSession.task)
        ? this.tasksStore.tasks.find((task) => task.id === existingTaskId(sourceSession.task))
        : undefined)
      ?? (parentTaskId(sourceSession.task)
        ? this.tasksStore.tasks.find((task) => task.id === parentTaskId(sourceSession.task))
        : undefined)

    const forkTask: Session['task'] = sourceSession.task.kind === 'none'
      ? { kind: 'none' }
      : { kind: 'new' }
    if (forkTask.kind === 'new' && sourceTask) forkTask.parentTaskId = sourceTask.parentId ?? sourceTask.id
    const forkedSession = makeSession(this.settings, {
      agentSessionId: sourceSession.agentSessionId,
      forked: true,
      forkExcludeLatestTurn: sourceIsRunning && inFlightFrom !== -1,
      forkedFromSessionId: sourceSession.agentSessionId,
      messages: [...copiedMessages, forkInfoMsg],
      additionalDirs: [...sourceSession.additionalDirs],
      // A fork runs exactly where its source does.
      run: {
        ...sourceSession.run,
        modelConfig: { ...sourceSession.run.modelConfig },
        gitContext: sourceSession.run.gitContext ? { ...sourceSession.run.gitContext } : null,
        sessionSkills: [...sourceSession.run.sessionSkills],
      },
      pluginCommands: this.pluginCommands,
      // A fork hangs under its source's top-level task until its own subtask is
      // minted at first dispatch — unless the source opted out of tasks entirely.
      task: forkTask,
    })

    forkedSession.title = `Fork: ${originalTitle}`
    const forkTab = makeTab(forkedSession.id, { id: tabId })

    this.sessions[forkedSession.id] = forkedSession
    this.tabs[forkTab.id] = forkTab
    this.addTabToOrder(forkTab.id)
    if (options.activate !== false) {
      this.setActiveTab(forkTab.id)
      this.resetOverlays()
    }
    await this.environment.refreshEnvironment(this, { sourceId: tabId })
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
    const forked = this.sessionFor(forkTabId)!
    forked.prompt.text = draft
    this.openSplitChat(forked.id)
    requestInputFocus({ tabId: forkTabId })
  }

  /** Move a live session into a fresh git worktree. Creates the worktree now (so
   *  the branch name and git panel update immediately), then flags the session to
   *  fork on its next prompt — that fork re-homes the conversation's transcript
   *  under the worktree, so the session truly lives there. Same tab, same history. */
  async continueInWorktree(tabId: string, via: Via = 'click'): Promise<void> {
    void via
    const session = this.sessionFor(tabId)
    if (!session?.agentSessionId || session.run.gitContext?.worktreePath || this.ui.isContinuingInWorktree(tabId)) return

    const firstUser = session.messages.find((m) => m.role === 'user')
    const namePrompt = firstUser?.content.slice(0, 200) ?? ''

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
        toasts.error("Couldn't create worktree", { description: result.error })
        return
      }

      // Keep agentSessionId as the fork source; forked=true makes the next run resume
      // it with --fork-session in the worktree cwd (see control-plane dispatch).
      session.run.gitContext = result.gitContext
      session.run.worktree = null
      const projectRoot = worktreeProjectRoot(result.gitContext.worktreePath ?? session.run.workingDirectory)
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
    // Selecting is also the user's explicit request to see this transcript.
    // Retry even when this is already active behind a draft/page: setActiveTab
    // does not run in that branch, and a failed boot hydration must not strand
    // the conversation as an empty composer for the renderer lifetime.
    prioritizeTabHydration(this, tabId)
    if (tabId === this.splitChatTabId) {
      const paneId = this.splitChatPaneId
      if (paneId) this.router.focusPane(paneId)
      const secondarySession = this.sessionFor(tabId)
      if (secondarySession) void this.refreshPluginCommands(secondarySession.run.workingDirectory, tabId)
      requestInputFocus({ tabId })
      track('tab_selected', { via })
      return
    }
    const tab = this.tabs[tabId]
    const session = this.sessionFor(tabId)
    const previousTabId = this.activeTabId
    if (tabId === this.activeTabId) {
      // Selecting the tab already active is the pill's expand/collapse toggle —
      // unless something is covering its conversation, in which case the click
      // is asking to see it rather than to put the pill away.
      if (this.showsConversation) this.isExpanded = !this.isExpanded
      else this.resetOverlays({ closeArtifact: true })
      if (this.isExpanded && tab) {
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
        logDevSessionState(`tab-switch:${previousTabId}->${tabId}`, session)
      }
    }
    if (session?.run.provider && this.settings.activeAgent !== session.run.provider) {
      this.config.followActiveSessionAgent(session.run.provider)
    }
    if (session) void this.refreshPluginCommands(session.run.workingDirectory, tabId)
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
    this.openSplitChat(tab.sessionId)
    track('tab_split_opened', {})
    requestInputFocus({ tabId })
  }

  /** Pin a conversation into a companion pane beside the leading one. The pane
   *  is addressed by session; which tab renders it is resolved on the way out.
   *  The split pane is already the narrow half, so it starts without its project
   *  rail — the user opens it deliberately from there. */
  openSplitChat(sessionId: string): void {
    // The route is persisted and restored: it must name the session's host or
    // a restore resolves the bare id against whichever host answers first.
    this.router.navigate(
      chatRoute(sessionId, this.sessions[sessionId]?.run.serverId),
      { target: 'aside' },
    )
    if (this.settings.splitProjectPanelOpen) this.settings.update({ splitProjectPanelOpen: false })
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
    if (splitSession.run.provider && this.settings.activeAgent !== splitSession.run.provider) {
      this.config.followActiveSessionAgent(splitSession.run.provider)
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
        serverId: sess.run.serverId,
        provider: sess.run.provider ?? this.settings.activeAgent,
        cwd: sess.run.workingDirectory,
        title: sess.title ?? null,
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
      run: {
        serverId: this.fallbackServerId,
        taskServerId: this.fallbackServerId,
        workingDirectory,
        gitContext: inheritedGitContext ? { ...inheritedGitContext } : null,
        worktree: inheritedWorktreeBaseBranch ? { baseBranch: inheritedWorktreeBaseBranch } : null,
        modelConfig: { ...this.globalDefaults.modelConfig },
        permissionMode: this.globalDefaults.permissionMode,
      },
    })
    const tabId = uuid()
    // Hand the tab-less composer off to the first tab, then reset it.
    // The prompt written with no tab selected becomes this session's own.
    session.prompt = this.activeInput
    const tab = makeTab(session.id, { id: tabId })
    this.activeInput = makePrompt()
    this.sessions[session.id] = session
    this.tabs[tab.id] = tab
    this.addTabToOrder(tab.id)
    this.setActiveTab(tab.id)
    this.resetOverlays()
    if (inheritedGitContext) {
      this.config.applyGlobalStartTarget({ gitContext: null, worktreeBaseBranch: null })
    }
    void this.environment.refreshEnvironment(this, {
      sourceId: tabId,
      worktreeRequested: !!inheritedWorktreeBaseBranch || this.settings.worktreeEnabled,
    })
    void this.refreshPluginCommands(workingDirectory)
    return tabId
  }

  closeTab(tabId: string, via: Via = 'click'): void {
    const serverId = this.sessionFor(tabId)?.run.serverId
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

    // Clean up the session once nothing is watching it any more. Only this —
    // the user closing the last view — unwatches; a dropped socket does not.
    if (sessionId && this.tabIdsForSession(sessionId).length === 0) {
      void this.apiFor(tabId).unwatchSession(sessionId).catch(() => {})
      this.lifecycle.disposeSession(sessionId)
      this.eventReducer.clearStreamingText(sessionId)
      delete this.sessions[sessionId]
    }
    if (serverId && !this.tabOrder.some((id) => id !== tabId && this.sessionFor(id)?.run.serverId === serverId)) {
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
    removePersistedTab(tabId, this.activeTabId)
    track('tab_closed', { via })
    // Closing the last tab lands on the draft you would have opened next, so no
    // surface has to describe a workspace with nothing in it.
    if (this.tabOrder.length === 0 && this.router.leadingPane.base?.name !== 'draft') {
      this.openSessionDraft({ via })
    }
  }

  /** Clear a conversation and remove its tab, then keep the focused pane on the
   *  dedicated draft surface. The draft is created first so it inherits the
   *  session's project and run configuration before the tab is removed. */
  clearTabToDraft(tabId: string, via: Via = 'click'): void {
    const draft = this.openSessionDraft({ via, sourceTabId: tabId })
    this.clearTab(tabId)
    this.closeTab(tabId, via)
    // Closing a split tab also closes its pane. Reopen the inherited draft in
    // whichever pane now owns focus; leading-pane clears are already a no-op.
    this.openDraft(draft.id, via)
  }

  clearTab(tabId?: string): void {
    const targetTabId = tabId ?? this.activeTabId
    this.apiFor(targetTabId).resetSession(this.ctxFor(targetTabId))
    const session = this.sessionFor(targetTabId)
    if (!session) return
    session.agentSessionId = null
    session.handoffId = undefined
    session.run.provider = null
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
    if (session.run.gitContext?.worktreePath) session.run.worktree = null
    session.title = 'New Tab'
    session.titleCustom = false
    this.metadataFinalizedTabs.delete(targetTabId)
    this.clearStreamingText(session.id)
    if (session.run.workingDirectory && !session.run.gitContext) {
      void this.environment.refreshEnvironment(this, { sourceId: targetTabId })
    }
  }

  async resumeSession(
    meta: SessionMeta,
    opts?: { background?: boolean; intoTabId?: string },
  ): Promise<string> {
    // A session ref crossing the client names its host — there is no probe.
    if (!meta.serverId) throw new Error(`Session ${meta.sessionId} names no host`)
    const selectedProvider = meta.provider ?? this.settings.activeAgent
    const selectedApi = serverConnections.apiFor(meta.serverId)
    const handoff = await selectedApi.resolveSessionLineage(selectedProvider, meta.sessionId)
    const stableSessionId = handoff?.sessionId ?? meta.sessionId
    const activeMember = handoff?.active
    let activeProviderSessionId: string | null = meta.sessionId
    if (activeMember?.providerSessionId) {
      const activeMeta = await selectedApi.getSessionInfo(activeMember.providerSessionId)
      if (!activeMeta) throw new SessionUnavailableError(activeMember.providerSessionId)
      meta = {
        ...meta,
        ...activeMeta,
        provider: activeMember.provider,
        sessionId: activeMember.providerSessionId,
        cwd: activeMember.cwd,
        serverId: meta.serverId,
      }
      activeProviderSessionId = activeMember.providerSessionId
    } else if (activeMember) {
      meta = { ...meta, provider: activeMember.provider, cwd: activeMember.cwd }
      activeProviderSessionId = null
    } else {
      const sourceMeta = await selectedApi.getSessionInfo(meta.sessionId)
      if (!sourceMeta) throw new SessionUnavailableError(meta.sessionId)
      meta = { ...meta, ...sourceMeta, serverId: meta.serverId }
    }
    const background = opts?.background ?? false
    const intoTabId = opts?.intoTabId
    const provider = meta.provider ?? this.settings.activeAgent
    if (!intoTabId) {
      const openTabId = findOpenTabForSession(
        stableSessionId,
        this.tabs,
        this.sessions,
        this.tabOrder,
        provider,
        meta.serverId,
      )
      if (openTabId) {
        if (!background) {
          if (openTabId === this.activeTabId) {
            this.isExpanded = true
            // Already the active tab, so nothing switches — but a draft or page
            // may still be sitting over the conversation being asked for.
            this.resetOverlays({ closeArtifact: true })
          } else this.selectTab(openTabId)
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
        // A session never moves between machines: resuming one the picker found
        // on another host has to open against that host, not this client's.
        serverId: meta.serverId,
      })
      const session = this.sessionFor(tabId)
      const tab = this.tabs[tabId]
      if (!session || !tab) throw new Error('The resumed session tab was not created')
      session.run.provider = provider
      session.agentSessionId = activeProviderSessionId
      session.handoffId = handoff?.sessionId
      session.readOnlyReason = null
      session.loadingHistory = true
      session.title = title
      session.titleCustom = !!meta.customTitle
      if (shouldActivate) {
        if (!background) this.isExpanded = true
        if (this.settings.activeAgent !== provider) {
          this.config.followActiveSessionAgent(provider)
        }
      }
    } else {
      const session = targetSession!
      session.run.provider = provider
      session.agentSessionId = activeProviderSessionId
      session.handoffId = handoff?.sessionId
      // Taking over an empty tab moves it to the session's host. Safe only
      // because takeover already requires a tab that has started nothing.
      if (meta.serverId) session.run.serverId = meta.serverId
      session.run.workingDirectory = workingDirectory
      session.messages.splice(0, session.messages.length)
      this.eventReducer.rebuildAgentConversations(session)
      session.readOnlyReason = null
      session.run.gitContext = null
      session.loadingHistory = true
      session.title = title
      session.titleCustom = !!meta.customTitle

      if (!background && !intoTabId) {
        this.setActiveTab(targetTab!.id)
        this.isExpanded = true
        if (this.settings.activeAgent !== provider) {
          this.config.followActiveSessionAgent(provider)
        }
      }
    }
    if (!background && !intoTabId) {
      this.resetOverlays()
    }

    // Main is authoritative on session identity. This client read the provider
    // thread off disk and minted a local id for it; if another client already
    // has that thread open, main answers with *its* id and we adopt it. Without
    // this the two clients hold different addresses for one session and "one id"
    // is only true within a client. Must happen before the bind, which sends the
    // id we are claiming — but nothing else here waits on identity, so the watch
    // and the bind are one chain running beside the reads rather than ahead of
    // them.
    const runtimeAttach = this.apiFor(tabId).watchSession({
      sessionId: stableSessionId,
      agentSessionId: activeProviderSessionId ?? undefined,
      provider,
    })
      .then(({ sessionId }) => this.adoptSessionId(tabId, sessionId))
      .catch(() => null)
      .then(() => this.attachRuntimeSession(tabId))

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
      return s && s === resumingSession ? s : null
    }

    try {
      const api = this.apiFor(tabId)
      const [identity, transcript] = await Promise.all([
        api.gitIdentity
          ? api.gitIdentity(defaultDir).catch(() => null)
          : Promise.resolve(null),
        loadSessionTranscript(this, {
          sessionId: stableSessionId,
          loadPath: meta.projectPath || defaultDir,
          displayCwd: workingDirectory,
          provider,
          ctx: this.ctxFor(tabId),
          limit: RESTORED_TRANSCRIPT_LIMIT,
        }),
        runtimeAttach,
        this.tasksStore.ensureSessionBinding(stableSessionId, this.runFor(tabId)?.taskServerId).catch(() => null),
      ])

      const session = currentResumeTarget()
      if (session) {
        // `gitIdentity` returning null means non-git dir (or a worktree whose
        // checkout is gone); `gitCheckoutFromState` yields null and the
        // background worktree restore below applies the read-only fallback.
        const gitContext = gitCheckoutFromState(identity, worktreePath)
        session.run.gitContext = gitContext
        if (gitContext) session.readOnlyReason = null
        // Paint before registering the environment: the transcript is in hand,
        // and nothing below changes what the conversation renders. Clearing the
        // spinner here rather than in the `finally` keeps a round trip the reader
        // cannot see off the front of the first frame.
        session.messages.splice(0, session.messages.length, ...transcript.messages)
        this.eventReducer.rebuildAgentConversations(session)
        session.progress = transcript.progress
        session.historyTruncated = transcript.truncated
        session.loadingHistory = false
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
            restoredSession.run.gitContext = restoredGitContext
            restoredSession.readOnlyReason = null
            environmentRefresh = this.environment.refreshEnvironment(this, { sourceId: tabId, level: 'full' })
          } else if (isSolusWorktreePath(defaultDir)) {
            restoredSession.run.gitContext = null
            restoredSession.readOnlyReason = 'This session is read-only because its worktree no longer exists.'
          } else {
            environmentRefresh = this.environment.refreshEnvironment(this, { sourceId: tabId, level: 'full' })
          }

          this.recomputeChangedFiles(tabId)
          this.onTurnSettled?.(tabId, this.sessionFor(tabId)?.run.workingDirectory ?? null)
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
    const modelConfig = session?.run.modelConfig ?? this.globalDefaults.modelConfig
    const modelChanged = 'modelId' in patch && patch.modelId !== modelConfig.modelId
    this.config.updateModelConfig(patch, tabId)
    if (modelChanged) track('model_changed', { via })
  }

  switchActiveAgent(agentId: AgentId, tabId?: string, via: Via = 'click'): Promise<void> {
    return this.config.switchActiveAgent(agentId, tabId, via)
  }

  setDefaultAgent(agentId: AgentId, via: Via = 'click'): void {
    this.config.setDefaultAgent(agentId, via)
  }

  setPermissionMode(mode: 'ask' | 'auto' | 'plan', tabId?: string, via: Via = 'click'): void {
    this.config.setPermissionMode(mode, tabId)
    track('permission_mode_set', { mode, via })
  }

  setWorktreeBaseBranch(branch: string | null): void {
    this.config.setWorktreeBaseBranch(branch)
  }

  setDispatchWorktree(worktree: WorktreeEntry | null, sourceId?: string): void {
    this.config.setDispatchWorktree(worktree, sourceId)
  }

  setDispatchBaseBranch(branch: string, sourceId?: string): void {
    this.config.setDispatchBaseBranch(branch, sourceId)
  }

  syncWorktreeDefault(enabled: boolean): void {
    this.config.syncWorktreeDefault(enabled)
  }

  toggleWorktreeMode(tabId?: string, via: Via = 'click'): void {
    const previousSession = tabId ? this.sessionFor(tabId) : this.activeSession
    const wasEnabled = previousSession ? !!previousSession.run.worktree : this.settings.worktreeEnabled
    this.config.toggleWorktreeMode(tabId)
    const session = tabId ? this.sessionFor(tabId) : this.activeSession
    const enabled = session ? !!session.run.worktree : this.settings.worktreeEnabled
    if (enabled !== wasEnabled) track('worktree_mode_toggled', { enabled, via })
  }

  async switchToWorktree(worktreePath: string, sourceId?: string, via: Via = 'click'): Promise<void> {
    await this.config.switchToWorktree(worktreePath, sourceId)
    track('worktree_switched', { via })
  }

  async setBaseDirectory(dir: string, sourceId?: string): Promise<void> {
    return this.config.setBaseDirectory(dir, sourceId)
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
    const promptSession = this.sessionFor(tabId)
    const watchedSessionId = promptSession?.id
    if (!promptSession || !watchedSessionId) return
    // Durability before dispatch (dispatch-client step 6): the send is queued
    // on the session's host before the wire is trusted with it. Acceptance
    // removes it; a dead transport leaves it for the drain.
    const outboxServerId = promptSession.run.serverId
    if (options.clientPromptId) {
      sendOutbox.enqueue(outboxServerId, {
        clientPromptId: options.clientPromptId,
        sessionId: watchedSessionId,
        text: options.displayPrompt,
        enqueuedAt: Date.now(),
        payload: {
          prompt: options.prompt,
          displayPrompt: options.displayPrompt,
          delivery: options.delivery,
          imageAttachments: options.imageAttachments,
        },
      })
    }
    // Watch before prompting, or the run's own events would have nowhere to go.
    api.watchSession({ sessionId: watchedSessionId })
      .then(() => this.config.pendingSessionStartTarget(tabId))
      .then(async () => {
        if (options.taskId) {
          try {
            await this.tasksStore.recordActivity(options.taskId)
          } catch (error) {
            console.warn('[Solus] Task activity update failed; the prompt will still send.', error)
          }
        }
      })
      .then(() => this.resolveTaskOnItsHost(tabId, options))
      .then((resolved) => {
        // Guard: user may have interrupted between the watch resolving and this
        // tick. If so, Stop already fired before prompt — skip submission to
        // avoid a phantom run that can never be cancelled.
        const session = this.sessionFor(tabId)
        if (!session) return
        return api.prompt(this.ctxFor(tabId), resolved).then(() => {
          // The host accepted the prompt: its durable copy has done its job.
          if (options.clientPromptId) sendOutbox.remove(outboxServerId, options.clientPromptId)
        })
      })
      .catch((err: Error) => {
        const session = this.sessionFor(tabId)
        if (options.clientPromptId) {
          if (classifySendFailure(err) === 'transient') {
            // The transport died under the send: the outbox entry stays for
            // the drain, and the pending bubble keeps standing — "failed"
            // would be a lie about a message that will still deliver.
            return
          }
          // The host answered "no": the in-session failed prompt owns the
          // retry UX, so the durable copy retires with the error shown there.
          sendOutbox.remove(outboxServerId, options.clientPromptId)
          const outbound = session?.outboundPrompts.find(
            (prompt) => prompt.clientPromptId === options.clientPromptId,
          )
          if (outbound) {
            outbound.state = 'failed'
            outbound.error = err.message
          }
        }
        if (session) {
          this.handleError(session.id, { message: err.message, stderrTail: [], exitCode: null, elapsedMs: 0, toolCallCount: 0 })
        }
      })
  }

  /** Replay one drained outbox record through the live prompt path. The tab
   *  must still be mounted — a queued send for a closed conversation is
   *  abandoned work, not a surprise message. */
  async redeliverOutboxPrompt(serverId: string, record: OutboxRecord): Promise<void> {
    const tabId = this.tabIdForSession(record.sessionId)
    if (!tabId || !record.payload) {
      sendOutbox.remove(serverId, record.clientPromptId)
      return
    }
    const result = await this.apiFor(tabId).prompt(this.ctxFor(tabId), {
      prompt: record.payload.prompt,
      displayPrompt: record.payload.displayPrompt || record.text,
      clientPromptId: record.clientPromptId,
      delivery: record.payload.delivery === 'steer' ? 'steer' : 'queue',
      imageAttachments: record.payload.imageAttachments,
    })
    if (result.disposition === 'duplicate') return
  }

  /**
   * Mint or bind this prompt's task on the host that owns the project, then hand
   * the execution host the resulting id with minting switched off.
   *
   * The two hosts are the same machine for ordinary work, and this is a no-op
   * beyond one extra call. They differ for a dispatch — and there, letting the
   * execution host mint (as it did when minting was a side effect of the prompt
   * landing) files the task in a database nobody is reading, on a machine the
   * user only borrowed to run an agent.
   *
   * A failure here is not allowed to swallow the prompt: the send proceeds
   * untouched, and the execution host mints as before.
   */
  private async resolveTaskOnItsHost<T extends { prompt: string; taskId?: string; parentTaskId?: string; skipTaskCreation?: boolean; taskSnapshot?: TaskSnapshot }>(
    tabId: string,
    options: T,
  ): Promise<T> {
    const session = this.sessionFor(tabId)
    if (!session || options.skipTaskCreation) return options
    // A session with a provider thread is past its first dispatch and outside
    // automatic minting, which is the host's own no-backfill rule. A dispatched
    // one still needs its packet re-shipped: the execution host cannot read the
    // task host's store, so every prompt carries the task's live state.
    if (session.agentSessionId) {
      return isDispatch(session.run) ? this.attachTaskSnapshot(session, options) : options
    }
    const environment = this.environment.environmentFor(session.run)
    try {
      const { task, snapshot } = await this.tasksStore.prepareForSession(session.run.taskServerId, {
        existingTaskId: options.taskId ?? null,
        parentTaskId: options.taskId ? null : options.parentTaskId ?? null,
        projectKey: environmentProjectKey(environment, session.run.projectGroupPath),
        worktreeKey: environment.worktreePath ?? null,
        prompt: options.prompt,
        branch: environment.branch ?? null,
        includeSnapshot: isDispatch(session.run),
      })
      if (!task) return options
      let preparedSnapshot = snapshot
      if (session.prReview) {
        try {
          await this.tasksStore.link(task.id, {
            kind: 'pr',
            targetScope: task.projectKey ?? environmentProjectKey(environment, session.run.projectGroupPath),
            targetKey: String(session.prReview.number),
            title: `#${session.prReview.number} ${session.prReview.title}`,
            createdBy: 'system',
          })
          // The first snapshot was read in the minting transaction, before the
          // PR edge existed. A dispatched run must ship the linked version.
          if (snapshot) {
            preparedSnapshot = await this.tasksStore.snapshotForDispatch(session.run.taskServerId, task.id)
          }
        } catch (error) {
          console.warn('[Solus] PR task link failed; the prompt will still send.', error)
        }
      }
      // Record the binding on the session so `session_init` — the first moment a
      // session id exists — knows which task to link it to, and on which host.
      session.task = { kind: 'existing', taskId: task.id }
      const prepared: typeof options = {
        ...options,
        taskId: task.id,
        parentTaskId: undefined,
        skipTaskCreation: true,
      }
      if (preparedSnapshot) prepared.taskSnapshot = preparedSnapshot
      return prepared
    } catch (error) {
      console.warn('[Solus] Task host mint failed; the run host will mint instead.', error)
      return options
    }
  }

  /** Re-ship a dispatched session's task state with a follow-up prompt. Best
   *  effort: a failure means the packet goes stale for one turn, never that the
   *  send is swallowed. */
  private async attachTaskSnapshot<T extends { taskId?: string; taskSnapshot?: TaskSnapshot }>(
    session: Session,
    options: T,
  ): Promise<T> {
    if (session.task.kind !== 'existing') return options
    try {
      const snapshot = await this.tasksStore.snapshotForDispatch(session.run.taskServerId, session.task.taskId)
      return snapshot ? { ...options, taskId: session.task.taskId, taskSnapshot: snapshot } : options
    } catch (error) {
      console.warn('[Solus] Task snapshot refresh failed; the packet stays stale this turn.', error)
      return options
    }
  }

  /** Sends to the active tab unless `tabId` targets another one (the split
   *  conversation pane's composer). */
  sendMessage(
    prompt: string,
    projectPath?: string,
    tabId?: string,
    delivery: PromptDelivery = 'steer',
  ): boolean {
    // The workspace seeds a composer at boot and after the last close, so this
    // holds only in the window before that lands. It repairs the invariant
    // rather than describing a second way to start a session.
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
      localApi.getPlatform() === 'web'
      && !serverConnections.defaultServerId()
      && !session.run.pendingHostDispatch
    ) {
      window.dispatchEvent(new CustomEvent('solus:open-server-connect'))
      toasts.info('Connect a host to start working')
      return false
    }

    const resolvedPath = projectPath || session.run.workingDirectory
    if (
      !session.run.pendingHostDispatch
      && session.run.serverId !== LOCAL_SERVER_ID
      && (!resolvedPath || resolvedPath === '~')
    ) {
      toasts.error('Choose a project on the remote host before sending')
      return false
    }

    if (session.run.pendingHostDispatch) {
      // Host checkout can take several seconds. The turn starts when the user
      // sends, not when that preparation eventually produces a provider echo.
      session.currentTurnStartedAt = Date.now()
      session.status = 'connecting'
      void this.prepareHostDispatchAndSend(targetTabId, prompt, projectPath, delivery)
      return true
    }

    const isBusy = isSessionBusyStatus(session.status)
    const input = session.prompt

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

    const title = session.messages.length === 0 && !session.titleCustom
      ? (prompt.length > 80 ? prompt.substring(0, 80) : prompt)
      : session.title

    if (resolvedPath !== session.run.workingDirectory) {
      session.run.workingDirectory = resolvedPath
    }
    if (session.messages.length === 0 && resolvedPath && resolvedPath !== '~') {
      void this.apiFor(targetTabId).trackRecentProject(resolvedPath)
      const catalogRoot = session.run.gitContext?.repoRoot ?? resolvedPath
      projectCatalog.record(
        { serverId: session.run.serverId, projectRoot: catalogRoot },
        projectDirLabel(catalogRoot, this.staticInfo?.workspacePath),
      )
    }

    session.run.provider = session.run.provider ?? this.settings.activeAgent

    const isFirstMessage = session.messages.length === 0
    const agent = session.run.provider ?? this.settings.activeAgent
    if (isFirstMessage) track('conversation_started', { agent })
    track('message_sent', { agent, is_first_message: isFirstMessage, permission_mode: session.run.permissionMode, attachment_count: input.attachments.length, image_count: imageAttachments.length, plan_ref_count: planRefs?.length ?? 0, work_ref_count: workRefs?.length ?? 0, session_ref_count: sessionRefs?.length ?? 0, has_slash_command: prompt.startsWith('/'), delivery: isBusy ? (isSteerableStatus(session.status) && delivery === 'steer' ? 'steer' : 'queue') : 'immediate', is_remote_host: session.run.serverId !== LOCAL_SERVER_ID })

    if (isBusy) {
      session.title = title
      const outbound: OutboundPrompt = {
        clientPromptId,
        text: prompt,
        state: isSteerableStatus(session.status) && delivery === 'steer' ? 'steering' : 'queueing',
        enqueuedAt: Date.now(),
      }
      if (imageAttachments.length > 0) outbound.images = imageAttachments
      if (attachments) outbound.attachments = attachments
      if (planRefs) outbound.planRefs = planRefs
      if (workRefs) outbound.workRefs = workRefs
      if (sessionRefs) outbound.sessionRefs = sessionRefs
      session.outboundPrompts.push(outbound)
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
      session.title = title
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

    const promptTaskId =
      existingTaskId(session.task) ??
      this.tasksStore.taskForSession(taskBindingSessionId(session))?.id ??
      undefined
    this.promptTab(targetTabId, {
      prompt: fullPrompt,
      displayPrompt: prompt,
      clientPromptId,
      delivery,
      imageAttachments,
      taskId: promptTaskId,
      // Only until the fork's own subtask exists — the two are mutually exclusive.
      parentTaskId: existingTaskId(session.task) || this.tasksStore.taskForSession(taskBindingSessionId(session))
        ? undefined
        : parentTaskId(session.task) ?? undefined,
      skipTaskCreation: session.task.kind === 'none' || undefined,
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
    const pending = session?.run.pendingHostDispatch
    if (!tab || !session || !pending) return
    const attempt = (this.hostDispatchAttempts.get(tabId) ?? 0) + 1
    this.hostDispatchAttempts.set(tabId, attempt)
    const superseded = () =>
      this.hostDispatchAttempts.get(tabId) !== attempt || this.sessionFor(tabId) !== session
    const bailIfStale = (): boolean => {
      if (superseded()) return true
      if (session.status === 'connecting' && session.run.pendingHostDispatch === pending) return false
      // The user withdrew this send (Stop, or a replaced pick); this attempt still
      // owns the tab's dispatch UI, so it also cleans it up and returns the prompt.
      session.statusCard = null
      if (!session.prompt.text) session.prompt.text = prompt
      return true
    }
    let activeStep: 'connection' | 'repository' = 'connection'
    // Named from the connection registry rather than from a label copied at pick
    // time, which goes stale the moment that host is renamed. Falls back to the
    // id, which is all there is to say about a host that cannot be resolved.
    let hostLabel = pending.serverId
    let isLocalHost = false
    requestConversationScrollToBottom(tabId)

    try {
      // Synchronous and idempotent, so the card below still paints before any
      // awaiting — and it is what knows this host's name.
      const connection = serverConnections.ensure(pending.serverId)
      const selectedDispatchBaseBranch = pending.intent === 'dispatch' ? pending.baseBranch : undefined
      hostLabel = connection.target.label
      isLocalHost = connection.target.local
      session.statusCard = buildRemoteDispatchCard({ tabId, hostLabel, phase: 'connecting' })
      await connection.api.connectionsGetServerInfo()
      if (bailIfStale()) return
      // Only a dispatch has a repository to prepare. An opened project is
      // already on disk over there, so its path is the one the picker chose and
      // the card skips a step it would only ever report as instantly done.
      let path = session.run.workingDirectory
      if (pending.intent === 'dispatch') {
        activeStep = 'repository'
        session.statusCard = buildRemoteDispatchCard({ tabId, hostLabel, phase: 'repository' })
        const prepared = await prepareHostCheckout(
          {
            target: connection.api,
            local: serverConnections.apiFor(LOCAL_SERVER_ID),
          },
          pending.serverId,
          pending.repoKey,
          pending.worktree?.path,
          selectedDispatchBaseBranch,
        )
        if (bailIfStale()) return
        path = prepared.path
      }
      session.statusCard = buildRemoteDispatchCard({ tabId, hostLabel, phase: 'ready' })
      const result = moveTabToHost({
        workspace: this,
        tabId,
        serverId: pending.serverId,
        isLocalHost,
        path,
        repoKey: pending.intent === 'dispatch' ? pending.repoKey : null,
        intent: pending.intent,
      })
      if (!result.ok) throw new Error('The selected host has no usable checkout.')
      session.run.pendingHostDispatch = null
      await result.refreshStartTarget
      if (superseded()) return
      if (session.status !== 'connecting') {
        // Interrupted after the move already landed: keep the move, drop the send.
        session.statusCard = null
        if (!session.prompt.text) session.prompt.text = prompt
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
        hostLabel,
        phase: activeStep === 'connection' ? 'connecting' : 'repository',
        error: { step: activeStep, message },
      })
      if (!session.prompt.text) session.prompt.text = prompt
      requestInputFocus({ tabId })
    }
  }

  /** Read where a source will start, from the host that holds the directory.
   *  A tab moved to another machine and a draft opened on one arrive the same
   *  way — pointed at a path nothing here has read yet. */
  refreshStartTarget(sourceId: string, path: string, worktree: boolean): Promise<void> {
    // `worktree` is the run's own answer, which already folds in the saved
    // preference — so it is taken as final. Or-ing the preference back in here
    // would overrule a run that explicitly declined isolation.
    return this.config.refreshSessionStartTarget(sourceId, path, worktree)
  }

  retryLastMessage(tabId: string): void {
    const session = this.sessionFor(tabId)
    if (!session) return
    if (session.status === 'connecting') return
    if (session.readOnlyReason) return

    if (session.status === 'rate_limited' && session.outboundPrompts.some((prompt) => prompt.state === 'queued' && prompt.reason === 'rate_limit')) {
      sendRateLimitedNow(this.apiFor(tabId), this.ctxFor(tabId), true, (err) => this.handleError(session.id, err))
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
    session.run.provider = session.run.provider ?? this.settings.activeAgent
    session.latestCheckpointId = null
    session.progress = null
    session.retryAttempt = (session.retryAttempt ?? 1) + 1
    session.terminalFailure = null

    const retry = this.apiFor(tabId).retry(this.ctxFor(tabId), { prompt: lastUserMsg.content })

    retry.catch((err: Error) => {
      this.handleError(session.id, { message: err.message, stderrTail: [], exitCode: null, elapsedMs: 0, toolCallCount: 0 })
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

  handleNormalizedEvent(sessionId: string, event: WireNormalizedEvent): void {
    this.eventReducer.apply(sessionId, event)
  }

  interruptSession(sessionId: string, opts: { notice?: boolean } = {}): void {
    // A visible stop is the user putting this goal on hold. Internal handoffs
    // pass `notice: false` because the work is continuing in another session.
    if (opts.notice !== false) this.goalSync.pauseForInterrupt(sessionId)
    this.eventReducer.interruptSession(sessionId, opts)
    track('session_interrupted', {})
  }

  /** Stop whatever conversation a tab is showing. The tab is how the user
   *  pointed at it; the session is what gets interrupted. */
  interruptTabSession(tabId: string, opts: { notice?: boolean } = {}): void {
    const sessionId = this.tabs[tabId]?.sessionId
    if (sessionId) this.interruptSession(sessionId, opts)
  }

  handleError(sessionId: string, error: EnrichedError): void {
    this.eventReducer.handleError(sessionId, error)
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
  notifySessionUnavailable(provider?: AgentId): void {
    toasts.error('Session no longer available', {
      description: unavailableSessionMessage(provider),
    })
  }

  /** Open a work as an artifact. By default it takes the Focus pane (or the
   *  secondary slot if one is already open); `secondary: true` forces it beside
   *  the conversation in the secondary pane (used by the project panel). */
  async openWorkModal(workId: string, title?: string, opts: { secondary?: boolean; via?: Via } = {}): Promise<void> {
    const cwd = this.sessionFor(this.activeTabId)?.run.workingDirectory
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
    this.router.navigate({ name: 'work', params: { workId } }, { target: this.artifactTarget(target) })
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
    const cwd = sess?.run.workingDirectory ?? this.globalDefaults.workingDirectory ?? '~'
    const provider: AgentId = sess?.run.provider ?? 'claude-code'
    const api = sess ? this.apiFor(this.activeTabId) : this.defaultHostApi()
    const work = await api.createWork(title, type, content, workPreview(type, content), undefined, provider, cwd)
    this.worksStore.works[work.id] = work
    this.worksStore.rememberHost(work.id, sess?.run.serverId ?? serverConnections.serverIdForApi(api))
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
    void this.worksStore.ensureContent(workId, 'open-chat-for-work', this.sessionFor(this.activeTabId)?.run.workingDirectory)
    if (mode === 'resume' && resumeSid) {
      // find an open tab with this session on the work's own host, else resume
      const openTab = this.tabIdForAgentSession(resumeSid, this.worksStore.hostFor(workId) ?? undefined)
      if (openTab) { this.selectTab(openTab); targetTabId = openTab; resumed = true }
      else {
        targetTabId = await this.resumeSession({
          serverId: this.worksStore.hostFor(workId) ?? undefined,
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
          this.worksStore.linkSession(s.run.workingDirectory, workId, s.agentSessionId)
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

  private showPage(ref: RouteRef, via: Via, surface: SolusEventMap['surface_viewed']['surface']): void {
    // A page that is already open is replaced where it lives (exclusivity);
    // a page opening for the first time covers the conversation rather than
    // taking over whichever companion pane happens to hold focus.
    this.router.navigate(ref, { via, target: this.router.leadingPane.id })
    this.isExpanded = true
    track('surface_viewed', { surface, via })
  }

  private togglePage(ref: RouteRef, via: Via, surface: SolusEventMap['surface_viewed']['surface']): boolean {
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
    this.router.navigate(
      { name: 'plan', params: { planId, serverId: this.planStore.hostFor(planId) ?? undefined } },
      { target: this.artifactTarget(target) },
    )
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
    const link = links?.[links.length - 1]
    if (!link?.sessionId) return void this.openTaskSession(task)

    const ownerServerId = await this.tasksStore.ownerHostForTask(task.id)
    if (!ownerServerId) return
    const sessionServerId = serverConnections.resolveId(link.executionServerId ?? ownerServerId)
    const openTab = findOpenTabForSession(
      link.sessionId,
      this.tabs,
      this.sessions,
      this.tabOrder,
      undefined,
      sessionServerId,
    )
    if (openTab) this.selectTab(openTab)
    else {
      // The task link stores a session id, not its agent backend. Resolve the
      // indexed record before resuming instead of assigning whichever provider
      // happens to be selected now; loading a Claude transcript through Codex
      // (or vice versa) returns an empty conversation.
      const meta = await readSessionMeta(sessionServerId, link.sessionId)
      if (meta) await this.resumeSession(meta)
    }
    this.router.closeGroup('page')
    requestInputFocus()
  }

  /** Open one task's page. Its own route, so it deep-links, joins history and
   *  can be opened in a split. */
  goToTask(taskId: string, via: Via = 'palette'): void {
    this.showPage(
      { name: 'task', params: { taskId, serverId: this.tasksStore.hostFor(taskId) ?? undefined } },
      via,
      'tasks',
    )
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
    serverId = this.serverIdForContext(ctx),
  ): Promise<void> {
    if (this.window.viewMode !== 'editor') await this.window.setViewMode('editor')
    this.prsStore.beginReviewMode(items.map((item) => item.number), ctx, serverId)
    this.showPage({ name: 'reviewMode', params: {} }, 'click', 'review')
  }

  /** Single destination seam for review-attention entry points. */
  openNeedsReview(): void {
    const open = () => void this.openReviewMode(this.prsStore.needsReviewItems)
    if (this.prsStore.needsReviewItems.length > 0) open()
    else {
      const api = this.apiForContext(this.ctx)
      const serverId = serverConnections.serverIdForApi(api)
      void this.prsStore.refreshNeedsReview(api, serverId, this.ctx).then(open).catch((error) => {
      toasts.error("Couldn't load reviews", {
        description: error instanceof Error ? error.message : String(error),
      })
      })
    }
  }

  // ─── Automations page ───

  toggleAutomations(via: Via = 'click'): void {
    if (this.togglePage({ name: 'automations', params: {} }, via, 'automations')) {
      // Unscoped: the store fans out over every connected host (dispatch-client
      // step 5 — the page aggregates the catalog, not the boot host).
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
  openAutomationBuilder(
    automationId: string | null,
    target: 'focused' | 'aside' = 'focused',
    sourceId?: string,
  ): void {
    this.router.closeGroup('page')
    const serverId = sourceId ? this.runFor(sourceId)?.serverId : undefined
    const params: Extract<RouteRef, { name: 'automation' }>['params'] = { automationId }
    if (serverId) params.serverId = serverId
    this.router.navigate(
      { name: 'automation', params },
      { target: this.artifactTarget(target) },
    )
    this.isExpanded = true
    void this.automationsStore.loadAll(serverId)
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
      session.run.gitContext = gitContext ? { ...gitContext } : null
      session.run.worktree = null
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
    session.run.gitContext = { branch: pr.branch, targetBranch: pr.baseRef, worktreePath: pr.worktreePath }
    session.run.worktree = null
    session.run.permissionMode = 'auto'
    session.prReview = pr

    const prompt = buildPrCommentsFixPrompt(pr, feedback)
    this.sendMessage(prompt, undefined, tabId)
    if (session) session.title = `Fix PR #${pr.number}`
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
      ?? this.activeSession?.run.gitContext?.repoRoot
      ?? (this.activeSession?.run.workingDirectory && this.activeSession.run.workingDirectory !== '~'
        ? worktreeProjectRoot(this.activeSession.run.workingDirectory)
        : undefined)
    const tabId = await this.createTab(placeholderDir)
    const session = this.sessionFor(tabId)
    if (!session) return
    if (session) session.title = `Resolve #${pr.number}`
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
    const prepared = await this.apiForContext(actionCtx).prPrepareConflictResolution(actionCtx, pr.number).catch((err) => ({
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
    session.run.workingDirectory = worktreeProjectRoot(review.worktreePath)
    session.run.gitContext = { branch: review.branch, targetBranch: review.baseRef, worktreePath: review.worktreePath }
    session.run.worktree = null
    session.run.permissionMode = 'auto'
    session.prReview = review
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
  private prReviewRef(
    number: number,
    title: string | undefined,
    ctx: IpcContext,
    serverId: string,
    expectedRepo?: RouteRef<'prReview'>['params']['expectedRepo'],
  ): RouteRef<'prReview'> {
    return {
      name: 'prReview',
      params: {
        number,
        title,
        cwd: projectScopeOf(ctx.session) || undefined,
        serverId,
        expectedRepo,
      },
    }
  }

  /**
   * Open a PR review as the page. The route is entered before the (slow)
   * host detail request so the click gets a real surface rather than a blank pane;
   * the descriptor's `resolve` fills that same mounted surface in place when the
   * host target lands. Re-entering a PR already in the router's payload cache
   * skips the request entirely. Checkout is a later, action-specific operation.
   *
   * List selection replaces the list in the leading pane. A transcript link can
   * explicitly target the companion pane instead, so reading the conversation
   * remains uninterrupted. The review's own chrome owns later pane changes.
   */
  private async openPrReviewRoute(
    number: number,
    title: string | undefined,
    ctx: IpcContext,
    opts: {
      tab?: PrReviewTab
      via?: Via
      serverId?: string
      target?: NavTarget
      expectedRepo?: RouteRef<'prReview'>['params']['expectedRepo']
    } = {},
  ): Promise<PrReviewTarget | null> {
    // The row's verb picks the tab: an inbox row that says Review lands on the
    // diff, everything else on Activity.
    this.prsStore.prReviewTab = opts.tab ?? 'activity'
    const api = opts.serverId ? serverConnections.apiFor(opts.serverId) : this.apiForContext(ctx)
    const serverId = opts.serverId ?? serverConnections.serverIdForApi(api)
    const ref = this.prReviewRef(number, title, ctx, serverId, opts.expectedRepo)
    const pane = this.router.navigate(ref, {
      target: opts.target ?? this.router.leadingPane.id,
      via: opts.via,
    })
    this.isExpanded = true
    track('surface_viewed', { surface: 'pr_review', via: opts.via })
    this.prsStore.prefetchReview(api, serverId, ctx, number)
    try {
      const pr = await this.router.resolve(ref, {
        api,
        ipc: (cwd) => (cwd ? this.ctxForDirectory(cwd) : ctx),
      })
      markPrReviewProfile('review-worktree-ready')
      return pr
    } catch (err) {
      if (prSurfaceError(err).kind === 'github-auth') return null
      // Tear down the pending surface so a failed open doesn't strand the user.
      this.router.dropResolved(ref)
      if (this.router.params('prReview')?.number === number) {
        if (pane.id === this.router.leadingPane.id) this.exitPrReview()
        else this.router.closePane(pane.id)
      }
      toasts.error(`Couldn't open PR #${number}`, {
        description: err instanceof Error ? err.message : String(err),
      })
      return null
    }
  }

  /** Enter PR review without creating a checkout. A worktree-rooted chat is
   * created only on demand. */
  async enterPrReview(
    number: number,
    title?: string,
    opts: {
      openChat?: boolean
      ctx?: IpcContext
      via?: Via
      serverId?: string
      target?: NavTarget
      expectedRepo?: RouteRef<'prReview'>['params']['expectedRepo']
    } = {},
  ): Promise<void> {
    beginPrReviewProfile(number)
    // Switch to the editor layout up front so the click registers immediately.
    if (this.window.viewMode !== 'editor') await this.window.setViewMode('editor')
    const ctx = opts.ctx ?? this.ctx
    const pr = await this.openPrReviewRoute(number, title, ctx, {
      via: opts.via,
      serverId: opts.serverId,
      target: opts.target,
      expectedRepo: opts.expectedRepo,
    })
    if (pr && opts.openChat) {
      const api = opts.serverId ? serverConnections.apiFor(opts.serverId) : this.apiForContext(ctx)
      const checkout = await api.prPrepareCheckout(ctx, pr)
      await this.openPrReviewChat({ ...pr, ...checkout }, {
        projectCtx: ctx,
        serverId: opts.serverId,
      })
    }
  }

  /** Prepare one review without changing pane placement. Review Mode uses this
   * seam to warm the next item in its queue. */
  async preparePrReview(number: number, opts: { ctx?: IpcContext; serverId?: string } = {}): Promise<{ pr: PrReviewTarget }> {
    const ctx = opts.ctx ?? this.ctx
    const api = opts.serverId ? serverConnections.apiFor(opts.serverId) : this.apiForContext(ctx)
    const pr = await api.prOpenReview(ctx, number)
    return { pr }
  }

  /** Open a PR picked from the list. It replaces the list rather than docking
   *  beside it; `tab` is the landing tab the picked row's verb promised. */
  async openPrReview(
    number: number,
    title?: string,
    opts: { ctx?: IpcContext; tab?: PrReviewTab; serverId?: string } = {},
  ): Promise<void> {
    if (this.router.params('prReview')?.number === number) return
    beginPrReviewProfile(number)
    await this.openPrReviewRoute(number, title, opts.ctx ?? this.ctx, { tab: opts.tab, serverId: opts.serverId })
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
      serverId: this.router.params('prReview')?.serverId,
    })
  }

  /** Create (once), activate, and reveal the chat associated with a PR review.
   * A host-only target opens a blocked draft immediately while its checkout is
   * prepared. Calling this again with the prepared context attaches that same
   * visible draft to the real PR branch. */
  async openPrReviewChat(
    pr: PrReviewTarget | PrReviewContext,
    opts: { existingTabId?: string | null; projectCtx?: IpcContext | null; serverId?: string } = {},
  ): Promise<string> {
    const checkout = 'worktreePath' in pr ? pr : null
    const existingTabId = opts.existingTabId ?? null
    const hasExistingChat = Boolean(existingTabId && this.tabs[existingTabId])
    beginPrReviewProfile(pr.number, { restart: true })
    markPrReviewProfile('chat-open-start', { hasExistingChat })
    if (existingTabId && this.tabs[existingTabId]) {
      if (checkout) this.attachPrReviewCheckout(existingTabId, checkout)
      this.setActiveTab(existingTabId)
      this.revealConversationBesideReview(existingTabId)
      this.tabs[existingTabId].hasUnread = false
      requestInputFocus()
      requestAnimationFrame(() => {
        markPrReviewProfile('chat-split-first-paint', { hasExistingChat })
        settlePrReviewProfile()
      })
      return existingTabId
    }

    const reviewGitContext: GitCheckout | null = checkout ? {
      branch: checkout.branch,
      targetBranch: checkout.baseRef,
      worktreePath: checkout.worktreePath,
    } : null
    const pendingDirectory = opts.projectCtx?.session.projectPath
      ?? opts.projectCtx?.session.workingDirectory
      ?? this.router.params('prReview')?.cwd
      ?? this.staticInfo?.projectPath
      ?? this.staticInfo?.workspacePath
    const tabId = await this.createTab(
      checkout ? worktreeProjectRoot(checkout.worktreePath) : pendingDirectory,
      {
      activate: false,
      gitContext: reviewGitContext,
      gitInitialization: 'background',
      worktreeRequested: false,
      serverId: opts.serverId ?? this.router.params('prReview')?.serverId,
      },
    )
    markPrReviewProfile('chat-tab-ready')
    const reviewSession = this.sessionFor(tabId)
    if (reviewSession) {
      reviewSession.title = `PR #${pr.number}`
      if (checkout) this.attachPrReviewCheckout(tabId, checkout)
      else {
        reviewSession.status = 'connecting'
        reviewSession.statusCard = {
          id: `pr-chat-checkout-${pr.number}`,
          title: `Preparing PR #${pr.number} checkout…`,
          icon: 'git-branch',
          status: 'active',
          steps: [{ id: 'checkout', label: 'Connecting the conversation to the PR branch', status: 'active' }],
        }
      }
    }
    this.setActiveTab(tabId)
    this.revealConversationBesideReview(tabId)
    requestInputFocus()
    requestAnimationFrame(() => {
      markPrReviewProfile('chat-split-first-paint', { hasExistingChat })
      settlePrReviewProfile()
    })
    return tabId
  }

  private attachPrReviewCheckout(tabId: string, pr: PrReviewContext): void {
    const reviewSession = this.sessionFor(tabId)
    if (!reviewSession) return
    reviewSession.run.workingDirectory = worktreeProjectRoot(pr.worktreePath)
    reviewSession.run.gitContext = {
      branch: pr.branch,
      targetBranch: pr.baseRef,
      worktreePath: pr.worktreePath,
    }
    reviewSession.run.worktree = null
    reviewSession.run.permissionMode = 'auto'
    reviewSession.prReview = pr
    reviewSession.statusCard = null
    if (reviewSession.status === 'connecting') reviewSession.status = 'idle'
  }

  failPrReviewChatCheckout(tabId: string, prNumber: number, message: string): void {
    const reviewSession = this.sessionFor(tabId)
    if (!reviewSession) return
    reviewSession.status = 'idle'
    reviewSession.statusCard = {
      id: `pr-chat-checkout-${prNumber}`,
      title: `Couldn't prepare PR #${prNumber} checkout`,
      icon: 'git-branch',
      status: 'error',
      steps: [{ id: 'checkout', label: message, status: 'error' }],
    }
  }

  /** Split the review: it keeps leading, and its conversation opens beside it.
   *  The chat and the popped-out diff share the aside, so revealing one puts
   *  the other away — the review is what you are always looking at. The pane
   *  names the review's session, as every companion chat does: one naming none
   *  shows whichever conversation the pool is on, which is not this review's. */
  private revealConversationBesideReview(tabId: string): void {
    const sessionId = this.tabs[tabId]?.sessionId
    if (!sessionId) return
    this.router.close('prDiff')
    // A review opened from a transcript link is itself the companion, and at the
    // pane cap "beside it" would then resolve back to the leading pane — the
    // chat would take the review's place rather than stand next to it. The
    // review takes the lead first, which is where it belongs either way.
    this.router.leadWith('prReview')
    // Checkout preparation calls this method again when it attaches the blocked
    // draft to the PR branch. By then focus is already in the secondary pane,
    // so another relative `aside` would mean the leading pane and put the same
    // conversation on both sides. Target the existing secondary by id instead.
    const target = this.router.asidePanes[0]?.id ?? 'aside'
    const pane = this.router.navigate(
      chatRoute(sessionId, this.sessions[sessionId]?.run.serverId),
      { target },
    )
    pane.defaultSize = 50
    this.isExpanded = true
  }

  /** Pop the open review's diff out beside it, so the activity feed and the
   *  change read together. Closing it returns the review to Activity. */
  openPrDiff(number: number, ctx: IpcContext = this.ctx): void {
    const pane = this.router.navigate(
      {
        name: 'prDiff',
        params: {
          number,
          cwd: projectScopeOf(ctx.session) || undefined,
          serverId: this.sessions[ctx.session.sessionId]?.run.serverId,
        },
      },
      { target: 'aside' },
    )
    pane.defaultSize = 50
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
   * bare navigation cannot know about — a plan's body off disk, a PR's provider
   * detail, or a session that must be resumed.
   */
  openRoute(ref: RouteRef, opts: { via?: Via; target?: NavTarget } = {}): void {
    switch (ref.name) {
      case 'plan':
        if (ref.params.planId) void this.openPlanModal(ref.params.planId)
        return
      case 'work':
        void this.openWorkModal(ref.params.workId, undefined, { via: opts.via })
        return
      case 'prReview':
        void this.enterPrReview(ref.params.number, ref.params.title, {
          via: opts.via,
          target: opts.target,
          expectedRepo: ref.params.expectedRepo,
          serverId: ref.params.serverId,
          ctx: ref.params.cwd ? this.ctxForDirectory(ref.params.cwd) : this.ctx,
        })
        return
      case 'chat': {
        // A chat names a session of ours; a notification or a deep link may
        // name the provider's instead. Our ids resolve hostless (client-minted,
        // collision-free); a provider id resolves only with the route's host.
        const sessionId = ref.params.sessionId
        const tabId = sessionId
          ? ref.params.serverId
            ? findOpenTabForSession(
                sessionId,
                this.tabs,
                this.sessions,
                this.tabOrder,
                undefined,
                ref.params.serverId,
              )
            : this.tabIdForSession(sessionId) ?? null
          : null
        if (tabId && this.tabs[tabId]) this.selectTab(tabId)
        else if (sessionId && ref.params.serverId) {
          // A route without a host cannot be resolved — no probe, no guess.
          void readSessionMeta(ref.params.serverId, sessionId).then((meta) => {
            if (meta) void this.resumeSession(meta)
          })
        }
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
    if (!this.sessionFor(sourceTabId)?.run.workingDirectory) return
    this.showDiff(sourceTabId, scope)
  }

  showDiff(sourceTabId: string, scope: DiffScope = { kind: 'session' }, filePath?: string): void {
    this.showViewer({ name: 'diff', params: { sourceTabId, scope, filePath } })
  }

  /** `sourceId` is a tab or a draft: the file tree follows its run, so browsing
   *  from a draft opens the project that draft will run in. */
  openFiles(sourceId: string): void {
    this.showViewer({ name: 'files', params: { sourceId } })
  }

  openFilePreview(file: FilePreviewRequest, sourceId: string): void {
    this.showViewer({
      name: 'fileEditor',
      params: { sourceId, path: file.path, line: file.line },
    })
  }

  /** Pop a sub-agent's nested transcript out of its card into a companion pane. */
  openSubagent(tabId: string, messageId: string): void {
    const sessionId = this.tabs[tabId]?.sessionId
    if (!sessionId) return
    this.showViewer({
      name: 'subagent',
      params: { sessionId, messageId, serverId: this.sessions[sessionId]?.run.serverId },
    })
  }

  /** Viewers cover a companion pane and size themselves; a diff opened over a
   *  review guide splits evenly so both halves stay readable. */
  private showViewer(ref: RouteRef): void {
    const pane = this.router.navigate(ref, { target: 'aside' })
    pane.defaultSize =
      ref.name === 'diff' && this.router.leadingPane.base?.name === 'review' ? 50 : 60
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
