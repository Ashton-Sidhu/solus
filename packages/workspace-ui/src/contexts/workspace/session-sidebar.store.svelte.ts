import type { TaskOpenTrace } from '../../components/session/lib/task-open-timing'
import { createAppContext } from '../app/create-app-context'
import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import { untrack } from 'svelte'
import { worktreeProjectRoot, type AgentId, type PinnedSession, type Session, type Tab } from '@solus/contracts/types'
import type { Task, TaskSessionLink } from '@solus/contracts/task-types'
import { parseGitHubPullRequestUrl } from '@solus/contracts/providers'
import { makePrompt } from './session.factories'
import { existingTaskId, taskRoleOf } from './session-draft.svelte'
import { firstActivityAt, lastActivityAt, turnStartedAt, withLazyActivity } from './session-activity'
import {
  buildProjectSummaries,
  disclosedSession,
  maxTaskAttention,
  dedupePrChoices,
  reconcileSidebarTasks,
  resolveTaskSidebarLifecycle,
  sessionRowLifecycle,
  shouldShelveCompletedTask,
  shouldShowDurableSidebarTask,
  shouldShowSidebarChild,
  isInWorkingSection,
  isWorkingStatus,
  projectFilterChoices,
  resolveProjectFilter,
  sortTasksByCreation,
  sortSidebarRowsByCreation,
  sortRowsByReturn,
  sortTasks,
  taskStatusFor,
  type ProjectFilterChoice,
  type ProjectSummary,
  type SidebarLinkedTask,
  type SidebarTask,
  type MountedPrObservation,
  type TaskPrChoice,
} from '../../components/session/lib/task-list'
import { draftTitle, sessionDraftTitle, type DraftRow } from '../../components/session/lib/draft-list'
import { projectsStore } from '../projects/projects.store.svelte'
import { CHAT_LABEL } from '../../lib/paths'
import { isChat } from '@solus/contracts/chat'
import type { ListProjectOption } from '../../components/ui/list-page/list-page'
import { pickerProjectKeys } from '../../components/session/unified-picker/lib/picker-rows'
import { SidebarSessionStatusFeed } from '../../components/session/lib/sidebar-session-status'
import { SidebarReturnOrder } from '../../components/session/lib/sidebar-return-order'
import {
  attemptServerId,
  findOpenTabForSession,
  getAttentionState,
  sessionLimitResetsAt,
  sessionDisplayName,
  sessionTitle,
  type AttentionState,
} from '../../lib/sessionUtils'
import { environmentBranchKey, environmentProjectKey } from '../git/session-environment.store.svelte'
import type { PlanStore } from '../plans/plan.store.svelte'
import type { SettingsContext } from '../app/settings.context.svelte'
import type { WorkspaceContext } from './workspace.context.svelte'
import type { PrsStore } from '../prs/prs.store.svelte'
import type { PrChecksStore } from '../prs/pr-checks.store.svelte'
import { repositoryKeyOf } from '@solus/contracts/repository-key'
import { checksPresentation } from '../../components/prs/lib/checks'
import type { Via } from '@solus/contracts/analytics-events'
import { nextOpenSidebarTabAfterClose } from './session-sidebar-selection'
import {
  loadDismissedSidebarRowKeys,
  loadOpenSidebarTaskIds,
  persistDismissedSidebarRow,
  persistOpenSidebarTaskIds,
  removeDismissedSidebarRows,
} from './tab-persistence'
import {
  reviewGuideStore,
  sessionGuideIdentity,
} from '../../components/review/review-guide.store.svelte'
import { serverConnections } from '@solus/client-core/server-connections'
import { hostKey } from '@solus/client-core/host-key'
import { readSessionMeta } from '@solus/client-core/session-meta'
import { isSolusApiId } from '@solus/contracts/uplink'
import { mergeSessionHomes, type SessionHomeHosts } from '../../components/session/lib/session-home'
import { subscribeAllHosts } from '@solus/client-core/host-events'
import { sessionPrLink, sessionPullRequestsStore } from '../prs/session-pull-requests.store.svelte'
import type { SessionPullRequestLink } from '@solus/contracts/session-pull-requests'
import { sessionStatesStore, type ShelvedSession } from './session-states.store.svelte'
import { canDriveSession } from '../sharing/session-drive'
import {
  prLinkDiscoveryAttempts,
  type PrLinkDiscoveryAttempt,
} from './pr-link-discovery'

function restoredSessionActivityAt(
  liveActivityAt: number,
  link: Pick<TaskSessionLink, 'lastActivityAt' | 'linkedAt'>,
): number {
  return liveActivityAt || link.lastActivityAt || link.linkedAt
}

export type SidebarSessionChild = {
  /** Present once this child session is mounted. Durable session rows remain
   *  visible without it and resume their session only when selected. */
  tabId?: string
  taskId?: string
  sessionId?: string
  projectKey?: string
  /** Branch or worktree this session works on. Null off a branch. */
  branchName: string | null
  label: string
  attention: AttentionState
  /** True while this session has output or an error the user has not viewed. */
  unread: boolean
  /** Session history mixes hosts, so each row has to carry the one it runs on. */
  serverId: string | null
  /** Agent and resolved model used by this session. */
  provider?: AgentId | null
  modelId?: string | null
  /** Start of the turn in flight, for the elapsed readout. 0 unless running. */
  runStartedAt: number
  /** While rate limited: when the provider window reopens, in epoch ms.
   *  Absent when the session is not limited or no reset is known. */
  limitResetsAt?: number
  /** Newest known session activity. The task/session index supplies this for
   * closed sessions; mounted sessions use their live transcript. */
  lastActivityAt: number
  /** Stable persisted key for hiding this child without deleting its task or session. */
  dismissalKey?: string
  /** Background walkthrough state for this exact agent session. */
  reviewGuideStatus: 'generating' | 'ready' | null
  /** Durable walkthrough state shown in the row tooltip after its notification
   * mark has been acknowledged. */
  reviewGuideTooltipStatus?: 'generating' | 'ready' | null
  /** The row is the cloud record of a session whose runner is not connected
   *  (docs/plans/cloud-service-model.md R8): it opens read-only. */
  runnerOffline?: boolean
  /** This session is its task's lead: the one the task's row stands for
   *  (docs/plans/task-conversation.md). Listed first. */
  isLead?: boolean
}

/** A row's project name. A chat has no project, so it reads "Chat". */
function projectLabel(projectKey: string): string {
  if (isChat(projectKey)) return CHAT_LABEL
  return projectKey === '~' ? '~' : projectKey.replace(/\/$/, '').split('/').at(-1) ?? '~'
}

/** Every chat files under one heading: each has its own folder, but none is a project. */
const CHATS_GROUP_KEY = 'solus:chats'

/** The project a row groups and filters under: the repository key, or the chats. */
export function groupKeyFor(serverId: string, projectKey: string): string {
  if (isChat(projectKey)) return CHATS_GROUP_KEY
  return projectKey === '~' ? projectKey : projectsStore.projectKeyFor(serverId, projectKey)
}

/** Every mounted conversation the sidebar must project. `tabOrder` gives the
 * stable display order, but a session started without activation can mount in a
 * companion pane before that pool represents it. Append those mounted tabs so a
 * secondary-pane send gets its immediate first-prompt row too. */
export function mountedSidebarTabIds(
  tabOrder: readonly string[],
  tabs: Readonly<Record<string, Tab>>,
): string[] {
  const mounted = tabOrder.filter((tabId) => !!tabs[tabId])
  const seen = new Set(mounted)
  for (const tabId of Object.keys(tabs)) {
    if (seen.has(tabId)) continue
    mounted.push(tabId)
    seen.add(tabId)
  }
  return mounted
}

/** The homes as the saved-host registry and the live sockets know them, without a reactive store. */
export function registrySessionHomes(): SessionHomeHosts {
  return {
    isSolusApi: isSolusApiId,
    isConnected: (serverId) => !!serverId && serverConnections.statusFor(serverId) === 'connected',
  }
}

export class SessionSidebarStore {
  private taskModelsById = new Map<string, SidebarTask>()
  /** The Completed shelf's own identity map. Its rows are disjoint from the
   *  column's, so they cannot share one without evicting each other. */
  private shelvedRowModelsById = new Map<string, SidebarTask>()
  private liveSessionStatuses?: SidebarSessionStatusFeed
  private openTaskIds: SvelteSet<string>
  private hasSettledBootLocation = false

  private sessionStatusFeed(): SidebarSessionStatusFeed {
    return this.liveSessionStatuses ??= new SidebarSessionStatusFeed()
  }

  /** Pinned sessions, most-recently-pinned first. Loaded on bootstrap, mutated by pin/unpin. */
  pinnedSessions = $state<PinnedSession[]>([])
  visibleTabIds: string[] = $derived.by(() => mountedSidebarTabIds(
    this.session.tabOrder,
    this.session.tabs,
  ))

  /** Which tab, if any, has a given session mounted. Built once per
   *  pass: every task row needs this answer for each of its linked sessions, and
   *  scanning the open tabs per lookup made the column O(tasks × sessions × tabs)
   *  on every stream tick. */
  private tabIdBySessionId: Map<string, string> = $derived.by(() => {
    const bySessionId = new Map<string, string>()
    for (const tabId of this.visibleTabIds) {
      const tab = this.session.tabs[tabId]
      const session = this.session.sessionFor(tabId)
      if (!tab) continue
      bySessionId.set(tab.sessionId, tabId)
      if (session?.run.serverId) bySessionId.set(hostKey(session.run.serverId, tab.sessionId), tabId)
    }
    return bySessionId
  })

  /** Durable tasks remain in the task board after their sidebar row is closed.
   *  This is persisted view state only: closing a row must not rewrite the
   *  task's lifecycle status. A later, explicitly opened tab restores it. */
  private dismissedRowKeys = new SvelteSet<string>(loadDismissedSidebarRowKeys())

  /** Advances when the next snooze is due, so a shelved row returns on time. */
  lifecycleNow = $state(Date.now())
  readonly regeneratingPinnedSessionIds = new SvelteSet<string>()

  /** Tabs opened for a task that do not have a durable link yet. */
  private pendingTabByTaskId: Map<string, string[]> = $derived.by(() => {
    const byTaskId = new SvelteMap<string, string[]>()
    for (const tabId of this.visibleTabIds) {
      const sess = this.session.sessionFor(tabId)
      // `session_init` assigns the provider id before the durable task link has
      // finished hydrating. The provisional task id must keep owning the tab
      // during that handoff or the row briefly changes shape in the sidebar.
      const task = this.pendingTaskFor(sess)
      if (!task) continue
      const tabIds = byTaskId.get(task.id)
      if (tabIds) tabIds.push(tabId)
      else byTaskId.set(task.id, [tabId])
    }
    return byTaskId
  })

