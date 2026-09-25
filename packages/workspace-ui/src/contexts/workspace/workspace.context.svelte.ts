import { createAppContext } from '../app/create-app-context'
import { ToolHistoryStore } from './tool-history.store'
import { splitHostKey } from '@solus/client-core/host-key'
import { browserStore } from '../browser/browser.store.svelte'
import type { AgentId, Tab, Prompt, Session, SessionSpec, RunConfig, Attachment, PlanDescriptor, SessionCtx, IpcContext, ModelConfig, RuntimeSessionInfo, GitCheckout, Work, ThreadGoal, ThreadGoalSetRequest } from '@solus/contracts/types'
import { type RepoRef } from '@solus/contracts/providers'
import { type ReviewTarget } from '@solus/contracts/review'
import type { SolusEventMap, Via } from '@solus/contracts/analytics-events'
import type { SurfaceContext } from '../app/surface-context.svelte'
import { findOpenTabForSession, hasSessionStarted } from '../../lib/sessionUtils'
import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import { uuid } from '@solus/contracts/uuid'
import { resolveArtifactTitle, workPreview } from '@solus/contracts/work-preview'
import { notificationsStore } from '../notifications/notifications.store.svelte'
import { type PlanStore } from '../plans/plan.store.svelte'
import { WorksStore } from '../works/works.store.svelte'
import { AutomationsStore } from '../automations/automations.store.svelte'
import { WatchesStore } from '../watches/watches.store.svelte'
import { automationDraftSessionRequest } from '../automations/automation-draft-session'
import { TasksStore } from '../tasks/tasks.store.svelte'
import { OutboxStore } from '../outbox/outbox.store.svelte'
import type { PullRequestsContext } from '../prs/pull-requests.context.svelte'
import type { PrReviewTab } from '../prs/pr-view.svelte'
import { projectsStore } from '../projects/projects.store.svelte'
import { workspaceProjectsStore } from '../projects/workspace-projects.store.svelte'
import { serversStore } from '../connections/servers.store.svelte'
import { projectScopeOptions, scopeForProject, type LogicalProject, type ProjectPageScope, type ProjectRef } from '../projects/project-catalog'
import type { ListProjectOption } from '../../components/ui/list-page/list-page'
import { toasts } from '../../lib/toasts'
import { RouterStore } from './routing/router.store.svelte'
import { visibleRef, type NavTarget, type PaneId } from './routing/location'
import { ROUTES, chatRoute, type ReviewView, type RouteParams, type RouteRef, type SettingsTab } from './routing/route-registry'
import { WorkStreamTracker } from './work-stream-tracker.svelte'
import { canReturnToRoute, leadingHomeRoute } from './leading-home'
import { WorkspaceUiStore } from './workspace-ui.store.svelte'
import { IpcContextBuilder } from './ipc-context'
import { PromptComposer } from './prompt-composer'
import { TabRegistry } from './tab-registry.svelte'
import { SessionControls } from './session-controls'
import { PrReviewActions } from './pr-review-actions'
import { SessionMetadata } from './session-metadata.svelte'
import { SessionOpening } from './session-opening'
import { SessionDrafts } from './session-drafts.svelte'
import { PromptDispatch } from './prompt-dispatch'
import type { SessionRecords } from './session-records.svelte'
import { SessionConfigController } from './session-config.svelte'
import { WorkspaceLifecycleStore, type StaticInfo } from './workspace-lifecycle.store.svelte'
import { SessionEventReducer } from './session-event-reducer.svelte'
import { type SettingsContext } from '../app/settings.context.svelte'
import { type ClientShellContext } from '../app/client-shell.svelte'
import { type StatusBarContext } from '../app/status-bar.context.svelte'
import { type AgentContext } from '../app/agent.context.svelte'
import { type SessionEnvironmentStore } from '../git/session-environment.store.svelte'

import { makeSession, makeTab } from './session.factories'
import { SessionDraft, existingTaskId, taskBindingSessionId } from './session-draft.svelte'
import { defaultStartProject, projectRootOf, resolveNewRunConfig, startsWorktree } from './run-config'
import { removeDraft, removePersistedTab } from './tab-persistence'
import { applyRuntimeConfig, nextMsgId } from './session.utils'
import type { DiffScope } from '@solus/contracts/git-types'
import type { FilePreviewRequest } from '../../lib/filePreview'
import { worktreeProjectRoot } from '@solus/contracts/types'
import { syncPendingInputFromEvent, loadSessionTranscript } from './session-transcript'
import { submitDiffFeedback, submitDiffFeedbackToNewSession } from './session-diff-feedback'
import { clearPlanWaiting, openPlanModal, closePlanModal, approvePlanWithModel, rejectPlan, openPlanFromDescriptor, closePlanPreview, resumeSessionFromDescriptor, loadPlanContent, type ApprovePlanOptions } from './session-plan-operations'
import { unavailableSessionMessage } from './session-errors'
import { track } from '../../lib/analytics'
import { requestInputFocus } from '../../lib/inputFocus'
import { projectDirLabel } from '../../lib/paths'
import { disposeGitActions } from '../../lib/git-actions.svelte'
import { prioritizeTabHydration } from './session-bootstrap'
import { serverConnections } from '@solus/client-core/server-connections'
import { LOCAL_SERVER_ID } from '@solus/client-core/server-registry'
import type { HostApi } from '@solus/client-core/host-api'
import { readSessionMeta } from '@solus/client-core/session-meta'
import { hostKey } from '@solus/client-core/host-key'
import { isPristineSplitTab } from '../../lib/split-chat'
import { GoalSync } from './goal-sync'
import { taskCreationContextFor, type TaskCreationContext } from '../../components/tasks/lib/task-creation-context'
import {
  reviewGuideStore,
  sessionGuideIdentity,
} from '../../components/review/review-guide.store.svelte'
import { z } from 'zod'

export interface PullRequestOpenTarget {
  number: number
  title?: string
  /** The original remote link, when this target came from a durable link. */
  url?: string | null
  /** Provider identity carried by PR list records. */
  baseRepo?: RepoRef
  /** Provider identity parsed from a remote link. */
  expectedRepo?: RouteRef<'prReview'>['params']['expectedRepo']
}

const devSessionLogging = Boolean(import.meta.env.DEV)
const outboxTaskPayloadSchema = z.object({ taskId: z.string().optional() })

export interface PersistedSessionDrafts {
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
  staticInfo: StaticInfo | null
  pendingInput: string | null
}

export interface CreateTabOptions {
  activate?: boolean
  /** Where a draft opens: a pane id, or `'aside'` for a new companion pane.
   *  Defaults to the focused pane. */
  target?: NavTarget
  /** Whether selecting this tab should also reveal its conversation. True for
   *  every tab a person asks for; false for the tab seeded at startup. */
  reveal?: boolean
  freshTask?: boolean
  withoutTask?: boolean
  taskId?: string
  workId?: string
  gitContext?: GitCheckout | null
  /** `skip` when the caller resolves the environment itself — a resume reads
   *  identity and registers the checkout on its own path. */
  gitInitialization?: 'blocking' | 'background' | 'skip'
  /** True when the caller reads the directory's commands itself. */
  skipPluginCommands?: boolean
  worktreeRequested?: boolean
  /** The host this tab's session runs on. Must be set here rather than after the
   *  fact: `createTab` resolves the git environment, and a remote working
   *  directory has to be read on the machine that holds it. */
  serverId?: string
  /** The host that owns the session's task, when it differs from `serverId`. */
  taskServerId?: string
  /** The tab or draft the gesture came from. The new run inherits this focused
   *  source, not whichever hidden tab happens to be active. */
  sourceId?: string
  via?: Via
}

export interface ForkTabOptions {
  activate?: boolean
  task?: Session['task']
}

export class WorkspaceContext implements SurfaceContext {
  /** The narrow context a record surface reads is this workspace itself. */
  get workspace(): WorkspaceContext { return this }
  readonly toolHistory = new ToolHistoryStore()
  get deferHistoryToolInputs(): boolean { return this.shell.deferHistoryToolInputs }
  registry: TabRegistry
  readonly controls: SessionControls
  readonly prReview: PrReviewActions
  readonly metadata: SessionMetadata
  readonly opening: SessionOpening
  readonly drafts: SessionDrafts
  readonly dispatch: PromptDispatch
  lifecycle: WorkspaceLifecycleStore
  pendingInput = $state<string | null>(null)
  eventReducer: SessionEventReducer

