import { createAppContext } from '../app/create-app-context'
import { SvelteSet } from 'svelte/reactivity'
import { untrack } from 'svelte'
import { worktreeProjectRoot, type AgentId, type PinnedSession, type RunConfig, type Session, type SessionMeta, type Tab } from '@solus/contracts/types'
import type { Task, TaskSessionLink } from '@solus/contracts/task-types'
import { parseGitHubPullRequestUrl } from '@solus/contracts/providers'
import { makePrompt } from './session.factories'
import { existingTaskId } from './session-draft.svelte'
import { firstActivityAt, lastActivityAt, turnStartedAt, withLazyActivity } from './session-activity'
import {
  buildProjectSummaries,
  dedupePrChoices,
  reconcileSidebarTasks,
  sessionRowLifecycle,
  sidebarSectionOf,
  sortSharedRows,
  projectFilterChoices,
  resolveProjectFilter,
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
import { CHATS_GROUP_KEY, groupKeyFor } from '../projects/projects.store.svelte'
import { CHAT_LABEL } from '../../lib/paths'
import { isChat } from '@solus/contracts/chat'
import type { ListProjectOption } from '../../components/ui/list-page/list-page'
import { pickerProjectKeys } from '../../components/session/unified-picker/lib/picker-scope'
import { SidebarSessionStatusFeed } from '../../components/session/lib/sidebar-session-status'
import { delegatedRows, nestedRowParents } from '../../components/session/lib/session-tree'
import { SidebarReturnOrder } from '../../components/session/lib/sidebar-return-order'
import type { PinnedEntry, SidebarSection } from '../../components/session/lib/sidebar-list-items'
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
  reviewGuideStore,
  sessionGuideIdentity,
} from '../../components/review/review-guide.store.svelte'
import { serverConnections } from '@solus/client-core/server-connections'
import { hostKey } from '@solus/client-core/host-key'
import { readSessionMeta } from '@solus/client-core/session-meta'
import { isSolusApiId } from '@solus/contracts/uplink'
import { mergeSessionHomes, type SessionHomeHosts } from '../../components/session/lib/session-home'
import { snoozeWakeDelay } from '../../components/session/lib/task-snooze'
import { subscribeAllHosts } from '@solus/client-core/host-events'
import { sessionPrLink, sessionPullRequestsStore } from '../prs/session-pull-requests.store.svelte'
import { sessionListStore, type ListedSession, type SessionListTarget } from './session-list.store.svelte'
import { isUnopenedShare } from './shared-sessions'
import { canDriveSession } from '../sharing/resource-roles'
import { projectHome, runHost, workingPlace } from './run-location'
import { usesWindowFilter, visibleInWindow } from '@solus/client-core/organization-filter'
import { managedHostIds } from '@solus/client-core/server-registry'
import { hostPathBaseName } from '@solus/contracts/host-path'

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
  /** Background walkthrough state for this exact agent session. */
  reviewGuideStatus: 'generating' | 'ready' | null
  /** Durable walkthrough state shown in the row tooltip after its notification
   * mark has been acknowledged. */
  reviewGuideTooltipStatus?: 'generating' | 'ready' | null
  /** The row is the cloud record of a session whose runner is not connected
   *  (docs/plans/cloud-service-model.md R8): it opens read-only. */
  runnerOffline?: boolean
}

/** A row's project name. A chat has no project, so it reads "Chat". */
function projectLabel(projectKey: string): string {
  if (isChat(projectKey)) return CHAT_LABEL
  return projectKey === '~' ? '~' : hostPathBaseName(projectKey)
}

/** The project a run works in. A dispatched run keeps its project's path on
 *  the host it was opened from, so the path is read on that host, not on the
 *  host its agent runs on. */
export function runGroupKey(run: Pick<RunConfig, 'location'>, projectKey: string): string {
  return groupKeyFor(projectHome(run).serverId, projectKey)
}

/** Every mounted conversation the sidebar must project. `tabOrder` gives the
 * stable display order, but a session started without activation can mount in a
 * companion pane before that pool represents it. Append those mounted tabs so a
 * secondary-pane send gets its immediate first-prompt row too. */
export function mountedSidebarTabIds(
  tabOrder: readonly string[],
  tabs: Readonly<Record<string, Tab>>,
  organizationIdForTab: (tabId: string) => string | undefined = () => undefined,
  activeOrganizationId: string | null = null,
  usesFilterForTab: (tabId: string) => boolean = () => true,
): string[] {
  const mounted = tabOrder.filter((tabId) => !!tabs[tabId])
  const seen = new Set(mounted)
  for (const tabId of Object.keys(tabs)) {
    if (seen.has(tabId)) continue
    mounted.push(tabId)
    seen.add(tabId)
  }
  return mounted.filter((tabId) => visibleInWindow(organizationIdForTab(tabId), activeOrganizationId, usesFilterForTab(tabId)))
}

/** The homes as the saved-host registry and the live sockets know them, without a reactive store. */
export function registrySessionHomes(): SessionHomeHosts {
  return {
    isSolusApi: isSolusApiId,
    isConnected: (serverId) => !!serverId && serverConnections.readinessFor(serverId).readiness === 'ready',
  }
}

export class SessionSidebarStore {
  private taskModelsById = new Map<string, SidebarTask>()
  private liveSessionStatuses?: SidebarSessionStatusFeed
  private hasSettledBootLocation = false

  private sessionStatusFeed(): SidebarSessionStatusFeed {
    return this.liveSessionStatuses ??= new SidebarSessionStatusFeed()
  }

  /** Pinned sessions, most-recently-pinned first. Loaded on bootstrap, mutated by pin/unpin. */
  pinnedSessions = $state<PinnedSession[]>([])
  visibleTabIds: string[] = $derived.by(() => mountedSidebarTabIds(
    this.session.tabOrder,
    this.session.tabs,
    (tabId) => this.session.sessionFor(tabId)?.organizationId ?? undefined,
    this.activeOrganizationId(),
    // A personal host's conversation shows in every window (plans/031 rule 1).
    (tabId) => {
      const session = this.session.sessionFor(tabId)
      return usesWindowFilter(session ? runHost(session.run) : null, managedHostIds())
    },
  ))