  /** The task an unlinked tab already belongs to: the one it was opened for. */
  private pendingTaskFor(session: Session | null | undefined): Task | undefined {
    const taskId = session ? existingTaskId(session.task) : undefined
    if (!taskId) return undefined
    return this.session.tasksStore.tasks.find((candidate) => candidate.id === taskId)
  }

  /**
   * Whether a link earns the session a row under this task. The owning link
   * does — the host keeps exactly one `working` owner per session, so this is
   * what makes one conversation one row. A `referenced` link is a relationship
   * the task page shows; it projects a row only where the user opened that
   * task and asked to see its sessions. An optimistic link written before the
   * host answered carries no role yet and is the owner by construction.
   */
  private projectsSessionUnder(
    rootTaskId: string,
    link: Pick<TaskSessionLink, 'sessionId' | 'role'>,
  ): boolean {
    return link.role !== 'referenced'
      || this.session.hasExplicitSidebarTaskSession(rootTaskId, link.sessionId)
  }

  /**
   * One durable task's row, aggregated over its sessions. Shared by the
   * active column and the Completed shelf, which select different tasks but
   * describe each of them identically — a finished task must not read
   * differently because it is being listed as history.
   *
   * `openTabBySessionId` is passed in rather than read here so a caller
   * building many rows reads that index once.
   */
  private buildDurableTaskRow(
    task: Task,
    openTabBySessionId: Map<string, string>,
  ): SidebarTask {
    const tabIds: string[] = []
    let attention: AttentionState = null
    let unread = false
    let createdAt = task.createdAt ?? task.updatedAt
    let runStartedAt = 0
    let limitResetsAt: number | undefined
    // The host the task is being worked on, taken from the first session it
    // has open. A task record remembers a project, never a machine — but its
    // links remember one each, which is what answers for a task whose only
    // session is closed.
    let serverId: string | null = null
    let linkedServerId: string | null = null

    const taskModel = this.session.tasksStore.get(task.id)
    const leadSessionId = taskModel.sessions.find((link) => link.role === 'lead')?.sessionId
    for (const link of taskModel.sessions) {
      if (!this.projectsSessionUnder(task.id, link)) continue
      const linkServerId = attemptServerId({ link, taskServerId: taskModel.serverId })
      linkedServerId ??= linkServerId
      createdAt = Math.min(createdAt, link.startedAt ?? createdAt)
      const tabId = linkServerId
        ? openTabBySessionId.get(hostKey(linkServerId, link.sessionId))
        : openTabBySessionId.get(link.sessionId)
      // The feed speaks for the sessions with no tab, as its name says. A
      // mounted tab knows the same status and, unlike the feed, whether the
      // user has read it — letting the feed answer for one kept a viewed
      // failure red on the parent row.
      if (!tabId) {
        const liveState = this.sessionStatusFeed().stateFor(linkServerId, link.sessionId)
        attention = maxTaskAttention(attention, liveState?.attention ?? null)
        if (liveState?.attention === 'running') {
          runStartedAt = runStartedAt === 0
            ? liveState.runStartedAt
            : Math.min(runStartedAt, liveState.runStartedAt)
        }
        continue
      }
      if (tabIds.includes(tabId)) continue
      tabIds.push(tabId)
      const tab = this.session.tabs[tabId]
      const session = this.session.sessionFor(tabId)
      if (!tab || !session) continue
      createdAt = Math.min(createdAt, firstActivityAt(session))
      serverId ??= session.run.serverId ?? null
      const nextAttention = getAttentionState(session, tab, this.planStore.plans)
      attention = maxTaskAttention(attention, link.role === 'lead' || nextAttention !== 'unread' ? nextAttention : null)
      if (link.role === 'lead') unread ||= tab.hasUnread
      limitResetsAt ??= sessionLimitResetsAt(session) ?? undefined
      if (nextAttention === 'running') {
        const startedAt = turnStartedAt(session)
        if (startedAt > 0) runStartedAt = runStartedAt === 0 ? startedAt : Math.min(runStartedAt, startedAt)
      }
    }

    // Provisional tabs come last so an undispatched tab never becomes the
    // navigation target. Once session_init arrives, though, its live state
    // must immediately drive the parent row while the durable link hydrates.
    for (const pendingTabId of this.pendingTabByTaskId.get(task.id) ?? []) {
      if (tabIds.includes(pendingTabId)) continue
      tabIds.push(pendingTabId)
      const tab = this.session.tabs[pendingTabId]
      const session = this.session.sessionFor(pendingTabId)
      if (!tab || !session) continue
      createdAt = Math.min(createdAt, firstActivityAt(session))
      serverId ??= session.run.serverId ?? null
      const nextAttention = getAttentionState(session, tab, this.planStore.plans)
      const isLead = taskRoleOf(session.task) === 'lead' && (!leadSessionId || tab.sessionId === leadSessionId)
      attention = maxTaskAttention(attention, isLead || nextAttention !== 'unread' ? nextAttention : null)
      if (isLead) unread ||= tab.hasUnread
      limitResetsAt ??= sessionLimitResetsAt(session) ?? undefined
      if (nextAttention === 'running') {
        const startedAt = turnStartedAt(session)
        if (startedAt > 0) runStartedAt = runStartedAt === 0 ? startedAt : Math.min(runStartedAt, startedAt)
      }
    }
    const projectKey = worktreeProjectRoot(task.projectKey ?? '~')
    // A snoozed task is on the Snoozed shelf; a finished task is on the
    // Completed shelf.
    const lifecycle = resolveTaskSidebarLifecycle({
      status: task.status,
      doneAt: task.doneAt,
      updatedAt: task.updatedAt,
      snoozedUntil: task.snoozedUntil,
      lastReadAt: task.lastReadAt,
      attention,
      now: this.lifecycleNow,
    })
    return {
      id: task.id,
      taskId: task.id,
      key: task.id,
      title: task.title,
      projectKey,
      projectLabel: projectLabel(projectKey),
      groupKey: isChat(projectKey) ? CHATS_GROUP_KEY : this.session.tasksStore.projectKeyOf(task) ?? projectKey,
      branchName: null,
      serverId: serverId ?? linkedServerId,
      prNumber: this.session.tasksStore.get(task.id).prLink?.number || null,
      // A completed task can receive more work through its existing session.
      // Live attention then outranks the stale lifecycle verdict, just as it
      // does for the sidebar's session-only completion check.
      status: taskStatusFor(attention, task.status === 'done' || task.status === 'dropped'),
      attention,
      unread,
      createdAt,
      runStartedAt,
      limitResetsAt,
      lifecycle: lifecycle.lifecycle,
      completedAt: lifecycle.completedAt,
      snoozedUntil: lifecycle.snoozedUntil,
      snoozeNote: task.snoozeNote ?? null,
      lastReadAt: lifecycle.lastReadAt,
      woke: lifecycle.woke,
      tabIds,
    }
  }

  /**
   * Whether a task earns a row in the Tasks section: while it is open on this
   * client. It was opened here (`openTaskIds`, written by `restoreTask` and
   * `releaseTab`), or its lead's conversation is mounted. Another of its
   * sessions does not open it: that session keeps a row of its own in the
   * Sessions section, with the task on a chip
   * (docs/plans/task-conversation.md, decision 5).
   *
   * Read straight from the tabs, in the same pass that decides which sessions
   * keep a row of their own, so no session is without a row for one render.
   */
  private isDurableRowShown(task: Task, openTabBySessionId: Map<string, string>): boolean {
    const hasLeadTab = this.session.tasksStore.get(task.id).sessions.some((link) =>
      link.role === 'lead' && openTabBySessionId.has(link.sessionId),
    ) || (this.pendingTabByTaskId.get(task.id) ?? []).some((tabId) => {
      const session = this.session.sessionFor(tabId)
      return !!session && taskRoleOf(session.task) === 'lead'
    })
    return shouldShowDurableSidebarTask(
      this.dismissedRowKeys.has(task.id),
      hasLeadTab,
      this.openTaskIds.has(task.id),
    )
  }

  /**
   * A session's own row: one mounted conversation that no task row stands for.
   * Its lifecycle is the session's state on its host: settled, snoozed, or
   * active (docs/plans/session-pull-requests.md). `linkedTask` names the task
   * the session belongs to when that task has no row here.
   */
  private buildSessionRow(
    tabId: string,
    session: Session,
    tab: Tab,
    linkedTask: SidebarLinkedTask | undefined,
  ): SidebarTask {
    const environment = this.session.environment.environmentFor(this.session.sessionFor(tabId)?.run)
    const projectKey = environmentProjectKey(environment, session.run.projectGroupPath)
    const attention = getAttentionState(session, tab, this.planStore.plans)
    const state = sessionStatesStore.stateFor(session.id)
    const isSettled = !!state?.settledAt
    const lifecycle = sessionRowLifecycle(state, attention, this.lifecycleNow)
    return {
      id: tabId,
      key: tabId,
      title: sessionTitle(session),
      projectKey,
      projectLabel: projectLabel(projectKey),
      groupKey: groupKeyFor(session.run.serverId, projectKey),
      branchName: environment.branch,
      serverId: session.run.serverId ?? null,
      prNumber: null,
      status: taskStatusFor(attention, isSettled),
      attention,
      unread: tab.hasUnread && !isSettled,
      createdAt: firstActivityAt(session),
      runStartedAt: attention === 'running' ? turnStartedAt(session) : 0,
      limitResetsAt: sessionLimitResetsAt(session) ?? undefined,
      lifecycle: lifecycle.lifecycle,
      completedAt: lifecycle.completedAt,
      snoozedUntil: lifecycle.snoozedUntil,
      snoozeNote: state?.snoozeNote ?? null,
      lastReadAt: 0,
      woke: lifecycle.woke,
      tabIds: [tabId],
      linkedTask,
    }
  }

  /**
   * The row of a settled or snoozed session that has no conversation open on
   * this client. The host names it; selecting the row opens the session.
   */
  private buildShelvedSessionRow(entry: ShelvedSession): SidebarTask {
    const projectKey = worktreeProjectRoot(entry.projectPath ?? '~')
    const lifecycle = sessionRowLifecycle(entry, null, this.lifecycleNow)
    const rowId = `session:${entry.sessionId}`
    return {
      id: rowId,
      key: rowId,
      sessionId: entry.sessionId,
      title: entry.title ?? 'Session',
      projectKey,
      projectLabel: projectLabel(projectKey),
      groupKey: groupKeyFor(entry.serverId, projectKey),
      branchName: null,
      serverId: entry.serverId,
      prNumber: null,
      status: taskStatusFor(null, !!entry.settledAt),
      attention: null,
      unread: false,
      createdAt: entry.settledAt ?? entry.snoozedUntil ?? 0,
      runStartedAt: 0,
      lifecycle: lifecycle.lifecycle,
      completedAt: lifecycle.completedAt,
      snoozedUntil: lifecycle.snoozedUntil,
      snoozeNote: entry.snoozeNote,
      lastReadAt: 0,
      woke: lifecycle.woke,
      tabIds: [],
    }
  }

