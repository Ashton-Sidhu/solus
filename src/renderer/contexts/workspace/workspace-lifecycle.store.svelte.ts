import { type AgentId, type IpcContext, type Message, type QueuedPromptSnapshot, type Session, type StartInfo, type TurnSnapshot } from '../../../shared/types'
import type { GitRefreshResult } from '../git/session-environment.store.svelte'
import { loadCachedStart, saveCachedStart } from './tab-persistence'
import { extractChangedFilePaths, extractChangedFilePathsFromMessage } from '../../lib/changedFiles'
import { hasSessionStarted } from '../../lib/sessionUtils'
import type { AgentContext } from '../app/agent.context.svelte'
import type { PlanStore } from '../plans/plan.store.svelte'
import type { SessionConfigController } from './session-config.svelte'
import { reconcileQueuedPromptsForSession, RESTORED_TRANSCRIPT_LIMIT } from './session-transcript'
import { progressFromMessages } from './session.utils'
import type { SettingsContext } from '../app/settings.context.svelte'
import type { TabRegistry } from './tab-registry.svelte'
import { TransportDisconnectedError } from '@client-core/ws-transport'

/** Raw messages added per automatic backfill round. Matches the initial restore
 *  window, so filling an empty viewport costs the same read that opened it. */
const HISTORY_PAGE_LIMIT = RESTORED_TRANSCRIPT_LIMIT

export function startDirectoryForServer(result: StartInfo): string {
  return result.workspacePath || result.projectPath || '~'
}

export interface StaticInfo {
  version: string
  email: string | null
  subscriptionType: string | null
  projectPath: string
  homePath: string
  workspacePath: string
}

export interface WorkspaceLifecycleStoreDeps {
  registry: TabRegistry
  settings: SettingsContext
  config: SessionConfigController
  planStore: PlanStore
  agent?: AgentContext
  refreshGitState(opts?: { sourceId?: string; cwd?: string }): Promise<GitRefreshResult>
  ctxFor(tabId: string): IpcContext
  apiFor?(tabId: string): typeof window.solus
  loadTranscript(args: {
    sessionId: string
    loadPath: string
    displayCwd: string
    provider: AgentId
    ctx: IpcContext
    limit?: number
  }): Promise<{ messages: Session['messages']; progress: Session['progress']; planIds: string[]; truncated?: boolean }>
  rebuildAgentConversations(session: Session): void
}

function expandedMessageKey(message: Message): string {
  const stableId = message.toolId ?? message.planToolUseId ?? ''
  return `${message.role}\0${message.timestamp}\0${stableId}`
}

/** Keep live objects/updates that landed while a full-history RPC was running. */
export function reconcileExpandedHistory(
  loaded: Session['messages'],
  current: Session['messages'],
): Session['messages'] {
  const reconciled = [...loaded]
  const loadedIndexByKey = new Map<string, number>()
  for (let index = 0; index < reconciled.length; index++) {
    loadedIndexByKey.set(expandedMessageKey(reconciled[index]), index)
  }
  for (const message of current) {
    const key = expandedMessageKey(message)
    const loadedIndex = loadedIndexByKey.get(key)
    if (loadedIndex === undefined) {
      loadedIndexByKey.set(key, reconciled.length)
      reconciled.push(message)
    } else {
      // Prefer the existing reactive object: it may contain a streaming suffix,
      // a just-completed tool result, or nested sub-agent state newer than disk.
      reconciled[loadedIndex] = message
    }
  }
  return reconciled
}

export class WorkspaceLifecycleStore {
  staticInfo = $state<StaticInfo | null>(null)
  pluginCommands = $state<Session['pluginCommands']>({ global: [], project: [] })
  turnSnapshots = $state<Record<string, TurnSnapshot[]>>({})
  /** True until materializeTabs has rebuilt the persisted tabs into memory; prevents
   *  the persist effect from clobbering the saved snapshot with empty initial state. */
  hydrating = $state(true)
  /** True while a seq-reset recovery is re-registering tabs and re-binding sessions. */
  runtimeSyncing = $state(false)