  /** Which tab, if any, has a given session mounted. Built once per pass:
   *  the picker needs this answer for each linked session of every task, and
   *  scanning the open tabs per lookup made it O(tasks × sessions × tabs) on
   *  every stream tick. */
  private tabIdBySessionId: Map<string, string> = $derived.by(() => {
    const bySessionId = new Map<string, string>()
    for (const tabId of this.visibleTabIds) {
      const tab = this.session.tabs[tabId]
      const session = this.session.sessionFor(tabId)
      if (!tab) continue
      bySessionId.set(tab.sessionId, tabId)
      if (session) bySessionId.set(hostKey(runHost(session.run), tab.sessionId), tabId)
    }
    return bySessionId
  })

  /** Advances when the next snooze is due, so a shelved row returns on time. */
  lifecycleNow = $state(Date.now())
  readonly regeneratingPinnedSessionIds = new SvelteSet<string>()

  /** The task an unlinked tab already belongs to: the one it was opened for.
   *  `session_init` assigns the provider id before the durable task link has
   *  finished hydrating, so the chip names the task from the first prompt. */
  private pendingTaskFor(session: Session | null | undefined): Task | undefined {
    const taskId = session ? existingTaskId(session.task) : undefined
    if (!taskId) return undefined
    return this.session.tasksStore.tasks.find((candidate) => candidate.id === taskId)
  }

  /**
   * A session's own row: one mounted conversation. Its lifecycle is the
   * session's state on its host: settled, snoozed, or active
   * (docs/plans/session-pull-requests.md). `linkedTask` names the task the
   * session is linked to.
   */
  private buildSessionRow(
    tabId: string,
    session: Session,
    tab: Tab,
    linkedTask: SidebarLinkedTask | undefined,
  ): SidebarTask {
    // A task of the reader's around it keeps it out of Shared with you: the task is theirs.
    // Whose the session is decides its section, listed or not (docs/plans/shared-with-you.md §2, rule 1).
    const share = linkedTask ? undefined : sessionListStore.shareFacts(session.id)?.share
    const environment = this.session.environment.environmentFor(this.session.sessionFor(tabId)?.run)
    const projectKey = environmentProjectKey(environment, session.run)
    const attention = getAttentionState(session, tab, this.planStore.plans)
    const state = sessionListStore.stateFor(session.id)
    const isSettled = !!state?.settledAt
    const lifecycle = sessionRowLifecycle(state, attention, this.lifecycleNow)
    const row: SidebarTask = {
      id: tabId,
      key: tabId,
      title: sessionTitle(session),
      projectKey,
      projectLabel: projectLabel(projectKey),
      groupKey: runGroupKey(session.run, projectKey),
      branchName: environment.branch,
      serverId: runHost(session.run) ?? null,
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
      share,
    }
    if (session.isLead) row.isLead = true
    return row
  }

  /**
   * The row of a session in its host's list that has no conversation open on
   * this client (docs/plans/session-archive.md). The host names it; selecting
   * the row opens the session.
   */
  private buildListedSessionRow(listed: ListedSession): SidebarTask {
    const projectKey = worktreeProjectRoot(listed.projectPath ?? '~')
    const state = sessionListStore.stateFor(listed.sessionId)
    const lifecycle = sessionRowLifecycle(state, null, this.lifecycleNow)
    const rowId = `session:${listed.sessionId}`
    const linkedTask = this.session.tasksStore.taskForSession(listed.sessionId)
    const share = listed.share
    const row: SidebarTask = {
      id: rowId,
      key: rowId,
      sessionId: listed.sessionId,
      title: listed.title ?? 'Session',
      projectKey,
      projectLabel: projectLabel(projectKey),
      groupKey: groupKeyFor(listed.serverId, projectKey),
      branchName: null,
      serverId: listed.serverId,
      status: taskStatusFor(null, !!state?.settledAt),
      attention: null,
      unread: isUnopenedShare(share, sessionListStore.openedGrantAt(listed.sessionId)),
      createdAt: listed.createdAt,
      runStartedAt: 0,
      lifecycle: lifecycle.lifecycle,
      completedAt: lifecycle.completedAt,
      snoozedUntil: lifecycle.snoozedUntil,
      snoozeNote: state?.snoozeNote ?? null,
      lastReadAt: 0,
      woke: lifecycle.woke,
      tabIds: [],
      linkedTask: linkedTask ? { taskId: linkedTask.id, title: linkedTask.title } : undefined,
      share,
    }
    if (listed.isLead) row.isLead = true
    return row
  }

  /** Every sidebar row, unfiltered and unsorted — the rail's counts and the
   *  one-project checks both have to see the whole column. Each row stands for
   *  one session; a session linked to a task names it on a chip. */
  allTasks: SidebarTask[] = $derived.by(() => {
    const mountedRows: SidebarTask[] = []
    const mountedSessionIds = new Set<string>()
    for (const tabId of this.visibleTabIds) {
      const session = this.session.sessionFor(tabId)
      const tab = this.session.tabs[tabId]
      if (!session || !tab) continue
      mountedSessionIds.add(session.id)
      const linkedTask = this.session.tasksStore.taskForSession(session.id)
        ?? this.pendingTaskFor(session)
      mountedRows.push(this.buildSessionRow(
        tabId,
        session,
        tab,
        linkedTask ? { taskId: linkedTask.id, title: linkedTask.title } : undefined,
      ))
    }

    // Each session in its host's list has a row, with or without a
    // conversation here, so every client shows the same list
    // (docs/plans/session-archive.md).
    const listedSessions = sessionListStore.sessionsInOrganization(this.activeOrganizationId())
      .filter((listed) => !mountedSessionIds.has(listed.sessionId))
      .map((listed) => this.buildListedSessionRow(listed))

    return reconcileSidebarTasks(
      this.taskModelsById,
      sortSidebarRowsByCreation([...mountedRows, ...listedSessions]),
    )
  })