  /** Every sidebar row, unfiltered and unsorted — the rail's counts and the
   *  one-project checks both have to see the whole column. */
  allTasks: SidebarTask[] = $derived.by(() => {
    // Persisted tabs are materialized synchronously, before the task store has
    // loaded the task-to-session links that classify them. Do not project that
    // incomplete snapshot as sessions with no task: it flashes every restored
    // session as a separate row during refresh.
    if (!this.session.tasksStore.loaded) {
      return reconcileSidebarTasks(this.taskModelsById, [])
    }

    const openTabBySessionId = this.tabIdBySessionId

    const durableTasks = sortTasksByCreation(this.session.tasksStore.tasks)
      .filter((task) => this.isDurableRowShown(task, openTabBySessionId))
      .map((task) => this.buildDurableTaskRow(task, openTabBySessionId))
    const shownTaskIds = new Set(durableTasks.map((task) => task.id))

    // A session with no task has a row of its own. So does a session of a task
    // that has no row here: the row then names that task on a chip.
    const looseTasks: SidebarTask[] = []
    for (const tabId of this.visibleTabIds) {
      const session = this.session.sessionFor(tabId)
      const tab = this.session.tabs[tabId]
      if (!session || !tab) continue
      const ownerTask = this.session.tasksStore.taskForSession(session.id)
        ?? this.pendingTaskFor(session)
      if (ownerTask && shownTaskIds.has(ownerTask.id)) continue

      looseTasks.push(this.buildSessionRow(
        tabId,
        session,
        tab,
        ownerTask ? { taskId: ownerTask.id, title: ownerTask.title } : undefined,
      ))
    }

    // A settled or snoozed session with no conversation here still has a row,
    // so a session a person put away on one client is on the shelf of every
    // client. A session its task's finish settled has none: the finished task
    // is on the Completed shelf. A snooze that ended and was seen has none
    // either.
    const mountedSessionIds = new Set(this.visibleTabIds.flatMap((tabId) => {
      const session = this.session.sessionFor(tabId)
      return session ? [session.id] : []
    }))
    const shelvedSessions = sessionStatesStore.entries
      .filter((entry) => !mountedSessionIds.has(entry.sessionId) && entry.settledBy !== 'task')
      .map((entry) => this.buildShelvedSessionRow(entry))

    return reconcileSidebarTasks(
      this.taskModelsById,
      sortSidebarRowsByCreation([...durableTasks, ...looseTasks, ...shelvedSessions]),
    )
  })

  /** The sidebar aggregates every catalog host's rows into one list
   * (dispatch-client step 2); a row's own host still routes its actions. */
  catalogTasks: SidebarTask[] = $derived(this.allTasks)

  /** Every open project, with the counts and the lead task the breadcrumb's
   *  picker lands on. */
  projectSummaries: ProjectSummary[] = $derived(
    buildProjectSummaries(this.catalogTasks, (task) => this.activityAtFor(task), (keys) => this.projectOptionsFor(keys)),
  )

  /** The rows these group keys stand for, in order: the shared project rows
   *  (`WorkspaceContext.projectOptionsFor`), and the chats under their own name. */
  private projectOptionsFor(groupKeys: readonly string[]): ListProjectOption[] {
    const projects = new Map(
      this.session.projectOptionsFor(groupKeys.filter((key) => key !== CHATS_GROUP_KEY && key !== '~'))
        .map((option) => [option.key, option]),
    )
    return groupKeys.flatMap((key): ListProjectOption[] => {
      const project = projects.get(key)
      if (project) return [project]
      if (key !== CHATS_GROUP_KEY && key !== '~') return []
      return [{ key, projectKey: key, serverId: '', label: key === CHATS_GROUP_KEY ? CHAT_LABEL : '~', available: true }]
    })
  }

  /**
   * When a row last did anything: the latest change to its task or a
   * message in one of its mounted sessions. It moves with every streamed
   * message, so only a reader that shows or ranks by it may ask — the pickers'
   * ranking, or one phone row's timestamp — never the column's projection.
   */
  activityAtFor(task: SidebarTask): number {
    let latest = 0
    if (task.taskId) {
      const record = this.session.tasksStore.tasks.find((candidate) => candidate.id === task.taskId)
      if (record) latest = record.updatedAt
    }
    for (const tabId of task.tabIds) {
      const session = this.session.sessionFor(tabId)
      if (session) latest = Math.max(latest, lastActivityAt(session))
    }
    return latest
  }

  /**
   * The project the focused surface is working in, or null when it is working
   * in none.
   *
   * This is "where am I right now", not "what has the sidebar been filtered
   * to": a draft answers from its own run, so a fresh composer in a project
   * with no task yet still names that project. `~` is the renderer's
   * placeholder for a working directory nobody has chosen, so it is not a
   * scope — the picker must stay wide there rather than scope to nothing.
   */
  currentProjectKey: string | null = $derived.by(() => {
    const sourceId = this.session.focusedSourceId
    const draft = sourceId ? this.session.drafts.sessionDrafts.get(sourceId) : undefined
    const run = draft?.run ?? (sourceId ? this.session.sessionFor(sourceId)?.run : undefined)
    if (!run) return null
    const projectKey = environmentProjectKey(
      this.session.environment.environmentFor(run),
      run.projectGroupPath,
    )
    if (!projectKey || projectKey === '~' || isChat(projectKey)) return null
    return groupKeyFor(run.serverId, projectKey)
  })

  /** The projects the task picker offers as a scope (`pickerProjectKeys`),
   *  one row per project. Every row is available: the picker lists what this
   *  client already holds, whether or not its host is connected. */
  pickerProjectOptions: ListProjectOption[] = $derived.by(() =>
    this.session.projectOptionsFor(pickerProjectKeys(
      this.currentProjectKey,
      this.session.tasksStore.tasks,
      (task) => this.session.tasksStore.projectKeyOf(task),
      this.session.logicalProjects.map((project) => project.key),
    )).map((option) => ({ ...option, available: true })),
  )

  /** The project the list is scoped to, or null for all of them. Resolved
   *  against the column's own contents so a project that has left it never
   *  keeps scoping the list to something no longer there. */
  private openProjectFilter: string | null = $derived.by(() =>
    resolveProjectFilter(this.settings.sidebarProjectFilter, this.catalogTasks),
  )

  /** The saved filter controls the list even when the focused composer is a draft. */
  scopedProject: ProjectFilterChoice | null = $derived.by(() => {
    const filter = this.openProjectFilter
    if (!filter) return null
    return this.projectFilterChoices.find((choice) => choice.key === filter) ?? null
  })

  /** Every open task, before the filter. The order tasks arrived in, held:
   *  lifecycle changes update a row in place; only an explicit sidebar
   *  dismissal removes it. */
  activeTasks: SidebarTask[] = $derived(this.catalogTasks.filter((task) => task.lifecycle === 'active'))

  private taskRecord(taskId: string): Task | undefined {
    return this.session.tasksStore.peek(taskId) ?? undefined
  }

  private returnOrder = new SidebarReturnOrder()

  /** Open task rows, and open session rows that no task row stands for. A
   *  session with unsent work and no pane is in Drafts instead. */
  private openRows: SidebarTask[] = $derived.by(() => {
    const parked = this.parkedSessionTabIds
    // Every status change rebuilds this pass, so the return order sees each
    // row leave the Working section before the sections sort.
    this.returnOrder.observe(this.activeTasks, Date.now())
    return this.inFilter(this.activeTasks.filter((row) =>
      !!row.taskId || !row.tabIds.some((tabId) => parked.has(tabId)),
    ))
  })

  /**
   * The Tasks section: every open task, busy or not. A row opens the task's
   * lead with the task page beside it. A row lives in exactly one place: a
   * running task stays here and its row shows the run; a finished task is on
   * the Completed shelf.
   */
  taskRows: SidebarTask[] = $derived(sortRowsByReturn(
    this.openRows.filter((row) => !!row.taskId),
    (row) => this.returnOrder.returnedAt(row),
  ))

  /** The Sessions section: active sessions that no task row stands for and
   *  that are not working. A settled or snoozed session is on its shelf. */
  sessionRows: SidebarTask[] = $derived(sortRowsByReturn(
    this.openRows.filter((row) => !row.taskId && !isWorkingStatus(row.status)),
    (row) => this.returnOrder.returnedAt(row),
  ))

  /** The Working section: open sessions that no task row stands for, whose
   *  agent is busy without the user, in the order they arrived. A row leaves
   *  it when it comes back to the user, and lands on top of Sessions. */
  workingRows: SidebarTask[] = $derived(this.openRows.filter(isInWorkingSection))

  /**
   * The one session the list shows under a task row: the session on screen,
   * when it is not the task's lead (`disclosedSession`). A task's other
   * sessions are on its page; the list names only the one being read.
   */
  disclosedSession: { rowId: string; session: SidebarSessionChild } | null = $derived.by(() => {
    const tabId = this.session.onScreenTabId
    const row = this.taskForTab(tabId)
    if (!row?.taskId || row.lifecycle !== 'active') return null
    const session = disclosedSession(this.sessionsFor(row), tabId)
    return session ? { rowId: row.id, session } : null
  })
  snoozedTasks: SidebarTask[] = $derived(
    this.inFilter(this.catalogTasks.filter((task) => task.lifecycle === 'snoozed'))
      .toSorted((a, b) => a.snoozedUntil - b.snoozedUntil || a.id.localeCompare(b.id)),
  )
  /**
   * Finished tasks the column itself never listed.
   *
   * The active column is a working set: a row is there because this client has
   * the task open, and closing the row takes it out. That rule is right for
   * work in flight and exactly wrong for work that ended — a task the user
   * finished and put away is the one they later go looking for, and gating the
   * shelf on the same membership erased it instead of shelving it. So the shelf
   * asks the task store what is done, and retention alone decides how long it
   * stays.
   *
   * Deliberately skips the one-row-per-session projection rule the column
   * applies: two tasks that shared a session are two distinct pieces of
   * finished work, and history should name both.
   */
  private shelvedCompletedTasks: SidebarTask[] = $derived.by(() => {
    if (!this.session.tasksStore.loaded) return []
    const openTabBySessionId = this.tabIdBySessionId
    const alreadyInColumn = new Set(this.catalogTasks.map((task) => task.taskId))
    return reconcileSidebarTasks(
      this.shelvedRowModelsById,
      sortTasksByCreation(this.session.tasksStore.tasks)
        .filter((task) => shouldShelveCompletedTask(task, alreadyInColumn.has(task.id)))
        .map((task) => this.buildDurableTaskRow(task, openTabBySessionId)),
    )
  })

