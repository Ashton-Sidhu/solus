import { materializeStartupTranscript } from './startup-session'
import { NEW_CHAT_DIRECTORY } from '@solus/contracts/chat'
import { afterPaint } from '../../lib/after-paint'
import { markStartupTranscriptApplied } from './startup-transcript'
import { INITIAL_HISTORY_TURNS, requestSessionHistoryPage } from '@solus/client-core/session-history-page'
import { defaultContextWindowFor, isSessionBusyStatus, PERMISSION_MODES, type Message, type ModelConfig, type RunConfig, type Session, type SessionMeta } from '@solus/contracts/types'
import { loadServers } from '@solus/client-core/server-registry'
import { makePrompt, makeSession, makeTab } from './session.factories'
import { taskTargetFrom } from './session-draft.svelte'
import { loadRestoredSessionTranscript } from './session-transcript'
import { applyRuntimeConfig, nextMsgId } from './session.utils'
import { initDraftState, loadCachedStart, loadDrafts, loadPersistedSessionDrafts, loadPersistedTabs, type PersistedTab, type PersistedTabs, type TabDrafts } from './tab-persistence'
import type { WorkspaceContext } from './workspace.context.svelte'
import { readSessionMeta } from '@solus/client-core/session-meta'
import { serverConnections } from '@solus/client-core/server-connections'
import { hosts } from '../hosts/hosts.svelte'
import { loadSessionRecordTranscript } from '../sessions/session-record-transcript'
import { GONE_MACHINE_READ_ONLY_REASON, savedHostsAreAuthoritative } from './machine-references'
import { z } from 'zod'
import { AUTO_MODEL_ID } from '@solus/contracts/model-routing'

const permissionModeSchema = z.enum(PERMISSION_MODES).catch('full-access')

interface RestoredHydrationState {
  pending: Map<string, PersistedTab>
  running: Map<string, Promise<void>>
  hasStartedMetadataReads: boolean
}

interface RestoredWorkspaceState {
  snapshot: PersistedTabs | null
  hydration: RestoredHydrationState | null
}

/** One restore record per workspace. The snapshot guards synchronous
 * materialization; hydration owns all later startup, selection, and retry work. */
const restorations = new WeakMap<WorkspaceContext, RestoredWorkspaceState>()

/** History hydration replaces the provider transcript wholesale. Preserve an
 * activity row (an agent switch, a decision) that arrived live while a restored
 * tab was still loading: it is newer than the transcript request and would
 * otherwise disappear until the next reload. */
export function replaceHydratedMessages(session: Pick<Session, 'messages'>, hydrated: Message[]): void {
  const hydratedIds = new Set(hydrated.map((message) => message.id))
  const newestHydrated = hydrated.at(-1)?.timestamp ?? -Infinity
  const liveActivity = session.messages.filter((message) =>
    message.activity && !hydratedIds.has(message.id) && message.timestamp >= newestHydrated)
  session.messages.splice(0, session.messages.length, ...hydrated, ...liveActivity)
}

async function hydrateRestoredTab(
  ctx: WorkspaceContext,
  state: RestoredHydrationState,
  tabId: string,
): Promise<void> {
  const snapTab = state.pending.get(tabId)
  if (!snapTab) return
  const existing = state.running.get(tabId)
  if (existing) return existing

  const hydration = hydrateTab(ctx, snapTab)
    .then((applied) => {
      if (applied) state.pending.delete(tabId)
    })
    .finally(() => {
      state.running.delete(tabId)
    })
  state.running.set(tabId, hydration)
  return hydration
}

/** Hydrate an inactive persisted tab when the user selects it (or it is live). */
export function prioritizeTabHydration(ctx: WorkspaceContext, tabId: string): void {
  const state = restorations.get(ctx)?.hydration
  if (!state?.pending.has(tabId)) return
  // A connection failure leaves the tab pending. Selection, startup retry, or
  // reconnect will call the same operation again; no separate retry path exists.
  void hydrateRestoredTab(ctx, state, tabId).catch(() => null)
}

