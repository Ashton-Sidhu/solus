import { createAppContext } from '../app/create-app-context'
import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import { untrack } from 'svelte'
import { worktreeProjectRoot, type PinnedSession, type Session, type Tab } from '@solus/contracts/types'
import type { Task, TaskSessionLink } from '@solus/contracts/task-types'
import { parseGitHubPullRequestUrl } from '@solus/contracts/providers'
import { existingTaskId, parentTaskId } from './session-draft.svelte'
import {
  buildProjectSummaries,
  compareTaskCreationOrder,
  groupTasks,
  maxTaskAttention,
  dedupePrChoices,
  prChipForChoices,
  pullRequestForBranches,
  reconcileSidebarTasks,
  resolveTaskSidebarLifecycle,
  snoozedRowKeyForTab,
  shouldCompleteTaskForPr,
  sidebarChildLabel,
  shouldShelveCompletedTask,
  shouldShowDurableSidebarTask,
  shouldShowSidebarChild,
  projectFilterChoices,
  resolveProjectFilter,
  sortTasksByCreation,
  sortSidebarRowsByCreation,
  sortTasks,
  taskStatusFor,
  type PrChip,
  type ProjectFilterChoice,
  type ProjectSummary,
  type SidebarTask,
  type MountedPrObservation,
  type TaskPrChoice,
  type TaskGroup,
} from '../../components/session/lib/task-list'
import { draftTitle, type DraftRow } from '../../components/session/lib/draft-list'
import { pickerProjectChoices as buildPickerProjectChoices } from '../../components/session/unified-picker/lib/picker-rows'
import { SidebarSessionStatusFeed } from '../../components/session/lib/sidebar-session-status'
import {
  attemptServerId,
  findOpenTabForSession,
  getAttentionState,
  sessionDisplayName,
  sessionTitle,
  type AttentionState,
} from '../../lib/sessionUtils'
import { environmentBranchKey, environmentProjectKey } from '../git/session-environment.store.svelte'
import type { PlanStore } from '../plans/plan.store.svelte'
import type { SettingsContext } from '../app/settings.context.svelte'
import type { WorkspaceContext } from './workspace.context.svelte'
import type { PrsStore } from '../prs/prs.store.svelte'
import type { ProjectPrs } from '../prs/project-prs.svelte'
import {
  closestOpenSidebarTabAfterClose,
  taskSessionTarget,
} from './session-sidebar-selection'
import {
  loadDismissedSidebarRowKeys,
  loadOpenSidebarTaskIds,
  loadSidebarRowSnoozes,
  persistSidebarRowSnoozes,
  type SidebarRowSnooze,
  persistDismissedSidebarRow,
  persistOpenSidebarTaskIds,
  removeDismissedSidebarRows,
} from './tab-persistence'
import {
  reviewGuideStore,
  sessionGuideIdentity,
} from '../../components/review/review-guide.store.svelte'
import { serverConnections } from '@solus/client-core/server-connections'
import { readSessionMeta } from '@solus/client-core/session-meta'
import { subscribeAllHosts } from '@solus/client-core/host-events'
import type { HostApi } from '@solus/client-core/host-api'
import {
  needsDiscoveredPrLink,
  prLinkDiscoveryAttempts,
  prLinkDiscoveryKey,
  type PrLinkDiscoveryAttempt,
  type PrLinkDiscoveryInput,
} from './pr-link-discovery'

/** A running turn began at its prompt, so the tail-most user message dates it.
 *  Bounded because it only ever has to look at the turn in flight — a deep walk
 *  through a long transcript would run on every stream tick. */
const TURN_START_SCAN_DEPTH = 200
const SIDEBAR_PR_POLL_MS = 60_000

function turnStartedAt(sess: Session): number {
  if (sess.currentTurnStartedAt) return sess.currentTurnStartedAt
  const messages = sess.messages
  const floor = Math.max(0, messages.length - TURN_START_SCAN_DEPTH)
  for (let i = messages.length - 1; i >= floor; i--) {
    const message = messages[i]
    if (message.role === 'user' && message.timestamp) return message.timestamp
  }
  return 0
}

function lastActivityAt(sess: Session): number {
  return sess.messages.at(-1)?.timestamp ?? 0
}

function restoredSessionActivityAt(
  liveActivityAt: number,
  link: Pick<TaskSessionLink, 'lastActivityAt' | 'linkedAt'>,
): number {
  return liveActivityAt || link.lastActivityAt || link.linkedAt
}

function firstActivityAt(sess: Session): number {
  return sess.messages.find((message) => message.timestamp)?.timestamp ?? Number.MAX_SAFE_INTEGER
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
  provider?: string | null
  modelId?: string | null
  /** Start of the turn in flight, for the elapsed readout. 0 unless running. */
  runStartedAt: number
  /** Newest known session activity. The task/session index supplies this for
   * closed sessions; mounted sessions use their live transcript. */
  lastActivityAt: number
  /** Stable persisted key for hiding this child without deleting its task or session. */
  dismissalKey?: string
  /** True when this session belongs to a child task rather than the root task. */
  isSubtask?: boolean
  /** Background walkthrough state for this exact agent session. */
  reviewGuideStatus: 'generating' | 'ready' | null
  /** Durable walkthrough state shown in the row tooltip after its notification
   * mark has been acknowledged. */
  reviewGuideTooltipStatus?: 'generating' | 'ready' | null
}