  /** The Completed shelf: finished tasks and settled sessions, newest first. */
  completedTasks: SidebarTask[] = $derived(
    this.inFilter([
      ...this.catalogTasks.filter((task) => task.lifecycle === 'completed'),
      ...this.shelvedCompletedTasks,
    ]).toSorted((a, b) => b.completedAt - a.completedAt || a.id.localeCompare(b.id)),
  )

  /** The filter's own choices, over every project the column knows about. */
  projectFilterChoices: ProjectFilterChoice[] = $derived(
    projectFilterChoices(this.catalogTasks, (keys) => this.projectOptionsFor(keys)),
  )

  private inFilter(tasks: SidebarTask[]): SidebarTask[] {
    const filter = this.scopedProject?.key ?? null
    return filter ? tasks.filter((task) => task.groupKey === filter) : tasks
  }

  /** Open sessions with unsent work move to Drafts once no pane shows them.
   * Task rows keep their task identity and are not moved by a session prompt. */
  get parkedSessionTabIds(): Set<string> {
    const composing = new Set<string>()
    const panes = this.session.hasCompanionPanes
      ? this.session.router.panes
      : [this.session.router.leadingPane]
    for (const pane of panes) {
      const tabId = this.session.chatTabIn(pane.id)
      if (tabId) composing.add(tabId)
    }
    const parked = new Set<string>()
    for (const row of this.activeTasks) {
      if (row.taskId) continue
      for (const tabId of row.tabIds) {
        if (composing.has(tabId)) continue
        const prompt = this.session.sessionFor(tabId)?.prompt
        if (prompt && (prompt.text.trim() || prompt.attachments.length > 0)) parked.add(tabId)
      }
    }
    return parked
  }

  openDraftRow(row: DraftRow): void {
    if (row.tabId) this.session.selectTab(row.tabId)
    else this.session.drafts.openDraft(row.draftId)
  }

  /** Keep the discarded prompt for Undo. An existing conversation stays open;
   * only its unsent prompt is cleared. */
  discardDraftRow(row: DraftRow): (() => void) | null {
    if (row.tabId) {
      const session = this.session.sessionFor(row.tabId)
      if (!session) return null
      const prompt = $state.snapshot(session.prompt)
      session.prompt = makePrompt()
      const cleared = session.prompt
      return () => {
        // Undo must not replace words entered after the discard or target a
        // closed conversation. The empty prompt is the discard's receipt.
        const current = this.session.sessionFor(row.tabId!)
        if (current === session && current.prompt === cleared
          && !current.prompt.text.trim() && current.prompt.attachments.length === 0) {
          current.prompt = prompt
        }
      }
    }
    const spec = this.session.drafts.discardSessionDraft(row.draftId)
    if (!spec) return null
    return () => this.session.drafts.restoreSessionDrafts({
      order: [row.draftId],
      drafts: { [row.draftId]: spec },
    })
  }

  /** Prompts written and set aside, in the order they were opened. Two things
   *  keep a draft out: nothing has been written in it — every ⌘N opens one and
   *  boot seeds one, so listing those would fill the section with rows nobody
   *  wrote — or a pane is composing it right now, which is the prompt in front
   *  of the user rather than one they parked. Moving off it is what files it
   *  here. */
  draftRows: DraftRow[] = $derived.by(() => {
    const composing = this.session.drafts.composingDraftIds
    const filter = this.scopedProject?.key ?? null
    const rows: DraftRow[] = []
    for (const draft of this.session.drafts.sessionDrafts.values()) {
      if (draft.isEmpty || composing.has(draft.id)) continue
      const projectKey = environmentProjectKey(
        this.session.environment.environmentFor(draft.run),
        draft.run.projectGroupPath,
      )
      // A draft with no repo behind it belongs to nothing yet, so no project
      // scope can exclude it.
      if (filter && projectKey !== '~' && groupKeyFor(draft.run.serverId, projectKey) !== filter) continue
      rows.push({
        draftId: draft.id,
        title: draftTitle(draft.prompt),
        projectKey,
        projectLabel: projectLabel(projectKey),
        serverId: draft.run.serverId,
        hasAttachments: draft.prompt.attachments.length > 0,
      })
    }
    for (const tabId of this.parkedSessionTabIds) {
      const session = this.session.sessionFor(tabId)
      if (!session) continue
      const projectKey = environmentProjectKey(
        this.session.environment.environmentFor(session.run),
        session.run.projectGroupPath,
      )
      if (filter && projectKey !== '~' && groupKeyFor(session.run.serverId, projectKey) !== filter) continue
      rows.push({
        draftId: `session:${tabId}`,
        tabId,
        title: sessionDraftTitle(session),
        projectKey,
        projectLabel: projectLabel(projectKey),
        serverId: session.run.serverId,
        hasAttachments: session.prompt.attachments.length > 0,
      })
    }
    return rows
  })

  /** The task holding a tab, whether that conversation is leading or split.
   *  Every open tab is projected into `allTasks` — under its task when it has
   *  one, as its own loose row when it does not — so a composer that has yet to
   *  dispatch needs no row of its own synthesized here. */
  taskForTab(tabId: string): SidebarTask | null {
    const contextTaskId = this.session.sidebarTaskContextForTab(tabId)
    if (contextTaskId) {
      const contextualTask = this.catalogTasks.find((task) =>
        task.id === contextTaskId && task.tabIds.includes(tabId),
      )
      if (contextualTask) return contextualTask
    }
    return this.catalogTasks.find((task) => task.tabIds.includes(tabId)) ?? null
  }

  /** The task the leading breadcrumb names. */
  activeTask: SidebarTask | null = $derived.by(() => this.taskForTab(this.session.activeTabId))

  /** The row holding the conversation on screen. Resolved once for the column;
   *  each row compares its own id against it rather than scanning the column. */
  onScreenTaskId: string | null = $derived.by(() => this.taskForTab(this.session.onScreenTabId)?.id ?? null)

  /** Tasks this client completed. Completion marks the task done at once but
   *  closes its tabs only when the host answers, so for that round trip the
   *  task is both on screen and on the Completed shelf. */
  private completedHereTaskIds = new SvelteSet<string>()

  /** The row a collapsed shelf keeps showing: the one on screen, so it never
   *  disappears into a shelf — unless the user just completed it here. That
   *  row is on its way out with its tabs, and showing it on a collapsed
   *  Completed shelf for the round trip flashed it there before it vanished. */
  shelfRevealTaskId: string | null = $derived(
    this.onScreenTaskId && !this.completedHereTaskIds.has(this.onScreenTaskId)
      ? this.onScreenTaskId
      : null,
  )

  /** Mark a durable task done from this client. Both the sidebar's check and
   *  the phone's swipe complete through here, so neither flashes the row on a
   *  collapsed Completed shelf. Throws when the host refuses; the task then
   *  stays where it was. */
  async markTaskDone(taskId: string): Promise<void> {
    this.completedHereTaskIds.add(taskId)
    try {
      await this.session.tasksStore.get(taskId).setStatus('done')
    } catch (error) {
      this.completedHereTaskIds.delete(taskId)
      throw error
    }
  }

  /** The task choices for a breadcrumb scoped to either conversation pane. */
  tasksForProject(groupKey: string | null | undefined): SidebarTask[] {
    if (!groupKey) return []
    return sortTasks(
      this.catalogTasks.filter((task) => task.groupKey === groupKey),
      (task) => this.activityAtFor(task),
    )
  }

  /** The sessions inside the active task: what the session crumb drops down. */
  activeTaskSessions: SidebarSessionChild[] = $derived.by(() => {
    return this.sessionsForTab(this.session.activeTabId)
  })

  /** The sibling sessions a breadcrumb for this tab can switch between. */
  sessionsForTab(tabId: string): SidebarSessionChild[] {
    const task = this.taskForTab(tabId)
    return task ? this.sessionsFor(task) : []
  }

  setProjectFilter(projectKey: string | null): void {
    this.settings.setLayout('sidebarProjectFilter', projectKey)
  }

  /**
   * Every pull request a row stands for: the ones linked to its task, and the
   * ones its sessions are working on, as one deduplicated set.
   *
   * Two sources because neither covers the other. A link is durable and survives
   * the session that made it, but a row backed only by a session has no task to
   * link against, and a task can be linked to a pull request no session of it
   * ever checked out. So: take both, name each pull request once, and let the
   * provider record fill in what it can.
   *
   * The record is an enrichment, never a filter. A pull request this client
   * holds no record for — an unreachable host, a disconnected account, a project
   * whose list nothing has read yet — is still a pull request the user linked,
   * and the row shows it.
   */
  prChoicesFor(task: SidebarTask): TaskPrChoice[] {
    const serverId = task.taskId
      ? this.session.tasksStore.get(task.taskId).serverId ?? task.serverId
      : task.serverId
    if (!serverId) return []
    const choices = dedupePrChoices([
      ...this.linkedPrChoices(task, serverId),
      ...this.sessionPrChoices(task, serverId),
      ...this.branchPrChoices(task, serverId),
      ...this.mountedPrChoices(task, serverId),
    ])
    for (const choice of choices) choice.requiredChecksFail = this.requiredChecksFail(serverId, choice)
    return choices
  }

  /**
   * Whether a required check fails on the pull request's current head, so it
   * cannot merge. The same reading as the checks chip on the PR surfaces
   * (`checksPresentation`), including its refusal to trust a result for a head
   * the branch has moved past. Checks this client has not read are not a
   * failure.
   */
  private requiredChecksFail(serverId: string, choice: TaskPrChoice): boolean {
    const pullRequest = choice.pullRequest
    if (!pullRequest) return false
    const summary = this.pullRequestChecks.summaryIn(serverId, repositoryKeyOf(pullRequest.baseRepo), choice.number)
    if (!summary) return false
    const headSha = 'headSha' in pullRequest ? pullRequest.headSha : null
    return checksPresentation(summary, headSha, false).state === 'failing'
  }

