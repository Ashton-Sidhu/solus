import { parsePatchFiles } from '@pierre/diffs'
import { tabGitContextFromStatus, type AgentId, type GitProjectStatus, type IpcContext, type Message, type QueuedPromptSnapshot, type Session, type TurnSnapshot } from '../../shared/types'
import { extractChangedFilePaths, extractChangedFilePathsFromMessage } from '../lib/changedFiles'
import type { AgentContext } from './agent.context.svelte'
import type { PlanStore } from './plan.store.svelte'
import type { SessionConfigController } from './session-config.svelte'
import { reconcileQueuedPromptsForSession } from './session-transcript'
import type { SettingsContext } from './settings.context.svelte'
import type { TabRegistry } from './tab-registry.svelte'

export interface StaticInfo {
  version: string
  email: string | null
  subscriptionType: string | null
  projectPath: string
  homePath: string
  workspacePath: string
}

export interface EnvironmentStoreDeps {
  registry: TabRegistry
  settings: SettingsContext
  config: SessionConfigController
  planStore: PlanStore
  agent?: AgentContext
  setGitStatus(cwd: string, status: GitProjectStatus | null): void
  ctxFor(tabId: string): IpcContext
  loadTranscript(args: {
    sessionId: string
    loadPath: string
    displayCwd: string
    provider: AgentId
    ctx: IpcContext
  }): Promise<{ messages: Session['messages']; progress: Session['progress']; planIds: string[] }>
}

export class EnvironmentStore {
  staticInfo = $state<StaticInfo | null>(null)
  pluginCommands = $state<Session['pluginCommands']>({ global: [], project: [] })
  turnSnapshots = $state<Record<string, TurnSnapshot[]>>({})

  constructor(private deps: EnvironmentStoreDeps) {}

  async initStaticInfo(): Promise<void> {
    const result = await window.solus.start()
    this.staticInfo = {
      version: result.version || 'unknown',
      email: result.auth?.email || null,
      subscriptionType: result.auth?.subscriptionType || null,
      projectPath: result.projectPath || '~',
      homePath: result.homePath || '~',
      workspacePath: result.workspacePath || '~',
    }
    if (this.deps.config.globalDefaults.workingDirectory === '~') {
      this.deps.config.globalDefaults.workingDirectory = result.workspacePath || '~'
    }
    this.deps.agent?.hydrate(result.agents ?? [])
    if (!this.deps.agent?.metadata[this.deps.settings.activeAgent]?.available) {
      const fallback = result.agents?.find((agent) => agent.available)
      if (fallback) this.deps.settings.update({ activeAgent: fallback.id })
    }
    if (this.deps.registry.tabOrder.length === 0) {
      void this.fetchGitContext(this.deps.registry.activeTabId, this.deps.config.globalDefaults.workingDirectory)
    }
    void this.refreshPluginCommands(this.deps.config.globalDefaults.workingDirectory)
  }

  async refreshPluginCommands(workingDirectory: string, tabId?: string): Promise<void> {
    const targetTabId = tabId ?? this.deps.registry.activeTabId
    const ctx = this.deps.ctxFor(targetTabId)
    ctx.session.provider = this.deps.settings.activeAgent as AgentId
    const result = await window.solus.getPluginCommands(workingDirectory, $state.snapshot(ctx))
    this.pluginCommands = result
    const session = this.deps.registry.sessionFor(targetTabId)
    if (session) session.pluginCommands = result
  }

  async fetchGitContext(tabId: string, dir: string): Promise<void> {
    if (!dir || dir === '~') return
    const status = await window.solus.gitProjectStatus(dir).catch(() => null)
    this.deps.setGitStatus(dir, status)
    const gitCtx = tabGitContextFromStatus(status)
    const session = this.deps.registry.sessionFor(tabId)
    if (session && !session.gitContext?.worktreePath) {
      session.gitContext = gitCtx
      if (this.deps.settings.worktreeEnabled && !session.worktreeBaseBranch) {
        session.worktreeBaseBranch = gitCtx?.targetBranch ?? null
      }
    }
  }

  recomputeChangedFiles(tabId: string): void {
    const session = this.deps.registry.sessionFor(tabId)
    if (!session) return
    session.changedFiles.splice(0, session.changedFiles.length, ...extractChangedFilePaths(session.messages))
  }

  /**
   * Incremental changed-files update for a single just-completed tool message.
   * Unions its paths into the session's existing list instead of rescanning and
   * re-parsing every historical Write/Edit body. The full-scan recomputeChangedFiles
   * still runs at turn boundaries (task_complete) and on hydration to reconcile.
   */
  addChangedFilesFromMessage(tabId: string, message: Message): void {
    const session = this.deps.registry.sessionFor(tabId)
    if (!session) return
    for (const path of extractChangedFilePathsFromMessage(message)) {
      if (!session.changedFiles.includes(path)) session.changedFiles.push(path)
    }
  }

  async expandHistory(tabId: string): Promise<void> {
    const session = this.deps.registry.sessionFor(tabId)
    if (!session?.agentSessionId || !session.historyTruncated) return
    const displayCwd = session.workingDirectory
    const loadPath = session.gitContext?.worktreePath || displayCwd
    const provider = (session.provider ?? this.deps.settings.activeAgent) as AgentId
    const transcript = await this.deps.loadTranscript({
      sessionId: session.agentSessionId,
      loadPath,
      displayCwd,
      provider,
      ctx: this.deps.ctxFor(tabId),
    })
    const s = this.deps.registry.sessionFor(tabId)
    if (!s || transcript.messages.length === 0) return
    s.messages.splice(0, s.messages.length, ...transcript.messages)
    s.progress = transcript.progress
    s.historyTruncated = false
    this.recomputeChangedFiles(tabId)
    for (const planId of transcript.planIds) void this.deps.planStore.hydrateAnnotations(planId)
  }

  async hydrateChangedFilesFromDiff(tabId: string): Promise<void> {
    const session = this.deps.registry.sessionFor(tabId)
    if (!session?.agentSessionId || session.changedFiles.length > 0) return
    try {
      const diff = await window.solus.diff(this.deps.ctxFor(tabId), { scope: { kind: 'session' } })
      const files = diff ? parsePatchFiles(diff.patch).flatMap((patch) => patch.files.map((file) => file.name)) : []
      if (files.length === 0) return
      session.changedFiles.splice(0, session.changedFiles.length, ...files)
    } catch {
      /* best-effort; transcript-derived changed files remain the source of truth */
    }
  }

  async refreshTurnSnapshots(tabId: string): Promise<void> {
    const session = this.deps.registry.sessionFor(tabId)
    if (!session?.agentSessionId) return
    try {
      const snaps = await window.solus.listTurnSnapshots(this.deps.ctxFor(tabId))
      this.turnSnapshots[tabId] = snaps
    } catch {
      /* best-effort */
    }
  }

  reconcileQueuedPrompts(tabId: string, queuedPrompts: QueuedPromptSnapshot[]): void {
    const session = this.deps.registry.sessionFor(tabId)
    if (!session) return
    reconcileQueuedPromptsForSession(session, queuedPrompts)
  }

  /** Drop a closed tab's cached turn snapshots so the map can't grow unbounded. */
  disposeTab(tabId: string): void {
    if (tabId in this.turnSnapshots) delete this.turnSnapshots[tabId]
  }
}