  planStore: PlanStore
  worksStore: WorksStore
  automationsStore = new AutomationsStore()
  watchesStore = new WatchesStore()
  tasksStore = new TasksStore()
  /** The outbox courier: drains cross-host writes recorded on any connected
   *  host to the host that owns each resource (ADR-0007). */
  outboxStore = new OutboxStore()
  /** Task/session pairs the user explicitly opened. Automatic task refreshes do
   *  not add entries here, so one provider session stays in its first sidebar
   *  position unless the user asks to see another task-scoped occurrence. */
  readonly explicitSidebarTaskSessions = new SvelteSet<string>()
  /** The task-scoped occurrence selected for a mounted session. A session may be
   *  linked to several tasks, but only this occurrence leads the active path. */
  private readonly sidebarTaskContextBySessionId = new SvelteMap<string, string>()
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
  onTabClosing?: (tabId: string) => void
  onPromptSubmitted?: (tabId: string) => void

  settings: SettingsContext
  private shell: ClientShellContext
  private statusBar: StatusBarContext
  private agent?: AgentContext
  private workStreamTracker: WorkStreamTracker
  private ipcContextBuilder: IpcContextBuilder
  promptComposer: PromptComposer
  goalSync: GoalSync
  environment: SessionEnvironmentStore

  constructor(
    readonly sessions: SessionRecords,
    settings: SettingsContext,
    shell: ClientShellContext,
    statusBar: StatusBarContext,
    planStore: PlanStore,
    environment: SessionEnvironmentStore,
    readonly pullRequests: PullRequestsContext,
    agent?: AgentContext,
  ) {
    this.registry = new TabRegistry(sessions)
    this.controls = new SessionControls(this)
    this.prReview = new PrReviewActions(this)
    this.metadata = new SessionMetadata(this)
    this.opening = new SessionOpening(this)
    this.drafts = new SessionDrafts(this)
    this.dispatch = new PromptDispatch(this)
    this.settings = settings
    this.shell = shell
    this.statusBar = statusBar
    this.agent = agent
    this.planStore = planStore
    this.environment = environment
    this.environment.bindWorkspace(this)
    this.worksStore = new WorksStore()
    // Closing a page with no tab open lands on the composer, not on an empty
    // pool. The router asks only when the leading pane is the one closing.
    this.router.leadingHome = () => leadingHomeRoute({
      hasTabs: this.hasOpenTabs(),
      leadingBase: this.router.leadingPane.base,
      drafts: this.drafts.sessionDrafts,
      composingDraftIds: this.drafts.composingDraftIds,
      createDraft: () => this.drafts.createSessionDraft({}),
    })
    // Settings hands its pane back to what it covered, unless that tab closed
    // or that draft was sent while it was open.
    this.router.canReturnTo = (ref) => canReturnToRoute(ref, {
      hasTabs: this.hasOpenTabs(),
      hasTabForSession: (sessionId) => !!this.tabIdForSession(sessionId),
      drafts: this.drafts.sessionDrafts,
      composingDraftIds: this.drafts.composingDraftIds,
    })
    // The courier stays domain-blind; each domain contributes only the answer
    // to "which connected host owns this resource id".
    this.outboxStore.registerOwnerResolver('tasks', (taskId) => this.tasksStore.get(taskId).ownerHost())
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
      return taskId ? this.tasksStore.get(taskId).ownerHost() : Promise.resolve(undefined)
    })
    // A goal belongs to a thread, so GoalSync names sessions. The RPC surface
    // and IPC context are still reached through a tab — they describe where the
    // work runs — so the resolver supplies one.
    this.goalSync = new GoalSync({
      sessionById: (sessionId) => this.sessions.byId[sessionId],
      apiForSession: (sessionId) => this.apiForSession(sessionId),
      ctxForSession: (sessionId) => this.ctxFor(this.tabIdForSession(sessionId) ?? ''),
    })
    this.config = new SessionConfigController({
      settings: this.settings,
      registry: this.registry,
      statusBar: this.statusBar,
      setPluginCommands: (commands) => { this.pluginCommands = commands },
      openSessionDraft: (cwd, freshTask, gitContext) => {
        this.drafts.openSessionDraft({ freshTask, gitContext }, cwd)
      },
      draftFor: (sourceId) => this.drafts.sessionDrafts.get(sourceId),
      defaultRunConfig: () => this.defaultRunConfig,
      ctx: (tabId) => tabId ? this.ctxFor(tabId) : this.ctx,
      ctxForDirectory: (dir) => this.ctxForDirectory(dir),
      apiFor: (tabId) => tabId ? this.apiFor(tabId) : this.defaultHostApi(),
      apiForRun: (run) => this.apiForRun(run),
      refreshPluginCommands: (dir, tabId) => { void this.lifecycle.refreshPluginCommands(dir, tabId) },
      rekeyTaskSessionBinding: (sourceSessionId, targetSessionId, serverId) => {
        this.tasksStore.rekeySessionBinding(sourceSessionId, targetSessionId, serverId)
      },
      refreshGitRefs: (run, projectRoot, ctx) => {
        void this.environment.refreshRefs(run?.serverId ?? this.fallbackServerId, projectRoot, ctx, { force: true })
      },
      refreshGitState: (opts) => this.environment.refreshEnvironment(this, opts),
      selectTab: (tabId) => this.selectTab(tabId),
    })
    this.lifecycle = new WorkspaceLifecycleStore({
      registry: this.registry,
      sessions,
      settings: this.settings,
      config: this.config,
      planStore: this.planStore,
      agent: this.agent,
      defaultRunConfig: () => this.defaultRunConfig,
      unstartedRuns: () => this.unstartedRuns(),
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
      sessions,
      settings: this.settings,
      planStore: this.planStore,
      worksStore: this.worksStore,
      tasksStore: this.tasksStore,
      automationsStore: this.automationsStore,
      workStreamTracker: this.workStreamTracker,
      isSessionVisible: (sessionId) => this.isSessionVisible(sessionId),
      publishSessionViewed: (sessionId) => this.metadata.publishSessionViewed(sessionId),
      addChangedFilesFromMessage: (sessionId, message) => this.lifecycle.addChangedFilesFromMessage(sessionId, message),
      refreshTurnSnapshots: (sessionId) => { void this.lifecycle.refreshTurnSnapshots(sessionId) },
      setGitStatus: (serverId, cwd, status) => this.environment.set(serverId, cwd, status),
      playNotificationIfHidden: (sessionId, trigger) => {
        void notificationsStore.playSound(sessionId, this.sessions.byId[sessionId]?.agentSessionId ?? null, trigger)
      },
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
        void this.metadata.definePendingGoal(tabId)
        void this.metadata.generateSessionMetadata(tabId)
      },
      handlePendingInputSync: (session, events) => syncPendingInputFromEvent(this, session, events),
      log: (eventType, session) => logDevSessionState(eventType, session),
    })
    this.promptComposer = new PromptComposer(this.planStore, this.worksStore, this.tasksStore)
    this.ipcContextBuilder = new IpcContextBuilder({
      checkoutForRun: (run) => this.environment.environmentFor(run).checkout,
      sessionFor: (tabId) => this.sessionFor(tabId),
      runFor: (sourceId) => this.runFor(sourceId),
      hasDraft: (sourceId) => this.drafts.sessionDrafts.has(sourceId),
      defaultRunConfig: () => this.defaultRunConfig,
      settings: this.settings,
      statusBar: this.statusBar,
    })

    // Start with no tabs — first tab is auto-created on prompt submission or snapshot hydration
    this.registry.tabs = {}
    this.registry.tabOrder = []
    this.registry.activeTabId = ''
  }

  get staticInfo(): StaticInfo | null { return this.lifecycle.staticInfo }
  set staticInfo(value: StaticInfo | null) { this.lifecycle.staticInfo = value }
  get pluginCommands(): Session['pluginCommands'] { return this.lifecycle.pluginCommands }
  set pluginCommands(value: Session['pluginCommands']) { this.lifecycle.pluginCommands = value }
  get tabs(): Record<string, Tab> { return this.registry.tabs }
  set tabs(value: Record<string, Tab>) { this.registry.tabs = value }
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

  /** The tab *or draft* the focused pane composes into. `focusedChatTabId`
   *  answers only once a conversation has started, but a draft owns a run too,
   *  so a command that changes where work happens resolves its source here. */
  get focusedSourceId(): string | null {
    const ref = visibleRef(this.router.focused)
    if (ref?.name === 'draft') return ref.params.draftId
    return this.focusedChatTabId
  }

  /** Sidebar lifecycle decides whether a mounted conversation is current work.
   * Before that lifecycle has loaded, every mounted tab remains open. */
  private tabCountsTowardOpenState: (tabId: string) => boolean = () => true

  setOpenTabPredicate(predicate: (tabId: string) => boolean): void {
    this.tabCountsTowardOpenState = predicate
  }

  hasOpenTabs(): boolean {
    return this.tabOrder.some(
      (tabId) => !!this.tabs[tabId] && this.tabCountsTowardOpenState(tabId),
    )
  }

  /** The chat pinned into a companion pane, if any — the "split chat". */
  get splitChatTabId(): string | null {
    for (const pane of this.router.asidePanes) {
      const tabId = this.chatTabIn(pane.id)
      if (tabId) return tabId
    }
    return null
  }

  /** The pane holding the split chat, for focus and close operations. */
  private get splitChatPaneId(): PaneId | null {
    return this.router.asidePanes.find((pane) => pane.base?.name === 'chat')?.id ?? null
  }
  get activeInput(): Prompt { return this.registry.activeInput }
  set activeInput(value: Prompt) { this.registry.activeInput = value }
  /** The page scope, its key kept in step with its checkout: a folder picked
   *  before its host named the repository is found again under the repository
   *  once it does. */
  get projectPageScope(): ProjectPageScope {
    const scope = this.ui.projectPageScope
    if (scope.kind !== 'project' || !scope.checkout) return scope
    const key = projectsStore.projectKeyFor(scope.checkout.serverId, scope.checkout.projectRoot)
    return key === scope.key ? scope : { ...scope, key }
  }

  setProjectPageScope(scope: ProjectPageScope): void {
    this.ui.projectPageScope = scope
  }

  readonly logicalProjects: LogicalProject[] = $derived.by(() =>
    projectsStore.logicalProjects(workspaceProjectsStore.projectsFor(serversStore.activeCloudServerId)),
  )

  readonly projectScopeOptions: ListProjectOption[] = $derived.by(() =>
    projectScopeOptions(
      this.logicalProjects,
      (serverId) => serversStore.statusFor(serverId) === 'online',
      (serverId) => serversStore.hostFor(serverId)?.label ?? serverId,
      serversStore.activeCloudServerId,
    ),
  )

  scopePageToProject(projectKey: string): void {
    const project = this.logicalProjects.find((candidate) => candidate.key === projectKey)
    this.setProjectPageScope(project
      ? scopeForProject(project, (serverId) => serversStore.statusFor(serverId) === 'online')
      : { kind: 'project', key: projectKey, checkout: null })
  }

  get hasProjectPageOpen(): boolean {
    return this.router.at('tasks') || this.router.at('prs') || this.router.at('folio') || this.router.at('automations')
  }

  /** A project chosen while a project page is visible scopes that page rather
   * than opening a composer behind it. */
  scopeOpenProjectPage(project: ProjectRef): void {
    this.setProjectPageScope({
      kind: 'project',
      key: projectsStore.projectKeyFor(project.serverId, project.projectRoot),
      checkout: project,
    })
  }

  /** Scope the project pages to the project the input bar is in — the
   *  "Current project" choice. The page scope never follows the tab in focus
   *  by itself (docs/plans/project-model.md §5); this is the one explicit way
   *  to ask for it. False when the input bar names no project. */
  scopePageToCurrentProject(): boolean {
    const run = this.activeRun
    const projectRoot = run?.gitContext?.repoRoot ?? run?.workingDirectory
    if (!run || !projectRoot || projectRoot === '~') return false
    this.scopeOpenProjectPage({ serverId: run.serverId, projectRoot: worktreeProjectRoot(projectRoot) })
    return true
  }
  /** The visible input bar's task environment, including its base project and
   * checkout. A draft has no active session, so resolve through `activeRun` —
   * the same source the input header uses — rather than the tab behind it. */
  get taskCreationContext(): TaskCreationContext | null {
    const run = this.activeRun ?? this.defaultRunConfig
    const context = taskCreationContextFor(run.taskServerId, run.workingDirectory, run.gitContext)
    return context ? this.taskDestinationFor(run.serverId, context) : null
  }

  projectDefaultBranchFor(run: RunConfig): string | null {
    const directory = run.gitContext?.repoRoot ?? run.workingDirectory
    if (!directory || directory === '~') return null
    const repositoryKey = projectsStore.repositoryKeyFor(run.serverId, directory)
    return workspaceProjectsStore.projectFor(serversStore.activeCloudServerId, repositoryKey)?.defaultBranch ?? null
  }

  get activeCheckout(): ProjectRef | null {
    const run = this.activeRun ?? this.defaultRunConfig
    const directory = run.gitContext?.repoRoot ?? run.workingDirectory
    if (!directory || directory === '~') return null
    return { serverId: run.serverId, projectRoot: worktreeProjectRoot(directory) }
  }

  taskContextForProject(projectKey: string, checkout: ProjectRef | null): TaskCreationContext | null {
    if (checkout) return this.taskContextForCheckout(checkout.serverId, checkout.projectRoot)
    // A cloud project no known machine holds has only one place for a task.
    const cloudServerId = serversStore.activeCloudServerId
    return cloudServerId && workspaceProjectsStore.projectFor(cloudServerId, projectKey)
      ? { serverId: cloudServerId, projectKey, workingDirectory: projectKey }
      : null
  }

  private taskContextForCheckout(serverId: string, cwd: string): TaskCreationContext | null {
    const context = taskCreationContextFor(serverId, cwd, null)
    return context ? this.taskDestinationFor(serverId, context) : null
  }

  /** Where a new task is stored (docs/plans/project-model.md §4): on the host
   *  that holds the checkout — tasks are local first, and a person pushes one
   *  to the cloud on purpose — except on a cloud instance (a managed host),
   *  whose tasks are the organization's and go to the workspace service. */
  private taskDestinationFor(checkoutServerId: string, context: TaskCreationContext): TaskCreationContext {
    const cloudServerId = serversStore.activeCloudServerId
    const repositoryKey = projectsStore.repositoryKeyFor(checkoutServerId, context.projectKey)
    if (!serversStore.isolatesSessions(checkoutServerId) || !cloudServerId || !repositoryKey) return context
    return { ...context, serverId: cloudServerId, projectKey: repositoryKey }
  }

  /** The base project whose tasks the page lists, as a path on the input bar's host. */
  get tasksProjectCwd(): string | null {
    return this.activeCheckout?.projectRoot ?? null
  }

  private defaultModelConfigFor(agentId: AgentId): ModelConfig {
    return this.config.defaultModelConfigFor(agentId)
  }

  /** Resolve a tab id to its tab + session, or null if either is missing — the
   *  shared adapter for grouping helpers so the strip and keyboard nav agree. */
  resolveTab(tabId: string): { sess: Session; tab: Tab } | null {
    return this.registry.resolveTab(tabId)
  }

  setActiveTab(tabId: string): void {
    this.registry.setActiveTab(tabId)
    prioritizeTabHydration(this, tabId)
    // A review guide belongs to the session it was generated from, so moving to
    // another tab leaves it rather than showing a stale walkthrough.
    this.router.close('review')
  }

  /** Visibility can change without selecting a tab: window focus, closing a
   *  page, and restoring a companion pane all reveal chats. */
  trackVisibleConversations(): void {
    $effect(() => {
      for (const tabId of this.tabOrder) {
        const tab = this.tabs[tabId]
        if (tab?.hasUnread && this.isSessionVisible(tab.sessionId)) {
          tab.hasUnread = false
          // Seeing it here is what "read" means, so the host hears about it and
          // every other device clears the same session.
          this.metadata.publishSessionViewed(tab.sessionId)
        }
      }
    })
  }

  /** Is this conversation on screen anywhere? A session may be watched by
   *  several tabs; any one of them being on screen makes it visible. */
  private isSessionVisible(sessionId: string): boolean {
    if (!this.shell.visible) return false
    const hasCompanionPanes = this.shell.hasCompanionPanes
    // A chat pinned in a companion pane is on screen too — but only in
    // wide layouts, where companion panes actually render.
    if (hasCompanionPanes && this.router.asidePanes.some(
      (pane) => this.router.chatSessionIn(pane.id) === sessionId,
    )) {
      return true
    }
    return this.tabs[this.activeTabId]?.sessionId === sessionId
      && this.showsConversation
  }

  isSessionVisibleOnHost(serverId: string, sessionId: string): boolean {
    if (!this.shell.visible) return false
    const tabId = findOpenTabForSession(
      sessionId,
      this.tabs,
      this.sessions.byId,
      this.tabOrder,
      undefined,
      serverId,
    )
    if (!tabId) return false
    const hasCompanionPanes = this.shell.hasCompanionPanes
    if (hasCompanionPanes && this.router.asidePanes.some((pane) => {
      if (pane.overlay || pane.base?.name !== 'chat') return false
      if (pane.base.params.sessionId !== sessionId) return false
      return pane.base.params.serverId
        ? pane.base.params.serverId === serverId
        : this.chatTabIn(pane.id) === tabId
    })) {
      return true
    }
    return this.activeTabId === tabId && this.showsConversation
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

  /** Leave whatever page (and optionally artifact) is showing — what selecting
   *  another tab or creating one does, so the new conversation is what you see. */
  resetOverlays(opts: { closeArtifact?: boolean } = {}): void {
    this.router.closeGroup('page')
    if (opts.closeArtifact) this.router.closeGroup('artifact')
    this.drafts.leaveDraftInLead()
    this.planStore.dismissPreview()
  }

  lastActiveTabForBranch(branchKey: string): string | null {
    return this.registry.lastActiveTabForBranch(branchKey)
  }

  /** Returns the Session for a given tab, or undefined. */
  sessionFor(tabId: string): Session | undefined {
    return this.registry.sessionFor(tabId)
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

  /**
   * The run a surface is scoped to, named by whichever thing owns it: a started
   * conversation's tab, or a draft that has yet to become one. Every surface
   * that describes *where work happens* — the project rail, its Git actions, a
   * file tree — resolves through this and so needs to know neither which of the
   * two it was handed nor how to reach a run from it.
   */
  runFor(sourceId: string): RunConfig | undefined {
    return this.sessionFor(sourceId)?.run ?? this.drafts.sessionDrafts.get(sourceId)?.run
  }

  /** The new-work default host, for deliberately session-less operations. */
  private defaultServerId(): string {
    const serverId = serverConnections.defaultServerId()
    if (!serverId) throw new Error('Primary Solus connection has not been registered')
    return serverId
  }

  private defaultHostApi(): HostApi {
    return serverConnections.apiFor(this.defaultServerId())
  }

  /** Resolve the RPC surface that owns a run — the machine it runs on. With no
   *  run, the default run's: its directory names a folder on that host only. */
  apiForRun(run: RunConfig = this.defaultRunConfig): HostApi {
    const resolvedId = serverConnections.resolveId(run.serverId)
    const api = serverConnections.apiFor(resolvedId)
    serverConnections.retain(resolvedId)
    return api
  }

  /** Resolve the RPC surface that owns this tab's — or draft's — session. */
  apiFor(sourceId: string): HostApi {
    return this.apiForRun(this.runFor(sourceId))
  }

  /** The same surface, for callers holding only the session's own id. */
  apiForSession(sessionId: string): HostApi {
    const run = this.sessions.byId[sessionId]?.run
    return run ? this.apiForRun(run) : this.defaultHostApi()
  }

  /** Resolve a host from a stateful IPC context, or choose the new-work
   *  default host for a deliberately session-less operation. */
  apiForContext(ctx: IpcContext): HostApi {
    return ctx.session.sessionId
      ? this.apiForSession(ctx.session.sessionId)
      : this.defaultHostApi()
  }

  /** The id half of `apiForRun`, for callers that need to name the host rather
   *  than talk to it. Resolved from the run, never from the API object: an id
   *  is a stable name, whereas recovering one by matching an API's identity
   *  holds only while that exact object is the registry's current connection.
   *  Answers only — the retain/bind side effects belong to `apiForRun`. */
  serverIdForRun(run: RunConfig = this.defaultRunConfig): string {
    return serverConnections.resolveId(run.serverId)
  }

  /** The host that owns this tab's — or draft's — session. */
  serverIdFor(sourceId: string): string {
    return this.serverIdForRun(this.runFor(sourceId))
  }

  serverIdForSession(sessionId: string): string {
    return this.serverIdForRun(this.sessions.byId[sessionId]?.run)
  }

  serverIdForContext(ctx: IpcContext): string {
    return ctx.session.sessionId
      ? this.serverIdForSession(ctx.session.sessionId)
      : this.defaultServerId()
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

  /** The prompt owned by the leading pane's composer. A browser surface sits
   *  beside that pane, so annotations must follow its draft even when the tab
   *  strip still names an older session. */
  get leadingInput(): Prompt {
    const ref = this.router.leadingPane.base
    if (ref?.name === 'draft') {
      const draft = this.drafts.sessionDrafts.get(ref.params.draftId)
      if (draft) return draft.prompt
    }
    return this.currentInput
  }

  get activeSession(): Session | undefined {
    return this.registry.activeSession
  }

  get galleryProjectPath(): string {
    return (this.activeSession?.run ?? this.defaultRunConfig).workingDirectory
  }

  /** The run backing the leading pane — a started session's, or a draft's when
   *  the pane is composing one. This is the run the input header names, so a
   *  surface that must agree with it (the session picker's project scope) reads
   *  it here rather than off the active tab, which a draft has none of. */
  get activeRun(): RunConfig | undefined {
    // A page can cover a draft without changing the input bar below it. Read
    // the pane's base so that covered composer remains the project authority.
    const ref = this.router.leadingPane.base
    if (ref?.name === 'draft') {
      const draft = this.drafts.sessionDrafts.get(ref.params.draftId)
      if (draft) return draft.run
    }
    return this.activeSession?.run
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

  /** Path roots used to scope plans/works to the open projects. */
  get openProjectScopeRoots(): string[] {
    return [...new Set(this.openProjects.flatMap((project) => project.roots))]
  }

  addTabToOrder(tabId: string): void {
    this.registry.addTabToOrder(tabId)
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
    if (patch.staticInfo !== undefined) this.staticInfo = patch.staticInfo
    if (patch.pendingInput !== undefined) this.pendingInput = patch.pendingInput
  }

  // ─── Static info ───

  async switchToBranch(branch: string, sourceId?: string, via: Via = 'click'): Promise<boolean> {
    const switched = await this.config.switchToBranch(branch, sourceId)
    if (switched) track('branch_switched', { via })
    return switched
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
    if (!tab) return
    if (this.sessions.rekey(tab.sessionId, resolvedSessionId)) tab.sessionId = resolvedSessionId
  }

  /** Land what the host answered about a session's live runtime when the tab's
   *  watch asked to attach: the run config, status, and queue. `undefined` means
   *  the watch did not ask, so nothing here changes. */
  applyRuntimeAttach(tabId: string, info: RuntimeSessionInfo | null | undefined): void {
    const session = this.sessionFor(tabId)
    if (!session?.agentSessionId || info === undefined) return
    if (info) {
      applyRuntimeConfig(session, info)
      session.status = info.status
      session.rateLimitInfo = info.rateLimitInfo
      this.lifecycle.reconcileQueuedPrompts(tabId, info.queuedPrompts)
    }
    void this.refreshThreadGoal(session.id)
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

  /** Show the goal wherever this client keeps it. The wide layout has a project
   *  panel section, so it opens that panel and expands the section. The mobile
   *  layout has no project panel, so the goal takes the secondary pane. */
  revealGoal(tabId: string): void {
    const sessionId = this.tabs[tabId]?.sessionId
    if (!this.shell.hasProjectPanel) {
      if (!sessionId) return
      const pane = this.router.navigate(
        { name: 'goal', params: { sessionId, serverId: this.sessions.byId[sessionId]?.run.serverId } },
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


  // ─── Tab management ───

  async createTab(cwd?: string, options: CreateTabOptions = {}): Promise<string> {
    const sourceId = options.sourceId ?? this.focusedSourceId ?? this.activeTabId
    const run = resolveNewRunConfig(this.defaultRunConfig, this.runFor(sourceId), {
      freshTask: options.freshTask,
      workingDirectory: cwd,
      gitContext: options.gitContext,
      serverId: options.serverId,
    })
    // Isolation belongs to one piece of work, so a fresh tab only branches a
    // worktree when the gesture that opened it asked for one.
    const worktreeRequested = options.worktreeRequested ?? false
    // A tab is renderer-local now — the host only ever hears about the session,
    // and only once one is watched.
    run.worktree = worktreeRequested ? { baseBranch: run.gitContext?.targetBranch ?? null } : null
    const session = makeSession(this.settings, {
      run,
      pluginCommands: this.pluginCommands,
      task: options.taskId ? { kind: 'existing', taskId: options.taskId } : { kind: 'new' },
    })
    const tab = makeTab(session.id)
    const tabId = tab.id
    this.sessions.byId[session.id] = session
    this.tabs[tab.id] = tab
    this.addTabToOrder(tab.id)
    track('tab_created', { via: options.via, worktree: worktreeRequested })
    if (options.activate !== false) {
      this.setActiveTab(tab.id)
      this.resetOverlays({ closeArtifact: true })
    }
    if (options.gitInitialization !== 'skip') {
      const gitInitialization = this.environment.refreshEnvironment(this, { sourceId: tabId, worktreeRequested, force: false })
      if (options.gitInitialization === 'background') void gitInitialization
      else await gitInitialization
    }
    if (!options.skipPluginCommands) void this.lifecycle.refreshPluginCommands(run.workingDirectory)
    if (options.activate !== false) requestInputFocus()
    return tabId
  }

  /** The task the source belongs to — the anchor a new draft files under. */
  rootTaskIdFor(sourceId: string | undefined): string | null {
    const draftTaskId = sourceId
      ? existingTaskId(this.drafts.sessionDrafts.get(sourceId)?.task ?? { kind: 'new' })
      : null
    if (draftTaskId) return draftTaskId
    const anchor = sourceId ? this.sessionFor(sourceId) : undefined
    if (!anchor) return null
    return this.tasksStore.taskForSession(taskBindingSessionId(anchor))?.id
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
      boundWorkId: spec.boundWorkId,
      prReview: spec.prReview ?? null,
      // The draft's prompt becomes the session's, same object: what the composer
      // is about to clear is what the send just read.
      prompt: spec.prompt,
    })
    const tabId = uuid()
    this.sessions.byId[session.id] = session
    this.tabs[tabId] = makeTab(session.id, { id: tabId })
    this.addTabToOrder(tabId)
    this.rememberLastProject(session.run)
    track('tab_created', {
      via: options.via,
      worktree: !!session.run.worktree && !session.run.gitContext?.worktreePath,
    })
    if (options.activate !== false) {
      this.setActiveTab(tabId)
      if (options.reveal !== false) {
        this.resetOverlays({ closeArtifact: true })
      }
    }
    void this.config.refreshSessionStartTarget(
      tabId,
      spec.run.workingDirectory,
      startsWorktree(spec.run),
    ).catch(() => null)
    void this.lifecycle.refreshPluginCommands(spec.run.workingDirectory, tabId)
    if (options.activate !== false && options.reveal !== false) requestInputFocus({ tabId })
    return tabId
  }

  /** The one write to `lastProject`: a session the user composed has started. */
  private rememberLastProject(run: RunConfig): void {
    const directory = projectRootOf(run)
    if (!directory) return
    const last = this.settings.lastProject
    if (last?.serverId === run.serverId && last.directory === directory) return
    this.settings.update({ lastProject: { serverId: run.serverId, directory } })
  }

  /** Where a session starts when nothing is carried over: the app's own saved
   *  preferences, as the same `RunConfig` a session and a draft both hold. Its
   *  project is `defaultStartProject`; its checkout is unresolved until the
   *  run's own Git refresh answers. */
  get defaultRunConfig(): RunConfig {
    const defaults = this.config.globalDefaults
    const project = defaultStartProject(
      this.settings.lastProject,
      (serverId) => ['offline', 'different-server'].includes(serversStore.statusFor(serverId)),
      { serverId: this.fallbackServerId, directory: this.staticInfo?.workspacePath ?? '~' },
    )
    return {
      workingDirectory: project.directory,
      gitContext: null,
      worktree: null,
      modelConfig: defaults.modelConfig,
      permissionMode: defaults.permissionMode,
      provider: configuredAgent(this.settings.activeAgent),
      serverId: project.serverId,
      // Nothing has dispatched yet, so a new run owns its own tasks.
      taskServerId: project.serverId,
      projectGroupPath: null,
      sessionSkills: [],
      pendingHostDispatch: null,
    }
  }

  /** Every run nothing has happened in yet: the tabs that have not started, and
   *  the drafts, which by definition never have. */
  unstartedRuns(): RunConfig[] {
    const runs: RunConfig[] = []
    for (const tabId of this.tabOrder) {
      const session = this.sessionFor(tabId)
      if (session && !hasSessionStarted(session)) runs.push(session.run)
    }
    for (const draft of this.drafts.sessionDrafts.values()) runs.push(draft.run)
    return runs
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
      if (secondarySession) void this.lifecycle.refreshPluginCommands(secondarySession.run.workingDirectory, tabId, { onlyIfStale: true })
      requestInputFocus({ tabId })
      track('tab_selected', { via })
      return
    }
    const tab = this.tabs[tabId]
    const session = this.sessionFor(tabId)
    const previousTabId = this.activeTabId
    if (tabId === this.activeTabId) {
      // If a page covers the active conversation, selecting its tab reveals the
      // conversation again. Otherwise it is a no-op apart from read state.
      if (!this.showsConversation) this.resetOverlays({ closeArtifact: true })
      if (tab) tab.hasUnread = false
    } else {
      this.setActiveTab(tabId)
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
    if (session) void this.lifecycle.refreshPluginCommands(session.run.workingDirectory, tabId, { onlyIfStale: true })
    track('tab_selected', { via })
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
        this.drafts.openSessionDraft({ sourceId: tabId, via: 'click' })
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
      chatRoute(sessionId, this.sessions.byId[sessionId]?.run.serverId),
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
  closeTab(tabId: string, via: Via = 'click'): void {
    const serverId = this.sessionFor(tabId)?.run.serverId
    if (this.splitChatTabId === tabId) this.closeSplitPane()
    const tab = this.tabs[tabId]
    const sessionId = tab?.sessionId
    const closedTabIndex = this.tabOrder.indexOf(tabId)
    const newOrder = this.tabOrder.filter((id) => id !== tabId)
    this.onTabClosing?.(tabId)
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
      delete this.sessions.byId[sessionId]
    }
    if (serverId && !this.tabOrder.some((id) => id !== tabId && this.sessionFor(id)?.run.serverId === serverId)) {
      serverConnections.unretain(serverId)
      serverConnections.release(serverId)
    }

    // Which conversation comes next is the sidebar's call
    // (`SessionSidebarStore.closeTabs`); this only keeps the active id valid
    // until the caller selects it.
    if (this.activeTabId === tabId) {
      if (newOrder.length === 0) this.activeTabId = ''
      else this.setActiveTab(newOrder[0])
    }
    // Preserve the reactive array identity so closing one tab only invalidates the
    // removed index instead of rebuilding every tab-strip item.
    if (closedTabIndex !== -1) this.tabOrder.splice(closedTabIndex, 1)
    removePersistedTab(tabId, this.activeTabId)
    track('tab_closed', { via })
    // Closing the last tab lands on the draft you would have opened next, so no
    // surface has to describe a workspace with nothing in it.
    if (this.tabOrder.length === 0 && this.router.leadingPane.base?.name !== 'draft') {
      this.drafts.openSessionDraft({ via })
    }
  }

  /** Clear a conversation and remove its tab, then keep the focused pane on the
   *  dedicated draft surface. The draft is created first so it inherits the
   *  session's project and run configuration before the tab is removed. */
  clearTabToDraft(tabId: string, via: Via = 'click'): void {
    const draft = this.drafts.openSessionDraft({ via, sourceId: tabId })
    this.clearTab(tabId)
    this.closeTab(tabId, via)
    // Closing a split tab also closes its pane. Reopen the inherited draft in
    // whichever pane now owns focus; leading-pane clears are already a no-op.
    this.drafts.openDraft(draft.id, via)
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
    this.metadata.metadataFinalizedTabs.delete(targetTabId)
    if (session.run.workingDirectory && !session.run.gitContext) {
      void this.environment.refreshEnvironment(this, { sourceId: targetTabId })
    }
  }

  // ─── Tab configuration ───

  updateModelConfig(patch: Partial<import('@solus/contracts/types').ModelConfig>, tabId?: string, via: Via = 'click'): void {
    const session = tabId ? this.sessionFor(tabId) : this.activeSession
    const modelConfig = session?.run.modelConfig ?? this.config.globalDefaults.modelConfig
    const modelChanged = 'modelId' in patch && patch.modelId !== modelConfig.modelId
    this.config.updateModelConfig(patch, tabId)
    if (modelChanged) track('model_changed', { via })
  }

  setPermissionMode(mode: 'ask' | 'auto' | 'plan', tabId?: string, via: Via = 'click'): void {
    this.config.setPermissionMode(mode, tabId)
    track('permission_mode_set', { mode, via })
  }

  toggleWorktreeMode(sourceId?: string, via: Via = 'click'): void {
    const wasEnabled = !!this.runFor(sourceId ?? this.activeTabId)?.worktree
    this.config.toggleWorktreeMode(sourceId)
    const enabled = !!this.runFor(sourceId ?? this.activeTabId)?.worktree
    if (enabled !== wasEnabled) track('worktree_mode_toggled', { enabled, via })
  }

  async switchToWorktree(worktreePath: string, sourceId?: string, via: Via = 'click'): Promise<void> {
    await this.config.switchToWorktree(worktreePath, sourceId)
    track('worktree_switched', { via })
  }

  // ─── Attachments (UI-only, on the current input state) ───

  addAttachments(attachments: Attachment[], tabId?: string): void {
    const input = tabId === undefined ? this.currentInput : this.inputFor(tabId)
    input.attachments.push(...attachments)
  }

  // ─── Messaging ───

  addSystemMessage(content: string, tabId?: string): void {
    const session = tabId === undefined ? this.activeSession : this.sessionFor(tabId)
    if (!session) return
    session.messages.push({ id: nextMsgId(), role: 'system' as const, content, timestamp: Date.now() })
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

  // ─── Permissions & questions ───

  // ─── Event handlers ───

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
    let resolvedId = workId
    if (workId) {
      // Start the read, then show the pane's loading state while it
      // completes. WorkPane shares this pending read.
      void this.worksStore.ensureContent(workId, 'open-work-modal')
    } else {
      if (!title) return
      // workId not yet resolved (historical message) — load the list once, find by title
      await this.worksStore.loadAll()
      const entry = Object.entries(this.worksStore.works).find(([, w]) => w.title === title)
      if (!entry) return
      void this.worksStore.ensureContent(entry[0], 'open-work-modal-title-fallback')
      resolvedId = entry[0]
    }
    this.router.close('folio')
    this.openWork(resolvedId, opts.secondary ? 'aside' : 'focused')
    track('surface_viewed', { surface: 'work_modal', via: opts.via })
  }

  /** Open a work as the single artifact. `aside` puts it beside the
   *  conversation; otherwise it takes the focused pane. */
  openWork(workId: string, target: 'focused' | 'aside' = 'focused'): void {
    const serverId = this.worksStore.hostFor(workId) ?? undefined
    const params: Extract<RouteRef, { name: 'work' }>['params'] = { workId }
    if (serverId) params.serverId = serverId
    this.router.navigate(
      { name: 'work', params },
      { target: this.paneTarget(target) },
    )
  }

  /** Close a work and reveal a real prompt destination. A work can be opened
   *  before the first session exists; in that case the chat route has no tab
   *  to render, so restore the draft composer instead of exposing its empty
   *  conversation pool. */
  closeWork(paneId?: PaneId): void {
    if (paneId) this.router.closePane(paneId)
    else this.router.close('work')

    if (this.hasOpenTabs()) {
      requestInputFocus()
      return
    }

    const openDraftPane = this.router.panes.find(
      (pane) => pane.base?.name === 'draft'
        && this.drafts.sessionDrafts.has(pane.base.params.draftId),
    )
    if (openDraftPane) {
      const draftIndex = this.router.panes.indexOf(openDraftPane)
      if (draftIndex > 0) this.router.movePane(openDraftPane.id, -draftIndex)
      else this.router.focusPane(openDraftPane.id)
      requestInputFocus()
      return
    }

    let latestDraft: SessionDraft | null = null
    for (const draft of this.drafts.sessionDrafts.values()) latestDraft = draft
    if (latestDraft) this.drafts.openDraft(latestDraft.id)
    else this.drafts.openSessionDraft({ target: this.router.leadingPane.id, via: 'click' })
    requestInputFocus()
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
    const sessionRun = this.sessionFor(this.activeTabId)?.run
    const run = sessionRun ?? this.defaultRunConfig
    const provider: AgentId = sessionRun?.provider ?? 'claude-code'
    // The work is remembered on the host that created it, so both halves read
    // the same run.
    const api = this.apiForRun(run)
    const serverId = this.serverIdForRun(run)
    const work = await api.createWork(title, type, content, workPreview(type, content), undefined, provider, run.workingDirectory)
    this.worksStore.works[work.id] = work
    this.worksStore.rememberHost(work.id, serverId)
    this.router.close('folio')
    this.openWork(work.id)
  }

  /** Promote an HTML block the reader liked into an `artifact` work: a durable
   *  id the gallery lists, `update_work` revises, and a task can link. The
   *  block itself is ephemeral, so this is the one way it acquires identity.
   *  `sourceTabId` names the conversation it was read in; without one the work
   *  files against the active session, the way a hand-authored work does. */
  async createArtifact(html: string, sourceTabId?: string, title?: string): Promise<{ workId: string; title: string } | null> {
    const sessionRun = this.sessionFor(sourceTabId ?? this.activeTabId)?.run
    const run = sessionRun ?? this.defaultRunConfig
    const provider: AgentId = sessionRun?.provider ?? 'claude-code'
    const api = this.apiForRun(run)
    const serverId = this.serverIdForRun(run)
    try {
      const work = await api.createWork(
        resolveArtifactTitle(title, html),
        'artifact',
        html,
        workPreview('artifact', html),
        undefined,
        provider,
        run.workingDirectory,
      )
      this.worksStore.works[work.id] = work
      this.worksStore.rememberHost(work.id, serverId)
      return { workId: work.id, title: work.title }
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : 'Could not save this artifact.')
      return null
    }
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
    void this.worksStore.ensureContent(workId, 'open-chat-for-work')
    if (mode === 'resume' && resumeSid) {
      // find an open tab with this session on the work's own host, else resume
      const openTab = this.tabIdForAgentSession(resumeSid, this.worksStore.hostFor(workId) ?? undefined)
      if (openTab) { this.selectTab(openTab); targetTabId = openTab; resumed = true }
      else {
        targetTabId = await this.opening.resumeSession({
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
      // New work starts in the same pre-flight composer as every other fresh
      // session. The work binding crosses into the session only when Send
      // creates it, so an abandoned prompt leaves no empty tab behind.
      this.drafts.openSessionDraft(
        { freshTask: true, workId, target: this.router.leadingPane.id },
        work.cwd,
      )
      requestInputFocus()
      return
    }

    // A resumed session already exists, so attach the work immediately and
    // publish the back-reference now.
    if (targetTabId) {
      const s = this.sessionFor(targetTabId)
      if (s) {
        s.boundWorkId = workId
        if (s.agentSessionId) {
          this.worksStore.linkSession(workId, s.agentSessionId)
        }
      }
    }

    requestInputFocus()
  }

  /** Start a new session for work feedback. It joins the linked task when one
   *  exists and stays taskless otherwise. The comment is already a complete
   *  prompt, so no intermediate draft composer is needed. */
  async sendMessageToNewWorkSession(workId: string, prompt: string): Promise<boolean> {
    const work = this.worksStore.get(workId)
    if (!work) return false

    const linkTarget = { kind: 'work' as const, targetScope: '', targetKey: workId }
    const taskServerId = this.worksStore.hostFor(workId) ?? undefined
    await this.tasksStore.ensureLinkedTasks([linkTarget], taskServerId)
    const owningTask = this.tasksStore.linkedTasksFor(linkTarget)?.[0]

    this.router.closeGroup('page')
    this.openWork(workId, 'aside')
    void this.worksStore.ensureContent(workId, 'send-message-to-work')

    const draft = this.drafts.createSessionDraft(
      owningTask ? { taskId: owningTask.taskId, workId } : { withoutTask: true, workId },
      work.cwd,
    )
    if (taskServerId) draft.run.taskServerId = taskServerId
    const tabId = this.drafts.startSessionDraft(draft.id, { via: 'click' })
    if (!tabId) return false

    this.router.navigate(
      { name: 'chat', params: {} },
      { target: this.router.leadingPane.id },
    )
    return this.dispatch.sendMessage(prompt, undefined, tabId)
  }

  // ─── Pages ───
  //
  // A page is a route with `exclusiveGroup: 'page'`, so only one can exist.
  // `showPage` makes an explicit destination win over that reuse rule.

  showPage(
    ref: RouteRef,
    via: Via,
    surface: SolusEventMap['surface_viewed']['surface'],
    target: NavTarget = this.router.leadingPane.id,
  ): void {
    // An explicit target must beat page-group reuse. Main page entry points
    // name the leading pane; contextual links can name the companion. Without
    // clearing a page in the other pane first, exclusivity replaces it where it
    // already lives and silently ignores the requested destination.
    const existingPage = this.router.panes.find(
      (pane) => pane.base && ROUTES[pane.base.name].exclusiveGroup === 'page',
    )
    if (existingPage && (
      target === 'aside' ||
      target === 'new' ||
      (target !== 'focused' && existingPage.id !== target)
    )) {
      this.router.closeGroup('page')
    }
    this.router.navigate(ref, { via, target })
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

  /** The read-only record of a session whose transcript this client cannot reach. */
  openSessionRecord(sessionId: string, serverId: string, via: Via = 'click'): void {
    this.showPage({ name: 'sessionRecord', params: { sessionId, serverId } }, via, 'tasks')
  }

  openFolio(via: Via = 'click', target: 'focused' | 'aside' = 'focused'): void {
    this.showPage({ name: 'folio', params: {} }, via, 'workspace', this.paneTarget(target))
  }

  /** Open a plan as the single artifact. */
  openPlan(planId: string, target: 'focused' | 'aside' = 'focused'): void {
    this.router.navigate(
      { name: 'plan', params: { planId, serverId: this.planStore.hostFor(planId) ?? undefined } },
      { target: this.paneTarget(target) },
    )
  }

  /**
   * Open the browser pane — the running UI at a chosen viewport. Naming a page
   * deep-links it; without one the pane follows the browser store's active
   * page, or offers the dev servers the host discovered.
   *
   * `aside` by placement: looking at the app while directing an agent is the
   * gesture, not leaving the conversation to do it.
   */
  openBrowser(browserPageId?: string, serverId?: string): void {
    const params: Extract<RouteRef, { name: 'browser' }>['params'] = {}
    if (browserPageId) params.browserPageId = browserPageId
    if (serverId) params.serverId = serverId
    this.router.navigate({ name: 'browser', params }, { target: 'aside' })
  }

  /**
   * Open an ordinary web address in Solus's own browser.
   *
   * The host is named by the caller and never assumed. A link in a transcript
   * belongs to the session that produced it, and that session's project may be
   * served by a machine other than this one — a `localhost:5173` in an agent's
   * output means the agent's host, not the device the user is holding. Opening
   * it through the ambient client shell would resolve the address here instead,
   * which for a remote session is either nothing or the wrong app.
   *
   * The user's default browser stays the default for a plain click. This is the
   * explicit second way in, for the page a person wants beside the conversation
   * they are directing.
   */
  async openUrlInBrowser(url: string, serverId: string): Promise<void> {
    const key = await browserStore.open(serverId, { target: { kind: 'url', url } })
    this.openBrowser(splitHostKey(key).path, serverId)
  }

  /** A surface opening fresh covers the conversation; `aside` puts it beside
   *  one. Where an artifact of the same group is already open, exclusivity
   *  replaces it in place and this target is never consulted. */
  private paneTarget(target: 'focused' | 'aside'): NavTarget {
    return target === 'aside' ? 'aside' : this.router.leadingPane.id
  }

  // ─── Tasks page ───

  private sidebarRootTaskId(taskId: string): string {
    const task = this.tasksStore.peek(taskId)
    return task?.parentId ?? taskId
  }

  private sidebarSessionIdsForTab(tabId: string): string[] {
    const session = this.sessionFor(tabId)
    const tab = this.tabs[tabId]
    return [tab?.sessionId, session?.id, session?.handoffId, session?.agentSessionId]
      .filter((sessionId): sessionId is string => !!sessionId)
  }

  /** Record the task-scoped occurrence the user selected. This controls the
   * active path only; it does not create another automatic sidebar row. */
  selectSidebarTaskOccurrence(taskId: string, sessionId: string): void {
    this.sidebarTaskContextBySessionId.set(sessionId, this.sidebarRootTaskId(taskId))
  }

  /** Materialize the one permitted duplicate: a task/session pair the user
   * explicitly opened rather than one discovered by background reconciliation. */
  showExplicitSidebarTaskSession(taskId: string, sessionId: string): void {
    const rootTaskId = this.sidebarRootTaskId(taskId)
    this.explicitSidebarTaskSessions.add(`${rootTaskId}:${sessionId}`)
    this.sidebarTaskContextBySessionId.set(sessionId, rootTaskId)
  }

  hasExplicitSidebarTaskSession(taskId: string, sessionId: string): boolean {
    return this.explicitSidebarTaskSessions.has(
      `${this.sidebarRootTaskId(taskId)}:${sessionId}`,
    )
  }

  sidebarTaskContextForTab(tabId: string): string | null {
    for (const sessionId of this.sidebarSessionIdsForTab(tabId)) {
      const taskId = this.sidebarTaskContextBySessionId.get(sessionId)
      if (taskId) return taskId
    }
    return null
  }

  clearSidebarTaskOccurrences(taskId: string): void {
    const rootTaskId = this.sidebarRootTaskId(taskId)
    for (const key of this.explicitSidebarTaskSessions) {
      if (key.startsWith(`${rootTaskId}:`)) this.explicitSidebarTaskSessions.delete(key)
    }
    for (const [sessionId, contextTaskId] of this.sidebarTaskContextBySessionId) {
      if (contextTaskId === rootTaskId) this.sidebarTaskContextBySessionId.delete(sessionId)
    }
  }

  toggleTasks(via: Via = 'click'): void {
    // The page's own $effect loads on open (it needs the active project's cwd),
    // so there's nothing to kick off here — toggling just flips the route.
    this.togglePage({ name: 'tasks', params: {} }, via, 'tasks')
  }

  /**
   * Focus a session's open tab, or resume the session from the host's index when
   * no tab holds it: the one command a surface uses to reach a session it names
   * by id. A surface never reads the tab strip to find out (surface boundary,
   * `scripts/check-surface-boundary.ts`). The id is Solus's own, so the indexed
   * record decides the agent backend; loading a Claude transcript through Codex
   * returns an empty conversation. Answers the tab, or null when the host no
   * longer has the session. A background reveal opens without switching.
   */
  async revealSession(
    sessionId: string,
    serverId: string,
    opts: { background?: boolean } = {},
  ): Promise<string | null> {
    const openTab = findOpenTabForSession(sessionId, this.tabs, this.sessions.byId, this.tabOrder, undefined, serverId)
    if (openTab) {
      if (!opts.background) this.selectTab(openTab)
      return openTab
    }
    const meta = await readSessionMeta(serverId, sessionId)
    return meta ? await this.opening.resumeSession(meta, { background: opts.background }) : null
  }

  /** The open session showing a provider's session, on one host; see `tabIdForAgentSession`. */
  sessionForAgentSession(agentSessionId: string, serverId: string | undefined): Session | undefined {
    const tabId = this.tabIdForAgentSession(agentSessionId, serverId)
    return tabId ? this.sessionFor(tabId) : undefined
  }

  /** Open one task's page. Its own route, so it deep-links, joins history and
   *  can be opened beside the conversation from contextual entry points. */
  goToTask(
    taskId: string,
    via: Via = 'palette',
    target: 'leading' | 'secondary' = 'leading',
  ): void {
    this.showPage(
      { name: 'task', params: { taskId, serverId: this.tasksStore.get(taskId).serverId ?? undefined } },
      via,
      'tasks',
      target === 'secondary' ? 'new' : this.router.leadingPane.id,
    )
  }

  openTasks(via: Via = 'click', target: 'focused' | 'aside' = 'focused'): void {
    this.showPage({ name: 'tasks', params: {} }, via, 'tasks', this.paneTarget(target))
  }

  /** Open the standalone create-task modal. Current-project entry points may
   * preserve the active tab's branch/worktree; explicit project picks do not. */
  openTaskComposer(serverId: string, cwd: string, useActiveEnvironment = false): void {
    const activeContext = this.taskCreationContext
    const chosen = this.taskContextForCheckout(serverId, cwd)
    this.ui.taskComposer = useActiveEnvironment
      && activeContext
      && activeContext.serverId === chosen?.serverId
      && activeContext.projectKey === chosen.projectKey
      ? activeContext
      : chosen
  }

  // ─── Pull Requests page ───

  // Opening the page is enough; PrsPage loads once on open. Loading here too
  // would double every `pulls.list` on open, so leave the fetch to the page.
  // The list's filters are the device's remembered choices, not reset here.
  togglePrs(via: Via = 'click'): void {
    this.togglePage({ name: 'prs', params: {} }, via, 'prs')
  }

  openPrs(
    projectPath: string | null = null,
    via: Via = 'click',
    target: 'focused' | 'aside' = 'focused',
  ): void {
    this.showPage(
      { name: 'prs', params: { projectPath: projectPath ?? undefined } },
      via,
      'prs',
      this.paneTarget(target),
    )
  }

  // ─── Insights page ───
  //
  // The page loads its own registry, saved queries, and histogram on entry —
  // it needs the active host, which the store resolves — so opening one is
  // just a location change.

  toggleInsights(via: Via = 'click'): void {
    this.togglePage({ name: 'insights', params: {} }, via, 'insights')
  }

  openInsights(via: Via = 'click', target: 'focused' | 'aside' = 'focused'): void {
    this.showPage({ name: 'insights', params: {} }, via, 'insights', this.paneTarget(target))
  }

  /** One turn's waterfall, by the trace that identifies it: the Insights page
   *  with that turn's detail panel open beside the list. Naming a span opens
   *  the waterfall with that span's detail already expanded. */
  openInsightsTurn(traceId: string, spanId?: string, via: Via = 'click'): void {
    this.showPage({ name: 'insights', params: spanId ? { traceId, spanId } : { traceId } }, via, 'insights')
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
  openAutomations(
    focusId?: string | null,
    via: Via = 'click',
    target: 'focused' | 'aside' = 'focused',
  ): void {
    if (focusId && this.shell.hasCompanionPanes) this.openAutomationBuilder(focusId, target)
    else {
      this.showPage(
        { name: 'automations', params: { automationId: focusId ?? undefined } },
        via,
        'automations',
        this.paneTarget(target),
      )
    }
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
      { target: this.paneTarget(target) },
    )
    void this.automationsStore.loadAll(serverId)
  }

  // ─── Diff comments (on Tab — UI-only) ───

  submitDiffFeedback(generalComment: string, tabId?: string): boolean { const submitted = submitDiffFeedback(this, generalComment, tabId); if (submitted) track('diff_feedback_submitted', {}); return submitted }
  async submitDiffFeedbackToNewSession(opts: Parameters<typeof submitDiffFeedbackToNewSession>[1]): Promise<boolean> {
    const submitted = await submitDiffFeedbackToNewSession(this, opts); if (submitted) track('diff_feedback_submitted', {}); return submitted
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
    this.ui.unifiedPickerOpen = false
    this.showPage({ name: 'settings', params: { tab } }, via, 'settings')
    track('settings_opened', { tab, via })
  }

  /** Move between settings tabs without stacking a history entry per tab. */
  selectSettingsTab(tab: SettingsTab) {
    this.router.navigate({ name: 'settings', params: { tab } }, { replace: true })
  }

  // ─── Arriving from outside ───

  /**
   * Enter a route that came from somewhere other than a click in the UI: an
   * agent-emitted `plan://` link, a notification payload, a deep link. The
   * router places it; this adds whatever the destination needs on entry that a
   * bare navigation cannot know about — a plan's body off disk, a PR's provider
   * detail, or a session that must be resumed.
   */
  openRoute(
    ref: RouteRef,
    opts: { via?: Via; target?: NavTarget; sourceUrl?: string; tab?: PrReviewTab } = {},
  ): void {
    switch (ref.name) {
      case 'plan':
        if (ref.params.planId) {
          void this.openPlanModal(ref.params.planId, undefined, {
            secondary: opts.target === 'aside' || opts.target === 'new',
          })
        }
        return
      case 'work':
        if (ref.params.serverId) {
          this.worksStore.rememberHost(ref.params.workId, ref.params.serverId)
        }
        void this.openWorkModal(ref.params.workId, undefined, {
          secondary: opts.target === 'aside' || opts.target === 'new',
          via: opts.via,
        })
        return
      case 'task':
        this.showPage(ref, opts.via ?? 'click', 'tasks', opts.target)
        return
      case 'prReview':
        void this.prReview.openPullRequest({
          number: ref.params.number,
          title: ref.params.title,
          expectedRepo: ref.params.expectedRepo,
          url: opts.sourceUrl,
        }, {
          // URL-backed PRs, from a transcript or task menu, check access before
          // moving a pane so an unreadable PR opens in the browser instead.
          preflight: opts.sourceUrl !== undefined,
          tab: opts.tab,
          via: opts.via,
          target: opts.target,
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
                this.sessions.byId,
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
            if (meta) void this.opening.resumeSession(meta)
          })
        }
        return
      }
      default:
        this.router.navigate(ref, { via: opts.via })
    }
  }

  // ─── Viewers ───

  /** Show a session's changes in the review pane. A generic toggle closes
   *  whatever review is open; `switchScope` is the explicit "view working tree
   *  diff" action, which switches a mismatched-scope review instead of closing
   *  it. */
  toggleDiff(sourceTabId: string, scope: DiffScope = { kind: 'session' }, switchScope = false): void {
    const current = this.router.overlay
    if (current?.name === 'review' && (!switchScope || current.params.scope?.kind === scope.kind)) {
      this.router.closeOverlay()
      return
    }
    if (!this.sessionFor(sourceTabId)?.run.workingDirectory) return
    this.showDiff(sourceTabId, scope)
  }

  /** Open the review pane on the change itself. Diff is the primary reading
   *  view; the map and guide stay one tab away. */
  showDiff(sourceTabId: string, scope: DiffScope = { kind: 'session' }, filePath?: string): void {
    const params: RouteParams['review'] = {
      sourceTabId,
      view: 'diff',
      scope,
    }
    if (filePath) params.filePath = filePath
    this.showViewer({ name: 'review', params })
  }

  /** `sourceId` is a tab or a draft: the file tree follows its run, so browsing
   *  from a draft opens the project that draft will run in. The route keeps the
   *  resolved target, not this temporary owner, so starting the draft cannot
   *  reload the pane. */
  openFiles(sourceId: string): void {
    const run = this.runFor(sourceId)
    const environment = this.environment.environmentFor(run)
    if (!environment.cwd || environment.cwd === '~') return
    this.showViewer({
      name: 'files',
      params: {
        serverId: this.serverIdForRun(run),
        cwd: environment.cwd,
      },
    })
  }

  openFileInFiles(file: FilePreviewRequest, sourceId: string, sourcePaneId?: PaneId): void {
    const run = this.runFor(sourceId)
    const environment = this.environment.environmentFor(run)
    if (!environment.cwd || environment.cwd === '~') return
    this.showViewer(
      {
        name: 'files',
        params: { serverId: this.serverIdForRun(run), cwd: environment.cwd, path: file.path, line: file.line },
      },
      sourcePaneId ? this.router.targetAcrossFrom(sourcePaneId) : 'aside',
    )
  }

  /** Pop a sub-agent's nested transcript out of its card into a companion pane. */
  openSubagent(tabId: string, messageId: string): void {
    const sessionId = this.tabs[tabId]?.sessionId
    if (!sessionId) return
    this.showViewer({
      name: 'subagent',
      params: { sessionId, messageId, serverId: this.sessions.byId[sessionId]?.run.serverId },
    })
  }

  /** Viewers cover a companion pane and size themselves. */
  private showViewer(ref: RouteRef, target: NavTarget = 'aside'): void {
    const pane = this.router.navigate(ref, { target })
    pane.defaultSize = 60
  }

  // ─── Reviews ───

  /** Open one view of the review pane. `scope` is the guide scope: a session
   *  walkthrough reads the session's own changes, a branch one reads the whole
   *  branch — which the pane resolves live, so the route carries no base. */
  enterReview(
    scope: 'branch' | 'session' = 'branch',
    sourceTabId?: string,
    view: ReviewView = 'diff',
  ): void {
    const reviewTabId = sourceTabId ?? this.activeTabId
    if (!reviewTabId) return
    if (scope === 'session') {
      reviewGuideStore.markOpened(
        this.serverIdFor(reviewTabId),
        sessionGuideIdentity(this.sessionFor(reviewTabId)),
      )
    }
    const params: RouteParams['review'] = { sourceTabId: reviewTabId, view }
    if (scope === 'session') params.scope = { kind: 'session' }
    this.showViewer({ name: 'review', params })
  }

  /** Open the exact guide selected by a durable conversation reference. */
  openReviewGuide(
    target: ReviewTarget,
    sourceTabId: string,
    prepared?: { repoRoot: string; key: string; serverId: string },
  ): void {
    if (target.kind === 'pr' && prepared) {
      this.showViewer({
        name: 'review',
        params: {
          sourceTabId,
          view: 'guide',
          target,
          guideKey: prepared.key,
          cwd: prepared.repoRoot,
          serverId: prepared.serverId,
        },
      })
      reviewGuideStore.markOpened(prepared.serverId, {
        repoRoot: prepared.repoRoot,
        key: prepared.key,
        target,
        headSha: target.headSha,
      })
      requestInputFocus({ tabId: sourceTabId })
      return
    }
    const params: RouteParams['review'] = { sourceTabId, view: 'guide' }
    if (target.kind === 'session') params.scope = { kind: 'session' }
    if (target.kind === 'working-tree') params.scope = { kind: 'working-tree' }
    this.showViewer({ name: 'review', params })
    requestInputFocus({ tabId: sourceTabId })
  }

}

export const [getWorkspaceContext, setWorkspaceContext] = createAppContext<WorkspaceContext>('workspace')
