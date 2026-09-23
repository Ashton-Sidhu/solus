import type { GitCheckout, IpcContext, RunConfig, Session, Work } from '@solus/contracts/types'
import type { TasksStore } from '../tasks/tasks.store.svelte'
import type { LogicalProject, ProjectPageScope, ProjectRef } from '../projects/project-catalog'
import type { StaticInfo } from '../workspace/workspace-lifecycle.store.svelte'
import type { TaskCreationContext } from '../../components/tasks/lib/task-creation-context'
import type { ListProjectOption } from '../../components/ui/list-page/list-page'
import type { WorksStore } from '../works/works.store.svelte'
import type { OutboxStore } from '../outbox/outbox.store.svelte'
import type { AutomationsStore } from '../automations/automations.store.svelte'
import type { PlanStore } from '../plans/plan.store.svelte'
import type { HostApi } from '@solus/client-core/host-api'
import type { SettingsContext } from './settings.context.svelte'
import type { WorkspaceContext } from '../workspace/workspace.context.svelte'
import type { SessionOpening } from '../workspace/session-opening'
import type { PrReviewActions } from '../workspace/pr-review-actions'
import type { PaneId } from '../workspace/routing/location'
import type { Via } from '@solus/contracts/analytics-events'
import { createAppContext } from './create-app-context'

/**
 * What a record surface reads (docs/plans/cloud-console-native-pages.md §4):
 * the stores of its hosts, an RPC context for a call that names a working
 * directory, and the commands that open another resource. The workspace
 * provides it (`WorkspaceContext`, `workspace = this`); a client that renders a
 * record with no runner behind it provides one with `workspace = null`. A
 * surface asks `workspace` before it offers a control only the workspace has —
 * a split chat, the plan modal, the automation builder — and omits the control
 * when null.
 *
 * Do not add a member here that needs a runner to satisfy; that member is a
 * workspace command, listed in `WorkspaceCommands` and reached through
 * `workspace`.
 */
export interface SurfaceContext {
  readonly settings: SettingsContext
  readonly tasksStore: TasksStore
  readonly worksStore: WorksStore
  readonly outboxStore: OutboxStore
  /** A transcript's plan and automation cards resolve against these. */
  readonly automationsStore: AutomationsStore
  readonly planStore: PlanStore
  readonly deferHistoryToolInputs: boolean
  /** The host a session is read from: its tab's host, or the one host a runnerless client holds. */
  apiForSession(sessionId: string): HostApi
  /** The project the task board is scoped to; null with no runner. */
  readonly tasksProjectCwd: string | null
  readonly pluginCommands: Session['pluginCommands']
  /** The session the person is in, when this client has one. */
  readonly activeSession: Session | undefined
  sessionForAgentSession(agentSessionId: string, serverId: string | undefined): Session | undefined
  ctxForDirectory(workingDirectory: string): IpcContext
  ctxForEnvironment(workingDirectory: string, gitContext: GitCheckout | null): IpcContext
  /** The RPC context of the surface the person is on: the active tab's, or one host with no directory. */
  readonly ctx: IpcContext
  /** The host's static facts; null with no runner. */
  readonly staticInfo: StaticInfo | null
  /** The run the input bar names; undefined with no input bar. */
  readonly activeRun: RunConfig | undefined
  /** The project a new task files against; null where a task cannot be made. */
  readonly taskCreationContext: TaskCreationContext | null
  /** The checkout the input bar is in, as a host and repository root; null with none. */
  readonly activeCheckout: ProjectRef | null
  /** Where a task filed in a project goes (docs/plans/project-model.md §4):
   *  the host of `checkout`, else the cloud workspace for a project the
   *  organization has. Null when neither can take it. */
  taskContextForProject(projectKey: string, checkout: ProjectRef | null): TaskCreationContext | null
  /** Scope the project pages to the input bar's project; false when it names none. */
  scopePageToCurrentProject(): boolean
  /** Scope the project pages to one project, by its key. */
  scopePageToProject(projectKey: string): void
  /** Every project the pages list, one per repository (docs/plans/project-model.md). */
  readonly logicalProjects: LogicalProject[]
  /** The same projects as rows of a page's project selector. */
  readonly projectScopeOptions: ListProjectOption[]
  // ── The boards (docs/plans/cloud-console-native-pages.md §9) ──
  /** The project authority the boards share. A board owns it while open. */
  readonly projectPageScope: ProjectPageScope
  setProjectPageScope(scope: ProjectPageScope): void
  goToTask(taskId: string, via?: Via, target?: 'leading' | 'secondary'): void
  openTasks(via?: Via, target?: 'focused' | 'aside'): void
  openWork(workId: string, target?: 'focused' | 'aside'): void
  openFolio(via?: Via, target?: 'focused' | 'aside'): void
  closeWork(paneId?: PaneId): void
  /** Delete a work with a brief undo window. */
  requestWorkDelete(work: Work): void
  /** Create an empty user-authored work on the surface's host and open it. */
  createBlankWork(type: 'doc' | 'slides' | 'diagram'): Promise<void>
  /** Create a user-authored work from existing content (blank or imported) and open it. */
  createWorkFromContent(title: string, type: 'doc' | 'slides' | 'diagram', content: string): Promise<void>
  /** The commands only the workspace has, or null on a client without one. */
  readonly workspace: WorkspaceCommands | null
}

/**
 * The workspace commands a record surface may use, and no others. A surface
 * that needs another one adds it here, which makes each new reach from a
 * portable surface into the runner-backed workspace a visible decision.
 */
export type WorkspaceCommands = Pick<WorkspaceContext,
  // Where the person is: panes, tabs, and the sessions they show.
  | 'router'
  | 'maximizedPaneId'
  | 'activeTabId'
  | 'focusedChatTabId'
  | 'leadingInput'
  | 'tabs'
  | 'tabOrder'
  | 'sessions'
  | 'sessionFor'
  | 'runFor'
  | 'staticInfo'
  | 'fallbackServerId'
  | 'apiFor'
  | 'ctxFor'
  // Sessions reached from a record.
  | 'revealSession'
  | 'openSplitChat'
  | 'notifySessionUnavailable'
  // Plans, works, and other destinations.
  | 'openPlanModal'
  | 'openPlanFromDescriptor'
  | 'resumeSessionFromDescriptor'
  | 'loadPlanContent'
  | 'openWork'
  | 'openWorkModal'
  | 'openChatForWork'
  | 'sendMessageToNewWorkSession'
  | 'createArtifact'
  | 'openAutomations'
  | 'openAutomationBuilder'
  | 'openInsights'
  | 'openPrs'
  | 'openRoute'
  | 'openUrlInBrowser'
  | 'showSettings'
> & {
  readonly opening: Pick<SessionOpening, 'resumeSession' | 'openTaskSession' | 'openTaskLinkedSession'>
  readonly prReview: Pick<PrReviewActions, 'openReviewMode'>
}

export const [getSurfaceContext, setSurfaceContext] = createAppContext<SurfaceContext>('surface')