  /** The sidebar aggregates every catalog host's rows into one list
   * (dispatch-client step 2); a row's own host still routes its actions. */
  catalogTasks: SidebarTask[] = $derived(this.allTasks.filter((row) => {
    const sessionId = this.sessionIdOfRow(row)
    return !sessionId || !sessionListStore.isCompletedShare(sessionId)
  }))

  /**
   * The session rows that sit under another row (`nestedRowParents`): each
   * nested row id with the id of the row above it. A nested row stays in
   * `catalogTasks`, so its menu, breadcrumb, and shelf actions are its own;
   * only its place in the list changes.
   */
  private nestedParentRowIds: Map<string, string> = $derived.by(() => {
    const parentSessionOf = new Map<string, string>()
    const rowOfSession = new Map<string, string>()
    for (const row of this.catalogTasks) {
      if (row.sessionId) rowOfSession.set(row.sessionId, row.id)
      for (const tabId of row.tabIds) {
        const session = this.session.sessionFor(tabId)
        if (!session) continue
        rowOfSession.set(session.id, row.id)
        if (session.parentSessionId) parentSessionOf.set(row.id, session.parentSessionId)
      }
    }
    return nestedRowParents(this.catalogTasks, parentSessionOf, rowOfSession)
  })

  /** The sessions listed under each row that has nested rows, oldest first. */
  private nestedSessionsByRowId: Map<string, SidebarSessionChild[]> = $derived.by(() => {
    const byRowId = new Map<string, SidebarSessionChild[]>()
    for (const row of this.catalogTasks) {
      const parentRowId = this.nestedParentRowIds.get(row.id)
      const tabId = row.tabIds[0]
      if (!parentRowId || !tabId) continue
      const child = withLazyActivity(
        { ...this.liveChildFor(tabId), projectKey: row.projectKey },
        () => this.tabActivityAt(tabId),
      )
      const children = byRowId.get(parentRowId) ?? []
      children.push(child)
      byRowId.set(parentRowId, children)
    }
    return byRowId
  })

  /**
   * The drawer of started sessions follows the conversation on screen: open
   * under the row on its path, closed under every other row. The caret and
   * the keys override that for one row, and the override lasts until the
   * conversation on screen changes, so a fold the person made holds while
   * they read, and clicking away closes the drawer. View state for this
   * client only, so it is not saved.
   */
  private nestedFoldOverride = $state<{ rowId: string; onScreenRowId: string | null; isOpen: boolean } | null>(null)

  /** Every delegated session under a row, folded or not. The row decides
   *  which it draws (`visibleNestedSessions`). */
  nestedSessionsFor(row: SidebarTask): SidebarSessionChild[] {
    return this.nestedSessionsByRowId.get(row.id) ?? []
  }

  isNestedOpen(row: SidebarTask): boolean {
    const override = this.nestedFoldOverride
    if (override?.rowId === row.id && override.onScreenRowId === this.onScreenRowId) return override.isOpen
    return row.id === this.onScreenRowId
  }

  toggleNestedSessions(row: SidebarTask): void {
    this.setNestedOpen(row, !this.isNestedOpen(row))
  }

  setNestedOpen(row: SidebarTask, isOpen: boolean): void {
    this.nestedFoldOverride = { rowId: row.id, onScreenRowId: this.onScreenRowId, isOpen }
  }

  private withoutNested(rows: SidebarTask[]): SidebarTask[] {
    return rows.filter((row) => !this.nestedParentRowIds.has(row.id))
  }

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
   * When a row last did anything: the latest message in its mounted session.
   * It moves with every streamed
   * message, so only a reader that shows or ranks by it may ask — the pickers'
   * ranking, or one phone row's timestamp — never the column's projection.
   */
  activityAtFor(task: SidebarTask): number {
    let latest = 0
    for (const tabId of task.tabIds) {
      const session = this.session.sessionFor(tabId)
      if (session) latest = Math.max(latest, lastActivityAt(session))
    }
    return latest
  }

  /**
   * When the person last sent a prompt to a row's session from a composer, or
   * 0. It changes once per send, never per streamed message, so the project
   * view may order its folders by it.
   */
  sentAtFor(task: SidebarTask): number {
    let latest = 0
    for (const tabId of task.tabIds) {
      latest = Math.max(latest, this.session.sessionFor(tabId)?.lastSentAt ?? 0)
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
    const projectKey = environmentProjectKey(this.session.environment.environmentFor(run), run)
    if (!projectKey || projectKey === '~' || isChat(projectKey)) return null
    return runGroupKey(run, projectKey)
  })

