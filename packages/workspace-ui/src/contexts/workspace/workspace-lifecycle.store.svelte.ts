import type { WireSessionLoadMessage } from '@solus/contracts/session-history'
import { NEW_CHAT_DIRECTORY } from '@solus/contracts/chat'
import { isSessionBusyStatus, type AgentId, type AgentMetadata, type IpcContext, type Message, type QueuedPromptSnapshot, type RunConfig, type Session, type StartInfo, type TurnSnapshot } from '@solus/contracts/types'
import type { GitRefreshResult } from '../git/session-environment.store.svelte'
import { loadCachedStart, saveCachedStart } from './tab-persistence'
import { extractChangedFilePaths, extractChangedFilePathsFromMessage } from '../../lib/changedFiles'
import { hasSessionStarted } from '../../lib/sessionUtils'
import type { AgentContext } from '../app/agent.context.svelte'
import type { PlanStore } from '../plans/plan.store.svelte'
import type { SessionConfigController } from './session-config.svelte'
import { OLDER_HISTORY_TURNS } from '@solus/client-core/session-history-page'
import { reconcileQueuedPromptsForSession } from './session-transcript'
import type { SettingsContext } from '../app/settings.context.svelte'
import type { TabRegistry } from './tab-registry.svelte'
import type { SessionRecords } from './session-records.svelte'
import { TransportDisconnectedError } from '@solus/client-core/ws-transport'
import type { HostApi } from '@solus/client-core/host-api'
import { hosts } from '../hosts/hosts.svelte'

export interface WorkspaceLifecycleStoreDeps {
  registry: TabRegistry
  sessions: SessionRecords
  settings: SettingsContext
  config: SessionConfigController
  planStore: PlanStore
  agent?: AgentContext
  /** Where work happens when no run is in play — `WorkspaceContext.defaultRunConfig`. */
  defaultRunConfig(): RunConfig
  /** The runs of everything that has begun nothing — unstarted tabs and every
   *  open draft. What the agent demotion retargets: nothing has happened in
   *  them yet to disturb. */
  unstartedRuns(): RunConfig[]
  refreshGitState(opts?: { sourceId?: string; cwd?: string; force?: boolean }): Promise<GitRefreshResult>
  ctxFor(tabId: string): IpcContext
  apiFor(tabId: string): HostApi
  /** The host `apiFor` answers with, by name: plugin commands are read only from a machine. */
  serverIdFor(tabId: string): string
  loadTranscript(args: {
    sessionId: string
    loadPath: string
    displayCwd: string
    provider: AgentId
    ctx: IpcContext
    turnLimit?: number
    before?: string
    pendingMessages?: WireSessionLoadMessage[]
  }): Promise<{ messages: Session['messages']; progress: Session['progress']; planIds: string[]; truncated?: boolean; before?: string | null; pendingMessages?: WireSessionLoadMessage[] }>
  rebuildAgentConversations(session: Session): void
}

export class WorkspaceLifecycleStore {
  pluginCommands = $state<Session['pluginCommands']>({ global: [], project: [] })
  turnSnapshots = $state<Record<string, TurnSnapshot[]>>({})
  /** True until materializeTabs has rebuilt the persisted tabs into memory; prevents
   *  the persist effect from clobbering the saved snapshot with empty initial state. */
  hydrating = $state(true)

  // Non-reactive guards: callers share an in-flight initialization, and a failed
  // connection attempt remains retryable after the transport reconnects.
  /** The Run on host whose agents the agent list shows; a new Run on host reads again. */
  private agentsServerId: string | null = null
  private agentsInitialization: Promise<void> | null = null
  private pluginCommandRequestSequence = 0
  private pluginCommandRequests = new Map<string, number>()
  /** The provider and directory a session's commands were last read for, so a
   *  tab switch back to it does not read the same list again. */
  private pluginCommandSources = new WeakMap<Session, string>()
  /** Reads still on the wire, by request key. Boot asks for the active tab's
   *  commands from three places within a frame; the later asks join the first.
   *  A skill edit that lands while an identical read is in flight is caught by
   *  the next read, which every later open or switch makes. */
  private pluginCommandInflight = new Map<string, { source: string; promise: Promise<void> }>()
  private historyExpansions = new Map<string, Promise<void>>()
  /** The window a session had before its first older page was prepended: the
   *  message that opened it and the cursor that read the page before it. The
   *  host cursor is opaque, so this is the only way back to that window. */
  private restoredWindows = new WeakMap<Session, {
    firstMessageId: string
    cursor: string
    pendingMessages: Session['historyPendingMessages']
  }>()