  // Non-reactive guards: callers share an in-flight initialization, and a failed
  // connection attempt remains retryable after the transport reconnects.
  private staticInfoInitialized = false
  private staticInfoInitialization: Promise<void> | null = null
  private appliedStartDirectory: string | null = null
  private pluginCommandRequestSequence = 0
  private pluginCommandRequests = new Map<string, number>()
  private historyExpansions = new Map<string, Promise<void>>()
  /** Widest raw-message window already pulled for an agent session, so each paged
   *  expansion asks for strictly more than the last one did. Keyed by agent session
   *  id rather than tab: a tab outlives the session that was resumed into it. */
  private historyWindowLimits = new Map<string, number>()

  constructor(private deps: WorkspaceLifecycleStoreDeps) {}

  /**
   * Apply a start() payload to staticInfo + agent metadata + the workingDirectory
   * default. The active-agent availability demotion is FRESH-only: a stale cache
   * could wrongly demote an agent whose availability has since recovered, so the
   * optimistic path never touches the active agent.
   */
  private applyStartInfo(result: StartInfo, opts: { fresh: boolean }): void {
    const startDirectory = startDirectoryForServer(result)
    const currentDirectory = this.deps.config.globalDefaults.workingDirectory
    // "Nothing has begun yet", which is what makes the default still free to
    // move — not "no tabs". The workspace seeds a composer before this payload
    // lands, and a composer is exactly a tab that has begun nothing.
    const canReconcileCachedDefault = this.unstartedTabIds().length === this.deps.registry.tabOrder.length
      && currentDirectory === this.appliedStartDirectory
    this.staticInfo = {
      version: result.version || 'unknown',
      email: result.auth?.email || null,
      subscriptionType: result.auth?.subscriptionType || null,
      projectPath: result.projectPath || '~',
      homePath: result.homePath || '~',
      workspacePath: result.workspacePath || '~',
    }
    if (currentDirectory === '~' || canReconcileCachedDefault) {
      this.deps.config.globalDefaults.workingDirectory = startDirectory
      this.followDefaultDirectory(currentDirectory, startDirectory)
    }
    this.appliedStartDirectory = startDirectory
    this.deps.agent?.hydrate(result.agents ?? [])
    if (opts.fresh && !this.deps.agent?.metadata[this.deps.settings.activeAgent]?.available) {
      const fallback = result.agents?.find((agent) => agent.available)
      if (fallback) this.deps.settings.update({ activeAgent: fallback.id })
    }
  }

  /**
   * Optimistically apply the last cached start() payload so staticInfo, agent
   * metadata, and the workingDirectory default are ready before first paint —
   * no server round trip. Idempotent: once staticInfo exists (cache or fresh)
   * this is a no-op. Fresh reconciliation happens in initStaticInfo.
   */
  /** Tabs that have begun nothing: composers, which the workspace is free to
   *  retarget because there is no conversation in them to disturb. */
  private unstartedTabIds(): string[] {
    return this.deps.registry.tabOrder.filter(
      (tabId) => !hasSessionStarted(this.deps.registry.sessionFor(tabId)),
    )
  }

  /**
   * The seeded composer is built from the cached start payload, so when the
   * fresh one names a different directory it would otherwise sit on a project
   * the app is no longer pointed at — most visibly on a first run, where the
   * cache says `~`. It is showing the default rather than a choice anyone made,
   * so it follows the default.
   */
  private followDefaultDirectory(from: string, to: string): void {
    if (from === to) return
    for (const tabId of this.unstartedTabIds()) {
      const session = this.deps.registry.sessionFor(tabId)
      if (!session || session.run.workingDirectory !== from) continue
      session.run.workingDirectory = to
      session.run.gitContext = null
      void this.deps.refreshGitState({ sourceId: tabId }).catch(() => null)
    }
  }

  hydrateStaticInfoFromCache(): void {
    if (this.staticInfo) return
    const cached = loadCachedStart()
    if (cached) this.applyStartInfo(cached, { fresh: false })
  }

