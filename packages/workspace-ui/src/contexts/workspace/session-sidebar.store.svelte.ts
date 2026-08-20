import { createAppContext } from '../app/create-app-context'
import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import { untrack } from 'svelte'
import { worktreeProjectRoot, type PinnedSession, type Session } from '@solus/contracts/types'
import type { Task } from '@solus/contracts/task-types'
import type { PullRequestSummary } from '@solus/contracts/providers'
import { existingTaskId, parentTaskId } from './session-draft.svelte'
import {
  buildProjectSummaries,
  compareTaskCreationOrder,
  groupTasks,
  prChipForBranches as resolvePrChip,
  pullRequestForBranches,
  reconcileSidebarTasks,
  resolveTaskSidebarLifecycle,
  shouldCompleteTaskForPr,
  sidebarChildLabel,
  shouldShowDurableSidebarTask,
  shouldShowSidebarChild,
  projectFilterChoices,
  resolveProjectFilter,
  sortTasksByCreation,
  sortSidebarRowsBySessionOrder,
  sortTasks,
  taskStatusFor,
  type PrChip,
  type ProjectFilterChoice,
  type ProjectSummary,
  type SidebarTask,
  type TaskGroup,
} from '../../components/session/lib/task-list'
import { draftTitle, type DraftRow } from '../../components/session/lib/draft-list'
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
import { closestOpenSidebarTabAfterClose, taskTabTarget } from './session-sidebar-selection'
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
import { readSessionMeta } from '@solus/client-core/session-meta'
import { subscribeAllHosts } from '@solus/client-core/host-events'
import type { HostApi } from '@solus/client-core/host-api'
import { prLinkDiscoveryKey, type PrLinkDiscoveryInput } from './pr-link-discovery'

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
  /** Start of the turn in flight, for the elapsed readout. 0 unless running. */
  runStartedAt: number
  /** Stable persisted key for hiding this child without deleting its task or session. */
  dismissalKey?: string
  /** True when this session belongs to a child task rather than the root task. */
  isSubtask?: boolean
  /** Background walkthrough state for this exact agent session. */
  reviewGuideStatus: 'generating' | 'ready' | null
  /** Reminder from the most recent expired snooze on this task. */
  snoozeReminder?: string | null
}

const attentionRank = {
  awaiting: 5,
  awaiting_plan: 5,
  queued: 4,
  error: 3,
  running: 2,
  unread: 1,
} satisfies Record<NonNullable<AttentionState>, number>

function maxAttention(current: AttentionState, next: AttentionState): AttentionState {
  if (!next) return current
  if (!current) return next
  return attentionRank[next] > attentionRank[current] ? next : current
}

function projectLabel(projectKey: string): string {
  return projectKey === '~' ? '~' : projectKey.replace(/\/$/, '').split('/').at(-1) ?? '~'
}

export class SessionSidebarStore {
  private taskModelsById = new Map<string, SidebarTask>()
  private liveSessionStatuses?: SidebarSessionStatusFeed
  private openTaskIds: SvelteSet<string>
  private hasSeededOpenTasks: boolean
  private hasSettledBootLocation = false

  private sessionStatusFeed(): SidebarSessionStatusFeed {
    return this.liveSessionStatuses ??= new SidebarSessionStatusFeed()
  }

  /** Pinned sessions, most-recently-pinned first. Loaded on bootstrap, mutated by pin/unpin. */
  pinnedSessions = $state<PinnedSession[]>([])
  visibleTabIds: string[] = $derived.by(() => this.session.tabOrder.filter((id) => this.session.tabs[id]))