  /** The projects the task picker offers as a scope (`pickerProjectKeys`),
   *  one row per project. Every row is available: the picker lists what this
   *  client already holds, whether or not its host is connected. */
  pickerProjectOptions: ListProjectOption[] = $derived.by(() =>
    this.session.projectOptionsFor(pickerProjectKeys(
      this.currentProjectKey,
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

  /** Every open row, before the filter. The order rows arrived in, held:
   *  lifecycle changes update a row in place. */
  activeTasks: SidebarTask[] = $derived(this.catalogTasks.filter((task) => task.lifecycle === 'active'))

  private returnOrder = new SidebarReturnOrder()

  /** Open session rows. A session with unsent work and no pane is in Drafts
   *  instead. */
  private openRows: SidebarTask[] = $derived.by(() => {
    const parked = this.parkedSessionTabIds
    // Every status change rebuilds this pass, so the return order sees each
    // row leave the Working section before the sections sort.
    this.returnOrder.observe(this.activeTasks, Date.now())
    return this.inFilter(this.withoutNested(this.activeTasks).filter((row) =>
      !row.tabIds.some((tabId) => parked.has(tabId)),
    ))
  })

  /** The sessions the list shows bare: active sessions that are not working.
   *  A settled or snoozed session is on its shelf. Another person's session is
   *  in Shared with you. */
  sessionRows: SidebarTask[] = $derived(sortRowsByReturn(
    this.openRows.filter((row) => this.sectionOf(row) === 'sessions'),
    (row) => this.returnOrder.returnedAt(row),
  ))

  /** The Working section: open sessions whose agent is busy without the user,
   *  in the order they arrived. A row leaves it when it comes back to the
   *  user, and lands on top of the sessions. */
  workingRows: SidebarTask[] = $derived(this.openRows.filter((row) => this.sectionOf(row) === 'working'))

  /** Shared with you (docs/plans/shared-with-you.md): other people's sessions
   *  in this person's list, until they complete it, newest grant first. A row with
   *  unsent work and no pane is in Drafts, as a session of their own is. A
   *  shared session nested under one of the reader's sessions stays nested. */
  sharedRows: SidebarTask[] = $derived.by(() => {
    const parked = this.parkedSessionTabIds
    return sortSharedRows(this.inFilter(this.withoutNested(this.catalogTasks).filter((row) =>
      this.sectionOf(row) === 'shared' && !row.tabIds.some((tabId) => parked.has(tabId)),
    )))
  })

  snoozedTasks: SidebarTask[] = $derived(
    this.inFilter(this.withoutNested(this.catalogTasks).filter((task) => this.sectionOf(task) === 'snoozed'))
      .toSorted((a, b) => a.snoozedUntil - b.snoozedUntil || a.id.localeCompare(b.id)),
  )
  /** The Completed shelf: settled sessions, newest first. */
  completedTasks: SidebarTask[] = $derived(
    this.inFilter(this.withoutNested(this.catalogTasks).filter((task) => this.sectionOf(task) === 'completed'))
      .toSorted((a, b) => b.completedAt - a.completedAt || a.id.localeCompare(b.id)),
  )

  /** The Pinned section, in pin order: each pin with the row that stands for
   *  its session, or none when the list has no row for it (a closed session).
   *  A pinned session shows here and nowhere else, Drafts included. Pins are
   *  the person's own choice, so the project scope does not hide them. */
  pinnedEntries: PinnedEntry[] = $derived.by(() => {
    const rowByPin = new Map<PinnedSession, SidebarTask>()
    for (const row of this.withoutNested(this.catalogTasks)) {
      const pin = this.pinFor(this.sessionIdOfRow(row), row.serverId)
      if (pin) rowByPin.set(pin, row)
    }
    return this.pinnedSessions.map((pin) => ({ pin, row: rowByPin.get(pin) ?? null }))
  })

  /** The rows of the Pinned section, in its order. */
  pinnedRows: SidebarTask[] = $derived(this.pinnedEntries.flatMap((entry) => (entry.row ? [entry.row] : [])))

  /** The one section a row is in (`sidebarSectionOf`). */
  private sectionOf(row: SidebarTask): SidebarSection {
    return sidebarSectionOf(row, this.pinFor(this.sessionIdOfRow(row), row.serverId) !== null)
  }

  /** The filter's own choices, over every project the column knows about. */
  projectFilterChoices: ProjectFilterChoice[] = $derived(
    projectFilterChoices(this.catalogTasks, (keys) => this.projectOptionsFor(keys)),
  )

  private inFilter(tasks: SidebarTask[]): SidebarTask[] {
    const filter = this.scopedProject?.key ?? null
    return filter ? tasks.filter((task) => task.groupKey === filter) : tasks
  }

  /** Open sessions with unsent work move to Drafts once no pane shows them. */
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
      const projectKey = environmentProjectKey(this.session.environment.environmentFor(draft.run), draft.run)
      const groupKey = runGroupKey(draft.run, projectKey)
      // A draft with no repo behind it belongs to nothing yet, so no project
      // scope can exclude it.
      if (filter && projectKey !== '~' && groupKey !== filter) continue
      rows.push({
        draftId: draft.id,
        title: draftTitle(draft.prompt),
        projectKey,
        projectLabel: projectLabel(projectKey),
        groupKey,
        serverId: runHost(draft.run),
        hasAttachments: draft.prompt.attachments.length > 0,
      })
    }
    for (const tabId of this.parkedSessionTabIds) {
      const session = this.session.sessionFor(tabId)
      // A pinned session keeps its row in Pinned, with its unsent prompt.
      if (!session || this.isPinned(session.id, runHost(session.run))) continue
      const projectKey = environmentProjectKey(this.session.environment.environmentFor(session.run), session.run)
      const groupKey = runGroupKey(session.run, projectKey)
      if (filter && projectKey !== '~' && groupKey !== filter) continue
      rows.push({
        draftId: `session:${tabId}`,
        tabId,
        title: sessionDraftTitle(session),
        projectKey,
        projectLabel: projectLabel(projectKey),
        groupKey,
        serverId: runHost(session.run),
        hasAttachments: session.prompt.attachments.length > 0,
      })
    }
    return rows
  })

  /** The row holding a tab, whether that conversation is leading or split.
   *  Every open tab is projected into `allTasks` as its own row, so a composer
   *  that has yet to dispatch needs no row of its own synthesized here. */
  taskForTab(tabId: string): SidebarTask | null {
    return this.catalogTasks.find((task) => task.tabIds.includes(tabId)) ?? null
  }

  /** The task the leading breadcrumb names. */
  activeTask: SidebarTask | null = $derived.by(() => this.taskForTab(this.session.activeTabId))

  /** The row holding the conversation on screen. Resolved once for the column;
   *  each row compares its own id against it rather than scanning the column. */
  onScreenTaskId: string | null = $derived.by(() => this.taskForTab(this.session.onScreenTabId)?.id ?? null)

  /** The list row on the path to the conversation on screen: the row of that
   *  conversation, or the row it is nested under. */
  onScreenRowId: string | null = $derived(
    (this.onScreenTaskId && this.nestedParentRowIds.get(this.onScreenTaskId)) || this.onScreenTaskId,
  )