  async initStaticInfo(): Promise<void> {
    if (this.staticInfoInitialized) return
    if (this.staticInfoInitialization) return this.staticInfoInitialization

    const initialization = (async () => {
      // Paint from cache first (safety net if setup didn't already), then reconcile.
      this.hydrateStaticInfoFromCache()
      // Same reading as the reconcile above: a workspace holding nothing but
      // composers is a cold load, and is the case worth pre-warming Git for.
      const coldLoad = this.unstartedTabIds().length === this.deps.registry.tabOrder.length
      const optimisticEnvironmentRefresh = coldLoad
        ? this.deps.refreshGitState().catch(() => null)
        : null
      const result = await window.solus.start()
      this.applyStartInfo(result, { fresh: true })
      saveCachedStart(result)
      if (coldLoad) {
        await optimisticEnvironmentRefresh
        await this.deps.refreshGitState()
      }
      const commandDirectory = this.deps.registry.activeSession?.run.workingDirectory
        ?? this.deps.config.globalDefaults.workingDirectory
      void this.refreshPluginCommands(commandDirectory).catch((error) => {
        if (!(error instanceof TransportDisconnectedError)) {
          console.error('getPluginCommands failed', error)
        }
      })
    })()
    this.staticInfoInitialization = initialization

    try {
      await initialization
      this.staticInfoInitialized = true
    } finally {
      if (this.staticInfoInitialization === initialization) this.staticInfoInitialization = null
    }
  }

  async refreshPluginCommands(workingDirectory: string, tabId?: string): Promise<void> {
    const targetTabId = tabId ?? this.deps.registry.activeTabId
    const targetSession = this.deps.registry.sessionFor(targetTabId)
    const requestKey = targetSession ? targetTabId : ''
    const requestSequence = ++this.pluginCommandRequestSequence
    this.pluginCommandRequests.set(requestKey, requestSequence)
    const ctx = this.deps.ctxFor(targetTabId)
    ctx.session.provider = (targetSession?.run.provider ?? this.deps.settings.activeAgent) as AgentId
    const result = await (this.deps.apiFor?.(targetTabId) ?? window.solus)
      .getPluginCommands(workingDirectory, $state.snapshot(ctx))
    if (this.pluginCommandRequests.get(requestKey) !== requestSequence) return

    if (targetSession) {
      const currentSession = this.deps.registry.sessionFor(targetTabId)
      if (currentSession !== targetSession || currentSession.run.workingDirectory !== workingDirectory) return
      currentSession.pluginCommands = result
      if (this.deps.registry.activeTabId === targetTabId) this.pluginCommands = result
      return
    }

    if (this.deps.registry.activeSession) return
    if (this.deps.config.globalDefaults.workingDirectory !== workingDirectory) return
    this.pluginCommands = result
  }

  recomputeChangedFiles(tabId: string): void {
    const session = this.deps.registry.sessionFor(tabId)
    if (!session) return
    session.sessionChangedFiles.splice(0, session.sessionChangedFiles.length, ...extractChangedFilePaths(session.messages))
  }

  /**
   * Incremental changed-files update for a single just-completed tool message.
   * Unions its paths into the session's existing list instead of rescanning and
   * re-parsing every historical Write/Edit body. Transcript hydration still uses
   * the full scan; the backend publishes authoritative net paths at turn completion.
   */
  addChangedFilesFromMessage(sessionId: string, message: Message): void {
    const session = this.deps.registry.sessions[sessionId]
    if (!session) return
    for (const path of extractChangedFilePathsFromMessage(message)) {
      if (!session.sessionChangedFiles.includes(path)) session.sessionChangedFiles.push(path)
    }
  }

  /**
   * Bring older messages into the transcript. `paged` widens the window by one
   * page; without it the whole remaining transcript is read. Only a deliberate
   * user gesture — scrolling to the top, Find, reveal-all — is worth reading a
   * long session end to end, so automatic backfill pages instead.
   */
  async expandHistory(tabId: string, opts?: { paged?: boolean }): Promise<void> {
    const existing = this.historyExpansions.get(tabId)
    if (existing) {
      // A page already in flight is not the full history a user gesture asked
      // for, so wait it out and then read the rest.
      await existing
      if (opts?.paged) return
    }
    const expansion = this.expandHistoryOnce(tabId, opts?.paged ?? false)
    this.historyExpansions.set(tabId, expansion)
    try {
      await expansion
    } finally {
      if (this.historyExpansions.get(tabId) === expansion) this.historyExpansions.delete(tabId)
    }
  }

