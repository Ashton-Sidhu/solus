import { createContext } from 'svelte'
import { SvelteSet } from 'svelte/reactivity'
import type { AgentId, PinnedSession, Session } from '../../../shared/types'
import {
  buildProjectSummaries,
  groupTasks,
  prChipFor as resolvePrChip,
  reconcileSidebarTasks,
  showsProjectLine as projectLineVisible,
  sortTasks,
  taskStatusFor,
  type PrChip,
  type ProjectSummary,
  type SidebarTask,
  type TaskGroup,
} from '../../components/session/lib/task-list'
import {
  findOpenTabForSession,
  getAttentionState,
  sessionTitle,
  type AttentionState,
} from '../../lib/sessionUtils'
import { environmentBranchKey, environmentProjectKey } from '../git/session-environment.store.svelte'
import type { PlanStore } from '../plans/plan.store.svelte'
import type { SettingsContext, SidebarViewMode } from '../app/settings.context.svelte'
import type { WorkspaceContext } from './workspace.context.svelte'

export type BranchKind = 'workspace' | 'worktree' | 'branch'

export type SidebarBranch = {
  key: string
  label: string
  kind: BranchKind
  /** Real git branch name, matched against a PR's head ref. Null off a branch. */
  branchName: string | null
  /** True while a worktree is requested but not yet created (AI names it on the first turn). */
  pending: boolean
  tabIds: string[]
  attention: AttentionState
  /** Any session here finished with output the user has not opened yet. */
  unread: boolean
  /** Newest message timestamp across the branch's sessions — the sort tie-break. */
  activityAt: number
  /** Earliest turn still in flight across the branch's sessions, so the row
   *  reports how long the task has been working rather than how long its most
   *  recently started session has. 0 when nothing here is running. */
  runStartedAt: number
}

export type ProjectBranchGroup = {
  projectKey: string
  projectLabel: string
  attention: AttentionState
  branches: SidebarBranch[]
}

/** A running turn began at its prompt, so the tail-most user message dates it.
 *  Bounded because it only ever has to look at the turn in flight — a deep walk
 *  through a long transcript would run on every stream tick. */
const TURN_START_SCAN_DEPTH = 200