  /** The row a collapsed shelf keeps showing: the one on screen, so it never
   *  disappears into a shelf. */
  shelfRevealTaskId: string | null = $derived(this.onScreenRowId)

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
   * Every pull request a row stands for: the ones its session links, and the
   * one its checkout is on, as one deduplicated set.
   *
   * Two sources because neither covers the other. A link is durable and
   * survives the checkout that made it, and a checkout can be on a pull
   * request no link names yet. So: take both, name each pull request once, and
   * let the provider record fill in what it can.
   *
   * The record is an enrichment, never a filter. A pull request this client
   * holds no record for — an unreachable host, a disconnected account, a project
   * whose list nothing has read yet — is still a pull request the user linked,
   * and the row shows it.
   */
  prChoicesFor(task: SidebarTask): TaskPrChoice[] {
    const serverId = task.serverId
    if (!serverId) return []
    return this.withRequiredChecks(serverId, dedupePrChoices([
      ...this.sessionPrChoices(this.sessionIdOfRow(task), serverId, task.projectKey),
      ...this.mountedPrChoices(task.tabIds, serverId, task.projectKey),
    ]))
  }

  /** The same set for a surface that names a session rather than a sidebar
   *  row: the session menu, wherever it opens. */
  prChoicesForSession(serverId: string, sessionId: string, tabId: string | null): TaskPrChoice[] {
    return this.withRequiredChecks(serverId, dedupePrChoices([
      ...this.sessionPrChoices(sessionId, serverId, null),
      ...this.mountedPrChoices(tabId ? [tabId] : [], serverId, null),
    ]))
  }