  constructor(private deps: WorkspaceLifecycleStoreDeps) {}

  /**
   * Drop the older pages a reader scrolled into, back to the window the tab
   * was restored with. The pool calls this when a conversation unmounts, so a
   * hidden tab does not hold a long history in memory; scrolling up reads it
   * again. A running session keeps everything: its turn may reach back.
   */
  releaseOlderHistory(tabId: string): void {
    const session = this.deps.registry.sessionFor(tabId)
    if (!session || isSessionBusyStatus(session.status)) return
    const restored = this.restoredWindows.get(session)
    if (!restored || session.historyCursor === restored.cursor) return
    const start = session.messages.findIndex((message) => message.id === restored.firstMessageId)
    if (start <= 0) return
    session.messages.splice(0, start)
    session.historyCursor = restored.cursor
    session.historyPendingMessages = restored.pendingMessages
    session.historyTruncated = true
    this.restoredWindows.delete(session)
    this.deps.rebuildAgentConversations(session)
  }

  /**
   * Show a host's agents in the agent list. The list is the Run on host's by
   * decision (`AgentContext`, docs/plans/host-model.md). The active-agent
   * availability demotion is FRESH-only: a stale cache could wrongly demote an
   * agent whose availability has since recovered, so the optimistic path never
   * touches the active agent.
   */
  private applyAgents(result: StartInfo, opts: { fresh: boolean }): void {
    this.deps.agent?.hydrate(result.agents ?? [])
    if (opts.fresh) this.followAvailableAgent(result.agents ?? [])
  }

  /**
   * Move the default agent off one this host cannot run, and carry that move
   * into the work that has not begun. The seeded composer is built from the
   * saved preference before this payload lands, so on a host with only one
   * agent installed it would keep pointing at the other one and fail at the
   * first prompt.
   */
  private followAvailableAgent(agents: AgentMetadata[]): void {
    const isAvailable = (agentId: AgentId): boolean =>
      agents.some((agent) => agent.id === agentId && agent.available)
    if (isAvailable(this.deps.settings.activeAgent)) return
    const fallback = agents.find((agent) => agent.available)
    if (!fallback) return
    this.deps.config.followActiveSessionAgent(fallback.id)
    const modelConfig = this.deps.config.defaultModelConfigFor(fallback.id)
    for (const run of this.deps.unstartedRuns()) {
      // A run with no provider reads the default at send, so the settings move
      // above already answers for it.
      if (!run.provider || isAvailable(run.provider)) continue
      run.provider = fallback.id
      run.modelConfig = { ...modelConfig }
    }
  }

  /** Tabs that have begun nothing: composers, which the workspace is free to
   *  retarget because there is no conversation in them to disturb. */
  private unstartedTabIds(): string[] {
    return this.deps.registry.tabOrder.filter(
      (tabId) => !hasSessionStarted(this.deps.registry.sessionFor(tabId)),
    )
  }

  /**
   * Optimistically show the Run on host's last cached agents before first
   * paint, with no server round trip. Idempotent: once the list has a host's
   * agents this is a no-op. The fresh read happens in `readRunOnAgents`.
   */
  hydrateAgentsFromCache(): void {
    if (this.agentsServerId !== null || (this.deps.agent?.agents.length ?? 0) > 0) return
    const host = hosts.runOn
    const cached = host ? loadCachedStart(host.id) : null
    if (cached) this.applyAgents(cached, { fresh: false })
  }