/**
 * Synchronous first step: read the persisted snapshot + drafts from localStorage
 * and materialize all tabs/sessions/order/active-tab into the workspace context so
 * the tab strip paints on the very first mounted frame — no server round trip gates
 * this. The async runtime-attach (createTab registrations, transcript load, bind)
 * runs later from bootstrapRuntimeTabs.
 *
 * Releases the `hydrating` gate: in-memory state now mirrors the saved snapshot, so
 * the persist effects can re-run without clobbering it. Per-session `loadingHistory`
 * (set during attach) covers the conversation skeleton, so the gate need not wait on
 * transcript/bind. Call once during App setup; re-entry is guarded.
 */
export function materializeTabs(ctx: WorkspaceContext): void {
  if (restorations.has(ctx)) return
  const snapshot = loadPersistedTabs()
  const drafts = loadDrafts()
  restorations.set(ctx, { snapshot, hydration: null })
  // Seed the live draft map so unvisited tabs retain their saved drafts even
  // though the new per-keystroke effect only patches the active tab.
  initDraftState(drafts)
  // Before the location, so a restored `draft/<id>` route resolves to the draft
  // it names rather than being dropped as a dead pane.
  const persistedDrafts = loadPersistedSessionDrafts()
  if (persistedDrafts) ctx.drafts.restoreSessionDrafts(persistedDrafts)
  // Before the location too: entering it shows the restored destination's strip.
  ctx.router.restoreStrips(snapshot?.strips)
  if (!snapshot?.tabs?.length) {
    const hasCurrentDraftSnapshot = ctx.drafts.sessionDrafts.size > 0
    if (drafts) ctx.activeInput.text = drafts.activeInputText
    restoreLocation(ctx, snapshot?.location)
    const destination = ctx.router.destination
    const hasVisibleDraft = destination.name === 'draft' && ctx.drafts.sessionDrafts.has(destination.params.draftId)
    // Keep a restored page in place. Only replace the empty chat pool, which
    // has no conversation to render in this state.
    if (!hasVisibleDraft && destination.name === 'chat') {
      let latestDraftId: string | null = null
      for (const draftId of ctx.drafts.sessionDrafts.keys()) latestDraftId = draftId
      if (latestDraftId) ctx.drafts.openDraft(latestDraftId)
    }
    seedSessionDraft(ctx)
    // Migrate the pre-session-draft text slot once. It no longer has a send
    // path of its own, so leaving text there would make the new draft look
    // empty while an invisible legacy composer still held the user's words.
    if (!hasCurrentDraftSnapshot && ctx.activeInput.text) {
      let latestDraftId: string | null = null
      for (const draftId of ctx.drafts.sessionDrafts.keys()) latestDraftId = draftId
      const draft = latestDraftId ? ctx.drafts.sessionDrafts.get(latestDraftId) : undefined
      if (draft?.isEmpty) {
        draft.prompt.text = ctx.activeInput.text
        ctx.activeInput.text = ''
      }
    }
    ctx.lifecycle.hydrating = false
    return
  }
  _materializeTabs(ctx, snapshot.tabs, snapshot.tabOrder, snapshot.activeTabId, drafts)
  restoreLocation(ctx, snapshot.location)
  materializeStartupTranscript(ctx, snapshot)
  seedSessionDraft(ctx)
  ctx.lifecycle.hydrating = false
}

/**
 * A workspace with nothing restored opens onto a draft — the prompt the user was
 * going to write anyway. Nothing is created but the draft itself: no session, no
 * tab, nothing persisted, so an app opened and closed without typing leaves no
 * trace.
 */
function seedSessionDraft(ctx: WorkspaceContext): void {
  if (ctx.hasOpenTabs()) return
  // A restored draft is already the thing the seed would have created.
  if (ctx.drafts.sessionDrafts.size > 0) return
  ctx.drafts.openSessionDraft({ reveal: false })
}

/**
 * Re-enter the saved location, then drop any pane that points at a tab this boot
 * did not restore. The codec is already total, so a route that no longer parses
 * is gone by this point; this covers the one thing it cannot know — whether the
 * chat a pane names still exists.
 */
export function restoreLocation(ctx: WorkspaceContext, serialized: string | undefined): void {
  if (!serialized) return
  ctx.router.enter(serialized, { replace: true })
  reconcileReloadLocation(ctx)
}