  /** Which tab, if any, has a given stable or active provider session mounted. Built once per
   *  pass: every task row needs this answer for each of its linked sessions, and
   *  scanning the open tabs per lookup made the column O(tasks × sessions × tabs)
   *  on every stream tick. */
  private tabIdBySessionId: Map<string, string> = $derived.by(() => {
    const bySessionId = new Map<string, string>()
    for (const tabId of this.visibleTabIds) {
      const tab = this.session.tabs[tabId]
      const session = this.session.sessionFor(tabId)
      if (tab?.sessionId) bySessionId.set(tab.sessionId, tabId)
      if (session?.handoffId) bySessionId.set(session.handoffId, tabId)
      if (session?.agentSessionId) bySessionId.set(session.agentSessionId, tabId)
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
  private observedPrLifecycle = new Set<string>()
  private prDiscoveryInFlight = new Set<string>()
  private prByTaskId = new SvelteMap<string, PullRequestSummary>()
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

  /** Mounted aliases all describe one visible session. Closed sessions fall
   * back to their durable link id, which is the only identity available. */
  private sidebarSessionIdentity(sessionId: string): string {
    return this.tabIdBySessionId.get(sessionId) ?? sessionId
  }

  /** The first durable link wins automatic sidebar placement. Later task links
   * remain valid relationships, but they do not project another row. */
  private automaticRootBySessionIdentity: Map<string, string> = $derived.by(() => {
    const links = this.session.tasksStore.tasks
      .filter((task) => !task.parentId)
      .flatMap((root) => [root, ...this.childrenOf(root.id)].flatMap((record) =>
        (this.session.tasksStore.sessionsByTask.get(record.id) ?? []).map((link) => ({
          rootTaskId: root.id,
          link,
        })),
      ))
      .sort((a, b) => a.link.linkedAt - b.link.linkedAt)
    const rootBySession = new Map<string, string>()
    for (const { rootTaskId, link } of links) {
      const identity = this.sidebarSessionIdentity(link.sessionId)
      if (!rootBySession.has(identity)) rootBySession.set(identity, rootTaskId)
    }
    return rootBySession
  })

  private projectsSessionUnder(rootTaskId: string, sessionId: string): boolean {
    // A few focused unit tests call the pure row builder on a prototype rather
    // than constructing Svelte state. With no projection index there is no
    // competing task, so the only available row remains the correct one.
    if (!this.automaticRootBySessionIdentity) return true
    return this.automaticRootBySessionIdentity.get(this.sidebarSessionIdentity(sessionId)) === rootTaskId
      || this.session.hasExplicitSidebarTaskSession(rootTaskId, sessionId)
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
          this.session.tasksStore.sessionsByTask.get(item.id) ?? [],
        )
        const hasProjectedSession = durableLinks.some((link) =>
          this.projectsSessionUnder(task.id, link.sessionId),
        )
        if (durableLinks.length && !hasProjectedSession && !this.pendingTabByTaskId.has(task.id)) {
          return false
        }
        const isDismissed = this.dismissedRowKeys.has(task.id)
        const hasOpenSession = isDismissed && (
          this.pendingTabByTaskId.has(task.id)
          || taskTree.some((item) =>
            (this.session.tasksStore.sessionsByTask.get(item.id) ?? []).some((link) =>
              this.projectsSessionUnder(task.id, link.sessionId)
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
      .map((task): SidebarTask => {
        const children = this.childrenOf(task.id)
        const taskTree = [task, ...children]
        const tabIds: string[] = []
        let attention: AttentionState = null
        let unread = false
        let activityAt = taskTree.reduce((latest, item) => Math.max(latest, item.updatedAt), 0)
        let runStartedAt = 0
        // The host the task is being worked on, taken from the first session it
        // has open. A task record remembers a project, never a machine — but its
        // links remember one each, which is what answers for a task whose only
        // session is closed.
        let serverId: string | null = null
        let linkedServerId: string | null = null

        for (const item of taskTree) {
          for (const link of this.session.tasksStore.sessionsByTask.get(item.id) ?? []) {
            if (!this.projectsSessionUnder(task.id, link.sessionId)) continue
            const linkServerId = attemptServerId({
              link,
              taskServerId: this.session.tasksStore.hostFor(item.id),
            })
            linkedServerId ??= linkServerId
            const liveState = this.sessionStatusFeed().stateFor(linkServerId, link.sessionId)
            attention = maxAttention(attention, liveState?.attention ?? null)
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
            serverId ??= session.run.serverId ?? null
            const nextAttention = getAttentionState(session, tab, this.planStore.plans)
            attention = maxAttention(attention, nextAttention)
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
          serverId ??= session.run.serverId ?? null
          const nextAttention = getAttentionState(session, tab, this.planStore.plans)
          attention = maxAttention(attention, nextAttention)
          unread ||= tab.hasUnread
          activityAt = Math.max(activityAt, lastActivityAt(session))
          if (nextAttention === 'running') {
            const startedAt = turnStartedAt(session)
            if (startedAt > 0) runStartedAt = runStartedAt === 0 ? startedAt : Math.min(runStartedAt, startedAt)
          }
        }
        const projectKey = worktreeProjectRoot(task.projectKey ?? '~')
        const lifecycle = resolveTaskSidebarLifecycle({
          task,
          now: this.session.tasksStore.lifecycleNow,
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
          prNumber: this.session.tasksStore.prLinkFor(task.id)?.number || null,
          // A completed task can receive more work through its existing session.
          // Live attention then outranks the stale lifecycle verdict, just as it
          // does for the sidebar's session-only completion check.
          status: taskStatusFor(attention, task.status === 'done' || task.status === 'dropped'),
          attention,
          unread,
          createdAt: task.createdAt ?? task.updatedAt,
          activityAt,
          runStartedAt,
          lifecycle: lifecycle.lifecycle,
          completedAt: lifecycle.completedAt,
          snoozedUntil: lifecycle.snoozedUntil,
          snoozeNote: task.snoozeNote ?? null,
          lastReadAt: lifecycle.lastReadAt,
          woke: lifecycle.woke,
          tabIds,
        }
      })

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
        lifecycle: 'active',
        completedAt: 0,
        snoozedUntil: 0,
        snoozeNote: null,
        lastReadAt: 0,
        woke: false,
        tabIds: [tabId],
      })
    }

    return reconcileSidebarTasks(
      this.taskModelsById,
      sortSidebarRowsBySessionOrder(
        [...durableTasks, ...looseTasks],
        this.visibleTabIds,
      ),
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
      const attempts = this.sessionsFor(task)
      const branches = [...attempts.map((attempt) => attempt.branchName).reverse(), task.branchName]
      if (!task.prNumber && !branches.some(Boolean)) continue
      const serverId = this.session.tasksStore.hostFor(task.taskId) ?? task.serverId
      if (!serverId) continue
      inputs.push({
        taskId: task.taskId,
        serverId,
        projectKey: task.projectKey,
        prNumber: task.prNumber ?? null,
        branches,
        originSessionId: attempts.findLast((attempt) => !!attempt.branchName)?.sessionId ?? null,
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

  /** The project the list is scoped to, or null for all of them. Resolved
   *  against the column's own contents so a project that has left it never
   *  keeps scoping the list to something no longer there. */
  private openProjectFilter: string | null = $derived.by(() =>
    resolveProjectFilter(this.settings.sidebarProjectFilter, this.catalogTasks),
  )

  /** The project the trigger and the empty line name, or null while unfiltered. */
  scopedProject: ProjectFilterChoice | null = $derived.by(() => {
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
  completedTasks: SidebarTask[] = $derived(
    this.inFilter(this.catalogTasks.filter((task) => task.lifecycle === 'completed'))
      .toSorted((a, b) => b.completedAt - a.completedAt || a.id.localeCompare(b.id)),
  )

  /** The filter's own choices, over every project the column knows about. */
  projectFilterChoices: ProjectFilterChoice[] = $derived(projectFilterChoices(this.catalogTasks))

  /** Grouped by project, unfiltered — the phone lists projects as collapsible
   *  sections rather than filtering to one, and must not inherit a scope set on
   *  a surface that has no control to clear it. */
  taskGroups: TaskGroup[] = $derived(groupTasks(this.activeTasks))

  private inFilter(tasks: SidebarTask[]): SidebarTask[] {
    const filter = this.openProjectFilter
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
    const filter = this.openProjectFilter
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

  prChipFor(task: SidebarTask): PrChip | null {
    const sessionBranches = this.sessionsFor(task).map((session) => session.branchName).reverse()
    const scopedPr = task.taskId ? this.prByTaskId.get(task.taskId) : undefined
    return resolvePrChip(
      [...sessionBranches, task.branchName],
      scopedPr ? [scopedPr] : this.session.prsStore.items,
      task.prNumber,
    )
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
  ) {
    const persistedOpenTaskIds = loadOpenSidebarTaskIds()
    this.openTaskIds = new SvelteSet(persistedOpenTaskIds ?? [])
    this.hasSeededOpenTasks = persistedOpenTaskIds !== null
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
          (this.session.tasksStore.sessionsByTask.get(item.id) ?? []).some((link) =>
            this.projectsSessionUnder(task.id, link.sessionId)
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
          (this.session.tasksStore.sessionsByTask.get(task.id) ?? [])
            .map((attempt) => attempt.branch)
            .filter((branch): branch is string => !!branch),
        )
        const pr = this.prByTaskId.get(task.id) ?? this.session.prsStore.items.find((candidate) =>
          (!!candidate.headRef && branches.has(candidate.headRef))
          || (this.session.tasksStore.prLinkFor(task.id)?.number === candidate.number),
        )
        if (!pr || !shouldCompleteTaskForPr(task, pr)) continue
        const key = `${task.id}:${pr.state}`
        if (this.observedPrLifecycle.has(key)) continue
        this.observedPrLifecycle.add(key)
        void this.session.tasksStore.setStatus(task.id, 'done')
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
      tasks: Array<{ task: SidebarTask; branches: (string | null)[]; originSessionId?: string }>
    }>()
    for (const task of this.catalogTasks) {
      if (!task.taskId) continue
      const attempts = this.sessionsFor(task)
      const branches = [...attempts.map((attempt) => attempt.branchName).reverse(), task.branchName]
      if (!task.prNumber && !branches.some(Boolean)) continue
      // A row that names no host is skipped, never attributed to the primary.
      const serverId = this.session.tasksStore.hostFor(task.taskId) ?? task.serverId
      if (!serverId) continue
      const key = `${serverId}:${task.projectKey}`
      const existing = groups.get(key)
      const entry = {
        task,
        branches,
        originSessionId: attempts.findLast((attempt) => !!attempt.branchName)?.sessionId,
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
      if (this.prDiscoveryInFlight.has(key)) continue
      this.prDiscoveryInFlight.add(key)
      const ctx = this.session.ctxForDirectory(group.projectKey)
      void this.session.prsStore.loadFor(
        group.api,
        group.serverId,
        ctx,
        { state: 'all' },
        { force },
      ).then(async (page) => {
        for (const { task, branches, originSessionId } of group.tasks) {
          const pr = pullRequestForBranches(branches, page.items, task.prNumber)
          if (!pr || !task.taskId) continue
          const previous = this.prByTaskId.get(task.taskId)
          if (!previous
            || previous.state !== pr.state
            || previous.draft !== pr.draft
            || previous.needsMyReview !== pr.needsMyReview) {
            this.prByTaskId.set(task.taskId, pr)
          }
          if (task.prNumber) continue
          await this.session.tasksStore.link(task.taskId, {
            kind: 'pr',
            targetScope: task.projectKey,
            targetKey: String(pr.number),
            title: `#${pr.number} ${pr.title}`,
            createdBy: 'system',
            originSessionId,
          })
        }
      }).catch(() => null)
        .finally(() => this.prDiscoveryInFlight.delete(key))
    }
  }

  /** Keep durable, unmounted task attempts live in the sidebar. */
  subscribeSessionStatuses(): () => void {
    return subscribeAllHosts('session.statusChanged', (serverId, event) => {
      this.sessionStatusFeed().apply(serverId, event)
    })
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

  getAttentionTarget(tabIds: string[]): string | null {
    let best: string | null = null
    let bestRank = 0
    for (const tabId of tabIds) {
      const tab = this.session.tabs[tabId]
      const sess = this.session.sessionFor(tabId)
      if (!tab || !sess) continue
      const state = getAttentionState(sess, tab, this.planStore.plans)
      if (!state || state === 'running') continue
      const rank = attentionRank[state]
      if (rank > bestRank) {
        best = tabId
        bestRank = rank
      }
    }
    return best
  }

  /** The first tab whose session is working right now. Used only as the
   *  select-a-task fallback: a running session outranks the oldest tab when
   *  nothing needs the user and they have not opened this branch yet. */
  getRunningTarget(tabIds: string[]): string | null {
    for (const tabId of tabIds) {
      const tab = this.session.tabs[tabId]
      const sess = this.session.sessionFor(tabId)
      if (!tab || !sess) continue
      if (getAttentionState(sess, tab, this.planStore.plans) === 'running') return tabId
    }
    return null
  }

  childForTab(tabId: string): SidebarSessionChild {
    const tab = this.session.tabs[tabId]
    const sess = this.session.sessionFor(tabId)
    const attention = tab && sess ? getAttentionState(sess, tab, this.planStore.plans) : null
    const guideStatus = reviewGuideStore.indicatorStatusFor(
      this.session.apiFor(tabId),
      sessionGuideIdentity(sess),
    )?.status
    return {
      tabId,
      label: sess ? sessionTitle(sess) : tabId,
      attention,
      unread: tab?.hasUnread ?? false,
      serverId: sess?.run.serverId ?? null,
      // The mounted tab's environment is live, so it outranks whatever branch
      // the task record captured when it was last written.
      branchName: this.session.environment.environmentFor(this.session.sessionFor(tabId)?.run).branch,
      runStartedAt: sess && attention === 'running' ? turnStartedAt(sess) : 0,
      reviewGuideStatus:
        guideStatus === 'queued' || guideStatus === 'generating'
          ? 'generating'
          : guideStatus === 'ready'
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
    for (const task of this.catalogTasks) byTaskId.set(task.id, this.buildSessionsFor(task))
    return byTaskId
  })

  sessionsFor(task: SidebarTask): SidebarSessionChild[] {
    // Callers can hold a row the last derived pass hasn't caught up with, so a
    // miss still answers rather than reporting the task as empty.
    return this.sessionsByTaskId.get(task.id) ?? this.buildSessionsFor(task)
  }

  /** Put a durable task and every linked attempt back into the sidebar. The
   * picker is an explicit reversal of per-row dismissal, so it restores the
   * whole task tree without changing any task lifecycle state. */
  restoreTask(taskId: string): void {
    const task = this.session.tasksStore.taskForId(taskId)
    if (!task) return
    const root = task.parentId
      ? this.session.tasksStore.taskForId(task.parentId) ?? task
      : task
    const taskTree = [root, ...this.childrenOf(root.id)]
    const rowKeys = [
      root.id,
      ...taskTree.flatMap((record) => [
        ...(record.parentId ? [`task:${record.id}`] : []),
        ...(this.session.tasksStore.sessionsByTask.get(record.id) ?? []).map(
          (link) => `session:${link.sessionId}`,
        ),
      ]),
    ]
    for (const rowKey of rowKeys) this.dismissedRowKeys.delete(rowKey)
    removeDismissedSidebarRows(rowKeys)
    for (const record of taskTree) {
      for (const link of this.session.tasksStore.sessionsByTask.get(record.id) ?? []) {
        this.session.showExplicitSidebarTaskSession(root.id, link.sessionId)
      }
    }
    this.openTaskIds.add(root.id)
    persistOpenSidebarTaskIds(this.openTaskIds)
  }

  private buildSessionsFor(task: SidebarTask): SidebarSessionChild[] {
    if (!task.taskId) return task.tabIds.map((tabId) => this.childForTab(tabId))
    const root = this.session.tasksStore.tasks.find((candidate) => candidate.id === task.taskId)
    if (!root) return []

    const linkedSessions = [root, ...this.childrenOf(root.id)]
      .flatMap((record) =>
        (this.session.tasksStore.sessionsByTask.get(record.id) ?? []).map((link) => ({
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
      if (!this.projectsSessionUnder(root.id, link.sessionId)) continue
      const projectKey = record.projectKey ?? root.projectKey ?? undefined
      const tabId = this.tabIdBySessionId.get(link.sessionId)
      const dismissalKey = record.parentId ? `task:${record.id}` : `session:${link.sessionId}`
      if (!shouldShowSidebarChild(this.dismissedRowKeys.has(dismissalKey), !!tabId)) continue
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
          branchName: child.branchName ?? link.branch ?? null,
          dismissalKey,
          isSubtask: !!record.parentId,
          snoozeReminder: record.snoozedUntil && record.snoozedUntil <= this.session.tasksStore.lifecycleNow
            ? record.snoozeNote ?? null
            : null,
        })
        continue
      }
      const serverId = attemptServerId({
        link,
        taskServerId: this.session.tasksStore.hostFor(record.id),
      })
      const liveState = this.sessionStatusFeed().stateFor(serverId, link.sessionId)
      children.push({
        taskId: record.id,
        sessionId: link.sessionId,
        projectKey,
        branchName: link.branch ?? null,
        label: sidebarChildLabel(record, sessionDisplayName({ link, taskTitle: record.title })),
        attention: liveState?.attention ?? null,
        unread: liveState?.attention === 'error',
        serverId,
        runStartedAt: liveState?.attention === 'running' ? liveState.runStartedAt : 0,
        reviewGuideStatus: null,
        dismissalKey,
        isSubtask: !!record.parentId,
        snoozeReminder: record.snoozedUntil && record.snoozedUntil <= this.session.tasksStore.lifecycleNow
          ? record.snoozeNote ?? null
          : null,
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
      if (this.dismissedRowKeys.has(dismissalKey)) continue
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
      if (this.dismissedRowKeys.has(dismissalKey)) continue
      children.push({
        taskId: record.id,
        projectKey: record.projectKey ?? root.projectKey ?? undefined,
        branchName: null,
        label: record.title,
        attention: null,
        unread: false,
        // Nothing has run yet, so the only true answer is where it would: the
        // host that holds the task.
        serverId: this.session.tasksStore.hostFor(record.id),
        runStartedAt: 0,
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
    if (task.tabIds.length) {
      if (this.selectBranch(task.key, task.tabIds)) {
        const activeSessionId = this.session.sessionFor(this.session.activeTabId)?.agentSessionId
        if (activeSessionId) this.session.selectSidebarTaskOccurrence(task.id, activeSessionId)
      }
      return
    }
    if (!task.taskId) return
    const record = this.session.tasksStore.tasks.find((candidate) => candidate.id === task.taskId)
    if (!record) return
    const newestClosed = this.sessionsFor(task).findLast((child) => !!child.sessionId && !child.tabId)
    if (newestClosed) await this.selectChild(newestClosed)
    else await this.session.openTaskSession(record)
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

  selectBranch(branchKey: string, tabIds: string[]): boolean {
    const attentionTarget = this.getAttentionTarget(tabIds)
    const isAlreadyActiveBranch = tabIds.includes(this.session.activeTabId)
    const lastActiveTabId = this.session.lastActiveTabForBranch(branchKey)
    const runningTabId = this.getRunningTarget(tabIds)
    const target = taskTabTarget(tabIds, attentionTarget, lastActiveTabId, runningTabId)
    if (!target) return false

    if (
      isAlreadyActiveBranch
      && this.session.showsConversation
      && (!attentionTarget || target === this.session.activeTabId)
    ) {
      return false
    }

    this.session.selectTab(target)
    return true
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
    else if (this.session.showsConversation) this.session.openSessionDraft({ via: 'click' })
  }

  /** Ending the column's last live task must not drop the pane onto a shelved
   * one. Keep this lifecycle fallback separate from `closeTabs` because task
   * dismissal can remove the row before its mounted tabs are closed. */
  private composeNextPromptIfNoActiveTask(endedTask: SidebarTask): void {
    if (endedTask.lifecycle !== 'active' || this.activeTasks.length) return
    if (!this.session.showsConversation) return
    this.session.openSessionDraft({ via: 'click' })
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
    this.session.openSessionDraft({ reveal: false })
  }

  /** The checkmark: completing says "I am finished with this", so it also
   *  unloads the mounted conversation, exactly as the row's close control
   *  does. A durable task moves to the Completed shelf and stays resumable
   *  from there; a loose row is only its tab, so completing closes the row
   *  itself. Reopening closes nothing. */
  async completeTask(task: SidebarTask): Promise<void> {
    const durable = task.taskId ? this.session.tasksStore.taskForId(task.taskId) : undefined
    if (durable) {
      const reopening = durable.status === 'done'
      await this.session.tasksStore.setStatus(durable.id, reopening ? 'todo' : 'done')
      if (!reopening) {
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
      void this.session.tasksStore.setStatus(
        durable.id,
        durable.status === 'done' ? 'todo' : 'done',
      )
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
      await this.session.tasksStore.update(task.taskId, { title })
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