  private async expandHistoryOnce(tabId: string, paged: boolean): Promise<void> {
    const session = this.deps.registry.sessionFor(tabId)
    if (!session?.agentSessionId || !session.historyTruncated) return
    const agentSessionId = session.agentSessionId
    // Grow off the previous window rather than the rendered message count: a
    // page of tool results can collapse into no new rows, and the next request
    // still has to reach further back or the caller loops forever.
    const previousLimit = this.historyWindowLimits.get(agentSessionId) ?? RESTORED_TRANSCRIPT_LIMIT
    const limit = paged ? previousLimit + HISTORY_PAGE_LIMIT : undefined
    const handoffFrom = session.handoffFrom ? { ...session.handoffFrom } : undefined
    const displayCwd = session.run.workingDirectory
    const loadPath = session.run.gitContext?.worktreePath || displayCwd
    const provider = (session.run.provider ?? this.deps.settings.activeAgent) as AgentId
    const predecessorTranscript = handoffFrom
      ? await this.deps.loadTranscript({
          sessionId: handoffFrom.sessionId,
          loadPath,
          displayCwd,
          provider: handoffFrom.provider,
          ctx: this.deps.ctxFor(tabId),
          limit,
        })
      : null
    const transcript = await this.deps.loadTranscript({
      sessionId: agentSessionId,
      loadPath,
      displayCwd,
      provider,
      ctx: this.deps.ctxFor(tabId),
      limit,
    })
    const s = this.deps.registry.sessionFor(tabId)
    if (
      s !== session ||
      s.agentSessionId !== agentSessionId ||
      s.handoffFrom?.sessionId !== handoffFrom?.sessionId ||
      s.handoffFrom?.provider !== handoffFrom?.provider
    ) return
    const loadedMessages = [
      ...(predecessorTranscript?.messages ?? []),
      ...transcript.messages,
    ]
    if (loadedMessages.length === 0) return
    const reconciled = reconcileExpandedHistory(loadedMessages, s.messages)
    s.messages.splice(0, s.messages.length, ...reconciled)
    this.deps.rebuildAgentConversations(s)
    s.progress = handoffFrom ? progressFromMessages(reconciled) : transcript.progress
    s.historyTruncated = !!predecessorTranscript?.truncated || !!transcript.truncated
    if (limit && s.historyTruncated) this.historyWindowLimits.set(agentSessionId, limit)
    else this.historyWindowLimits.delete(agentSessionId)
    this.recomputeChangedFiles(tabId)
    for (const planId of [...(predecessorTranscript?.planIds ?? []), ...transcript.planIds]) {
      void this.deps.planStore.hydrateAnnotations(planId)
    }
  }

  async hydrateChangedFilesFromDiff(tabId: string): Promise<void> {
    const session = this.deps.registry.sessionFor(tabId)
    if (!session?.agentSessionId || session.sessionChangedFiles.length > 0) return
    try {
      const stats = await (this.deps.apiFor?.(tabId) ?? window.solus)
        .diffStats(this.deps.ctxFor(tabId), { scope: { kind: 'session' } })
      const files = stats.map((file) => file.path)
      if (files.length === 0) return
      session.sessionChangedFiles.splice(0, session.sessionChangedFiles.length, ...files)
    } catch {
      /* best-effort; transcript-derived changed files remain the source of truth */
    }
  }

  /** A session's checkpointed turns. Keyed by session, not by tab: two views of
   *  one conversation are looking at the same turns and must not fetch or cache
   *  them twice. */
  async refreshTurnSnapshots(sessionId: string): Promise<void> {
    const session = this.deps.registry.sessions[sessionId]
    if (!session?.agentSessionId) return
    const tabId = this.deps.registry.tabIdsBySession.get(sessionId)?.[0]
    if (!tabId) return
    try {
      const snaps = await (this.deps.apiFor?.(tabId) ?? window.solus)
        .listTurnSnapshots(this.deps.ctxFor(tabId))
      this.turnSnapshots[sessionId] = snaps
    } catch {
      /* best-effort */
    }
  }

  reconcileQueuedPrompts(tabId: string, queuedPrompts: QueuedPromptSnapshot[]): void {
    const session = this.deps.registry.sessionFor(tabId)
    if (!session) return
    reconcileQueuedPromptsForSession(session, queuedPrompts)
  }

  /** Drop a gone session's cached turn snapshots so the map can't grow
   *  unbounded. Called once the last tab watching it has closed. */
  disposeSession(sessionId: string): void {
    if (sessionId in this.turnSnapshots) delete this.turnSnapshots[sessionId]
  }
}