/** Make a reloaded location consistent with the durable tab snapshot. A draft
 * may remain saved for later, but it must not replace a session that survived
 * this reload. Web calls this after the address bar has supplied its location;
 * desktop calls it through restoreLocation above. */
export function reconcileReloadLocation(ctx: WorkspaceContext): void {
  const hasRestoredTab = ctx.tabOrder.some((tabId) => !!ctx.tabs[tabId])
  // A surface that names a conversation or a draft this boot did not restore
  // would render nothing.
  ctx.router.closeSurfacesWhere((ref) =>
    (ref.name === 'chat' && !!ref.params.sessionId && !ctx.tabIdForSession(ref.params.sessionId))
    || (ref.name === 'draft' && !ctx.drafts.sessionDrafts.has(ref.params.draftId)))
  // A draft must not replace a session that survived this reload; an empty one
  // that was deliberately not restored is gone. The leading pane falls back to
  // the active conversation.
  const destination = ctx.router.destination
  if (destination.name === 'draft' && (hasRestoredTab || !ctx.drafts.sessionDrafts.has(destination.params.draftId))) {
    ctx.router.closePane(ctx.router.leadingPane.id)
  }
}

/**
 * Async second step: register the materialized tabs with the server, hydrate the
 * active tab's transcript + bind its live session. Cold inactive tabs stay as
 * metadata until selected; busy tabs are promoted immediately. Assumes
 * materializeTabs already built the client-side tabs and falls back to running
 * it if the caller skipped it. Re-entry retries the active tab after a failed
 * connection; the per-tab running promise deduplicates concurrent callers.
 */
export async function bootstrapRuntimeTabs(ctx: WorkspaceContext): Promise<void> {
  if (!restorations.has(ctx)) materializeTabs(ctx)
  const restoration = restorations.get(ctx)
  if (!restoration?.snapshot?.tabs?.length) return
  const snapshot = restoration.snapshot

  let state = restoration.hydration
  if (!state) {
    state = {
      pending: new Map(snapshot.tabs.map((snapTab) => [snapTab.tabId, snapTab])),
      running: new Map(),
      hasStartedMetadataReads: false,
    }
    restoration.hydration = state
  }

  if (!ctx.tabs[ctx.activeTabId]) {
    ctx.activeTabId = ctx.tabOrder.find((tabId) => ctx.tabs[tabId]) ?? ''
  }
  ctx.pruneTabOrder()
  const activeHydration = ctx.activeTabId ? hydrateRestoredTab(ctx, state, ctx.activeTabId) : Promise.resolve()
  // A chat surface restored beside it is on screen too. Later navigation loads
  // what it shows itself (`loadShownConversations`).
  const surfaceTabId = ctx.chatSurfaceTabId
  if (surfaceTabId) void hydrateRestoredTab(ctx, state, surfaceTabId).catch(() => null)
  void afterPaint().then(() => startRestoredMetadataReads(ctx, snapshot.tabs, state))
  await activeHydration
}

/**
 * Re-register tabs with the server and re-bind any alive sessions without
 * clearing client state. Used by the network-gap recovery path.
 */