  /**
   * The durable link behind a row's pull request, when the row can remove it.
   * A task row removes it from the task, which the host routes to the session
   * that owns it. A session row removes its own link. A pull request the row
   * only reads from its checkout has no link to remove.
   */
  private unlinkablePullRequest(task: SidebarTask, choice: TaskPrChoice): (() => Promise<void>) | null {
    if (task.taskId) {
      const model = this.session.tasksStore.get(task.taskId)
      const isLinked = model.prLinks.some((link) => link.number === choice.number
        && (link.targetScope ?? '').toLowerCase() === choice.targetScope.toLowerCase())
      return isLinked
        ? async () => { await model.unlink('pr', String(choice.number), choice.targetScope) }
        : null
    }
    const link = sessionPullRequestsStore.linksFor(this.sessionIdOfRow(task))
      .find((candidate) => candidate.number === choice.number && candidate.repository === choice.targetScope.toLowerCase())
    if (!link || !task.serverId) return null
    const serverId = task.serverId
    return () => sessionPullRequestsStore.unlink(serverId, link)
  }

  canUnlinkPullRequest(task: SidebarTask, choice: TaskPrChoice): boolean {
    return this.unlinkablePullRequest(task, choice) !== null
  }

  /** Remove a pull request from the row that shows it. */
  async unlinkPullRequest(task: SidebarTask, choice: TaskPrChoice): Promise<void> {
    await this.unlinkablePullRequest(task, choice)?.()
  }

  /** The pull requests the session behind a tab links. A draft has none. */
  pullRequestLinksForTab(tabId: string): SessionPullRequestLink[] {
    return sessionPullRequestsStore.linksFor(this.session.tabs[tabId]?.sessionId)
  }

  /** The one session a session row stands for. */
  sessionIdOfRow(task: SidebarTask): string | null {
    const tabId = task.tabIds[0]
    return (tabId ? this.session.tabs[tabId]?.sessionId : undefined) ?? task.sessionId ?? null
  }

  /**
   * The pull requests a session row's own session links
   * (docs/plans/session-pull-requests.md). A task row has none here: the host
   * answers a task's links with the links of its sessions in them.
   */
  private sessionPrChoices(task: SidebarTask, serverId: string): TaskPrChoice[] {
    if (task.taskId) return []
    return sessionPullRequestsStore.linksFor(this.sessionIdOfRow(task)).flatMap((link) => {
      const pr = this.pullRequestProjects.linkedPr(serverId, sessionPrLink(link), task.projectKey)
      return pr ? [pr] : []
    })
  }

  /**
   * The pull request a mounted tab's checkout reports right now.
   *
   * Nothing records this. A shared clone's HEAD is a fact about the clone, not
   * about the session reading it, so writing it down would let one branch claim
   * every task open on that checkout. It is still the answer in front of the
   * user, so the row shows it for as long as the tab does and loses it with the
   * tab — a derived chip, not a claim. A worktree's observation is durable and
   * arrives through `linkedPrChoices` instead, where deduplication meets it.
   */
  private mountedPrChoices(task: SidebarTask, serverId: string): TaskPrChoice[] {
    return this.mountedPrObservations(task).flatMap((observation) => {
      const parsedUrl = observation.prUrl ? parseGitHubPullRequestUrl(observation.prUrl) : null
      if (!parsedUrl) return []
      const pr = this.pullRequestProjects.linkedPr(serverId, {
        number: parsedUrl.number, url: parsedUrl.url,
      }, task.projectKey)
      return pr ? [pr] : []
    })
  }

  /** The pull requests this task's own record links. */
  private linkedPrChoices(task: SidebarTask, serverId: string): TaskPrChoice[] {
    if (!task.taskId) return []
    return this.session.tasksStore.get(task.taskId).prLinks.flatMap((link) => {
      const pr = this.pullRequestProjects.linkedPr(serverId, link, task.projectKey)
      return pr ? [pr] : []
    })
  }

  /**
   * The pull requests on the branches this task's sessions are working on.
   *
   * One pass over the task's own session links, mounted or not: a mounted
   * session reports the branch its checkout is currently on, and a closed one
   * still speaks through the branch the task recorded for it. Branches are
   * deduplicated first, because several attempts on one branch are several
   * attempts at one pull request.
   *
   * Only the project's index is asked. A pull request the host detected for a
   * mounted checkout is not read here: the host worker writes that observation
   * as a durable task link, so it arrives as one — and a link is the better
   * carrier, since it survives the tab being closed.
   */
  private branchPrChoices(task: SidebarTask, serverId: string): TaskPrChoice[] {
    const project = this.pullRequestProjects.at(serverId, task.projectKey)
    if (!project) return []
    return this.sessionBranchesFor(task).flatMap((branchName) => {
      const pullRequest = project.prForBranch(branchName)
      return pullRequest
        ? [{
            number: pullRequest.number,
            targetScope: task.projectKey,
            title: pullRequest.title,
            url: pullRequest.url,
            pullRequest,
          }]
        : []
    })
  }

  /** Every distinct branch this task's sessions are on — the live one for a
   *  mounted session, the recorded one for an attempt whose tab is closed. */
  private sessionBranchesFor(task: SidebarTask): string[] {
    const branches = new SvelteSet<string>()
    for (const attempt of this.prDiscoveryAttemptsFor(task)) {
      if (attempt.branchName) branches.add(attempt.branchName)
    }
    return [...branches]
  }

  /** The Git section's detailed status is the canonical detector for mounted
   * sessions. The sidebar reads that same result instead of maintaining a
   * second branch-to-PR opinion. */
  private mountedPrObservations(task: SidebarTask): MountedPrObservation[] {
    return task.tabIds.flatMap((tabId) => {
      const session = this.session.sessionFor(tabId)
      if (!session) return []
      const environment = this.session.environment.environmentFor(session.run)
      const status = environment.status
      return [{
        prUrl: status === undefined ? undefined : status?.prUrl ?? null,
        isolatedCheckout: environment.isolated,
      }]
    })
  }

  activeBranchKey: string = $derived.by(() => environmentBranchKey(
    this.session.environment.environmentFor(this.session.activeSession?.run),
    this.session.sessionFor(this.session.activeTabId)?.run.projectGroupPath,
  ))

  activeProjectKey: string = $derived.by(() => environmentProjectKey(
    this.session.environment.environmentFor(this.session.activeSession?.run),
    this.session.sessionFor(this.session.activeTabId)?.run.projectGroupPath,
  ))

  constructor(
    private settings: SettingsContext,
    private session: WorkspaceContext,
    private planStore: PlanStore,
    private pullRequestProjects: PrsStore,
    private pullRequestChecks: PrChecksStore,
    /** Which hosts are the cloud and which are up, for one row per session across
     *  its homes. The app core hands in the reactive servers store; the registry
     *  answers on its own for a store built without one. */
    private readonly sessionHomes: SessionHomeHosts = registrySessionHomes(),
  ) {
    this.openTaskIds = new SvelteSet(loadOpenSidebarTaskIds() ?? [])
    this.session.onTaskOpened = (taskId) => this.restoreTask(taskId)
    this.session.setOpenTabPredicate((tabId) =>
      !this.session.tasksStore.loaded
      || this.activeTasks.some((task) => task.tabIds.includes(tabId)),
    )

    // Wake the next snoozed row exactly when it is due. Without this the shelf
    // only empties on the next unrelated invalidation, so a row the user asked
    // for at 3pm might not reappear until they typed something.
    $effect(() => {
      const now = this.lifecycleNow
      let nextWake = 0
      for (const { snoozedUntil } of [...sessionStatesStore.entries, ...this.session.tasksStore.tasks]) {
        if (snoozedUntil && snoozedUntil > now && (nextWake === 0 || snoozedUntil < nextWake)) {
          nextWake = snoozedUntil
        }
      }
      if (!nextWake) return
      const timeout = window.setTimeout(() => {
        this.lifecycleNow = Date.now()
      }, Math.max(1, nextWake - Date.now()))
      return () => window.clearTimeout(timeout)
    })
    $effect(() => {
      // Depend on the answer arriving, not on the rows it produces: this is a
      // one-shot boot decision, not a rule that keeps re-running as tasks move.
      void this.session.tasksStore.loaded
      untrack(() => this.settleBootLocation())
    })
  }

  /** PR discovery is task-domain behavior, so sidebar projection and dismissal
   * must not remove a durable attempt from its branch inputs. */
  private prDiscoveryAttemptsFor(task: SidebarTask): PrLinkDiscoveryAttempt[] {
    if (!task.taskId) {
      // A loose row has no durable task to record anything against, so its
      // branches only ever feed display.
      return this.sessionsFor(task).map((attempt) => ({
        sessionId: attempt.sessionId ?? attempt.tabId ?? task.id,
        branchName: attempt.branchName,
        isolatedCheckout: false,
      }))
    }
    return prLinkDiscoveryAttempts(
      this.session.tasksStore.get(task.taskId).sessions,
      (sessionId) => {
        const tabId = this.tabIdBySessionId.get(sessionId)
        return tabId
          ? this.session.environment.environmentFor(this.session.sessionFor(tabId)?.run).branch
          : undefined
      },
    )
  }

  /** Keep durable, unmounted task attempts live in the sidebar. */
  subscribeSessionStatuses(): () => void {
    return subscribeAllHosts('session.statusChanged', (serverId, event) => {
      this.sessionStatusFeed().apply(serverId, event)
    })
  }

  /**
   * A tab is closing. Its task keeps its row — a task the user had open here
   * stays in the column after its last tab closes, until the row itself is
   * closed — and the attention that session contributed to it is cleared.
   * While the tab was open, the tab alone showed the row (`isDurableRowShown`),
   * so this is the only moment the task has to be remembered.
   */
  releaseTab(tabId: string): void {
    const taskId = this.taskForTab(tabId)?.taskId
    if (taskId && !this.dismissedRowKeys.has(taskId) && !this.openTaskIds.has(taskId)) {
      this.openTaskIds.add(taskId)
      this.persistOpenTaskIds()
    }
    const session = this.session.sessionFor(tabId)
    if (!session) return
    this.sessionStatusFeed().clear(serverConnections.resolveId(session.run.serverId), session.id)
  }