  /**
   * Read the Run on host's machine facts and show its agents. A window with no
   * machine yet — the account origin before any machine connects — reads
   * nothing and paints from the cache; the runtime calls this again as machines
   * connect, and a Run on host that changed is read again.
   */
  async readRunOnAgents(): Promise<void> {
    const host = hosts.runOn
    if (!host || host.id === this.agentsServerId) return
    if (this.agentsInitialization) return this.agentsInitialization

    const initialization = (async () => {
      // Paint from cache first (safety net if setup didn't already), then reconcile.
      this.hydrateAgentsFromCache()
      // Resolve startup defaults first, then read the selected checkout once.
      // Other startup consumers may already have registered its live watcher.
      const coldLoad = this.unstartedTabIds().length === this.deps.registry.tabOrder.length
      const result = await host.when('machine')
      this.applyAgents(result, { fresh: true })
      saveCachedStart(host.id, result)
      if (coldLoad) {
        await this.deps.refreshGitState({ force: false })
      }
      const commandDirectory = this.deps.registry.activeSession?.run.workingDirectory
        ?? this.deps.defaultRunConfig().workingDirectory
      void this.refreshPluginCommands(commandDirectory).catch((error) => {
        if (!(error instanceof TransportDisconnectedError)) {
          console.error('getPluginCommands failed', error)
        }
      })
    })()
    this.agentsInitialization = initialization

    try {
      await initialization
      this.agentsServerId = host.id
    } finally {
      if (this.agentsInitialization === initialization) this.agentsInitialization = null
    }
  }

  /**
   * Re-reads the Run on host's machine facts so agent availability probed at
   * boot does not survive as a stale answer. Misses are never cached
   * server-side, so this re-probes any binary the boot-time check failed to
   * find — an agent installed or repaired during onboarding reads as available
   * without a relaunch.
   */
  async refreshAgentAvailability(): Promise<void> {
    const host = hosts.runOn
    if (!host) return
    await host.refresh('machine')
    const result = await host.when('machine')
    this.applyAgents(result, { fresh: true })
    saveCachedStart(host.id, result)
    this.agentsServerId = host.id
  }

  /**
   * Read the slash commands a directory offers the session's provider. With
   * `onlyIfStale`, a session whose commands were already read for this provider
   * and directory keeps them: selecting a tab is not a reason to ask again.
   * Skill edits and agent switches refresh without the flag.
   */
  async refreshPluginCommands(workingDirectory: string, tabId?: string, opts: { onlyIfStale?: boolean } = {}): Promise<void> {
    const targetTabId = tabId ?? this.deps.registry.activeTabId
    // Slash commands are a checkout's; a run that names no machine (the account
    // origin before one connects) falls to the workspace service, which has none.
    if (!hosts.hasExecution(this.deps.serverIdFor(targetTabId))) return
    const targetSession = this.deps.registry.sessionFor(targetTabId)
    const provider = targetSession?.run.provider ?? this.deps.settings.activeAgent
    const source = `${provider}\0${workingDirectory}`
    if (opts.onlyIfStale && targetSession && this.pluginCommandSources.get(targetSession) === source) {
      if (this.deps.registry.activeTabId === targetTabId) this.pluginCommands = targetSession.pluginCommands
      return
    }
    const requestKey = targetSession ? targetTabId : ''
    const inflight = this.pluginCommandInflight.get(requestKey)
    if (inflight?.source === source) return inflight.promise
    const promise = this.readPluginCommands(requestKey, targetTabId, targetSession, provider, workingDirectory, source)
      .finally(() => {
        if (this.pluginCommandInflight.get(requestKey)?.promise === promise) this.pluginCommandInflight.delete(requestKey)
      })
    this.pluginCommandInflight.set(requestKey, { source, promise })
    return promise
  }

  private async readPluginCommands(
    requestKey: string,
    targetTabId: string,
    targetSession: Session | undefined,
    provider: AgentId,
    workingDirectory: string,
    source: string,
  ): Promise<void> {
    const requestSequence = ++this.pluginCommandRequestSequence
    this.pluginCommandRequests.set(requestKey, requestSequence)
    const ctx = this.deps.ctxFor(targetTabId)
    ctx.session.provider = provider
    // A new chat has no folder yet, so it reads the commands every folder has.
    const directory = workingDirectory === NEW_CHAT_DIRECTORY ? '~' : workingDirectory
    if (directory !== workingDirectory) ctx.session.workingDirectory = ctx.session.projectPath = directory
    const result = await this.deps.apiFor(targetTabId)
      .getPluginCommands(directory, $state.snapshot(ctx))
    if (this.pluginCommandRequests.get(requestKey) !== requestSequence) return

    if (targetSession) {
      const currentSession = this.deps.registry.sessionFor(targetTabId)
      if (currentSession !== targetSession || currentSession.run.workingDirectory !== workingDirectory) return
      currentSession.pluginCommands = result
      this.pluginCommandSources.set(currentSession, source)
      if (this.deps.registry.activeTabId === targetTabId) this.pluginCommands = result
      return
    }

    if (this.deps.registry.activeSession) return
    if (this.deps.defaultRunConfig().workingDirectory !== workingDirectory) return
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
    const session = this.deps.sessions.byId[sessionId]
    if (!session) return
    for (const path of extractChangedFilePathsFromMessage(message)) {
      if (!session.sessionChangedFiles.includes(path)) session.sessionChangedFiles.push(path)
    }
  }