export async function resyncRuntime(ctx: WorkspaceContext, serverId?: string): Promise<void> {
    const tabIds = ctx.tabOrder.filter((tabId) => !serverId || ctx.sessionFor(tabId)?.run.serverId === serverId)
    // Clear only the affected host's in-flight activity before replay without
    // churning healthy tabs on other connections.
    for (const tabId of tabIds) {
      const sessionId = ctx.tabs[tabId]?.sessionId
      if (!sessionId) continue
      const session = ctx.sessions.byId[sessionId]
      if (session) session.isStreamingText = false
      delete ctx.lifecycle.turnSnapshots[sessionId]
    }
    // Re-register per session, not per tab: a split chat is one watch, and one
    // watch is what the host fans out to.
    const sessionIds = [...new Set(tabIds.map((tabId) => ctx.tabs[tabId]?.sessionId).filter(Boolean))]
    await Promise.all(sessionIds.map(async (sessionId) => {
      const session = ctx.sessions.byId[sessionId]
      const tabId = ctx.tabIdsForSession(sessionId)[0]
      if (!session || !tabId || session.forked) return

      // A reset can arrive while this restored tab still has no durable history.
      // Use the same history -> watch -> bind operation as boot and selection;
      // subscribing here first would recreate the startup race.
      const restoredState = restorations.get(ctx)?.hydration
      if (restoredState?.pending.has(tabId)) {
        await hydrateRestoredTab(ctx, restoredState, tabId).catch(() => null)
        return
      }

      // Re-register with the server so event routing is alive again. The same
      // round trip attaches to the live runtime when there is a provider thread
      // to attach to.
      const api = ctx.apiFor(tabId)
      const watched = await api.watchSession({
        sessionId,
        attachRuntime: !!session.agentSessionId,
      }).catch(() => null)

      void ctx.queue.refresh(tabId).catch(() => null)

      // Registration needs the watch above, hence not earlier.
      const environmentRefresh = ctx.environment.refreshEnvironment(ctx, { sourceId: tabId, level: 'status', force: false }).catch(() => null)

      if (session.agentSessionId) {
        const info = watched?.runtime ?? null
        if (info && session) {
          applyRuntimeConfig(session, info)
          session.status = info.status
          session.rateLimitInfo = info.rateLimitInfo
          ctx.lifecycle.reconcileQueuedPrompts(tabId, info.queuedPrompts)
        } else if (info === null) {
          // Session no longer alive.
          session.status = 'idle'
          session.rateLimitInfo = null
        }
        void ctx.refreshThreadGoal(session.id)
      }
      await environmentRefresh
    }))
}

/** Snapshots written before tabs carried a window have `contextWindow: null`,
 *  which would keep those tabs on the provider default forever. Backfill from
 *  the model's profile; an explicit choice already in the snapshot wins. */
function restoredModelConfig(snapTab: PersistedTab): ModelConfig {
  const modelConfig = { ...snapTab.modelConfig }
  modelConfig.contextWindow ??= defaultContextWindowFor(snapTab.provider, modelConfig.modelId)
  return modelConfig
}

/** Apply the lightweight host record that every restored tab reads on startup.
 * This path updates sidebar-visible state only; transcript hydration remains a
 * separate active-first operation and cannot gate these fields on selection. */
export function applyRestoredSessionMeta(session: Session, meta: SessionMeta): void {
  if (meta.status) session.status = meta.status
  session.run.provider = meta.provider
  if (meta.model && session.run.modelConfig.modelId !== AUTO_MODEL_ID) {
    session.run.modelConfig.modelId = meta.model
  }
  if (meta.reasoningEffort) session.run.modelConfig.reasoningEffort = meta.reasoningEffort
  session.startedBy = meta.startedBy
  session.currentTurnStartedAt = isSessionBusyStatus(session.status)
    ? meta.currentTurnStartedAt ?? session.currentTurnStartedAt
    : null
}

/** Synchronous builder: create tabs/sessions from the snapshot and restore order +
 *  active tab. Pure client-state mutation, no RPC — safe to run before first paint. */
