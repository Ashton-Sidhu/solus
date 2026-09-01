import { createContext } from 'svelte'
import type { AgentId, PinnedSession } from '../../shared/types'
import { sessionEnvironment } from '../lib/git-context'
import {
  branchKeyFor,
  findOpenTabForSession,
  getAttentionState,
  projectByline,
  sessionTitle,
  type AttentionState,
} from '../lib/sessionUtils'
import type { PlanStore } from './plan.store.svelte'
import type { SettingsContext } from './settings.context.svelte'
import type { WorkspaceContext } from './workspace.context.svelte'

export type BranchKind = 'workspace' | 'worktree' | 'branch'

export type ProjectBranchGroup = {
  projectKey: string
  projectLabel: string
  attention: AttentionState
  branches: {
    key: string
    label: string
    kind: BranchKind
    /** True while a worktree is requested but not yet created (AI names it on the first turn). */
    pending: boolean
    tabIds: string[]
    attention: AttentionState
  }[]
}

export type SidebarSessionChild = {
  tabId: string
  label: string
  attention: AttentionState
  active: boolean
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
  /** Pinned sessions, most-recently-pinned first. Loaded on bootstrap, mutated by pin/unpin. */
  pinnedSessions = $state<PinnedSession[]>([])

  visibleTabIds: string[] = $derived.by(() => this.session.tabOrder.filter((id) => this.session.tabs[id]))

  projectBranchGroups: ProjectBranchGroup[] = $derived.by(() => {
    const projectMap = new Map<
      string,
      { label: string; branches: Map<string, { label: string; kind: BranchKind; pending: boolean; tabIds: string[]; attention: AttentionState }> }
    >()
    const projectOrder: string[] = []

    for (const tabId of this.visibleTabIds) {
      const tabSess = this.session.sessionFor(tabId)
      const tabEntry = this.session.tabs[tabId]
      if (!tabSess || !tabEntry) continue
      if (tabSess.loadingHistory) continue

      const projectKey = tabSess.gitContext?.repoRoot ?? tabSess.workingDirectory ?? '~'
      const projectLabel = projectByline(tabSess)
      const branchKey = branchKeyFor(tabSess)
      // Sidebar needs identity only — pass no live status. env.name is the real
      // branch name (or 'Workspace'); the Local/Worktree chip stays panel-only.
      const env = sessionEnvironment(tabSess.gitContext ?? null, tabSess.worktreeBaseBranch ?? null)
      const attention = getAttentionState(tabSess, tabEntry, this.planStore.plans)

      if (!projectMap.has(projectKey)) {
        projectMap.set(projectKey, { label: projectLabel, branches: new Map() })
        projectOrder.push(projectKey)
      }
      const project = projectMap.get(projectKey)!
      if (!project.branches.has(branchKey)) {
        project.branches.set(branchKey, {
          label: env.name,
          kind: env.kind,
          pending: env.pending,
          tabIds: [],
          attention: null,
        })
      }
      const branch = project.branches.get(branchKey)!
      branch.tabIds.push(tabId)
      // A group reads as pending only while every session in it is awaiting worktree creation.
      branch.pending = branch.pending && env.pending
      branch.attention = maxAttention(branch.attention, attention)
    }

    return projectOrder.map((projectKey) => {
      const project = projectMap.get(projectKey)!
      const branches = Array.from(project.branches.entries()).map(([key, val]) => ({
        key,
        label: val.label,
        kind: val.kind,
        pending: val.pending,
        tabIds: val.tabIds,
        attention: val.attention,
      }))
      const attention = branches.reduce<AttentionState>((acc, branch) => maxAttention(acc, branch.attention), null)
      return { projectKey, projectLabel: project.label, attention, branches }
    })
  })

  activeBranchKey: string = $derived(branchKeyFor(this.session.sessionFor(this.session.activeTabId)))

  activeProjectKey: string = $derived.by(() => {
    const activeSession = this.session.sessionFor(this.session.activeTabId)
    return activeSession?.gitContext?.repoRoot ?? activeSession?.workingDirectory ?? '~'
  })

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
    return {
      tabId,
      label: tab && sess ? sessionTitle(sess, tab) : tabId,
      attention: tab && sess ? getAttentionState(sess, tab, this.planStore.plans) : null,
      active: tabId === this.session.activeTabId,
    }
  }

  selectTab(tabId: string): void {
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

  async newSessionForGroup(tabIds: string[]): Promise<void> {
    if (tabIds.length > 0) this.session.selectTab(tabIds[0])
    await this.session.createTab()
  }

  closeTabs(tabIds: string[]): void {
    for (const tabId of [...tabIds]) this.session.closeTab(tabId)
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