function projectLabel(projectKey: string): string {
  return projectKey === '~' ? '~' : projectKey.replace(/\/$/, '').split('/').at(-1) ?? '~'
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

/** Every durable identity that can describe one mounted conversation. A
 * worktree move forks the provider thread, so its source id must keep resolving
 * to the same tab or the sidebar projects the old attempt beside the live one. */
export function sidebarSessionIds(
  tab: Pick<Tab, 'sessionId'>,
  session: Pick<Session, 'handoffId' | 'agentSessionId' | 'forkedFromSessionId'> | null | undefined,
): string[] {
  return [
    tab.sessionId,
    session?.handoffId,
    session?.agentSessionId,
    session?.forkedFromSessionId,
  ].filter((sessionId): sessionId is string => !!sessionId)
}

export class SessionSidebarStore {
  private taskModelsById = new Map<string, SidebarTask>()
  /** The Completed shelf's own identity map. Its rows are disjoint from the
   *  column's, so they cannot share one without evicting each other. */
  private shelvedRowModelsById = new Map<string, SidebarTask>()
  private liveSessionStatuses?: SidebarSessionStatusFeed
  private openTaskIds: SvelteSet<string>
  private hasSeededOpenTasks: boolean
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

  /** Which tab, if any, has a given stable or active provider session mounted. Built once per
   *  pass: every task row needs this answer for each of its linked sessions, and
   *  scanning the open tabs per lookup made the column O(tasks × sessions × tabs)
   *  on every stream tick. */
  private tabIdBySessionId: Map<string, string> = $derived.by(() => {
    const bySessionId = new Map<string, string>()
    for (const tabId of this.visibleTabIds) {
      const tab = this.session.tabs[tabId]
      const session = this.session.sessionFor(tabId)
      if (!tab) continue
      for (const sessionId of sidebarSessionIds(tab, session)) {
        bySessionId.set(sessionId, tabId)
      }
    }
    return bySessionId
  })

  /** The user's own "I am finished with this", which nothing else in the app
   *  knows. Deliberately not persisted: a completed task stays for the session
   *  and drops out when it closes or the app restarts. */
  private doneTaskIds = new SvelteSet<string>()

  /** Durable tasks remain in the task board after their sidebar row is closed.
   *  This is persisted view state only: closing a row must not rewrite the
   *  task's lifecycle status. A later, explicitly opened tab restores it. */
  private dismissedRowKeys = new SvelteSet<string>(loadDismissedSidebarRowKeys())

  /** Wake times for snoozed rows, keyed by row key. Snoozing hides a row under
   *  the Snoozed shelf and says nothing about the work, so it is sidebar view
   *  state like the dismissals above — a row needs no task to have one. */
  private rowSnoozes = new SvelteMap<string, SidebarRowSnooze>(loadSidebarRowSnoozes())

  /** Advances when the next snooze is due, so a shelved row returns on time. */
  lifecycleNow = $state(Date.now())
  private observedPrLifecycle = new Set<string>()
  private prDiscoveryInFlight = new Set<string>()
  readonly regeneratingPinnedSessionIds = new SvelteSet<string>()

  /** Tabs opened for a task that do not have a durable link yet. Children
   *  resolve to their root because the sidebar
   *  renders one durable row for the whole task tree. */
  private pendingTabByTaskId: Map<string, string[]> = $derived.by(() => {
    const byTaskId = new SvelteMap<string, string[]>()
    for (const tabId of this.visibleTabIds) {
      const sess = this.session.sessionFor(tabId)
      // `session_init` assigns the provider id before the durable task link has
      // finished hydrating. The provisional task id must keep owning the tab
      // during that handoff or the row briefly changes shape in the sidebar.
      const task = this.pendingTaskFor(sess)
      if (!task) continue
      const rootTaskId = task.parentId ?? task.id
      const tabIds = byTaskId.get(rootTaskId)
      if (tabIds) tabIds.push(tabId)
      else byTaskId.set(rootTaskId, [tabId])
    }
    return byTaskId
  })

  /** The task an unlinked tab already belongs to: the one it was opened
   *  for, or — for a fork, whose own subtask is minted after its first turn — the
   *  parent it will hang under. */
  private pendingTaskFor(session: Session | null | undefined): Task | undefined {
    const taskId = session ? existingTaskId(session.task) ?? parentTaskId(session.task) : undefined
    if (!taskId) return undefined
    return this.session.tasksStore.tasks.find((candidate) => candidate.id === taskId)
  }

  /** A root task's child records, in the order they were created. */
  private childrenOf(taskId: string): Task[] {
    return [...(this.session.tasksStore.byParent.get(taskId) ?? [])].sort(
      compareTaskCreationOrder,
    )
  }

  /**
   * Whether a link earns the session a row under this root. The owning link
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
   * One durable task's row, aggregated over its whole tree. Shared by the
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
    const children = this.childrenOf(task.id)
    const taskTree = [task, ...children]
    const tabIds: string[] = []
    let attention: AttentionState = null
    let unread = false
    let activityAt = taskTree.reduce((latest, item) => Math.max(latest, item.updatedAt), 0)
    let createdAt = task.createdAt ?? task.updatedAt
    let runStartedAt = 0
    // The host the task is being worked on, taken from the first session it
    // has open. A task record remembers a project, never a machine — but its
    // links remember one each, which is what answers for a task whose only
    // session is closed.
    let serverId: string | null = null
    let linkedServerId: string | null = null

    for (const item of taskTree) {
      for (const link of this.session.tasksStore.get(item.id).sessions) {
        if (!this.projectsSessionUnder(task.id, link)) continue
        const linkServerId = attemptServerId({
          link,
          taskServerId: this.session.tasksStore.get(item.id).serverId,
        })
        linkedServerId ??= linkServerId
        createdAt = Math.min(createdAt, link.startedAt ?? createdAt)
        const liveState = this.sessionStatusFeed().stateFor(linkServerId, link.sessionId)
        attention = maxTaskAttention(attention, liveState?.attention ?? null)
        if (liveState?.attention === 'running') {
          runStartedAt = runStartedAt === 0
            ? liveState.runStartedAt
            : Math.min(runStartedAt, liveState.runStartedAt)
        }
        const tabId = openTabBySessionId.get(link.sessionId)
        if (!tabId || tabIds.includes(tabId)) continue
        tabIds.push(tabId)
        const tab = this.session.tabs[tabId]
        const session = this.session.sessionFor(tabId)
        if (!tab || !session) continue
        createdAt = Math.min(createdAt, firstActivityAt(session))
        serverId ??= session.run.serverId ?? null
        const nextAttention = getAttentionState(session, tab, this.planStore.plans)
        attention = maxTaskAttention(attention, nextAttention)
        unread ||= tab.hasUnread
        activityAt = Math.max(activityAt, lastActivityAt(session))
        if (nextAttention === 'running') {
          const startedAt = turnStartedAt(session)
          if (startedAt > 0) runStartedAt = runStartedAt === 0 ? startedAt : Math.min(runStartedAt, startedAt)
        }
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
      attention = maxTaskAttention(attention, nextAttention)
      unread ||= tab.hasUnread
      activityAt = Math.max(activityAt, lastActivityAt(session))
      if (nextAttention === 'running') {
        const startedAt = turnStartedAt(session)
        if (startedAt > 0) runStartedAt = runStartedAt === 0 ? startedAt : Math.min(runStartedAt, startedAt)
      }
    }
    const projectKey = worktreeProjectRoot(task.projectKey ?? '~')
    const rowSnooze = this.rowSnoozes.get(task.id)
    const lifecycle = resolveTaskSidebarLifecycle({
      status: task.status,
      doneAt: task.doneAt,
      updatedAt: task.updatedAt,
      lastReadAt: task.lastReadAt,
      snoozedUntil: rowSnooze?.until,
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
      activityAt,
      runStartedAt,
      lifecycle: lifecycle.lifecycle,
      completedAt: lifecycle.completedAt,
      snoozedUntil: lifecycle.snoozedUntil,
      snoozeNote: rowSnooze?.note ?? null,
      lastReadAt: lifecycle.lastReadAt,
      woke: lifecycle.woke,
      tabIds,
    }
  }

  /** Every sidebar task, unfiltered and unsorted — the rail's counts and the
   *  one-project checks both have to see the whole column. */
  allTasks: SidebarTask[] = $derived.by(() => {
    // Persisted tabs are materialized synchronously, before the task store has
    // loaded the task-to-session links that classify them. Do not project that
    // incomplete snapshot as loose tasks: it flashes every restored session as
    // a separate row during refresh.
    if (!this.session.tasksStore.loaded) {
      return reconcileSidebarTasks(this.taskModelsById, [])
    }

    const openTabBySessionId = this.tabIdBySessionId

    const durableTasks = sortTasksByCreation(this.session.tasksStore.tasks)
      .filter((task) => {
        const taskTree = [task, ...this.childrenOf(task.id)]
        const durableLinks = taskTree.flatMap((item) =>
          this.session.tasksStore.get(item.id).sessions,
        )
        const hasProjectedSession = durableLinks.some((link) =>
          this.projectsSessionUnder(task.id, link),
        )
        if (durableLinks.length && !hasProjectedSession && !this.pendingTabByTaskId.has(task.id)) {
          return false
        }
        const isDismissed = this.dismissedRowKeys.has(task.id)
        const hasOpenSession = isDismissed && (
          this.pendingTabByTaskId.has(task.id)
          || taskTree.some((item) =>
            this.session.tasksStore.get(item.id).sessions.some((link) =>
              this.projectsSessionUnder(task.id, link)
              && openTabBySessionId.has(link.sessionId),
            ),
          )
        )
        return shouldShowDurableSidebarTask(
          task,
          isDismissed,
          hasOpenSession,
          this.openTaskIds.has(task.id),
        )
      })
      .map((task) => this.buildDurableTaskRow(task, openTabBySessionId))

    // A new session stays loose until its first turn settles. Older resumed
    // sessions can also predate task minting. Each stays visible as its own
    // temporary row rather than reviving the deleted branch projection.
    const looseTasks: SidebarTask[] = []
    for (const tabId of this.visibleTabIds) {
      const session = this.session.sessionFor(tabId)
      const tab = this.session.tabs[tabId]
      if (!session || !tab) continue
      const linkedTask = this.session.tasksStore.taskForSession(session.handoffId ?? session.id)
        ?? this.session.tasksStore.taskForSession(session.agentSessionId)
      if (linkedTask || this.pendingTaskFor(session)) continue

      const environment = this.session.environment.environmentFor(this.session.sessionFor(tabId)?.run)
      const projectKey = environmentProjectKey(environment, session.run.projectGroupPath)
      const attention = getAttentionState(session, tab, this.planStore.plans)
      const markedDone = this.doneTaskIds.has(tabId)
      const rowSnooze = this.rowSnoozes.get(tabId)
      const lifecycle = resolveTaskSidebarLifecycle({
        status: markedDone ? 'done' : 'in_progress',
        snoozedUntil: rowSnooze?.until,
        attention,
        now: this.lifecycleNow,
      })
      looseTasks.push({
        id: tabId,
        key: tabId,
        title: sessionTitle(session),
        projectKey,
        projectLabel: projectLabel(projectKey),
        branchName: environment.branch,
        serverId: session.run.serverId ?? null,
        prNumber: null,
        status: taskStatusFor(attention, markedDone),
        attention,
        unread: tab.hasUnread && !markedDone,
        createdAt: firstActivityAt(session),
        activityAt: lastActivityAt(session),
        runStartedAt: attention === 'running' ? turnStartedAt(session) : 0,
        lifecycle: lifecycle.lifecycle,
        completedAt: 0,
        snoozedUntil: lifecycle.snoozedUntil,
        snoozeNote: rowSnooze?.note ?? null,
        lastReadAt: 0,
        woke: false,
        tabIds: [tabId],
      })
    }

    return reconcileSidebarTasks(
      this.taskModelsById,
      sortSidebarRowsByCreation([...durableTasks, ...looseTasks]),
    )
  })

  /** The sidebar aggregates every catalog host's rows into one list
   * (dispatch-client step 2); a row's own host still routes its actions. */
  catalogTasks: SidebarTask[] = $derived(this.allTasks)

  /** Transcript and status fields can rebuild sidebar rows. PR discovery only
   * depends on task identity, host, project, linked PR, and branch inputs. */
  private prDiscoveryInputKey: string = $derived.by(() => {
    const inputs: PrLinkDiscoveryInput[] = []
    for (const task of this.catalogTasks) {
      if (!task.taskId) continue
      const attempts = this.prDiscoveryAttemptsFor(task)
      const branches = [
        ...attempts
          .filter((attempt) => !this.tabIdBySessionId.has(attempt.sessionId))
          .map((attempt) => attempt.branchName),
        task.branchName,
      ]
      const prUrls = this.mountedPrObservations(task)
        .map((observation) => observation.prUrl)
        .filter((url): url is string => !!url)
      const prNumbers = [
        ...this.session.tasksStore.get(task.taskId).prLinks.map((link) => link.number),
        ...prUrls.flatMap((url) => {
          const parsed = parseGitHubPullRequestUrl(url)
          return parsed ? [parsed.number] : []
        }),
      ]
      if (!prNumbers.length && !branches.some(Boolean)) continue
      const serverId = this.session.tasksStore.get(task.taskId).serverId ?? task.serverId
      if (!serverId) continue
      inputs.push({
        taskId: task.taskId,
        serverId,
        projectKey: task.projectKey,
        prNumbers,
        prUrls,
        branches,
        originSessionId: attempts.find((attempt) => !!attempt.branchName)?.sessionId ?? null,
      })
    }
    return prLinkDiscoveryKey(inputs)
  })

  /** Root tasks any catalog host can restore through the sidebar picker.
   * Unlike `catalogTasks`, this includes rows the user dismissed earlier. */
  pickableTasks: Task[] = $derived.by(() =>
    this.session.tasksStore.tasks.filter((task) => !task.parentId),
  )

  /** Every open project, with the counts and the lead task the breadcrumb's
   *  picker lands on. */
  projectSummaries: ProjectSummary[] = $derived(buildProjectSummaries(this.catalogTasks))

  /** With no active task row, the draft in the focused composer is the only
   *  current project context. Keep the sidebar scoped to it instead of leaving
   *  a completed task or an empty catalog to decide what project is current. */
  private draftProjectChoice: ProjectFilterChoice | null = $derived.by(() => {
    if (this.catalogTasks.some((task) => task.lifecycle === 'active')) return null
    const sourceId = this.session.focusedSourceId
    const draft = sourceId ? this.session.sessionDrafts.get(sourceId) : undefined
    if (!draft) return null
    const projectKey = environmentProjectKey(
      this.session.environment.environmentFor(draft.run),
      draft.run.projectGroupPath,
    )
    return { projectKey, label: projectLabel(projectKey), count: 0 }
  })

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
  currentProject: ProjectFilterChoice | null = $derived.by(() => {
    const sourceId = this.session.focusedSourceId
    const draft = sourceId ? this.session.sessionDrafts.get(sourceId) : undefined
    const run = draft?.run ?? (sourceId ? this.session.sessionFor(sourceId)?.run : undefined)
    if (!run) return null
    const projectKey = environmentProjectKey(
      this.session.environment.environmentFor(run),
      run.projectGroupPath,
    )
    if (!projectKey || projectKey === '~') return null
    return { projectKey, label: projectLabel(projectKey), count: 0 }
  })

  /** The projects the task picker offers as a scope. Built from what that
   *  picker can actually list, not from the sidebar's columns. */
  pickerProjectChoices: ProjectFilterChoice[] = $derived(
    buildPickerProjectChoices(this.pickableTasks, this.currentProject),
  )

  /** The project the list is scoped to, or null for all of them. Resolved
   *  against the column's own contents so a project that has left it never
   *  keeps scoping the list to something no longer there. */
  private openProjectFilter: string | null = $derived.by(() =>
    resolveProjectFilter(this.settings.sidebarProjectFilter, this.catalogTasks),
  )

  /** The project the trigger and the empty line name, or null while unfiltered. */
  scopedProject: ProjectFilterChoice | null = $derived.by(() => {
    if (this.draftProjectChoice) return this.draftProjectChoice
    const filter = this.openProjectFilter
    if (!filter) return null
    return this.projectFilterChoices.find((choice) => choice.projectKey === filter) ?? null
  })

  /** Every open task, before the filter. The order tasks arrived in, held:
   *  lifecycle changes update a row in place; only an explicit sidebar
   *  dismissal removes it. */
  activeTasks: SidebarTask[] = $derived(this.catalogTasks.filter((task) => task.lifecycle === 'active'))

  /** What the column actually lists. Filtering is a subset of the same order,
   *  never a re-sort. */
  visibleTasks: SidebarTask[] = $derived(this.inFilter(this.activeTasks))
  snoozedTasks: SidebarTask[] = $derived(
    this.inFilter(this.catalogTasks.filter((task) => task.lifecycle === 'snoozed'))
      .toSorted((a, b) => a.snoozedUntil - b.snoozedUntil || a.id.localeCompare(b.id)),
  )
  /**
   * Finished work the column itself never listed.
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

  completedTasks: SidebarTask[] = $derived(
    this.inFilter([
      ...this.catalogTasks.filter((task) => task.lifecycle === 'completed'),
      ...this.shelvedCompletedTasks,
    ]).toSorted((a, b) => b.completedAt - a.completedAt || a.id.localeCompare(b.id)),
  )

  /** The filter's own choices, over every project the column knows about. */
  projectFilterChoices: ProjectFilterChoice[] = $derived.by(() => {
    const choices = projectFilterChoices(this.catalogTasks)
    const draftChoice = this.draftProjectChoice
    if (draftChoice && !choices.some((choice) => choice.projectKey === draftChoice.projectKey)) {
      choices.push(draftChoice)
    }
    return choices
  })

  /** Grouped by project, unfiltered — the phone lists projects as collapsible
   *  sections rather than filtering to one, and must not inherit a scope set on
   *  a surface that has no control to clear it. */
  taskGroups: TaskGroup[] = $derived(groupTasks(this.activeTasks))

  private inFilter(tasks: SidebarTask[]): SidebarTask[] {
    const filter = this.scopedProject?.projectKey ?? null
    return filter ? tasks.filter((task) => task.projectKey === filter) : tasks
  }

  /** Prompts written and set aside, in the order they were opened. Two things
   *  keep a draft out: nothing has been written in it — every ⌘N opens one and
   *  boot seeds one, so listing those would fill the section with rows nobody
   *  wrote — or a pane is composing it right now, which is the prompt in front
   *  of the user rather than one they parked. Moving off it is what files it
   *  here. */
  draftRows: DraftRow[] = $derived.by(() => {
    const composing = this.session.composingDraftIds
    const filter = this.scopedProject?.projectKey ?? null
    const rows: DraftRow[] = []
    for (const draft of this.session.sessionDrafts.values()) {
      if (draft.isEmpty || composing.has(draft.id)) continue
      const projectKey = environmentProjectKey(
        this.session.environment.environmentFor(draft.run),
        draft.run.projectGroupPath,
      )
      // A draft with no repo behind it belongs to nothing yet, so no project
      // scope can exclude it.
      if (filter && projectKey !== filter && projectKey !== '~') continue
      rows.push({
        draftId: draft.id,
        title: draftTitle(draft.prompt),
        projectKey,
        projectLabel: projectLabel(projectKey),
        serverId: draft.run.serverId,
        hasAttachments: draft.prompt.attachments.length > 0,
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

  /** The active task's siblings, most urgent first: what the task crumb drops down. */
  tasksInActiveProject: SidebarTask[] = $derived.by(() => {
    return this.tasksForProject(this.activeTask?.projectKey)
  })

  /** The task choices for a breadcrumb scoped to either conversation pane. */
  tasksForProject(projectKey: string | null | undefined): SidebarTask[] {
    if (!projectKey) return []
    return sortTasks(this.catalogTasks.filter((task) => task.projectKey === projectKey))
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
    this.settings.update({ sidebarProjectFilter: projectKey })
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
    return dedupePrChoices([
      ...this.linkedPrChoices(task, serverId),
      ...this.branchPrChoices(task, serverId),
      ...this.mountedPrChoices(task, serverId),
    ])
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
      const pullRequest = this.pullRequestProjects
        .at(serverId, task.projectKey)?.prFor(parsedUrl.number) ?? null
      return [{
        number: parsedUrl.number,
        targetScope: task.projectKey,
        title: pullRequest?.title || `#${parsedUrl.number}`,
        url: parsedUrl.url,
        pullRequest,
      }]
    })
  }

  /** The pull requests this task's own record links. */
  private linkedPrChoices(task: SidebarTask, serverId: string): TaskPrChoice[] {
    if (!task.taskId) return []
    return this.session.tasksStore.get(task.taskId).prLinks.map((link) => {
      const targetScope = link.targetScope ?? task.projectKey
      const pullRequest = this.pullRequestProjects.at(serverId, targetScope)?.prFor(link.number) ?? null
      return {
        number: link.number,
        targetScope,
        title: pullRequest?.title || link.title || `#${link.number}`,
        url: link.url ?? pullRequest?.url ?? null,
        pullRequest,
      }
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
   * mounted checkout is not read here: `refreshPrLinks` writes that observation
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
      const aliases = [session.id, session.handoffId, session.agentSessionId]
        .filter((sessionId): sessionId is string => !!sessionId)
      const linkedAttempt = task.taskId
        ? this.session.tasksStore.get(task.taskId).attempts
          .find((attempt) => this.tabIdBySessionId.get(attempt.sessionId) === tabId)
        : undefined
      if (linkedAttempt && !aliases.includes(linkedAttempt.sessionId)) aliases.push(linkedAttempt.sessionId)
      const environment = this.session.environment.environmentFor(session.run)
      const status = environment.status
      return [{
        sessionIds: aliases,
        originSessionId: linkedAttempt?.sessionId ?? session.agentSessionId ?? session.handoffId ?? session.id,
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
  ) {
    const persistedOpenTaskIds = loadOpenSidebarTaskIds()
    this.openTaskIds = new SvelteSet(persistedOpenTaskIds ?? [])
    this.hasSeededOpenTasks = persistedOpenTaskIds !== null
    this.session.onPromptSubmitted = (tabId) => this.wakeSession(tabId)

    // Wake the next snoozed row exactly when it is due. Without this the shelf
    // only empties on the next unrelated invalidation, so a row the user asked
    // for at 3pm might not reappear until they typed something.
    $effect(() => {
      const now = this.lifecycleNow
      let nextWake = 0
      for (const snooze of this.rowSnoozes.values()) {
        if (snooze.until > now && (nextWake === 0 || snooze.until < nextWake)) {
          nextWake = snooze.until
        }
      }
      if (!nextWake) return
      const timeout = window.setTimeout(() => {
        this.lifecycleNow = Date.now()
      }, Math.max(1, nextWake - Date.now()))
      return () => window.clearTimeout(timeout)
    })
    $effect(() => {
      if (!this.session.tasksStore.loaded) return
      const rootTasks = this.session.tasksStore.tasks.filter((task) => !task.parentId)
      let openTasksChanged = false

      // Do not infer sidebar membership from a task snapshot. Seeding root
      // tasks here made connecting a remote host copy that host's task list
      // into this client's session sidebar. A picker action or an open session
      // adds a row after this migration.
      if (!this.hasSeededOpenTasks) {
        this.hasSeededOpenTasks = true
        openTasksChanged = true
      }

      for (const task of rootTasks) {
        const hasLocalTab = this.pendingTabByTaskId.has(task.id) || [task, ...this.childrenOf(task.id)].some((item) =>
          this.session.tasksStore.get(item.id).sessions.some((link) =>
            this.projectsSessionUnder(task.id, link)
            && this.tabIdBySessionId.has(link.sessionId),
          ),
        )
        if (hasLocalTab && !this.openTaskIds.has(task.id)) {
          this.openTaskIds.add(task.id)
          openTasksChanged = true
        }
      }

      const currentRootTaskIds = new Set(rootTasks.map((task) => task.id))
      for (const taskId of this.openTaskIds) {
        if (currentRootTaskIds.has(taskId)) continue
        this.openTaskIds.delete(taskId)
        openTasksChanged = true
      }
      if (openTasksChanged) persistOpenSidebarTaskIds(this.openTaskIds)
    })
    $effect(() => {
      // Depend on the answer arriving, not on the rows it produces: this is a
      // one-shot boot decision, not a rule that keeps re-running as tasks move.
      void this.session.tasksStore.loaded
      untrack(() => this.settleBootLocation())
    })
    $effect(() => {
      for (const task of this.session.tasksStore.tasks) {
        const branches = new Set(
          this.session.tasksStore.get(task.id).sessions
            .map((attempt) => attempt.branch)
            .filter((branch): branch is string => !!branch),
        )
        // This task's own scope, not whichever project a page happens to show.
        const serverId = this.session.tasksStore.get(task.id).serverId
        const linkedPrs = this.session.tasksStore.get(task.id).prLinks
          .map((link) => this.pullRequestProjects
            .at(serverId, link.targetScope ?? task.projectKey)
            ?.prFor(link.number) ?? null)
        const discoveredPr = [...branches]
          .map((branch) => this.pullRequestProjects.at(serverId, task.projectKey)?.prForBranch(branch) ?? null)
          .find((candidate) => !!candidate) ?? undefined
        const prs = linkedPrs.length ? linkedPrs : [discoveredPr]
        if (prs.some((pr) => !pr)) continue
        const resolvedPrs = prs.flatMap((pr) => (pr ? [pr] : []))
        const completionPr = resolvedPrs.length === 1
          ? resolvedPrs[0]
          : resolvedPrs.every((pr) => pr.state === 'merged')
            ? resolvedPrs.toSorted((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0]
            : undefined
        if (!completionPr || !shouldCompleteTaskForPr(task, completionPr)) continue
        const key = `${task.id}:${completionPr.state}`
        if (this.observedPrLifecycle.has(key)) continue
        this.observedPrLifecycle.add(key)
        void this.session.tasksStore.get(task.id).setStatus('done')
          .catch(() => this.observedPrLifecycle.delete(key))
      }
    })
    $effect(() => {
      void this.prDiscoveryInputKey
      untrack(() => this.refreshPrLinks(false))
    })
  }

  private refreshPrLinks(force: boolean): void {
    const groups = new Map<string, {
      api: HostApi
      serverId: string
      projectKey: string
      tasks: Array<{
        task: SidebarTask
        taskId: string
        branches: Array<{ headRef: string; originSessionId?: string; isolatedCheckout: boolean }>
        mounted: MountedPrObservation[]
      }>
    }>()
    for (const task of this.catalogTasks) {
      if (!task.taskId) continue
      const attempts = this.prDiscoveryAttemptsFor(task)
      const mounted = this.mountedPrObservations(task)
      const branches: Array<{ headRef: string; originSessionId?: string; isolatedCheckout: boolean }> = []
      const seenBranches = new Set<string>()
      for (const attempt of attempts) {
        if (this.tabIdBySessionId.has(attempt.sessionId)) continue
        if (!attempt.branchName || seenBranches.has(attempt.branchName)) continue
        seenBranches.add(attempt.branchName)
        branches.push({
          headRef: attempt.branchName,
          originSessionId: attempt.sessionId,
          isolatedCheckout: attempt.isolatedCheckout,
        })
      }
      // The row's own branch names no session, so nothing can vouch for the
      // checkout it came from. It still warms the index; it never records.
      if (task.branchName && !seenBranches.has(task.branchName)) {
        branches.push({ headRef: task.branchName, isolatedCheckout: false })
      }
      const prNumbers = this.session.tasksStore.get(task.taskId).prLinks.map((link) => link.number)
      if (!prNumbers.length && !branches.length && !mounted.some((observation) => observation.prUrl)) continue
      // A row that names no host is skipped, never attributed to the primary.
      const serverId = this.session.tasksStore.get(task.taskId).serverId ?? task.serverId
      if (!serverId) continue
      const key = `${serverId}:${task.projectKey}`
      const existing = groups.get(key)
      const entry = {
        task,
        taskId: task.taskId,
        branches,
        mounted,
      }
      if (existing) existing.tasks.push(entry)
      else groups.set(key, {
        api: serverConnections.apiFor(serverId),
        serverId,
        projectKey: task.projectKey,
        tasks: [entry],
      })
    }

    for (const [key, group] of groups) {
      const lookupKey = `${key}:${this.prDiscoveryInputKey}`
      if (this.prDiscoveryInFlight.has(lookupKey)) continue
      this.prDiscoveryInFlight.add(lookupKey)
      const ctx = this.session.ctxForDirectory(group.projectKey)
      void Promise.all(group.tasks.map(async ({ task, taskId, branches, mounted }) => {
        for (const observation of mounted) {
          // A shared clone answers with its own HEAD for every tab open on it,
          // so recording that answer lets whichever branch the user checked out
          // claim every task in the sidebar. The row still shows the pull
          // request through `prChoicesFor` for as long as the tab reports it.
          if (!observation.isolatedCheckout) continue
          const parsedUrl = observation.prUrl ? parseGitHubPullRequestUrl(observation.prUrl) : null
          if (!parsedUrl) continue
          const links = this.session.tasksStore.get(taskId).prLinks
          if (!needsDiscoveredPrLink(links, parsedUrl)) continue
          await this.session.tasksStore.get(taskId).link({
            kind: 'pr',
            targetScope: task.projectKey,
            targetKey: String(parsedUrl.number),
            title: `#${parsedUrl.number}`,
            url: parsedUrl.url,
            createdBy: 'system',
            originSessionId: observation.originSessionId,
          }).catch(() => null)
        }
        const linkedPrs = this.session.tasksStore.get(taskId).prLinks
        // A task can link pull requests in more than one project. Warm each
        // owning project here, outside the render path, so every surface reads
        // the same provider record without creating reactive state while it
        // renders.
        const linkedNumbersByScope = new Map<string, number[]>()
        for (const link of linkedPrs) {
          const targetScope = link.targetScope ?? task.projectKey
          const numbers = linkedNumbersByScope.get(targetScope)
          if (numbers) numbers.push(link.number)
          else linkedNumbersByScope.set(targetScope, [link.number])
        }
        for (const [targetScope, numbers] of linkedNumbersByScope) {
          this.pullRequestProjects
            .get(group.api, group.serverId, this.session.ctxForDirectory(targetScope))
            .ensureNumbers(numbers)
        }
        // Branch discovery belongs to the task's project even when one of its
        // explicit links points elsewhere.
        const project = this.pullRequestProjects.get(group.api, group.serverId, ctx)
        const linkedNumbers = new Set(linkedPrs
          .filter((link) => (link.targetScope ?? task.projectKey) === task.projectKey)
          .map((link) => link.number))
        for (const { headRef, originSessionId, isolatedCheckout } of branches) {
          const page = await project
            .query({ state: 'all', head: headRef }, { force })
            .catch(() => null)
          const pr = page ? pullRequestForBranches([headRef], page.items) : undefined
          if (!pr) continue
          if (linkedNumbers.has(pr.number)) continue
          // Warming the index above is what lets the row show an unrecorded
          // pull request. Writing one down needs the branch to be the session's
          // own worktree, for the same reason the mounted pass does.
          if (!isolatedCheckout) continue
          await this.session.tasksStore.get(taskId).link({
            kind: 'pr',
            targetScope: task.projectKey,
            targetKey: String(pr.number),
            title: `#${pr.number} ${pr.title}`,
            createdBy: 'system',
            originSessionId,
          })
          linkedNumbers.add(pr.number)
        }
      }))
        .catch(() => null)
        .finally(() => this.prDiscoveryInFlight.delete(lookupKey))
    }
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
      this.session.tasksStore.get(task.taskId).attempts,
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

  /** Closing a tab removes all attention that session contributed to its task. */
  clearTabAttention(tabId: string): void {
    const session = this.session.sessionFor(tabId)
    if (!session) return
    const serverId = serverConnections.resolveId(session.run.serverId)
    const sessionIds = [session.id, session.handoffId, session.agentSessionId].filter(
      (sessionId): sessionId is string => !!sessionId,
    )
    this.sessionStatusFeed().clear(serverId, sessionIds)
  }

  /** Reconcile externally changed PR lifecycle while the sidebar stays mounted. */
  subscribePrLifecycle(): () => void {
    const refresh = () => {
      if (document.visibilityState === 'visible') this.refreshPrLinks(true)
    }
    const unsubscribe = subscribeAllHosts('prs.invalidated', refresh)
    const interval = window.setInterval(refresh, SIDEBAR_PR_POLL_MS)
    window.addEventListener('focus', refresh)
    refresh()
    return () => {
      unsubscribe()
      window.clearInterval(interval)
      window.removeEventListener('focus', refresh)
    }
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
      this.session.sessions,
      this.session.tabOrder,
      pin.provider,
      serverId,
    )
  }

  childForTab(tabId: string): SidebarSessionChild {
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
      lastActivityAt: sess ? lastActivityAt(sess) : 0,
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
   * it is open here or has a mounted session. `pickableTasks` is every root
   * task on every catalog host, so most of them have no row, and reading their
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
    for (const task of this.pickableTasks) {
      byTaskId.set(task.id, this.buildSessions(task.id, tabIdsByTaskId.get(task.id) ?? [], true))
    }
    return byTaskId
  })

  sessionsForPickableTask(task: Task): SidebarSessionChild[] {
    return this.pickerSessionsByTaskId.get(task.id) ?? this.buildSessions(task.id, [], true)
  }

  /** Mark the durable task and every mounted session represented by its root
   * row as unread. The task timestamp persists the choice; the tab flags drive
   * the blue unread indicator in the mounted sidebar. */
  async markTaskUnread(taskId: string): Promise<void> {
    const task = this.session.tasksStore.peek(taskId)
    const rootTaskId = task?.parentId ?? taskId
    const tabIds = this.catalogTasks.find((row) => row.taskId === rootTaskId)?.tabIds ?? []
    await this.session.tasksStore.get(taskId).markRead(false)
    for (const tabId of tabIds) {
      const tab = this.session.tabs[tabId]
      if (tab) tab.hasUnread = true
    }
  }

  /** Defer a row that has no task record. `until` of null wakes it now, which
   *  is what the row's own Wake button and the undo toast both call. */
  snoozeRow(rowKey: string, until: number | null, note = ''): void {
    if (until === null) this.rowSnoozes.delete(rowKey)
    else this.rowSnoozes.set(rowKey, { until, note: note.trim() || null })
    persistSidebarRowSnoozes(this.rowSnoozes)
  }

  /** Sending new input is an explicit return to the session, so its task or
   * loose-session row must leave the Snoozed shelf immediately. */
  wakeSession(tabId: string): void {
    const rowKey = snoozedRowKeyForTab(this.allTasks, tabId)
    if (rowKey) this.snoozeRow(rowKey, null)
  }

  /** Put a durable task and every linked attempt back into the sidebar. The
   * picker is an explicit reversal of per-row dismissal, so it restores the
   * whole task tree without changing any task lifecycle state. */
  restoreTask(taskId: string): void {
    const task = this.session.tasksStore.peek(taskId)
    if (!task) return
    const root = this.session.tasksStore.peek(task.parentId) ?? task
    const taskTree = [root, ...this.childrenOf(root.id)]
    const rowKeys = [
      root.id,
      ...taskTree.flatMap((record) => [
        ...(record.parentId ? [`task:${record.id}`] : []),
        ...this.session.tasksStore.get(record.id).sessions.map(
          (link) => `session:${link.sessionId}`,
        ),
      ]),
    ]
    for (const rowKey of rowKeys) this.dismissedRowKeys.delete(rowKey)
    removeDismissedSidebarRows(rowKeys)
    for (const record of taskTree) {
      for (const link of this.session.tasksStore.get(record.id).sessions) {
        this.session.showExplicitSidebarTaskSession(root.id, link.sessionId)
      }
    }
    this.openTaskIds.add(root.id)
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
    const root = this.session.tasksStore.tasks.find((candidate) => candidate.id === taskId)
    if (!root) return []

    const linkedSessions = [root, ...this.childrenOf(root.id)]
      .flatMap((record) =>
        this.session.tasksStore.get(record.id).sessions.map((link) => ({
          record,
          link,
        })),
      )
      .sort((a, b) => a.link.linkedAt - b.link.linkedAt)
    const seenSessionIds = new Set<string>()
    const children: SidebarSessionChild[] = []

    for (const { record, link } of linkedSessions) {
      if (seenSessionIds.has(link.sessionId)) continue
      seenSessionIds.add(link.sessionId)
      if (!includeRestorable && !this.projectsSessionUnder(root.id, link)) continue
      const projectKey = record.projectKey ?? root.projectKey ?? undefined
      const tabId = this.tabIdBySessionId.get(link.sessionId)
      const dismissalKey = record.parentId ? `task:${record.id}` : `session:${link.sessionId}`
      const linkServerId = attemptServerId({
        link,
        taskServerId: this.session.tasksStore.get(record.id).serverId,
      })
      if (
        !includeRestorable
        && !shouldShowSidebarChild(this.dismissedRowKeys.has(dismissalKey), !!tabId)
      ) continue
      if (tabId) {
        const child = this.childForTab(tabId)
        children.push({
          ...child,
          label: sidebarChildLabel(
            record,
            sessionDisplayName({ link, liveTitle: child.label, taskTitle: record.title }),
          ),
          taskId: record.id,
          sessionId: link.sessionId,
          projectKey,
          serverId: child.serverId ?? linkServerId,
          provider: child.provider ?? link.provider,
          modelId: child.modelId ?? link.model,
          branchName: child.branchName ?? link.branch ?? null,
          // A restored tab can exist before its transcript is hydrated. The
          // durable link still knows when that session was active; do not turn
          // an empty mounted transcript into the Unix epoch in the picker.
          lastActivityAt: restoredSessionActivityAt(child.lastActivityAt, link),
          dismissalKey,
          isSubtask: !!record.parentId,
        })
        continue
      }
      const liveState = this.sessionStatusFeed().stateFor(linkServerId, link.sessionId)
      children.push({
        taskId: record.id,
        sessionId: link.sessionId,
        projectKey,
        branchName: link.branch ?? null,
        label: sidebarChildLabel(record, sessionDisplayName({ link, taskTitle: record.title })),
        attention: liveState?.attention ?? null,
        unread: liveState?.attention === 'error',
        serverId: linkServerId,
        provider: link.provider,
        modelId: link.model,
        runStartedAt: liveState?.attention === 'running' ? liveState.runStartedAt : 0,
        lastActivityAt: link.lastActivityAt ?? link.linkedAt,
        reviewGuideStatus: null,
        dismissalKey,
        isSubtask: !!record.parentId,
      })
    }

    for (const tabId of this.pendingTabByTaskId.get(root.id) ?? []) {
      if (children.some((child) => child.tabId === tabId)) continue
      const target = this.session.sessionFor(tabId)?.task
      const pendingTaskId = target ? existingTaskId(target) : null
      const pendingTask = pendingTaskId
        ? this.session.tasksStore.tasks.find((candidate) => candidate.id === pendingTaskId)
        : undefined
      const dismissalKey = pendingTask?.parentId ? `task:${pendingTask.id}` : `tab:${tabId}`
      if (!includeRestorable && this.dismissedRowKeys.has(dismissalKey)) continue
      const child = this.childForTab(tabId)
      children.push({
        ...child,
        label: pendingTask ? sidebarChildLabel(pendingTask, child.label) : child.label,
        taskId: pendingTask?.id ?? root.id,
        projectKey: pendingTask?.projectKey ?? root.projectKey ?? undefined,
        dismissalKey,
        isSubtask: !!pendingTask?.parentId,
      })
    }

    // A subtask is part of the task tree before it has a provider session.
    // Keep those rows visible and selectable; selecting one starts its first
    // session through the existing no-session child path.
    for (const record of this.childrenOf(root.id)) {
      if (children.some((child) => child.taskId === record.id)) continue
      const dismissalKey = `task:${record.id}`
      if (!includeRestorable && this.dismissedRowKeys.has(dismissalKey)) continue
      children.push({
        taskId: record.id,
        projectKey: record.projectKey ?? root.projectKey ?? undefined,
        branchName: null,
        label: record.title,
        attention: null,
        unread: false,
        // Nothing has run yet, so the only true answer is where it would: the
        // host that holds the task.
        serverId: this.session.tasksStore.get(record.id).serverId,
        runStartedAt: 0,
        lastActivityAt: 0,
        reviewGuideStatus: null,
        dismissalKey,
        isSubtask: true,
      })
    }

    return children
  }

  selectTab(tabId: string): void {
    // Sidebar rows are navigation, not the tab-strip's expand/collapse toggle.
    // Clicking the selected child must therefore be a no-op — unless its
    // conversation isn't what's on screen (a draft or a page owns the pane),
    // which is the one case where the row still has somewhere to take you.
    if (tabId === this.session.activeTabId && this.session.showsConversation) return
    this.session.selectTab(tabId)
  }

  async selectTask(task: SidebarTask): Promise<void> {
    // Rank mounted and remote sessions together. This keeps the task bar and
    // task picker on one rule, including the recency tie-break.
    const target = taskSessionTarget(this.sessionsFor(task))
    if (target) {
      await this.selectChild(target)
      return
    }
    if (!task.taskId) return
    const record = this.session.tasksStore.tasks.find((candidate) => candidate.id === task.taskId)
    if (!record) return
    await this.session.openTaskSession(record)
  }

  /** Restore a picker result, then navigate through the same selection rule as
   * clicking its task-bar row. */
  async selectTaskRecord(task: Task): Promise<void> {
    this.restoreTask(task.id)
    const rootTaskId = task.parentId ?? task.id
    const root = this.session.tasksStore.peek(rootTaskId) ?? task
    // The picker's own session list, so the row the reader saw and the session
    // ⏎ opens can never disagree.
    const target = taskSessionTarget(this.sessionsForPickableTask(root))
    if (target) await this.selectChild(target)
    else await this.session.openTaskSession(task)
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
      if (record) await this.session.openTaskSession(record)
      return
    }
    // The task link already names the exact session and its host. A legacy row
    // without a host is inert — no probe, no guess.
    if (!child.serverId) return
    const meta = await readSessionMeta(child.serverId, child.sessionId)
    if (meta) await this.session.resumeSession(meta)
  }

  closeTabs(tabIds: string[]): void {
    const closesActiveTab = tabIds.includes(this.session.activeTabId)
    const sidebarTasks = [
      ...this.visibleTasks,
      ...this.snoozedTasks,
      ...this.completedTasks,
    ]
    const sidebarTabIds = sidebarTasks.flatMap((task) =>
      this.sessionsFor(task).flatMap((child) => child.tabId ? [child.tabId] : []),
    )
    const openTabIds = this.visibleTasks.flatMap((task) =>
      this.sessionsFor(task).flatMap((child) => child.tabId ? [child.tabId] : []),
    )
    const nextTabId = closesActiveTab
      ? closestOpenSidebarTabAfterClose(
          sidebarTabIds,
          openTabIds,
          tabIds,
          this.session.activeTabId,
        )
      : null

    for (const tabId of tabIds) this.session.closeTab(tabId)

    if (!closesActiveTab) return
    if (nextTabId && this.session.tabs[nextTabId]) this.session.selectTab(nextTabId)
    else if (this.session.showsConversation) {
      this.session.openSessionDraft({
        freshTask: this.activeTasks.length === 0,
        via: 'click',
      })
    }
  }

  /** Ending the column's last live task must not drop the pane onto a shelved
   * one. Keep this lifecycle fallback separate from `closeTabs` because task
   * dismissal can remove the row before its mounted tabs are closed. */
  private composeNextPromptIfNoActiveTask(endedTask: SidebarTask): void {
    if (endedTask.lifecycle !== 'active' || this.activeTasks.length) return
    if (!this.session.showsConversation) return
    this.session.openSessionDraft({ freshTask: true, via: 'click' })
  }

  /** The same rule at launch: the snapshot restores whichever conversation was
   *  last on screen, and its task can have finished since. Only the task store
   *  can say, so its first answer is the one chance to decide — after that,
   *  opening a completed task is deliberate. Nothing is revealed, so this never
   *  pops the pill open on launch. */
  private settleBootLocation(): void {
    if (this.hasSettledBootLocation || !this.session.tasksStore.loaded) return
    this.hasSettledBootLocation = true
    if (this.activeTasks.length || !this.session.showsConversation) return
    this.session.openSessionDraft({ freshTask: true, reveal: false })
  }

  /** The checkmark: completing says "I am finished with this", so it also
   *  unloads the mounted conversation, exactly as the row's close control
   *  does. A durable task moves to the Completed shelf and stays resumable
   *  from there; a loose row is only its tab, so completing closes the row
   *  itself. Reopening closes nothing. */
  async completeTask(task: SidebarTask): Promise<void> {
    const durable = this.session.tasksStore.peek(task.taskId)
    if (durable) {
      // The row draws one finished glyph for both endings, so the control under
      // it has to take both of them back.
      const reopening = durable.status === 'done' || durable.status === 'dropped'
      await this.session.tasksStore.get(durable.id).setStatus(reopening ? 'todo' : 'done')
      if (reopening) {
        // The shelf lists finished work whether or not this client has the row
        // open, so a task reopened from there has nowhere to land — it leaves
        // Completed and the column never listed it. Put the row back.
        this.restoreTask(durable.id)
      } else {
        this.closeTabs(task.tabIds)
        this.composeNextPromptIfNoActiveTask(task)
      }
      return
    }
    if (task.status === 'done') this.toggleTaskDone(task.id)
    else this.closeTask(task)
  }

  /** The check is a toggle: it is the only affordance that sets the state, so
   *  it has to be the one that takes it back. */
  toggleTaskDone(taskId: string): void {
    const durable = this.session.tasksStore.tasks.find((task) => task.id === taskId)
    if (durable) {
      void this.session.tasksStore
        .get(durable.id)
        .setStatus(durable.status === 'done' ? 'todo' : 'done')
      return
    }
    if (!this.doneTaskIds.delete(taskId)) this.doneTaskIds.add(taskId)
  }

  /** Close a sidebar task's mounted tabs while keeping its durable sessions
   *  available to resume from history. */
  closeTask(task: SidebarTask): void {
    this.doneTaskIds.delete(task.id)
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
      persistOpenSidebarTaskIds(this.openTaskIds)
    }
    this.closeTabs(tabIdsToClose)
    if (tabIdsToClose.length) this.composeNextPromptIfNoActiveTask(task)
  }

  /** Close every task a project has in the sidebar, which takes the project's
   *  whole section with them — the heading exists only while it has rows. Each
   *  task is dismissed the same way closing its own row does, so nothing about
   *  their lifecycle changes and reopening any session brings its task back. */
  closeProject(projectKey: string): void {
    for (const task of this.catalogTasks.filter((item) => item.projectKey === projectKey)) {
      this.closeTask(task)
    }
  }

  /** How many runs this project would stop, for surfaces that ask first. */
  runningTaskCountIn(projectKey: string): number {
    return this.catalogTasks.filter(
      (task) => task.projectKey === projectKey && task.status === 'running',
    ).length
  }

  /** Close one task-tree child's mounted tab while keeping its durable session. */
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
    const pin: PinnedSession = {
      sessionId: session.agentSessionId,
      serverId: pinServerId,
      provider: session.run.provider ?? this.settings.activeAgent,
      title: sessionTitle(session),
      cwd: session.run.gitContext?.worktreePath ?? session.run.workingDirectory,
      pinnedAt: Date.now(),
    }
    // The pin lives on the session's own host; the host's answer is only that
    // host's manifest, so the federated list reloads rather than adopting it.
    await serverConnections.apiFor(pinServerId).togglePinnedSession(pin)
    await this.loadPinnedSessions()
  }

  /** Rename from a sidebar row. Pins carry their own label, so a pinned session
   *  needs the manifest re-read for the row to show the new name. */
  async renameSession(tabId: string, title: string): Promise<void> {
    const sessionId = this.session.sessionFor(tabId)?.agentSessionId
    await this.session.renameTab(tabId, title)
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
      const metadata = await api.generateSessionMetadata(openingPrompt, info?.cwd || pin.cwd)
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
    await this.session.resumeSession({
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