function _materializeTabs(
  ctx: WorkspaceContext,
  persistedTabs: PersistedTab[],
  tabOrder: string[],
  activeTabId: string,
  drafts: TabDrafts | null,
): void {
  const savedServers = loadServers()
  for (const snapTab of persistedTabs) {
    let tab = ctx.tabs[snapTab.tabId]
    let session = tab ? ctx.sessions.byId[tab.sessionId] : undefined
    const draftText = drafts?.tabs[snapTab.tabId] ?? ''

    if (!tab || !session) {
      const serverId = snapTab.serverInstallationId
        ? savedServers.find((server) => server.installationId === snapTab.serverInstallationId)?.id
          ?? snapTab.serverId
        : snapTab.serverId
      const run: Partial<RunConfig> = {
        serverId,
        provider: snapTab.provider,
        workingDirectory: snapTab.workingDirectory || machineProjectPath(serverId) || NEW_CHAT_DIRECTORY,
        gitContext: snapTab.gitContext,
        worktree: snapTab.worktreeRequested
          ? { baseBranch: snapTab.worktreeBaseBranch }
          : null,
        taskServerId: snapTab.taskServerId,
        projectGroupPath: snapTab.projectGroupPath ?? null,
        permissionMode: permissionModeSchema.parse(snapTab.permissionMode),
      }
      if (snapTab.modelConfig) run.modelConfig = restoredModelConfig(snapTab)
      const overrides: NonNullable<Parameters<typeof makeSession>[1]> = {
        // Keep the id the snapshot carried: the persisted location names chats
        // by session, so a restored split pane has to find the same one back.
        agentSessionId: snapTab.agentSessionId,
        forked: !!snapTab.pendingFork,
        forkExcludeLatestTurn: snapTab.pendingFork?.excludeLatestTurn ?? false,
        forkedFromSessionId: snapTab.forkedFromSessionId ?? null,
        messages: snapTab.pendingFork?.messages ?? [],
        handoffFrom: snapTab.handoffFrom ? { ...snapTab.handoffFrom } : undefined,
        status: snapTab.pendingFork ? 'idle' : snapTab.status ?? 'idle',
        currentTurnStartedAt: snapTab.currentTurnStartedAt ?? null,
        startedAt: snapTab.startedAt ?? null,
        additionalDirs: [...snapTab.additionalDirs],
        run,
        // Only a composer carries these; a started session's task comes from its
        // session link. Restoring them is what keeps a composer under the task
        // it was opened in when the client refreshes out from under it.
        task: taskTargetFrom(snapTab),
        terminalFailure: snapTab.terminalFailure
          ? { ...snapTab.terminalFailure }
          : null,
        contextUsage: snapTab.contextUsage ? { ...snapTab.contextUsage } : null,
        // The active transcript is attached after the first paint. Mark it now
        // so the renderer shows a finite loading state instead of inferring one
        // forever from agentSessionId + an empty transcript.
        loadingHistory: !snapTab.pendingFork && snapTab.tabId === activeTabId && !!(snapTab.agentSessionId || snapTab.handoffFrom),
      }
      if (snapTab.sessionId) overrides.id = snapTab.sessionId
      session = makeSession(ctx.settings, overrides)
      // The name is the session's; the snapshot still carries it per tab
      // because that is the record it was written from.
      session.title = snapTab.title || 'New Tab'
      session.titleCustom = snapTab.titleCustom ?? false
      tab = makeTab(session.id, { id: snapTab.tabId })
      // The unsent prompt is the session's, so a restored draft lands there —
      // the persisted map is still keyed by tab because that is the id the
      // snapshot carries.
      session.prompt = makePrompt({ text: draftText })
      tab.hasUnread = snapTab.hasUnread ?? false
      ctx.sessions.byId[session.id] = session
      ctx.tabs[tab.id] = tab
    } else if (draftText) {
      session.prompt.text = draftText
    }
  }

  // Restore order and active tab from snapshot.
  for (const tabId of tabOrder) {
    if (ctx.tabs[tabId] && !ctx.tabOrder.includes(tabId)) ctx.tabOrder.push(tabId)
  }
  // Any tabs that weren't in the persisted order get appended.
  for (const tabId of Object.keys(ctx.tabs)) {
    if (!ctx.tabOrder.includes(tabId)) ctx.tabOrder.push(tabId)
  }

  if (ctx.tabs[activeTabId]) ctx.activeTabId = activeTabId
}

/** Start side-effect-free status reads once. They can promote a busy inactive
 * tab, but all transcript and runtime work still goes through hydrateRestoredTab. */
function startRestoredMetadataReads(
  ctx: WorkspaceContext,
  persistedTabs: PersistedTab[],
  state: RestoredHydrationState,
): void {
  if (state.hasStartedMetadataReads) return
  state.hasStartedMetadataReads = true

  // Transcript hydration for inactive tabs is intentionally deferred, but their
  // tab-strip status must still reflect live work immediately after refresh.
  // getSessionInfo is side-effect free, unlike bindRuntimeSession, which may
  // replay in-flight events before the persisted transcript has loaded.
  for (const snapTab of persistedTabs) {
    if (!snapTab.agentSessionId || snapTab.pendingFork) continue
    const sourceServerId = ctx.sessionFor(snapTab.tabId)?.run.serverId
      ?? snapTab.serverId
    const serverId = serverConnections.resolveId(sourceServerId)
    void readSessionMeta(serverId, snapTab.agentSessionId)
      .then((meta) => {
        const tab = ctx.tabs[snapTab.tabId]
        const session = tab ? ctx.sessions.byId[tab.sessionId] : undefined
        if (session?.agentSessionId !== snapTab.agentSessionId || !meta) return
        applyRestoredSessionMeta(session, meta)
        if (isSessionBusyStatus(session.status)) prioritizeTabHydration(ctx, snapTab.tabId)
      })
      .catch(() => null)
  }
}