  /**
   * Bring older turns into the transcript, one page at a time. The default
   * reads one page for scrolling. `full` reads every remaining page, only for
   * an explicit operation that needs it, such as Find or reveal-all.
   */
  async expandHistory(tabId: string, opts?: { full?: boolean }): Promise<void> {
    const existing = this.historyExpansions.get(tabId)
    if (existing) {
      // A page already in flight is not the full history an explicit operation
      // asked for, so wait it out and then read the rest.
      await existing
      if (!opts?.full) return
    }
    const target = this.deps.registry.sessionFor(tabId)
    const expansion = (async () => {
      do {
        await this.expandHistoryOnce(tabId)
      } while (opts?.full && target === this.deps.registry.sessionFor(tabId)
        && target?.historyTruncated && target.historyCursor != null)
    })()
    this.historyExpansions.set(tabId, expansion)
    try {
      await expansion
    } finally {
      if (this.historyExpansions.get(tabId) === expansion) this.historyExpansions.delete(tabId)
    }
  }

  private async prependHistoryPage(tabId: string, session: Session, agentSessionId: string, before: string): Promise<void> {
    const transcript = await this.deps.loadTranscript({
      sessionId: session.id,
      loadPath: session.run.gitContext?.worktreePath || session.run.workingDirectory,
      displayCwd: session.run.workingDirectory,
      provider: session.run.provider ?? this.deps.settings.activeAgent,
      ctx: this.deps.ctxFor(tabId), turnLimit: OLDER_HISTORY_TURNS, before,
      pendingMessages: session.historyPendingMessages,
    })
    if (this.deps.registry.sessionFor(tabId) !== session
      || session.agentSessionId !== agentSessionId || session.historyCursor !== before) return
    if (transcript.before === before) throw new Error('History paging made no progress.')
    const firstMessageId = session.messages[0]?.id
    if (!this.restoredWindows.has(session) && firstMessageId) {
      this.restoredWindows.set(session, {
        firstMessageId, cursor: before, pendingMessages: session.historyPendingMessages,
      })
    }
    // Pages are disjoint. Timestamp-based deduplication could discard two
    // distinct messages that share a provider timestamp.
    const older = transcript.messages
    for (let end = older.length; end > 0; end -= 1000) {
      session.messages.unshift(...older.slice(Math.max(0, end - 1000), end))
    }
    session.historyCursor = transcript.before ?? null
    session.historyPendingMessages = transcript.pendingMessages
    session.historyTruncated = session.historyCursor !== null
    this.deps.rebuildAgentConversations(session)
    this.recomputeChangedFiles(tabId)
    for (const planId of transcript.planIds) void this.deps.planStore.hydrateAnnotations(planId)
  }

  private async expandHistoryOnce(tabId: string): Promise<void> {
    const session = this.deps.registry.sessionFor(tabId)
    if (!session?.agentSessionId || !session.historyTruncated || session.historyCursor == null) return
    return this.prependHistoryPage(tabId, session, session.agentSessionId, session.historyCursor)
  }

  async hydrateChangedFilesFromDiff(tabId: string): Promise<void> {
    const session = this.deps.registry.sessionFor(tabId)
    if (!session?.agentSessionId || session.sessionChangedFiles.length > 0) return
    try {
      const stats = await this.deps.apiFor(tabId)
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
    const session = this.deps.sessions.byId[sessionId]
    if (!session?.agentSessionId) return
    const tabId = this.deps.registry.tabIdsBySession.get(sessionId)?.[0]
    if (!tabId) return
    try {
      const snaps = await this.deps.apiFor(tabId)
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