  /** Hydrate the pinned list by fanning out over every connected host: pins
   *  are host-authoritative (dispatch-client), so each host answers for its
   *  own sessions. Rows read naked get the answering host stamped; a host
   *  that fails the read keeps the rows it answered with last time. */
  async loadPinnedSessions(): Promise<void> {
    const serverIds = serverConnections.connectedServerIds()
    const results = await Promise.all(serverIds.map(async (serverId) => {
      try {
        const rows = await serverConnections.apiFor(serverId).pinnedSessionsList()
        for (const row of rows) {
          row.serverId = serverId
        }
        return rows
      } catch {
        return this.pinnedSessions.filter((pin) => pin.serverId === serverId)
      }
    }))
    const seen = new Set<string>()
    this.pinnedSessions = results.flat().filter((pin) => {
      const key = `${pin.serverId ?? ''}:${pin.sessionId}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  isPinned(sessionId: string | null | undefined, serverId?: string): boolean {
    if (!sessionId || !serverId) return false
    const resolvedServerId = serverConnections.resolveId(serverId)
    return this.pinnedSessions.some((pin) =>
      pin.sessionId === sessionId
      && pin.serverId === resolvedServerId,
    )
  }

  openTabIdForPinned(pin: PinnedSession): string | null {
    const serverId = pin.serverId ? serverConnections.resolveId(pin.serverId) : undefined
    return findOpenTabForSession(
      pin.sessionId,
      this.session.tabs,
      this.session.sessions.byId,
      this.session.tabOrder,
      pin.provider,
      serverId,
    )
  }

  /** One session's attention as its sidebar row states it: a mounted tab
   *  answers for itself, and the host's status feed for a session with none. */
  sessionAttention(serverId: string | null, sessionId: string): AttentionState {
    const tabId = this.session.tabIdForHostSession(sessionId, serverId ?? undefined)
    const tab = tabId ? this.session.tabs[tabId] : undefined
    const sess = tabId ? this.session.sessionFor(tabId) : undefined
    if (tab && sess) return getAttentionState(sess, tab, this.planStore.plans)
    return this.sessionStatusFeed().stateFor(serverId, sessionId)?.attention ?? null
  }

  childForTab(tabId: string): SidebarSessionChild {
    return withLazyActivity(this.liveChildFor(tabId), () => this.tabActivityAt(tabId))
  }

  private tabActivityAt(tabId: string): number {
    const session = this.session.sessionFor(tabId)
    return session ? lastActivityAt(session) : 0
  }

  /** A mounted tab's child row without its activity time, which a caller
   *  attaches lazily with `withLazyActivity` so building the row never reads
   *  the transcript. */
  private liveChildFor(tabId: string): Omit<SidebarSessionChild, 'lastActivityAt'> {
    const tab = this.session.tabs[tabId]
    const sess = this.session.sessionFor(tabId)
    const attention = tab && sess ? getAttentionState(sess, tab, this.planStore.plans) : null
    const serverId = this.session.serverIdFor(tabId)
    const guideIdentity = sessionGuideIdentity(sess)
    const guideStatus = reviewGuideStore.indicatorStatusFor(serverId, guideIdentity)?.status
    const guideTooltipStatus = reviewGuideStore.statusFor(serverId, guideIdentity)?.status
    return {
      tabId,
      label: sess ? sessionTitle(sess) : tabId,
      attention,
      unread: tab?.hasUnread ?? false,
      serverId: sess?.run.serverId ?? null,
      provider: sess?.run.provider ?? null,
      modelId: sess ? (sess.sessionModel ?? sess.run.modelConfig.modelId) : null,
      // The mounted tab's environment is live, so it outranks whatever branch
      // the task record captured when it was last written.
      branchName: this.session.environment.environmentFor(this.session.sessionFor(tabId)?.run).branch,
      runStartedAt: sess && attention === 'running' ? turnStartedAt(sess) : 0,
      limitResetsAt: (sess && sessionLimitResetsAt(sess)) ?? undefined,
      reviewGuideStatus:
        guideStatus === 'queued' || guideStatus === 'generating'
          ? 'generating'
          : guideStatus === 'ready'
            ? 'ready'
            : null,
      reviewGuideTooltipStatus:
        guideTooltipStatus === 'queued' || guideTooltipStatus === 'generating'
          ? 'generating'
          : guideTooltipStatus === 'ready'
            ? 'ready'
            : null,
    }
  }

  /** Each row's children, computed once for the whole column. Building this list
   *  walks the task tree, its links and every mounted tab behind them, so a row
   *  that recomputed it on each render — as the sidebar's markup did — paid that
   *  walk again for every unrelated invalidation, and handed its subtree a fresh
   *  array identity each time. One derived pass keeps both costs at one. */
  private sessionsByTaskId: Map<string, SidebarSessionChild[]> = $derived.by(() => {
    const byTaskId = new Map<string, SidebarSessionChild[]>()
    for (const task of this.catalogTasks) {
      byTaskId.set(task.id, this.buildSessions(task.taskId, task.tabIds))
    }
    return byTaskId
  })

  sessionsFor(task: SidebarTask): SidebarSessionChild[] {
    // Callers can hold a row the last derived pass hasn't caught up with, so a
    // miss still answers rather than reporting the task as empty.
    return this.sessionsByTaskId.get(task.id) ?? this.buildSessions(task.taskId, task.tabIds)
  }

  /**
   * The sessions the picker lists for a pickable task.
   *
   * `catalogTasks` is this client's working set: a task earns a row only when
   * it is open here or has a mounted session. The picker lists every task on
   * every catalog host, so most of them have no row, and reading their
   * sessions through one reported them as empty. Opening such a task then
   * resumed a session the row had just said did not exist. This reads the
   * task's own links instead, and counts the rows per-row dismissal hid,
   * because opening a task in the picker restores them first.
   */
  private pickerSessionsByTaskId: Map<string, SidebarSessionChild[]> = $derived.by(() => {
    const tabIdsByTaskId = new Map(
      this.catalogTasks.flatMap((row) => (row.taskId ? [[row.taskId, row.tabIds] as const] : [])),
    )
    const byTaskId = new Map<string, SidebarSessionChild[]>()
    for (const task of this.session.tasksStore.tasks) {
      byTaskId.set(task.id, this.buildSessions(task.id, tabIdsByTaskId.get(task.id) ?? [], true))
    }
    return byTaskId
  })

  sessionsForPickableTask(task: Task): SidebarSessionChild[] {
    return this.pickerSessionsByTaskId.get(task.id) ?? this.buildSessions(task.id, [], true)
  }

  /** Mark only the task's lead as unread. Worker tabs keep their own read state. */
  async markTaskUnread(taskId: string): Promise<void> {
    const tabIds = this.catalogTasks.find((row) => row.taskId === taskId)?.tabIds ?? []
    const taskModel = this.session.tasksStore.get(taskId)
    const lead = taskModel.sessions.find((link) => link.role === 'lead')
    const leadServerId = lead ? attemptServerId({ link: lead, taskServerId: taskModel.serverId }) : null
    const leadTabIds = tabIds.filter((tabId) => {
      const tab = this.session.tabs[tabId]
      const session = this.session.sessionFor(tabId)
      if (!tab || !session) return false
      if (lead) return tab.sessionId === lead.sessionId
        && (!leadServerId || session.run.serverId === leadServerId)
      return taskRoleOf(session.task) === 'lead'
    })
    if (!lead && leadTabIds.length === 0) return
    await this.session.tasksStore.get(taskId).markRead(false)
    const notifiedSessions = new Set<string>()
    for (const tabId of leadTabIds) {
      const tab = this.session.tabs[tabId]
      if (!tab) continue
      tab.hasUnread = true
      // Marking unread is an explicit choice, so it belongs to the session on
      // its host rather than to this client — otherwise the phone still shows
      // the session as read. Once per session: several tabs can share one.
      if (notifiedSessions.has(tab.sessionId)) continue
      notifiedSessions.add(tab.sessionId)
      // A row can name a session the workspace no longer holds — a tab closing
      // while its task row is still on screen. The flag above is still correct
      // for that tab; there is just no host left to tell.
      const serverId = this.session.sessions.byId[tab.sessionId]?.run.serverId
      if (!serverId) continue
      void serverConnections.apiFor(serverId).setSessionReadState(tab.sessionId, null).catch(() => {})
    }
  }

  /** Opening a session whose snooze ended is the read that clears the woken
   *  mark: the host forgets the snooze. */
  acknowledgeRow(row: SidebarTask): void {
    if (!row.woke) return
    // Opening the task is a read: a failed clear of the reader's own snooze
    // is not an error to show, and the next open tries again.
    if (row.taskId) void this.session.tasksStore.get(row.taskId).snooze(null).catch(() => {})
    else this.snoozeRow(row.key, null)
  }

  /**
   * The session a session's row stands for, on its host. Null for a task row,
   * and for a session that has not started: its host does not know it yet.
   */
  private sessionOfRow(row: SidebarTask): { serverId: string; sessionId: string } | null {
    if (row.taskId) return null
    if (row.sessionId) return row.serverId ? { serverId: row.serverId, sessionId: row.sessionId } : null
    const tabId = row.tabIds[0]
    const session = tabId ? this.session.sessionFor(tabId) : null
    const sessionId = session?.agentSessionId ? session.id : null
    return tabId && sessionId ? { serverId: this.session.serverIdFor(tabId), sessionId } : null
  }

  /** Whether the row's session can be settled and snoozed: tasks cannot,
   *  neither can a session that has not started, and neither can a member who
   *  may only read a shared session (the host requires an editor). */
  canShelve(row: SidebarTask): boolean {
    const target = this.sessionOfRow(row)
    return target !== null && canDriveSession(target.serverId, target.sessionId)
  }

  /** Whether the row can be snoozed: a session's row as `canShelve` says, and
   *  a Solus task's row, which snoozes the task itself. A provider-owned
   *  ticket has no Solus record to hold the wake time. */
  canSnooze(row: SidebarTask): boolean {
    if (row.taskId) return this.session.tasksStore.peek(row.taskId)?.providerId === 'local'
    return this.canShelve(row)
  }

  /** Snooze a row on its host: a task's row snoozes the task for the reader
   *  alone (on every client they use), a session's row the session. `until` of null wakes it now,
   *  which is what the row's own Wake button and the undo toast both call. A
   *  prompt also wakes a session, on the host. */
  snoozeRow(rowKey: string, until: number | null, note = ''): void {
    const row = this.catalogTasks.find((task) => task.key === rowKey)
    if (!row) return
    const wasActive = row.lifecycle === 'active'
    const target = this.sessionOfRow(row)
    const write = row.taskId
      ? this.session.tasksStore.get(row.taskId).snooze(until, note)
      : target
        ? sessionStatesStore.snooze(target.serverId, target.sessionId, until, note)
        : null
    if (!write) return
    void write
      .then(() => {
        if (until !== null && wasActive) this.composeNextPromptIfNoActiveTask(row)
      })
      .catch(async () => {
        // The undo toast already said it moved; say that it did not.
        const { toasts } = await import('../../lib/toasts')
        toasts.error(until === null ? "Couldn't wake it" : "Couldn't snooze it")
      })
  }

  /** Open a settled or snoozed session that has no conversation here. */
  private async openShelvedSession(row: SidebarTask): Promise<void> {
    if (!row.sessionId || !row.serverId) return
    const meta = await readSessionMeta(row.serverId, row.sessionId)
    if (meta) await this.session.opening.resumeSession(meta)
  }

  /**
   * The check on a session's row. It settles the session on its host and
   * unloads its conversation; the row goes to Completed on every client. On a
   * settled session it makes the session active again, and opens it when no
   * conversation of it is here. A session that has not started has nothing on
   * its host, so its row is only closed.
   */
  private async toggleSessionSettled(row: SidebarTask): Promise<void> {
    const target = this.canShelve(row) ? this.sessionOfRow(row) : null
    if (!target) {
      this.closeTask(row)
      return
    }
    if (row.lifecycle === 'completed') {
      if (!row.tabIds.length) await this.openShelvedSession(row)
      await sessionStatesStore.setSettled(target.serverId, target.sessionId, false)
      return
    }
    await sessionStatesStore.setSettled(target.serverId, target.sessionId, true)
    this.closeTask(row)
  }

  /** Put a durable task and every linked attempt back into the sidebar. The
   * picker is an explicit reversal of per-row dismissal, so it restores the
   * task and its sessions without changing any task lifecycle state. */
  restoreTask(taskId: string): void {
    const task = this.session.tasksStore.peek(taskId)
    if (!task) return
    const sessions = this.session.tasksStore.get(task.id).sessions
    const rowKeys = [task.id, ...sessions.map((link) => `session:${link.sessionId}`)]
    for (const rowKey of rowKeys) this.dismissedRowKeys.delete(rowKey)
    removeDismissedSidebarRows(rowKeys)
    for (const link of sessions) this.session.showExplicitSidebarTaskSession(task.id, link.sessionId)
    this.openTaskIds.add(task.id)
    this.persistOpenTaskIds()
  }

  /** Save the open set, dropping tasks that no longer exist so it cannot grow
   *  without bound. Only against a loaded store: before load every task looks
   *  deleted. */
  private persistOpenTaskIds(): void {
    if (this.session.tasksStore.loaded) {
      const listedTaskIds = new Set(this.session.tasksStore.tasks.map((task) => task.id))
      for (const taskId of this.openTaskIds) {
        if (!listedTaskIds.has(taskId)) this.openTaskIds.delete(taskId)
      }
    }
    persistOpenSidebarTaskIds(this.openTaskIds)
  }

  /** `includeRestorable` keeps rows that task restoration will reveal: rows
   *  hidden by per-row dismissal and valid links projected under another task. */
  private buildSessions(
    taskId: string | null | undefined,
    tabIds: string[],
    includeRestorable = false,
  ): SidebarSessionChild[] {
    if (!taskId) return tabIds.map((tabId) => this.childForTab(tabId))
    const record = this.session.tasksStore.tasks.find((candidate) => candidate.id === taskId)
    if (!record) return []

    // The lead first — it owns the task's conversation — then the workers in
    // the order they were linked.
    const linkedSessions = this.session.tasksStore.get(record.id).sessions
      .toSorted((a, b) => Number(b.role === 'lead') - Number(a.role === 'lead') || a.linkedAt - b.linkedAt)
    const seenSessionIds = new Set<string>()
    const children: SidebarSessionChild[] = []
    const projectKey = record.projectKey ?? undefined

    for (const link of linkedSessions) {
      if (seenSessionIds.has(link.sessionId)) continue
      seenSessionIds.add(link.sessionId)
      if (!includeRestorable && !this.projectsSessionUnder(record.id, link)) continue
      const tabId = this.tabIdBySessionId.get(link.sessionId)
      const dismissalKey = `session:${link.sessionId}`
      const isLead = link.role === 'lead'
      const linkServerId = attemptServerId({
        link,
        taskServerId: this.session.tasksStore.get(record.id).serverId,
      })
      if (
        !includeRestorable
        && !shouldShowSidebarChild(this.dismissedRowKeys.has(dismissalKey), !!tabId)
      ) continue
      if (tabId) {
        const child = this.liveChildFor(tabId)
        children.push(withLazyActivity({
          ...child,
          // A row stands for one session, so it is named by that session.
          // Naming every attempt after the task drew four identical rows for
          // four conversations, and made renaming one of them impossible: the
          // typed name landed on the session while the row went on reading its
          // task. The task title is still the fallback for a session that has
          // no name of its own.
          label: sessionDisplayName({ link, liveTitle: child.label, taskTitle: record.title }),
          taskId: record.id,
          sessionId: link.sessionId,
          projectKey,
          serverId: child.serverId ?? linkServerId,
          provider: child.provider ?? link.provider,
          modelId: child.modelId ?? link.model,
          branchName: child.branchName ?? link.branch ?? null,
          dismissalKey,
          isLead,
        },
        // A restored tab can exist before its transcript is hydrated. The
        // durable link still knows when that session was active; do not turn
        // an empty mounted transcript into the Unix epoch in the picker.
        () => restoredSessionActivityAt(this.tabActivityAt(tabId), link)))
        continue
      }
      const liveState = this.sessionStatusFeed().stateFor(linkServerId, link.sessionId)
      const checkout = link.checkoutPath && linkServerId ? this.session.environment.checkouts.get(linkServerId, link.checkoutPath) : undefined
      children.push({
        taskId: record.id,
        sessionId: link.sessionId,
        projectKey,
        branchName: checkout ? checkout.checkout?.branch ?? null : link.branch ?? null,
        label: sessionDisplayName({ link, taskTitle: record.title }),
        attention: liveState?.attention ?? null,
        unread: liveState?.attention === 'error',
        serverId: linkServerId,
        provider: link.provider,
        modelId: link.model,
        runStartedAt: liveState?.attention === 'running' ? liveState.runStartedAt : 0,
        lastActivityAt: link.lastActivityAt ?? link.linkedAt,
        reviewGuideStatus: null,
        dismissalKey,
        isLead,
      })
    }

    for (const tabId of this.pendingTabByTaskId.get(record.id) ?? []) {
      if (children.some((child) => child.tabId === tabId)) continue
      const dismissalKey = `tab:${tabId}`
      if (!includeRestorable && this.dismissedRowKeys.has(dismissalKey)) continue
      const child = this.liveChildFor(tabId)
      const pendingSession = this.session.sessionFor(tabId)
      children.push(withLazyActivity({
        ...child,
        label: child.label,
        taskId: record.id,
        projectKey,
        dismissalKey,
        // A lead's tab is the lead before its link arrives, so the task row
        // stands for it from its first prompt.
        isLead: !!pendingSession && taskRoleOf(pendingSession.task) === 'lead',
      }, () => this.tabActivityAt(tabId)))
    }

    // One row per session across its homes: the runner while it is connected,
    // else the cloud record, marked.
    return mergeSessionHomes(children, this.sessionHomes)
  }

  selectTab(tabId: string): void {
    // Sidebar rows are navigation, so selecting the active row reveals it.
    // A selected, read conversation has nothing to do. An unread one must
    // still reach the workspace's acknowledgement, even when it is the only
    // tab and there is no other session to switch through.
    if (tabId === this.session.activeTabId
      && this.session.showsConversation
      && !this.session.tabs[tabId]?.hasUnread) return
    this.session.selectTab(tabId)
  }

  async selectTask(task: SidebarTask, timing?: TaskOpenTrace): Promise<void> {
    // A task is talked to through its lead, with the task page beside it
    // (docs/plans/task-conversation.md). A task with no lead gets a lead
    // draft. Its other sessions are on its page.
    const record = task.taskId ? this.taskRecord(task.taskId) : undefined
    if (record) {
      await this.session.opening.openTask(record, timing)
      return
    }
    // A session's own row stands for one conversation: the mounted one, or
    // the one its host names for a shelved session.
    const tabId = task.tabIds[0]
    if (tabId) this.selectTab(tabId)
    else await this.openShelvedSession(task)
    timing?.shown()
  }

  /** Restore a picker result, then open it as clicking its sidebar row does. */
  async selectTaskRecord(task: Task): Promise<void> {
    this.restoreTask(task.id)
    await this.session.opening.openTask(task)
  }

  async selectChild(child: SidebarSessionChild): Promise<void> {
    if (child.taskId && child.sessionId) {
      this.session.selectSidebarTaskOccurrence(child.taskId, child.sessionId)
    }
    if (child.tabId) {
      this.selectTab(child.tabId)
      return
    }
    // A task written in the composer has no session at all until someone opens
    // it. Clicking its row is that moment: start one bound to the task, in the
    // task's own project, rather than leaving the row inert.
    if (!child.sessionId) {
      const record = child.taskId
        ? this.session.tasksStore.tasks.find((candidate) => candidate.id === child.taskId)
        : undefined
      if (record) await this.session.opening.openTaskSession(record)
      return
    }
    // The task link already names the exact session and its host. A legacy row
    // without a host is inert — no probe, no guess.
    if (!child.serverId) return
    const meta = await readSessionMeta(child.serverId, child.sessionId)
    if (meta) await this.session.opening.resumeSession(meta)
  }

  /** Close tabs and, when the active one goes, move forward: the next open
   *  sidebar row below it, wrapping to the top. With none left, a draft in the
   *  closed conversation's project takes its place. */
  closeTabs(tabIds: string[], via: Via = 'click'): void {
    const activeTabId = this.session.activeTabId
    const closesActiveTab = tabIds.includes(activeTabId)
    const openRows = [...this.taskRows, ...this.sessionRows, ...this.workingRows]
    const sidebarTasks = [
      ...openRows,
      ...this.snoozedTasks,
      ...this.completedTasks,
    ]
    const sidebarTabIds = sidebarTasks.flatMap((task) =>
      this.sessionsFor(task).flatMap((child) => child.tabId ? [child.tabId] : []),
    )
    const openTabIds = openRows.flatMap((task) =>
      this.sessionsFor(task).flatMap((child) => child.tabId ? [child.tabId] : []),
    )
    const nextTabId = closesActiveTab
      ? nextOpenSidebarTabAfterClose(sidebarTabIds, openTabIds, tabIds, activeTabId)
      : null
    // Minted before the close so it inherits the closing conversation's
    // project; afterwards the source would be whatever tab the close landed on.
    // A fresh task, so the draft never files under the task being closed.
    const fallbackDraft = closesActiveTab && !nextTabId && this.session.showsConversation
      ? this.session.drafts.createSessionDraft({ freshTask: true, sourceId: activeTabId, via })
      : null

    for (const tabId of tabIds) this.session.closeTab(tabId, via)

    if (!closesActiveTab) return
    if (nextTabId && this.session.tabs[nextTabId]) this.session.selectTab(nextTabId)
    else if (fallbackDraft) this.session.drafts.openDraft(fallbackDraft.id, via)
  }

  /** Ending the column's last live task must not drop the pane onto a shelved
   * one. Keep this lifecycle fallback separate from `closeTabs` because task
   * dismissal can remove the row before its mounted tabs are closed. */
  private composeNextPromptIfNoActiveTask(endedTask: SidebarTask): void {
    if (endedTask.lifecycle !== 'active' || this.activeTasks.length) return
    if (!this.session.showsConversation) return
    this.session.drafts.openSessionDraft({ freshTask: true, via: 'click' })
  }

  /** The same rule at launch: the snapshot restores whichever conversation was
   *  last on screen, and its task can have finished since. Only the task store
   *  can say, so its first answer is the one chance to decide — after that,
   *  opening a completed task is deliberate. Nothing is revealed, so this never
   *  changes the startup route. */
  private settleBootLocation(): void {
    if (this.hasSettledBootLocation || !this.session.tasksStore.loaded) return
    this.hasSettledBootLocation = true
    if (this.activeTasks.length || !this.session.showsConversation) return
    this.session.drafts.openSessionDraft({ freshTask: true, reveal: false })
  }

  /** The checkmark: completing says "I am finished with this", so it also
   *  unloads the mounted conversation, exactly as the row's close control
   *  does. A task becomes done and moves to the Completed shelf, resumable
   *  from there. A session is settled on its host and goes to the same shelf.
   *  The check on finished work takes it back. */
  async completeTask(task: SidebarTask): Promise<void> {
    const durable = this.session.tasksStore.peek(task.taskId)
    if (!durable) {
      await this.toggleSessionSettled(task)
      return
    }
    // The row draws one finished glyph for both endings, so the control under
    // it has to take both of them back.
    if (durable.status === 'done' || durable.status === 'dropped') {
      await this.session.tasksStore.get(durable.id).setStatus('todo')
      this.completedHereTaskIds.delete(durable.id)
      // The shelf lists finished work whether or not this client has the row
      // open, so a task reopened from there has nowhere to land — it leaves
      // Completed and the column never listed it. Put the row back.
      this.restoreTask(durable.id)
      return
    }
    await this.markTaskDone(durable.id)
    this.closeTabs(task.tabIds)
    this.composeNextPromptIfNoActiveTask(task)
  }

  /** Close a sidebar task's mounted tabs while keeping its durable sessions
   *  available to resume from history. */
  closeTask(task: SidebarTask): void {
    const tabIdsToClose = task.tabIds.filter((tabId) =>
      !this.catalogTasks.some((candidate) =>
        candidate.id !== task.id && candidate.tabIds.includes(tabId),
      ),
    )
    if (task.taskId) {
      this.session.clearSidebarTaskOccurrences(task.taskId)
      this.dismissedRowKeys.add(task.taskId)
      persistDismissedSidebarRow(task.taskId)
      this.openTaskIds.delete(task.taskId)
      this.persistOpenTaskIds()
    }
    this.closeTabs(tabIdsToClose)
    if (tabIdsToClose.length) this.composeNextPromptIfNoActiveTask(task)
  }

  /** Hide tasks for their Undo window, and close their mounted conversations
   *  first so the view moves on instead of staying on deleted work. The
   *  sessions stay resumable from history, as they do after a close. */
  deleteTasks(taskIds: string[]) {
    const deleting = new Set(taskIds)
    const tabIdsToClose = this.catalogTasks.flatMap((task) =>
      task.taskId && deleting.has(task.taskId) ? task.tabIds : [],
    )
    if (tabIdsToClose.length) this.closeTabs(tabIdsToClose)
    return this.session.tasksStore.softRemove(taskIds)
  }

  /** Close one session's mounted tab under a row while keeping its durable session. */
  closeChild(child: SidebarSessionChild): void {
    if (child.dismissalKey) {
      this.dismissedRowKeys.add(child.dismissalKey)
      persistDismissedSidebarRow(child.dismissalKey)
    }
    if (child.tabId) this.closeTabs([child.tabId])
  }

  /** Keyboard dismissal targets a mounted row by tab id. Durable children hide
   *  independently; a loose session owns its whole temporary task row. */
  closeSidebarTab(tabId: string): void {
    for (const task of this.catalogTasks) {
      const child = this.sessionsFor(task).find((candidate) => candidate.tabId === tabId)
      if (task.taskId && child) {
        this.closeChild(child)
        return
      }
      if (task.tabIds.includes(tabId)) {
        this.closeTask(task)
        return
      }
    }
  }

  /** Pin or unpin the session backing a tab. No-op for tabs without an agent session. */
  async togglePinnedSession(tabId: string): Promise<void> {
    const tab = this.session.tabs[tabId]
    const session = this.session.sessionFor(tabId)
    if (!tab || !session?.agentSessionId) return

    const pinServerId = serverConnections.resolveId(session.run.serverId)
    // Captured before the toggle: the list orders by `pinnedAt`, so restoring a
    // pin with a fresh timestamp would put it back at the top rather than where
    // the user had it. Undo has to return the row to its own place.
    const existing = this.pinnedSessions.find((row) =>
      row.sessionId === session.id && row.serverId === pinServerId,
    )
    const pin: PinnedSession = {
      sessionId: session.id,
      serverId: pinServerId,
      provider: session.run.provider ?? this.settings.activeAgent,
      title: sessionTitle(session),
      cwd: session.run.gitContext?.worktreePath ?? session.run.workingDirectory,
      pinnedAt: existing?.pinnedAt ?? Date.now(),
    }
    // The pin lives on the session's own host; the host's answer is only that
    // host's manifest, so the federated list reloads rather than adopting it.
    await serverConnections.apiFor(pinServerId).togglePinnedSession(pin)
    await this.loadPinnedSessions()
    if (existing) void this.offerUnpinUndo(pin, pinServerId)
  }

  /**
   * Offer to put a just-unpinned session back. Unpinning is one keystroke and
   * drops the row out of the pinned list entirely, so without this the only way
   * back is to find the session again in history and pin it a second time.
   */
  private async offerUnpinUndo(pin: PinnedSession, serverId: string): Promise<void> {
    // Imported here rather than at module scope: this store is the sidebar's
    // model and is loaded headlessly by tests that never render a toast, and a
    // static import would pull the toast renderer into every one of them. The
    // module is already resolved by the time an unpin can happen.
    const { toasts } = await import('../../lib/toasts')
    toasts.undo(`Unpinned ${pin.title || 'session'}`, () => {
      void (async () => {
        // A newer pin or unpin for the same session has already answered this
        // question; re-pinning now would contradict it.
        if (this.isPinned(pin.sessionId, serverId)) return
        try {
          await serverConnections.apiFor(serverId).togglePinnedSession(pin)
          await this.loadPinnedSessions()
        } catch {
          toasts.error("Couldn't restore the pin")
        }
      })()
    })
  }

  /** Rename from a sidebar row. Pins carry their own label, so a pinned session
   *  needs the manifest re-read for the row to show the new name. */
  async renameSession(tabId: string, title: string): Promise<void> {
    const sessionId = this.session.sessionFor(tabId)?.id
    await this.session.metadata.renameTab(tabId, title)
    const serverId = this.session.sessionFor(tabId)?.run.serverId
    if (sessionId && this.isPinned(sessionId, serverId)) await this.loadPinnedSessions()
  }

  /** A closed pin has no mounted transcript, so read its indexed opening
   * prompt from the host that owns it before generating the replacement name. */
  async regeneratePinnedSessionTitle(pin: PinnedSession): Promise<void> {
    if (this.regeneratingPinnedSessionIds.has(pin.sessionId)) {
      throw new Error('The session title is already regenerating.')
    }
    const owningServerId = pin.serverId ?? serverConnections.defaultServerId()
    if (!owningServerId) throw new Error("Couldn't find the session's host.")
    const serverId = serverConnections.resolveId(owningServerId)
    const api = serverConnections.apiFor(serverId)
    this.regeneratingPinnedSessionIds.add(pin.sessionId)
    try {
      const info = await api.getSessionInfo(pin.sessionId)
      const openingPrompt = info?.firstMessage?.trim()
      if (!openingPrompt) throw new Error("Couldn't find the session's opening prompt.")
      const metadata = await api.generateSessionMetadata(openingPrompt, info?.cwd || pin.cwd, { sessionId: pin.sessionId, executionPreferences: this.settings.executionPreferences })
      if (!metadata) throw new Error("Couldn't generate a new session title.")
      await api.setSessionTitle(pin.sessionId, metadata.title, 'generated')
      await this.loadPinnedSessions()
    } finally {
      this.regeneratingPinnedSessionIds.delete(pin.sessionId)
    }
  }

  /** A durable task is named by its own record, and that is the whole write: the
   *  sessions under it keep the names they earned. Carrying the new title down
   *  into the lead session as well stamped a manual title onto a conversation
   *  the user never renamed, and reshaped its row out from under them.
   *
   *  A loose row has no record to name — the tab it stands for *is* its name, so
   *  there the session rename is the rename. */
  async renameTask(task: SidebarTask, title: string): Promise<void> {
    if (task.taskId) {
      await this.session.tasksStore.get(task.taskId).update({ title })
      return
    }
    const leadTabId = task.tabIds[0]
    if (leadTabId) await this.renameSession(leadTabId, title)
  }

  /** Unpin directly from a known host-scoped pin. */
  async unpinSession(pin: PinnedSession): Promise<void> {
    const serverId = pin.serverId
    if (!serverId) return
    const api = serverConnections.apiFor(serverConnections.resolveId(serverId))
    await api.togglePinnedSession($state.snapshot(pin))
    await this.loadPinnedSessions()
  }

  /** Focus an already-open tab for a pinned session, or resume it into a new tab. */
  async openPinnedSession(pin: PinnedSession): Promise<void> {
    const openTabId = this.openTabIdForPinned(pin)
    if (openTabId) {
      this.session.selectTab(openTabId)
      return
    }
    // We already have everything needed to resume directly: the session id and the real run
    // directory (pin.cwd — the worktree path when applicable). The transcript lives at
    // ~/.claude/projects/<encode(pin.cwd)>/<sessionId>.jsonl, and resumeSession derives the
    // load path from cwd, so there's no need to scan with listSessions first.
    await this.session.opening.resumeSession({
      provider: pin.provider,
      sessionId: pin.sessionId,
      serverId: pin.serverId,
      slug: null,
      firstMessage: pin.title,
      lastTimestamp: new Date(pin.pinnedAt).toISOString(),
      size: 0,
      cwd: pin.cwd,
      projectPath: '',
    })
  }
}

export const [getSessionSidebarStore, setSessionSidebarStore] = createAppContext<SessionSidebarStore>('session-sidebar')