/**
 * Hydrate a single tab: load its (windowed) transcript, then bind any live
 * runtime session. The order is fixed: durable history, watch, then bind. Git
 * and task state are independent and run alongside that sequence.
 */
/**
 * A restored tab whose machine is gone (docs/plans/workspace-and-machines.md §6):
 * nothing on that machine can be asked, so the tab is read-only and shows what the
 * window's own record home mirrored of it, when it holds any. Left pending until
 * the saved hosts are authoritative: a host missing before the directory answers
 * may still be listed.
 */
async function hydrateTabOnGoneMachine(ctx: WorkspaceContext, snapTab: PersistedTab, session: Session): Promise<boolean> {
  if (!savedHostsAreAuthoritative()) return false
  session.readOnlyReason = GONE_MACHINE_READ_ONLY_REASON
  const home = serverConnections.defaultServerId()
  if (!home || !hosts.hasCollaboration(home)) return true
  session.loadingHistory = session.messages.length === 0
  try {
    const meta = await readSessionMeta(home, session.id)
      ?? (snapTab.agentSessionId ? await readSessionMeta(home, snapTab.agentSessionId) : null)
    if (!meta || ctx.sessionFor(snapTab.tabId) !== session) return true
    const messages = await loadSessionRecordTranscript(ctx, home, meta)
    if (ctx.sessionFor(snapTab.tabId) !== session || messages.length === 0) return true
    replaceHydratedMessages(session, messages)
    ctx.eventReducer.rebuildAgentConversations(session)
  } catch {
    // The mirror may not hold this session; the tab stays read-only and empty.
  } finally {
    session.loadingHistory = false
  }
  return true
}

/** The project path of the tab's own host, read or cached. Restore runs before
 *  most hosts answer, so the last cached answer stands in until they do. */
function machineProjectPath(serverId: string | undefined): string | undefined {
  if (!serverId) return undefined
  return hosts.find(serverId)?.machineInfo?.projectPath ?? loadCachedStart(serverId)?.projectPath
}