  private withRequiredChecks(serverId: string, choices: TaskPrChoice[]): TaskPrChoice[] {
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
   * Removes a session's pull request, or null when the session has no link to
   * remove: a pull request read only from the checkout's branch is not linked.
   */
  pullRequestUnlink(serverId: string | null, sessionId: string | null, choice: TaskPrChoice): (() => Promise<void>) | null {
    const link = sessionPullRequestsStore.linksFor(sessionId)
      .find((candidate) => candidate.number === choice.number && candidate.repository === choice.targetScope.toLowerCase())
    if (!link || !serverId) return null
    return () => sessionPullRequestsStore.unlink(serverId, link)
  }

  /** The one session a session row stands for. */
  sessionIdOfRow(task: SidebarTask): string | null {
    const tabId = task.tabIds[0]
    return (tabId ? this.session.tabs[tabId]?.sessionId : undefined) ?? task.sessionId ?? null
  }

  /**
   * The pull requests a session row's own session links
   * (docs/plans/session-pull-requests.md).
   */
  private sessionPrChoices(sessionId: string | null, serverId: string, projectKey: string | null): TaskPrChoice[] {
    return sessionPullRequestsStore.linksFor(sessionId).flatMap((link) => {
      const pr = this.pullRequestProjects.linkedPr(serverId, sessionPrLink(link), projectKey)
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
   * arrives through `sessionPrChoices` instead, where deduplication meets it.
   */
  private mountedPrChoices(tabIds: readonly string[], serverId: string, projectKey: string | null): TaskPrChoice[] {
    return this.mountedPrObservations(tabIds).flatMap((observation) => {
      const parsedUrl = observation.prUrl ? parseGitHubPullRequestUrl(observation.prUrl) : null
      if (!parsedUrl) return []
      const pr = this.pullRequestProjects.linkedPr(serverId, {
        number: parsedUrl.number, url: parsedUrl.url,
      }, projectKey)
      return pr ? [pr] : []
    })
  }

  /** The Git section's detailed status is the canonical detector for mounted
   * sessions. The sidebar reads that same result instead of maintaining a
   * second branch-to-PR opinion. */
  private mountedPrObservations(tabIds: readonly string[]): MountedPrObservation[] {
    return tabIds.flatMap((tabId) => {
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
    this.session.sessionFor(this.session.activeTabId)?.run,
  ))

  activeProjectKey: string = $derived.by(() => environmentProjectKey(
    this.session.environment.environmentFor(this.session.activeSession?.run),
    this.session.sessionFor(this.session.activeTabId)?.run,
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
    private readonly activeOrganizationId: () => string | null = () => null,
  ) {
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
      for (const { snoozedUntil } of sessionListStore.views) {
        if (snoozedUntil && snoozedUntil > now && (nextWake === 0 || snoozedUntil < nextWake)) {
          nextWake = snoozedUntil
        }
      }
      if (!nextWake) return
      const timeout = window.setTimeout(() => {
        this.lifecycleNow = Date.now()
      }, snoozeWakeDelay(nextWake))
      return () => window.clearTimeout(timeout)
    })
    $effect(() => {
      // Depend on the answer arriving, not on the rows it produces: this is a
      // one-shot boot decision, not a rule that keeps re-running as tasks move.
      void this.session.tasksStore.loaded
      untrack(() => this.settleBootLocation())
    })
  }

  /** Keep the status of linked sessions with no tab live for the picker. */
  subscribeSessionStatuses(): () => void {
    const stopEvents = subscribeAllHosts('session.statusChanged', (serverId, event) => {
      this.sessionStatusFeed().apply(serverId, event)
    })
    // A list read (each reconnect makes one) answers what the events missed.
    const stopRecords = sessionListStore.onRecordsRead((serverId, records, readStartedAt) => {
      for (const record of records) this.sessionStatusFeed().adoptRecord(serverId, record, readStartedAt)
    })
    return () => { stopEvents(); stopRecords() }
  }

  /** A tab is closing: the status the feed held for its session is stale. */
  releaseTab(tabId: string): void {
    const session = this.session.sessionFor(tabId)
    if (!session) return
    this.sessionStatusFeed().clear(serverConnections.resolveId(runHost(session.run)), session.id)
  }

  /** Hydrate the pinned list by fanning out over every connected host: pins
   *  are host-authoritative (dispatch-client), so each host answers for its
   *  own sessions. Rows read naked get the answering host stamped; a host
   *  that fails the read keeps the rows it answered with last time. */
  async loadPinnedSessions(): Promise<void> {
    const serverIds = serverConnections.connectedServerIds()
    await Promise.all(serverIds.map(async (serverId) => {
      try {
        const rows = await serverConnections.apiFor(serverId).pinnedSessionsList()
        const seen = new Set<string>()
        const pins = rows.filter((row) => {
          if (seen.has(row.sessionId)) return false
          seen.add(row.sessionId)
          row.serverId = serverId
          return true
        })
        for (let index = this.pinnedSessions.length - 1; index >= 0; index--) {
          if (this.pinnedSessions[index].serverId === serverId) this.pinnedSessions.splice(index, 1)
        }
        this.pinnedSessions.push(...pins)
      } catch {
        // A failed host keeps its last rows; other hosts can still update.
      }
    }))
  }

  isPinned(sessionId: string | null | undefined, serverId?: string | null): boolean {
    return this.pinFor(sessionId, serverId) !== null
  }

  /** The pin of a session on its host, or null when it has none. */
  pinFor(sessionId: string | null | undefined, serverId: string | null | undefined): PinnedSession | null {
    if (!sessionId || !serverId) return null
    const resolvedServerId = serverConnections.resolveId(serverId)
    return this.pinnedSessions.find((pin) =>
      pin.sessionId === sessionId
      && pin.serverId === resolvedServerId,
    ) ?? null
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
      serverId: runHost(sess?.run) ?? null,
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

  /** Each row's sessions, computed once for the whole column, so a row's
   *  subtree keeps one array identity across unrelated invalidations. */
  private sessionsByRowId: Map<string, SidebarSessionChild[]> = $derived.by(() => {
    const byRowId = new Map<string, SidebarSessionChild[]>()
    for (const row of this.catalogTasks) {
      byRowId.set(row.id, row.tabIds.map((tabId) => this.childForTab(tabId)))
    }
    return byRowId
  })

  sessionsFor(task: SidebarTask): SidebarSessionChild[] {
    // Callers can hold a row the last derived pass hasn't caught up with, so a
    // miss still answers rather than reporting the row as empty.
    return this.sessionsByRowId.get(task.id) ?? task.tabIds.map((tabId) => this.childForTab(tabId))
  }

  /**
   * The sessions the picker lists for a task: every session linked to it, read
   * from the task's own links, whether or not it is mounted here.
   */
  private pickerSessionsByTaskId: Map<string, SidebarSessionChild[]> = $derived.by(() => {
    const byTaskId = new Map<string, SidebarSessionChild[]>()
    for (const task of this.session.tasksStore.tasks) {
      byTaskId.set(task.id, this.linkedSessionsOf(task))
    }
    return byTaskId
  })

  sessionsForPickableTask(task: Task): SidebarSessionChild[] {
    return this.pickerSessionsByTaskId.get(task.id) ?? this.linkedSessionsOf(task)
  }

  /** Opening a session whose snooze ended is the read that clears the woken
   *  mark: the host forgets the snooze. */
  acknowledgeRow(row: SidebarTask): void {
    if (row.woke) this.snoozeRow(row.key, null)
  }

  /**
   * The session a row stands for, on its host. Null for a session that has
   * not started: its host does not know it yet.
   */
  private sessionOfRow(row: SidebarTask): { serverId: string; sessionId: string } | null {
    if (row.sessionId) return row.serverId ? { serverId: row.serverId, sessionId: row.sessionId } : null
    const tabId = row.tabIds[0]
    const session = tabId ? this.session.sessionFor(tabId) : null
    const sessionId = session?.agentSessionId ? session.id : null
    return tabId && sessionId ? { serverId: this.session.serverIdFor(tabId), sessionId } : null
  }

  /** Whether the row's session can be settled, snoozed, and archived: a
   *  session that has not started cannot, and neither can a member who may
   *  only read a shared session (the host requires an editor). */
  canShelve(row: SidebarTask): boolean {
    const target = this.sessionOfRow(row)
    return target !== null && canDriveSession(target.serverId, target.sessionId)
  }

  /** Whether the row's session can be archived. Archive writes the reader's
   *  own view, so a session shared with them to view archives too
   *  (docs/plans/shared-with-you.md §2, rule 4). */
  canArchive(row: SidebarTask): boolean {
    return this.canShelve(row) || (!!row.share && this.sessionOfRow(row) !== null)
  }

  /** Snooze a row's session on its host. `until` of null wakes it now, which
   *  is what the row's own Wake button and the undo toast both call. A prompt
   *  also wakes a session, on the host. */
  snoozeRow(rowKey: string, until: number | null, note = ''): void {
    const row = this.catalogTasks.find((task) => task.key === rowKey)
    if (!row) return
    const wasActive = row.lifecycle === 'active'
    const target = this.sessionOfRow(row)
    if (!target) return
    void sessionListStore.snooze(target, until, note)
      .then(() => {
        if (until !== null && wasActive) this.composeNextPromptIfNoActiveTask(row)
      })
      .catch(async () => {
        // The undo toast already said it moved; say that it did not.
        const { toasts } = await import('../../lib/toasts')
        toasts.error(until === null ? "Couldn't wake it" : "Couldn't snooze it")
      })
  }

  /** The metadata read `prepareOpen` started for a row, taken by its open. */
  private preparedOpen: { rowKey: string; at: number; meta: Promise<SessionMeta | null> } | null = null

  /** Start the reads opening a listed session needs at the click, before the
   *  deferred switch: its metadata, then its first history page. */
  prepareOpen(row: SidebarTask): void {
    if (row.tabIds.length || !row.sessionId || !row.serverId) return
    // Pointer down and the click both ask; one read serves both.
    if (this.preparedOpen?.rowKey === row.key && Date.now() - this.preparedOpen.at < 2_000) return
    // The list already holds what the page is read with: ask for it now, beside
    // the metadata read rather than after it.
    const listed = sessionListStore.listed(row.sessionId)
    if (listed && !listed.runnerOffline) {
      this.session.opening.prefetchFirstPage({ sessionId: row.sessionId, serverId: listed.serverId, ...listed.opensWith })
    }
    const meta = readSessionMeta(row.serverId, row.sessionId)
    void meta.then((read) => { if (read) this.session.opening.prefetchFirstPage(read) })
    this.preparedOpen = { rowKey: row.key, at: Date.now(), meta }
  }

  /** Open a listed session that has no conversation here. */
  private async openListedSession(row: SidebarTask): Promise<void> {
    if (!row.sessionId || !row.serverId) return
    const prepared = this.preparedOpen?.rowKey === row.key && Date.now() - this.preparedOpen.at < 2_000
      ? this.preparedOpen.meta
      : null
    this.preparedOpen = null
    const meta = await (prepared ?? readSessionMeta(row.serverId, row.sessionId))
    if (meta) {
      await this.session.opening.resumeSession(meta)
      return
    }
    // A stale row of a shared session: say why it does not open.
    const { noticeUnopenableSession } = await import('../sharing/unopenable-session')
    noticeUnopenableSession(row.serverId, row.sessionId)
  }

  /**
   * The check on a row: completing says "I am finished with this". It settles
   * the session on its host and unloads its conversation, exactly as the row's
   * close control does; the row goes to Completed on this person's clients. On a
   * settled session it makes the session active again, and opens it when no
   * conversation of it is here. A session that has not started has nothing on
   * its host, so its row is only closed.
   */
  async completeTask(row: SidebarTask): Promise<void> {
    const target = this.canShelve(row) ? this.sessionOfRow(row) : null
    if (!target) {
      this.closeTask(row)
      return
    }
    // The list changes before the home answers, so the row moves at once.
    if (row.lifecycle === 'completed') {
      const unsettling = sessionListStore.setSettled(target, false)
      if (!row.tabIds.length) await this.openListedSession(row)
      await unsettling
      return
    }
    // The sessions it delegated are finished with it: they settle and close too.
    const targets = [target, ...this.closeDelegatedRows(row, (child) => this.canShelve(child))]
    const settling = Promise.all(targets.map((settled) => sessionListStore.setSettled(settled, true)))
    this.closeTask(row)
    const { toasts } = await import('../../lib/toasts')
    try {
      await settling
    } catch (error) {
      toasts.error("Couldn't change session status", { description: error instanceof Error ? error.message : String(error) })
      return
    }
    // Undo makes the session active again, as the mobile list's Undo does.
    toasts.undo('Session marked as completed.', () => {
      void Promise.all(targets.map((settled) => sessionListStore.setSettled(settled, false))).catch(() => {
        toasts.error("Couldn't make it active again")
      })
    })
  }

  /**
   * Close the rows of the sessions a row's session delegated, at any depth
   * (`delegatedRows`), before the row itself closes. Returns the sessions of
   * the closed rows that `canChange` accepts, so the row's settle or archive
   * applies to them too.
   */
  private closeDelegatedRows(row: SidebarTask, canChange: (child: SidebarTask) => boolean): SessionListTarget[] {
    const target = this.sessionOfRow(row)
    if (!target) return []
    const children = delegatedRows(target.sessionId, this.catalogTasks, (candidate) => {
      const tabId = candidate.tabIds[0]
      return tabId ? this.session.sessionFor(tabId) ?? null : null
    })
    const targets: SessionListTarget[] = []
    for (const child of children) {
      const childTarget = canChange(child) ? this.sessionOfRow(child) : null
      if (childTarget) targets.push(childTarget)
      this.closeTask(child)
    }
    return targets
  }

  /** Every session linked to a task, in the order they were linked. */
  private linkedSessionsOf(record: Task): SidebarSessionChild[] {
    const taskModel = this.session.tasksStore.get(record.id)
    const seenSessionIds = new Set<string>()
    const children: SidebarSessionChild[] = []
    for (const link of taskModel.sessions.toSorted((a, b) => a.linkedAt - b.linkedAt)) {
      if (seenSessionIds.has(link.sessionId)) continue
      seenSessionIds.add(link.sessionId)
      children.push(this.linkedSessionChild(record, link, attemptServerId({ link, taskServerId: taskModel.serverId })))
    }
    // One row per session across its homes: the runner while it is connected,
    // else the cloud record, marked.
    return mergeSessionHomes(children, this.sessionHomes)
  }

  /** One linked session: a mounted one as its tab states it, any other from
   *  its link and the status feed. */
  private linkedSessionChild(record: Task, link: TaskSessionLink, linkServerId: string | null): SidebarSessionChild {
    // The folder of the session's own project: a task names no folder.
    const projectKey = link.checkoutPath ? worktreeProjectRoot(link.checkoutPath) : undefined
    const tabId = this.tabIdBySessionId.get(link.sessionId)
    if (tabId) {
      const child = this.liveChildFor(tabId)
      return withLazyActivity({
        ...child,
        // A row stands for one session, so it is named by that session. The
        // task title is the fallback for a session with no name of its own.
        label: sessionDisplayName({ link, liveTitle: child.label, taskTitle: record.title }),
        sessionId: link.sessionId,
        projectKey,
        serverId: child.serverId ?? linkServerId,
        provider: child.provider ?? link.provider,
        modelId: child.modelId ?? link.model,
        branchName: child.branchName ?? link.branch ?? null,
      },
      // A restored tab can exist before its transcript is hydrated. The
      // durable link still knows when that session was active; do not turn
      // an empty mounted transcript into the Unix epoch in the picker.
      () => restoredSessionActivityAt(this.tabActivityAt(tabId), link))
    }
    const liveState = this.sessionStatusFeed().stateFor(linkServerId, link.sessionId)
    const checkout = link.checkoutPath && linkServerId ? this.session.environment.checkouts.get(linkServerId, link.checkoutPath) : undefined
    return {
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
    }
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

  async selectTask(task: SidebarTask): Promise<void> {
    // A row stands for one conversation: the mounted one, or the one its host
    // names for a listed session.
    const tabId = task.tabIds[0]
    if (tabId) this.selectTab(tabId)
    else await this.openListedSession(task)
  }

  /** The next/previous-session keys: open the open row `delta` rows from the
   *  one on screen, in the order the column lists them, wrapping at the ends.
   *  With no row on screen, start from the top or the bottom. */
  async selectAdjacentRow(delta: 1 | -1): Promise<void> {
    const rows = [...this.sessionRows, ...this.sharedRows, ...this.pinnedRows, ...this.workingRows]
    if (!rows.length) return
    const index = rows.findIndex((row) => row.id === this.onScreenRowId)
    const next = index === -1
      ? rows[delta === 1 ? 0 : rows.length - 1]
      : rows[(index + delta + rows.length) % rows.length]
    if (next.id === this.onScreenTaskId) return
    await this.selectTask(next)
  }

  async selectChild(child: SidebarSessionChild): Promise<void> {
    if (child.tabId) {
      this.selectTab(child.tabId)
      return
    }
    // The task link already names the exact session and its host. A legacy row
    // without a host is inert — no probe, no guess.
    if (!child.sessionId || !child.serverId) return
    const meta = await readSessionMeta(child.serverId, child.sessionId)
    if (meta) await this.session.opening.resumeSession(meta)
  }

  /** Close tabs and, when the active one goes, move forward: the next open
   *  sidebar row below it, wrapping to the top. With none left, a draft in the
   *  closed conversation's project takes its place. */
  closeTabs(tabIds: string[], via: Via = 'click'): void {
    const activeTabId = this.session.activeTabId
    const closesActiveTab = tabIds.includes(activeTabId)
    const openRows = [...this.sessionRows, ...this.sharedRows, ...this.pinnedRows, ...this.workingRows]
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
    // A fresh draft, so it is not linked to the closed session's task.
    const fallbackDraft = closesActiveTab && !nextTabId && this.session.showsConversation
      ? this.session.drafts.createSessionDraft({ freshTask: true, sourceId: activeTabId, via })
      : null

    for (const tabId of tabIds) this.session.closeTab(tabId, via)

    if (!closesActiveTab) return
    if (nextTabId && this.session.tabs[nextTabId]) this.session.selectTab(nextTabId)
    else if (fallbackDraft) this.session.drafts.openDraft(fallbackDraft.id, via)
  }

  /** Ending the column's last live row must not drop the pane onto a shelved
   * one. Keep this lifecycle fallback separate from `closeTabs` because a
   * snooze can remove the row before its mounted tabs are closed. */
  private composeNextPromptIfNoActiveTask(endedTask: SidebarTask): void {
    if (endedTask.lifecycle !== 'active' || this.activeTasks.length) return
    if (!this.session.showsConversation) return
    this.session.drafts.openSessionDraft({ freshTask: true, via: 'click' })
  }

  /** The same rule at launch: the snapshot restores whichever conversation was
   *  last on screen, and it can have finished since. The task store's first
   *  answer is the one chance to decide — after that, opening finished work is
   *  deliberate. Nothing is revealed, so this never changes the startup route. */
  private settleBootLocation(): void {
    if (this.hasSettledBootLocation || !this.session.tasksStore.loaded) return
    this.hasSettledBootLocation = true
    if (this.activeTasks.length || !this.session.showsConversation) return
    this.session.drafts.openSessionDraft({ freshTask: true, reveal: false })
  }

  /** Close a row's mounted tabs while keeping its session available to resume
   *  from history. */
  closeTask(task: SidebarTask): void {
    const tabIdsToClose = task.tabIds.filter((tabId) =>
      !this.catalogTasks.some((candidate) =>
        candidate.id !== task.id && candidate.tabIds.includes(tabId),
      ),
    )
    this.closeTabs(tabIdsToClose)
    if (tabIdsToClose.length) this.composeNextPromptIfNoActiveTask(task)
  }

  /**
   * The X on a row (docs/plans/session-archive.md). A started session's row
   * archives the session on its host, so it leaves the list on every device,
   * and closes its tabs; the session picker still finds it. A session that
   * has not started, and a session the reader may not drive, only leave this
   * client.
   */
  removeRow(row: SidebarTask): void {
    const target = this.canArchive(row) ? this.sessionOfRow(row) : null
    // The sessions it delegated leave the list with it.
    const delegated = this.closeDelegatedRows(row, (child) => this.canArchive(child))
    this.closeTask(row)
    if (!target) return
    void this.archiveOnHost([target, ...delegated])
  }

  /** Archive sessions on their hosts. Only a refused archive says it failed,
   *  with the host's reason; Undo returns the sessions to the list. */
  private async archiveOnHost(targets: SessionListTarget[]): Promise<void> {
    const archiving = Promise.all(targets.map((target) => sessionListStore.setArchived(target, true)))
    const { toasts } = await import('../../lib/toasts')
    try {
      await archiving
    } catch (error) {
      toasts.error("Couldn't archive it", { description: error instanceof Error ? error.message : String(error) })
      return
    }
    toasts.undo('Session archived', () => {
      void Promise.all(targets.map((target) => sessionListStore.setArchived(target, false))).catch(() => {
        toasts.error("Couldn't return it to the list")
      })
    })
  }

  /** Keyboard dismissal targets a mounted row by tab id. */
  closeSidebarTab(tabId: string): void {
    const row = this.taskForTab(tabId)
    if (row) this.closeTask(row)
  }

  /** Pin or unpin the session backing a tab. No-op for tabs without an agent session. */
  async togglePinnedSession(tabId: string): Promise<void> {
    const tab = this.session.tabs[tabId]
    const session = this.session.sessionFor(tabId)
    if (!tab || !session?.agentSessionId) return

    const pinServerId = serverConnections.resolveId(runHost(session.run))
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
      cwd: workingPlace(session.run).path,
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
    const serverId = runHost(this.session.sessionFor(tabId)?.run)
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