function turnStartedAt(sess: Session): number {
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

export type SidebarSessionChild = {
  tabId: string
  label: string
  attention: AttentionState
  /** Session history mixes hosts, so each row has to carry the one it runs on. */
  serverId: string | null
  /** Start of the turn in flight, for the elapsed readout. 0 unless running. */
  runStartedAt: number
}

const attentionRank: Record<NonNullable<AttentionState>, number> = {
  awaiting: 5,
  awaiting_plan: 5,
  queued: 4,
  error: 3,
  running: 2,
  unread: 1,
}

function maxAttention(current: AttentionState, next: AttentionState): AttentionState {
  if (!next) return current
  if (!current) return next
  return attentionRank[next] > attentionRank[current] ? next : current
}

export class SessionSidebarStore {
  private taskModelsByKey = new Map<string, SidebarTask>()

  /** Pinned sessions, most-recently-pinned first. Loaded on bootstrap, mutated by pin/unpin. */
  pinnedSessions = $state<PinnedSession[]>([])
  visibleTabIds: string[] = $derived.by(() => this.session.tabOrder.filter((id) => this.session.tabs[id]))

  projectBranchGroups: ProjectBranchGroup[] = $derived.by(() => {
    const projectMap = new Map<string, { label: string; branches: Map<string, Omit<SidebarBranch, 'key'>> }>()
    const projectOrder: string[] = []

    // A loading transcript is deliberately not a reason to drop a tab. Everything
    // this builds — project, branch, title — comes from the persisted snapshot and
    // the environment store, none of which wait on the transcript. Skipping those
    // tabs made the row you clicked vanish and rebuild, because selecting a cold
    // tab starts its hydration.
    for (const tabId of this.visibleTabIds) {
      const tabSess = this.session.sessionFor(tabId)
      const tabEntry = this.session.tabs[tabId]
      if (!tabSess || !tabEntry) continue

      const env = this.session.environment.environmentFor(tabId)
      const projectKey = environmentProjectKey(env, tabSess.projectGroupPath)
      const projectLabel = projectKey === '~' ? '~' : projectKey.replace(/\/$/, '').split('/').at(-1) ?? '~'
      const branchKey = environmentBranchKey(env, tabSess.projectGroupPath)
      const branchLabel = tabSess.prReview?.title ?? env.name
      const attention = getAttentionState(tabSess, tabEntry, this.planStore.plans)

      if (!projectMap.has(projectKey)) {
        projectMap.set(projectKey, { label: projectLabel, branches: new Map() })
        projectOrder.push(projectKey)
      }
      const project = projectMap.get(projectKey)!
      if (!project.branches.has(branchKey)) {
        project.branches.set(branchKey, {
          label: branchLabel,
          kind: env.kind,
          branchName: env.branch,
          pending: env.pending,
          tabIds: [],
          attention: null,
          unread: false,
          activityAt: 0,
          runStartedAt: 0,
        })
      }
      const branch = project.branches.get(branchKey)!
      if (tabSess.prReview) branch.label = tabSess.prReview.title
      branch.tabIds.push(tabId)
      // A group reads as pending only while every session in it is awaiting worktree creation.
      branch.pending = branch.pending && env.pending
      branch.attention = maxAttention(branch.attention, attention)
      branch.unread ||= tabEntry.hasUnread
      branch.activityAt = Math.max(branch.activityAt, lastActivityAt(tabSess))
      if (attention === 'running') {
        const startedAt = turnStartedAt(tabSess)
        if (startedAt > 0) {
          branch.runStartedAt = branch.runStartedAt === 0 ? startedAt : Math.min(branch.runStartedAt, startedAt)
        }
      }
    }

    return projectOrder.map((projectKey) => {
      const project = projectMap.get(projectKey)!
      const branches = Array.from(project.branches.entries()).map(([key, val]) => ({ key, ...val }))
      const attention = branches.reduce<AttentionState>((acc, branch) => maxAttention(acc, branch.attention), null)
      return { projectKey, projectLabel: project.label, attention, branches }
    })
  })

  /** The user's own "I am finished with this", which nothing else in the app
   *  knows. Deliberately not persisted: a completed task stays for the session
   *  and drops out when it closes or the app restarts. */
  private doneTaskKeys = new SvelteSet<string>()

  /** Every open task, unfiltered and unsorted — the rail's counts and the
   *  one-project checks both have to see the whole column. */
  allTasks: SidebarTask[] = $derived.by(() =>
    reconcileSidebarTasks(
      this.taskModelsByKey,
      this.projectBranchGroups.flatMap((project) =>
        project.branches.map((branch) => ({
          key: branch.key,
          title: branch.label,
          projectKey: project.projectKey,
          projectLabel: project.projectLabel,
          branchName: branch.branchName,
          status: taskStatusFor(branch.attention, this.doneTaskKeys.has(branch.key)),
          attention: branch.attention,
          // Ticking the check is also "I have seen this", so a done row stops
          // spending a bolder title on output the user has already dismissed.
          unread: branch.unread && !this.doneTaskKeys.has(branch.key),
          activityAt: branch.activityAt,
          runStartedAt: branch.runStartedAt,
          tabIds: branch.tabIds,
        })),
      ),
    ),
  )

  projectCount: number = $derived(new Set(this.allTasks.map((task) => task.projectKey)).size)

  /** Every open project, with the counts and the lead task the breadcrumb's
   *  picker lands on. */
  projectSummaries: ProjectSummary[] = $derived(buildProjectSummaries(this.allTasks))

  get viewMode(): SidebarViewMode {
    return this.settings.sidebarViewMode
  }

  /** Null is unfiltered. A filter only survives while the project it names is
   *  still open — otherwise closing that project's last task would leave the
   *  column showing nothing, with the ✕ that clears it pointing at a project
   *  that no longer exists. */
  get projectFilter(): string | null {
    const filter = this.settings.sidebarProjectFilter
    if (!filter) return null
    return this.allTasks.some((task) => task.projectKey === filter) ? filter : null
  }

  /** Over one project the two modes differ by a single header line, so the
   *  toggle is offering a choice that isn't one. It comes back with the rail
   *  the moment a second project is open. */
  showsModeToggle: boolean = $derived(this.projectCount > 1)
  showsProjectLine: boolean = $derived(projectLineVisible(this.viewMode))

  /** The order tasks arrived in, held. The column is a place, not a feed: a row
   *  only moves when you open or close one. */
  visibleTasks: SidebarTask[] = $derived.by(() => {
    const filter = this.projectFilter
    return filter ? this.allTasks.filter((task) => task.projectKey === filter) : this.allTasks
  })

  taskGroups: TaskGroup[] = $derived(groupTasks(this.visibleTasks))

  /** The name of the project a filter is pinned to — only for the empty-state
   *  line, now that each task carries its own project and the header stays a
   *  plain "Tasks". Empty when nothing is filtered. */
  filterProjectLabel: string = $derived.by(() => {
    const filter = this.projectFilter
    if (!filter) return ''
    return this.allTasks.find((task) => task.projectKey === filter)?.projectLabel ?? 'this project'
  })

  headerCount: number = $derived(this.visibleTasks.length)

  /** The task the breadcrumb names — the one holding the session on screen. */
  activeTask: SidebarTask | null = $derived(
    this.allTasks.find((task) => task.tabIds.includes(this.session.activeTabId)) ?? null,
  )

  /** The active task's siblings, most urgent first: what the task crumb drops down. */
  tasksInActiveProject: SidebarTask[] = $derived.by(() => {
    const projectKey = this.activeTask?.projectKey
    if (!projectKey) return []
    return sortTasks(this.allTasks.filter((task) => task.projectKey === projectKey))
  })

  /** The sessions inside the active task: what the session crumb drops down. */
  activeTaskSessions: SidebarSessionChild[] = $derived(
    (this.activeTask?.tabIds ?? []).map((tabId) => this.childForTab(tabId)),
  )

  setViewMode(mode: SidebarViewMode): void {
    this.settings.update({ sidebarViewMode: mode })
  }

  setProjectFilter(projectKey: string | null): void {
    this.settings.update({ sidebarProjectFilter: projectKey })
  }

  prChipFor(task: SidebarTask): PrChip | null {
    return resolvePrChip(task.branchName, this.session.prsStore.items)
  }

  activeBranchKey: string = $derived(environmentBranchKey(
    this.session.environment.environmentFor(this.session.activeTabId),
    this.session.sessionFor(this.session.activeTabId)?.projectGroupPath,
  ))

  activeProjectKey: string = $derived(environmentProjectKey(
    this.session.environment.environmentFor(this.session.activeTabId),
    this.session.sessionFor(this.session.activeTabId)?.projectGroupPath,
  ))

  constructor(
    private settings: SettingsContext,
    private session: WorkspaceContext,
    private planStore: PlanStore,
  ) {}

  /** Hydrate the pinned list from the manifest. Called once on bootstrap. */
  async loadPinnedSessions(): Promise<void> {
    try {
      this.pinnedSessions = await window.solus.pinnedSessionsList()
    } catch {
      this.pinnedSessions = []
    }
  }

  isPinned(sessionId: string | null | undefined): boolean {
    if (!sessionId) return false
    return this.pinnedSessions.some((p) => p.sessionId === sessionId)
  }

  openTabIdForPinned(pin: PinnedSession): string | null {
    return findOpenTabForSession(
      pin.sessionId,
      this.session.tabs,
      this.session.sessions,
      this.session.tabOrder,
      pin.provider,
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

  childForTab(tabId: string): SidebarSessionChild {
    const tab = this.session.tabs[tabId]
    const sess = this.session.sessionFor(tabId)
    const attention = tab && sess ? getAttentionState(sess, tab, this.planStore.plans) : null
    return {
      tabId,
      label: tab && sess ? sessionTitle(sess, tab) : tabId,
      attention,
      serverId: sess?.serverId ?? null,
      runStartedAt: sess && attention === 'running' ? turnStartedAt(sess) : 0,
    }
  }

  selectTab(tabId: string): void {
    // Sidebar rows are navigation, not the tab-strip's expand/collapse toggle.
    // Clicking the selected child must therefore be a no-op.
    if (tabId === this.session.activeTabId) return
    this.session.selectTab(tabId)
  }

  selectBranch(branchKey: string, tabIds: string[]): boolean {
    const attentionTarget = this.getAttentionTarget(tabIds)
    const isAlreadyActiveBranch = tabIds.includes(this.session.activeTabId)
    const target = attentionTarget ?? this.session.lastActiveTabForBranch(branchKey) ?? tabIds[0]

    if (isAlreadyActiveBranch && (!attentionTarget || target === this.session.activeTabId)) {
      return false
    }

    this.session.selectTab(target)
    return true
  }

  closeTabs(tabIds: string[]): void {
    for (const tabId of [...tabIds]) this.session.closeTab(tabId)
  }

  /** The check is a toggle: it is the only affordance that sets the state, so
   *  it has to be the one that takes it back. */
  toggleTaskDone(taskKey: string): void {
    if (!this.doneTaskKeys.delete(taskKey)) this.doneTaskKeys.add(taskKey)
  }

  /** Forget the verdict along with the task, so reopening the same branch later
   *  does not come back already ticked off. */
  closeTask(task: SidebarTask): void {
    this.doneTaskKeys.delete(task.key)
    this.closeTabs(task.tabIds)
  }

  /** Pin or unpin the session backing a tab. No-op for tabs without an agent session. */
  async togglePinnedSession(tabId: string): Promise<void> {
    const tab = this.session.tabs[tabId]
    const session = this.session.sessionFor(tabId)
    if (!tab || !session?.agentSessionId) return

    const pin: PinnedSession = {
      sessionId: session.agentSessionId,
      provider: session.provider ?? (this.settings.activeAgent as AgentId),
      title: sessionTitle(session, tab),
      cwd: session.gitContext?.worktreePath ?? session.workingDirectory,
      pinnedAt: Date.now(),
    }
    this.pinnedSessions = await window.solus.togglePinnedSession(pin)
  }

  /** Rename from a sidebar row. Pins carry their own label, so a pinned session
   *  needs the manifest re-read for the row to show the new name. */
  async renameSession(tabId: string, title: string): Promise<void> {
    const sessionId = this.session.sessionFor(tabId)?.agentSessionId
    await this.session.renameTab(tabId, title)
    if (sessionId && this.isPinned(sessionId)) await this.loadPinnedSessions()
  }

  /** Unpin directly from a known pin (used by the sidebar's per-row pin). */
  async unpinSession(pin: PinnedSession): Promise<void> {
    this.pinnedSessions = await window.solus.togglePinnedSession($state.snapshot(pin))
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
      slug: null,
      firstMessage: pin.title,
      lastTimestamp: new Date(pin.pinnedAt).toISOString(),
      size: 0,
      cwd: pin.cwd,
      projectPath: '',
    })
  }
}

export const [getSessionSidebarStore, setSessionSidebarStore] = createContext<SessionSidebarStore>()