async function hydrateTab(ctx: WorkspaceContext, snapTab: PersistedTab): Promise<boolean> {
  const tab = ctx.tabs[snapTab.tabId]
  const session = tab ? ctx.sessions.byId[tab.sessionId] : undefined
  if (!tab || !session || session.forked || snapTab.pendingFork) return true
  if (!serverConnections.isKnownServer(session.run.serverId)) return hydrateTabOnGoneMachine(ctx, snapTab, session)

  const api = ctx.apiFor(snapTab.tabId)
  const snapshotProvider = snapTab.provider ?? ctx.settings.activeAgent
  const displayCwd = snapTab.workingDirectory || machineProjectPath(session.run.serverId) || NEW_CHAT_DIRECTORY
  // The host reads the session's whole lineage from its session id. Read the
  // bytes alongside the lineage, but build cards using the lineage below. A
  // worktree transcript lives under its checkout, not the repo root.
  const loadPath = snapTab.gitContext?.worktreePath || displayCwd
  const history = snapTab.agentSessionId
    ? requestSessionHistoryPage(api, {
        sessionId: session.id, projectPath: loadPath, provider: snapshotProvider,
        turnLimit: INITIAL_HISTORY_TURNS,
      })
    : undefined
  // Observe an early rejection while lineage is pending; awaiting history below
  // still propagates it so selection/reconnect can retry the hydration.
  void history?.catch(() => null)
  const handoff = (await api.describeSession(session.id).catch(() => null))?.lineage ?? null
  if (ctx.sessionFor(snapTab.tabId) !== session) return false
  const activeMember = handoff?.active
  if (activeMember) {
    session.handoffPending = !activeMember.providerSessionId
    session.run.provider = activeMember.provider
    session.agentSessionId = activeMember.providerSessionId
  }


  if (snapTab.agentSessionId || handoff) {
    const sessionId = session.id
    const provider = activeMember?.provider ?? snapshotProvider
    const tabId = snapTab.tabId
    session.loadingHistory = session.messages.length === 0
    try {
      const shouldApply = () => {
        const t = ctx.tabs[tabId]
        if (!t) return false
        const s = ctx.sessions.byId[t.sessionId]
        // Provider ids are replaceable handoff bindings. Only replacing this
        // stable Solus session makes the disk result stale.
        return s === session
      }
      const transcript = sessionId
        ? await loadRestoredSessionTranscript(ctx, {
            sessionId,
            loadPath,
            displayCwd,
            provider,
            ctx: ctx.ctxFor(tabId),
            history,
            shouldApply,
          })
        : { messages: [], planIds: [], progress: null, truncated: false, before: undefined, pendingMessages: undefined }
      if (!shouldApply()) return false
      const t = ctx.tabs[tabId]
      const s = t ? ctx.sessions.byId[t.sessionId] : undefined
      if (s) {
        s.historyTruncated = transcript.truncated
        s.historyCursor = transcript.before
        s.historyPendingMessages = transcript.pendingMessages
      }
      if (s && transcript.messages.length > 0) {
        replaceHydratedMessages(s, transcript.messages)
        markStartupTranscriptApplied(tabId)
        ctx.eventReducer.rebuildAgentConversations(s)
        s.progress = transcript.progress
        ctx.lifecycle.recomputeChangedFiles(tabId)
        for (const planId of transcript.planIds) void ctx.planStore.hydrateAnnotations(planId)
        if (transcript.endsInRefusedLogin) ctx.offerSignInAgain(s.id, s)
      }
      if (
        s &&
        snapTab.terminalFailure &&
        !s.messages.some(
          (message) =>
            message.role === 'system' &&
            message.content === snapTab.terminalFailure?.content,
        )
      ) {
        s.messages.push({
          id: nextMsgId(),
          role: 'system',
          content: snapTab.terminalFailure.content,
          timestamp: snapTab.terminalFailure.timestamp,
        })
      }
    } finally {
      const t = ctx.tabs[tabId]
      const s = t ? ctx.sessions.byId[t.sessionId] : undefined
      if (s === session) s.loadingHistory = false
    }
  }

  // Secondary reads run after the transcript can paint and never gate live attachment.
  void afterPaint().then(async () => {
    if (ctx.sessionFor(snapTab.tabId) !== session) return
    const environmentRefresh = ctx.environment.refreshEnvironment(ctx, { sourceId: snapTab.tabId, level: 'details', force: false }).catch(() => null)
    const taskHydration = ctx.tasksStore.ensureSessionBinding(session.id, snapTab.taskServerId).catch(() => null)
    await Promise.all([environmentRefresh, taskHydration])
  })

  if (session.agentSessionId) {
    // Join the live event stream only after durable history is in memory.
    // Otherwise an event that arrives during loadSession makes the successful
    // history response look stale and the restored session can stay blank.
    // The same round trip attaches to the live runtime, which a separate bind
    // used to do after the watch.
    const watched = await api.watchSession({ sessionId: session.id, attachRuntime: true })
    ctx.applyPendingQuestions(snapTab.tabId, watched.pendingQuestions)
    const info = watched.runtime ?? null
    if (info && session) {
      applyRuntimeConfig(session, info)
      session.status = info.status
      session.rateLimitInfo = info.rateLimitInfo
      if (info.handoffFrom) session.handoffFrom = info.handoffFrom
      ctx.lifecycle.reconcileQueuedPrompts(snapTab.tabId, info.queuedPrompts)
    } else if (info === null && (isSessionBusyStatus(session.status) || session.status === 'background')) {
      // An optimistic status probe may race the session settling before its
      // deferred bind. Reconcile that stale busy state when no runtime remains.
      // 'background' needs the live query too: after a host restart its tasks
      // are gone, and a kept status offers a stop that can never succeed.
      session.status = 'idle'
      session.rateLimitInfo = null
    }
    void ctx.refreshThreadGoal(session.id)
  }

  return true
}
