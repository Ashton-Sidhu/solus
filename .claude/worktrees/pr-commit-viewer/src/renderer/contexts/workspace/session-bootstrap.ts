import { defaultContextWindowFor, isSessionBusyStatus, type AgentId, type Message, type ModelConfig, type Session, type SessionMeta } from '../../../shared/types'
import { loadServers, LOCAL_SERVER_ID } from '../../../client-core/server-registry'
import { makePrompt, makeSession, makeTab } from './session.factories'
import { taskTargetFrom } from './session-draft.svelte'
import { loadRestoredSessionTranscript } from './session-transcript'
import { applyRuntimeConfig, nextMsgId, progressFromMessages } from './session.utils'
import { initDraftState, loadDrafts, loadPersistedSessionDrafts, loadPersistedTabs, type PersistedTab, type PersistedTabs, type TabDrafts } from './tab-persistence'
import type { WorkspaceContext } from './workspace.context.svelte'
import { stampSessionMeta } from '@client-core/session-meta'
import { serverConnections } from '@client-core/server-connections'

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

/** History hydration replaces the provider transcript wholesale. Preserve a
 * configuration divider added while a restored tab was still loading: it is
 * renderer state newer than the transcript request and would otherwise disappear. */
export function replaceHydratedMessages(session: Pick<Session, 'messages'>, hydrated: Message[]): void {
  const hydratedIds = new Set(hydrated.map((message) => message.id))
  const pendingConfigurationChanges = session.messages.filter(
    (message) =>
      message.agentChangedTo &&
      !hydratedIds.has(message.id),
  )
  session.messages.splice(0, session.messages.length, ...hydrated, ...pendingConfigurationChanges)
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
    .then(() => {
      state.pending.delete(tabId)
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
  if (persistedDrafts) ctx.restoreSessionDrafts(persistedDrafts)
  if (!snapshot?.tabs?.length) {
    if (drafts) ctx.activeInput.text = drafts.activeInputText
    seedSessionDraft(ctx)
    ctx.hydrating = false
    return
  }
  _materializeTabs(ctx, snapshot.tabs, snapshot.tabOrder, snapshot.activeTabId, drafts)
  restoreLocation(ctx, snapshot.location)
  seedSessionDraft(ctx)
  ctx.hydrating = false
}

/**
 * A workspace with nothing restored opens onto a draft — the prompt the user was
 * going to write anyway. Nothing is created but the draft itself: no session, no
 * tab, nothing persisted, so an app opened and closed without typing leaves no
 * trace.
 */
function seedSessionDraft(ctx: WorkspaceContext): void {
  if (ctx.tabOrder.some((tabId) => ctx.tabs[tabId])) return
  // A restored draft is already the thing the seed would have created.
  if (ctx.sessionDrafts.size > 0) return
  ctx.openSessionDraft({ reveal: false })
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
  for (const pane of [...ctx.router.panes]) {
    const sessionId = pane.base?.name === 'chat' ? pane.base.params.sessionId : undefined
    if (sessionId && !ctx.tabIdForSession(sessionId)) ctx.router.closePane(pane.id)
    const draftId = pane.base?.name === 'draft' ? pane.base.params.draftId : undefined
    // A pre-fix snapshot can still point at an empty draft that was deliberately
    // not restored. Treat it like any other dead pane: the leading pane falls
    // back to the active conversation and a companion pane closes.
    if (draftId && (hasRestoredTab || !ctx.sessionDrafts.has(draftId))) {
      ctx.router.closePane(pane.id)
    }
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

  startRestoredMetadataReads(ctx, snapshot.tabs, state)
  if (!ctx.tabs[ctx.activeTabId]) {
    ctx.activeTabId = ctx.tabOrder.find((tabId) => ctx.tabs[tabId]) ?? ''
  }
  ctx.pruneTabOrder()
  if (ctx.activeTabId) await hydrateRestoredTab(ctx, state, ctx.activeTabId)
}

/**
 * Re-register tabs with the server and re-bind any alive sessions without
 * clearing client state. Used by the network-gap recovery path.
 */
export async function resyncRuntime(ctx: WorkspaceContext, serverId?: string): Promise<void> {
  ctx.runtimeSyncing = true
  try {
    const tabIds = ctx.tabOrder.filter((tabId) => !serverId || ctx.sessionFor(tabId)?.run.serverId === serverId)
    // Clear only the affected host's in-flight state so replayed text doesn't
    // double-append without churning healthy tabs on other connections.
    for (const tabId of tabIds) {
      const sessionId = ctx.tabs[tabId]?.sessionId
      if (!sessionId) continue
      if (typeof ctx.clearStreamingText === 'function') ctx.clearStreamingText(sessionId)
      else delete ctx.streaming.text[sessionId]
      delete ctx.turnSnapshots[sessionId]
    }
    // Re-register per session, not per tab: a split chat is one watch, and one
    // watch is what the host fans out to.
    const sessionIds = [...new Set(tabIds.map((tabId) => ctx.tabs[tabId]?.sessionId).filter(Boolean))]
    await Promise.all(sessionIds.map(async (sessionId) => {
      const session = ctx.sessions[sessionId]
      const tabId = ctx.tabIdsForSession(sessionId)[0]
      if (!session || !tabId) return

      // A reset can arrive while this restored tab still has no durable history.
      // Use the same history -> watch -> bind operation as boot and selection;
      // subscribing here first would recreate the startup race.
      const restoredState = restorations.get(ctx)?.hydration
      if (restoredState?.pending.has(tabId)) {
        await hydrateRestoredTab(ctx, restoredState, tabId).catch(() => null)
        return
      }

      // Re-register with the server so event routing is alive again.
      const api = ctx.apiFor(tabId)
      await api.watchSession({ sessionId }).catch(() => null)

      // Same as hydrateTab: Git doesn't depend on the bind below, so don't queue
      // it behind one. Registration needs the watch above, hence not earlier.
      const environmentRefresh = ctx.environment.refreshEnvironment(ctx, { sourceId: tabId, level: 'status' }).catch(() => null)

      if (session.agentSessionId) {
        const info = await api.bindRuntimeSession(ctx.ctxFor(tabId)).catch(() => null)
        if (info && session) {
          applyRuntimeConfig(session, info)
          session.status = info.status
          session.rateLimitInfo = info.rateLimitInfo
          ctx.reconcileQueuedPrompts(tabId, info.queuedPrompts)
        } else if (info === null) {
          // Session no longer alive.
          session.status = 'idle'
          session.rateLimitInfo = null
        }
        void ctx.refreshThreadGoal(session.id)
      }
      await environmentRefresh
    }))
  } finally {
    ctx.runtimeSyncing = false
  }
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
  if (meta.model) session.run.modelConfig.modelId = meta.model
  if (meta.reasoningEffort) session.run.modelConfig.reasoningEffort = meta.reasoningEffort
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
    let session = tab ? ctx.sessions[tab.sessionId] : undefined
    const draftText = drafts?.tabs[snapTab.tabId] ?? ''

    if (!tab || !session) {
      const serverId = snapTab.serverInstallationId
        ? savedServers.find((server) => server.installationId === snapTab.serverInstallationId)?.id
          ?? snapTab.serverId
          ?? LOCAL_SERVER_ID
        : snapTab.serverId ?? LOCAL_SERVER_ID
      session = makeSession(ctx.settings, {
        // Keep the id the snapshot carried: the persisted location names chats
        // by session, so a restored split pane has to find the same one back.
        ...(snapTab.sessionId ? { id: snapTab.sessionId } : {}),
        agentSessionId: snapTab.agentSessionId,
        handoffFrom: snapTab.handoffFrom ? { ...snapTab.handoffFrom } : undefined,
        status: snapTab.status ?? 'idle',
        currentTurnStartedAt: snapTab.currentTurnStartedAt ?? null,
        additionalDirs: [...snapTab.additionalDirs],
        run: {
          serverId,
          provider: snapTab.provider,
          workingDirectory: snapTab.workingDirectory || ctx.staticInfo?.projectPath || ctx.staticInfo?.workspacePath || '~',
          gitContext: snapTab.gitContext,
          worktree: (snapTab.worktreeRequested ?? !!snapTab.worktreeBaseBranch)
            ? { baseBranch: snapTab.worktreeBaseBranch }
            : null,
          taskServerId: snapTab.taskServerId ?? serverId,
          projectGroupPath: snapTab.projectGroupPath ?? null,
          ...(snapTab.modelConfig ? { modelConfig: restoredModelConfig(snapTab) } : {}),
          permissionMode: snapTab.permissionMode as any,
        },
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
        loadingHistory: snapTab.tabId === activeTabId && !!(snapTab.agentSessionId || snapTab.handoffFrom),
      })
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
      ctx.sessions[session.id] = session
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
    if (!snapTab.agentSessionId) continue
    const sourceServerId = ctx.sessionFor(snapTab.tabId)?.run.serverId
      ?? snapTab.serverId
      ?? serverConnections.connectionFor()?.serverId
    if (!sourceServerId) continue
    const serverId = serverConnections.resolveId(sourceServerId)
    void ctx.apiFor(snapTab.tabId)
      .getSessionInfo(snapTab.agentSessionId)
      .then((readMeta) => {
        const meta = stampSessionMeta(readMeta, serverId)
        const tab = ctx.tabs[snapTab.tabId]
        const session = tab ? ctx.sessions[tab.sessionId] : undefined
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
async function hydrateTab(ctx: WorkspaceContext, snapTab: PersistedTab): Promise<void> {
  const tab = ctx.tabs[snapTab.tabId]
  const session = tab ? ctx.sessions[tab.sessionId] : undefined
  if (!tab || !session || session.agentSessionId !== snapTab.agentSessionId) return

  // Git is what the sidebar, home, and Git panel all read, and it depends on
  // nothing below — so start it now rather than behind a transcript parse and a
  // bind round-trip.
  const environmentRefresh = ctx.environment.refreshEnvironment(ctx, { sourceId: snapTab.tabId }).catch(() => null)
  const taskHydration = snapTab.agentSessionId
    ? ctx.tasksStore.ensureSessionBinding(snapTab.agentSessionId, snapTab.taskServerId).catch(() => null)
    : Promise.resolve(null)

  if (snapTab.agentSessionId || snapTab.handoffFrom) {
    const sessionId = snapTab.agentSessionId
    const provider = (snapTab.provider ?? ctx.settings.activeAgent) as AgentId
    const displayCwd = snapTab.workingDirectory || ctx.staticInfo?.projectPath || ctx.staticInfo?.workspacePath || '~'
    // Claude persists transcripts under the dir it actually ran in. Worktree
    // sessions ran in the worktree, not the project root, so load from there
    // or the .jsonl folder won't resolve and the transcript comes back empty.
    // (Codex reads by session id and ignores the path entirely.)
    const loadPath = snapTab.gitContext?.worktreePath || displayCwd
    const tabId = snapTab.tabId
    session.loadingHistory = true
    try {
      const shouldApply = () => {
        const t = ctx.tabs[tabId]
        if (!t) return false
        const s = ctx.sessions[t.sessionId]
        // Runtime events cannot reach this fresh client until the watch below.
        // Only a real tab/session replacement can make this history stale.
        return s === session && s.agentSessionId === snapTab.agentSessionId
      }
      const handoffFrom = snapTab.handoffFrom
      const predecessorTranscript = handoffFrom
        ? await loadRestoredSessionTranscript(ctx, {
            sessionId: handoffFrom.sessionId,
            loadPath,
            displayCwd,
            provider: handoffFrom.provider,
            ctx: ctx.ctxFor(tabId),
            shouldApply,
          })
        : null
      const transcript = sessionId
        ? await loadRestoredSessionTranscript(ctx, {
            sessionId,
            loadPath,
            displayCwd,
            provider,
            ctx: ctx.ctxFor(tabId),
            shouldApply,
          })
        : { messages: [], planIds: [], progress: null, truncated: false }
      const t = ctx.tabs[tabId]
      const s = t ? ctx.sessions[t.sessionId] : undefined
      if (s && handoffFrom) {
        const predecessorMessages = [...(predecessorTranscript?.messages ?? [])]
        const currentMessages = [...transcript.messages]
        // Provider boundaries are an implementation detail. Rehydrate one
        // continuous transcript so switching agents never interrupts the thread.
        const stitchedMessages = [...predecessorMessages, ...currentMessages]
        replaceHydratedMessages(s, stitchedMessages)
        ctx.eventReducer.rebuildAgentConversations(s)
        s.progress = progressFromMessages(stitchedMessages)
        s.historyTruncated = (predecessorTranscript?.truncated ?? false) || transcript.truncated
        ctx.recomputeChangedFiles(tabId)
        const planIds = [...(predecessorTranscript?.planIds ?? []), ...transcript.planIds]
        for (const planId of planIds) void ctx.planStore.hydrateAnnotations(planId)
      } else if (s && transcript.messages.length > 0) {
        replaceHydratedMessages(s, transcript.messages)
        ctx.eventReducer.rebuildAgentConversations(s)
        s.progress = transcript.progress
        s.historyTruncated = transcript.truncated
        ctx.recomputeChangedFiles(tabId)
        for (const planId of transcript.planIds) void ctx.planStore.hydrateAnnotations(planId)
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
      const s = t ? ctx.sessions[t.sessionId] : undefined
      if (s) s.loadingHistory = false
    }
  }

  if (snapTab.agentSessionId) {
    const api = ctx.apiFor(snapTab.tabId)
    // Join the live event stream only after durable history is in memory.
    // Otherwise an event that arrives during loadSession makes the successful
    // history response look stale and the restored session can stay blank.
    await api.watchSession({ sessionId: session.id })
    const info = await api
      .bindRuntimeSession(ctx.ctxFor(snapTab.tabId))
      .catch(() => null)
    if (info && session) {
      applyRuntimeConfig(session, info)
      session.status = info.status
      session.rateLimitInfo = info.rateLimitInfo
      if (info.handoffFrom) session.handoffFrom = info.handoffFrom
      ctx.reconcileQueuedPrompts(snapTab.tabId, info.queuedPrompts)
    } else if (info === null && isSessionBusyStatus(session.status)) {
      // An optimistic status probe may race the session settling before its
      // deferred bind. Reconcile that stale busy state when no runtime remains.
      session.status = 'idle'
      session.rateLimitInfo = null
    }
    void ctx.refreshThreadGoal(session.id)
  }

  await Promise.all([environmentRefresh, taskHydration])
}
