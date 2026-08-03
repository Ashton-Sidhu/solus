import { defaultContextWindowFor, isSessionBusyStatus, type AgentId, type Message, type ModelConfig, type Session } from '../../../shared/types'
import { loadServers, LOCAL_SERVER_ID } from '../../../client-core/server-registry'
import { makeInputState, makeSession, makeTab } from './session.factories'
import { loadRestoredSessionTranscript } from './session-transcript'
import { applyRuntimeConfig, hasConversation, nextMsgId, progressFromMessages } from './session.utils'
import { initDraftState, loadDrafts, loadPersistedTabs, type PersistedTab, type PersistedTabs, type TabDrafts } from './tab-persistence'
import type { WorkspaceContext } from './workspace.context.svelte'

interface DeferredHydrationState {
  pending: Map<string, PersistedTab>
  running: Set<string>
}

const deferredHydrations = new WeakMap<WorkspaceContext, DeferredHydrationState>()

/** Snapshot captured by the synchronous materialize step, consumed by the async
 *  runtime-attach step. Presence also guards materialize against re-running. */
const materializations = new WeakMap<WorkspaceContext, { snapshot: PersistedTabs | null }>()
/** Guards the async attach step against a re-running boot effect. */
const attached = new WeakSet<WorkspaceContext>()

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

async function hydrateDeferredTab(
  ctx: WorkspaceContext,
  state: DeferredHydrationState,
  tabId: string,
): Promise<void> {
  const snapTab = state.pending.get(tabId)
  if (!snapTab || state.running.has(tabId)) return
  state.pending.delete(tabId)
  state.running.add(tabId)
  try {
    await hydrateTab(ctx, snapTab)
  } catch {
    // A missing/deleted transcript leaves this cold tab empty until reopened.
  } finally {
    state.running.delete(tabId)
  }
}

/** Hydrate an inactive persisted tab when the user selects it (or it is live). */
export function prioritizeTabHydration(ctx: WorkspaceContext, tabId: string): void {
  const state = deferredHydrations.get(ctx)
  if (!state?.pending.has(tabId)) return
  void hydrateDeferredTab(ctx, state, tabId)
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
  if (materializations.has(ctx)) return
  const snapshot = loadPersistedTabs()
  const drafts = loadDrafts()
  materializations.set(ctx, { snapshot })
  // Seed the live draft map so unvisited tabs retain their saved drafts even
  // though the new per-keystroke effect only patches the active tab.
  initDraftState(drafts)
  if (!snapshot?.tabs?.length) {
    if (drafts) ctx.activeInput.text = drafts.activeInputText
    ctx.hydrating = false
    return
  }
  _materializeTabs(ctx, snapshot.tabs, snapshot.tabOrder, snapshot.activeTabId, drafts)
  restoreLocation(ctx, snapshot.location)
  ctx.hydrating = false
}

/**
 * Re-enter the saved location, then drop any pane that points at a tab this boot
 * did not restore. The codec is already total, so a route that no longer parses
 * is gone by this point; this covers the one thing it cannot know — whether the
 * chat a pane names still exists.
 */
function restoreLocation(ctx: WorkspaceContext, serialized: string | undefined): void {
  if (!serialized) return
  ctx.router.enter(serialized, { replace: true })
  for (const pane of [...ctx.router.panes]) {
    const tabId = pane.base?.name === 'chat' ? pane.base.params.tabId : undefined
    if (tabId && !ctx.tabs[tabId]) ctx.router.closePane(pane.id)
  }
}

/**
 * Async second step: register the materialized tabs with the server, hydrate the
 * active tab's transcript + bind its live session. Cold inactive tabs stay as
 * metadata until selected; busy tabs are promoted immediately. Assumes
 * materializeTabs already built the client-side tabs; falls back
 * to running it if the caller skipped it. Guarded so a re-running boot effect can't
 * double-register or double-hydrate.
 */
export async function bootstrapRuntimeTabs(ctx: WorkspaceContext): Promise<void> {
  if (!materializations.has(ctx)) materializeTabs(ctx)
  if (attached.has(ctx)) return
  attached.add(ctx)
  const snapshot = materializations.get(ctx)?.snapshot
  if (!snapshot?.tabs?.length) return
  try {
    await _attachRuntimeTabs(ctx, snapshot.tabs)
  } catch (error) {
    attached.delete(ctx)
    throw error
  }
}

/**
 * Re-register tabs with the server and re-bind any alive sessions without
 * clearing client state. Used by the network-gap recovery path.
 */
export async function resyncRuntime(ctx: WorkspaceContext, serverId?: string): Promise<void> {
  ctx.runtimeSyncing = true
  try {
    const tabIds = ctx.tabOrder.filter((tabId) => !serverId || ctx.sessionFor(tabId)?.serverId === serverId)
    // Clear only the affected host's in-flight state so replayed text doesn't
    // double-append without churning healthy tabs on other connections.
    for (const tabId of tabIds) {
      if (typeof ctx.clearStreamingText === 'function') ctx.clearStreamingText(tabId)
      else delete ctx.streaming.text[tabId]
      delete ctx.turnSnapshots[tabId]
    }
    await Promise.all(tabIds.map(async (tabId) => {
      const tab = ctx.tabs[tabId]
      const session = tab ? ctx.sessions[tab.sessionId] : undefined
      if (!tab || !session) return

      // Re-register with the server so event routing is alive again.
      const api = ctx.apiFor?.(tabId) ?? window.solus
      await api.createTab(tabId).catch(() => null)

      // Same as hydrateTab: Git doesn't depend on the bind below, so don't queue
      // it behind one. Registration needs the createTab above, hence not earlier.
      const environmentRefresh = ctx.environment.refreshTab(ctx, { tabId, level: 'status' }).catch(() => null)

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
        void ctx.refreshThreadGoal(tabId)
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
        serverId,
        agentSessionId: snapTab.agentSessionId,
        provider: snapTab.provider,
        handoffFrom: snapTab.handoffFrom ? { ...snapTab.handoffFrom } : undefined,
        status: 'idle',
        workingDirectory: snapTab.workingDirectory || ctx.staticInfo?.projectPath || ctx.staticInfo?.workspacePath || '~',
        projectGroupPath: snapTab.projectGroupPath ?? null,
        additionalDirs: [...snapTab.additionalDirs],
        gitContext: snapTab.gitContext,
        worktreeBaseBranch: snapTab.worktreeBaseBranch,
        worktreeRequired: snapTab.worktreeRequired ?? false,
        modelConfig: snapTab.modelConfig ? restoredModelConfig(snapTab) : undefined,
        permissionMode: snapTab.permissionMode as any,
        terminalFailure: snapTab.terminalFailure
          ? { ...snapTab.terminalFailure }
          : null,
        contextUsage: snapTab.contextUsage ? { ...snapTab.contextUsage } : null,
      })
      tab = makeTab(session.id, {
        id: snapTab.tabId,
        title: snapTab.title || 'New Tab',
        titleCustom: snapTab.titleCustom ?? false,
        input: makeInputState({ text: draftText }),
      })
      tab.hasUnread = snapTab.hasUnread ?? false
      ctx.sessions[session.id] = session
      ctx.tabs[tab.id] = tab
    } else if (draftText) {
      tab.input.text = draftText
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

/** Async runtime attach: register tabs with the server, hydrate the active tab, and
 *  queue the rest for idle-time hydration. */
async function _attachRuntimeTabs(
  ctx: WorkspaceContext,
  persistedTabs: PersistedTab[],
): Promise<void> {
  // Start registrations independently. A request queued on an offline host must
  // not prevent healthy hosts from hydrating their tabs.
  for (const tabId of Object.keys(ctx.tabs)) {
    void ctx.apiFor(tabId).createTab(tabId).catch(() => null)
  }

  // Transcript hydration for inactive tabs is intentionally deferred, but their
  // tab-strip status must still reflect live work immediately after refresh.
  // getSessionInfo is side-effect free, unlike bindRuntimeSession, which may
  // replay in-flight events before the persisted transcript has loaded.
  for (const snapTab of persistedTabs) {
    if (!snapTab.agentSessionId) continue
    void ctx.apiFor(snapTab.tabId)
      .getSessionInfo(snapTab.agentSessionId)
      .then((meta) => {
        const tab = ctx.tabs[snapTab.tabId]
        const session = tab ? ctx.sessions[tab.sessionId] : undefined
        if (
          session?.agentSessionId === snapTab.agentSessionId
          && session.status === 'idle'
          && meta?.status
          && isSessionBusyStatus(meta.status)
        ) {
          session.status = meta.status
          prioritizeTabHydration(ctx, snapTab.tabId)
        }
      })
      .catch(() => null)
  }

  if (!ctx.tabs[ctx.activeTabId]) {
    ctx.activeTabId = ctx.tabOrder.find((id) => ctx.tabs[id]) ?? ''
  }
  ctx.pruneTabOrder()

  // Hydrate the tab the user is actually looking at first (its loadingHistory
  // flag drives the conversation skeleton). Cold inactive tabs remain on disk;
  // selecting one promotes it immediately.
  const activeSnap = persistedTabs.find((t) => t.tabId === ctx.activeTabId)
  if (activeSnap) void hydrateTab(ctx, activeSnap).catch(() => {})

  const rest = persistedTabs.filter((t) => t.tabId !== ctx.activeTabId)
  const deferredState: DeferredHydrationState = {
    pending: new Map(rest.map((snapTab) => [snapTab.tabId, snapTab])),
    running: new Set(),
  }
  deferredHydrations.set(ctx, deferredState)
}

/**
 * Hydrate a single tab: load its (windowed) transcript, then bind any live
 * runtime session. Loads the transcript before binding because bindRuntimeSession
 * may replay in-flight events immediately; if those land first, the conversation
 * guard would treat the tab as populated and skip the persisted transcript.
 * The Git environment refresh is independent of both and runs alongside them.
 */
async function hydrateTab(ctx: WorkspaceContext, snapTab: PersistedTab): Promise<void> {
  const tab = ctx.tabs[snapTab.tabId]
  const session = tab ? ctx.sessions[tab.sessionId] : undefined
  if (!tab || !session) return

  // Git is what the sidebar, home, and Git panel all read, and it depends on
  // nothing below — so start it now rather than behind a transcript parse and a
  // bind round-trip. Tabs are already registered with the server by this point
  // (_attachRuntimeTabs), so environment registration is safe here.
  const environmentRefresh = ctx.environment.refreshTab(ctx, { tabId: snapTab.tabId }).catch(() => null)

  if (snapTab.agentSessionId || snapTab.handoffFrom) {
    if (!hasConversation(session)) {
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
          return !!s && !hasConversation(s)
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
        if (s && !hasConversation(s) && handoffFrom) {
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
  }

  if (snapTab.agentSessionId) {
    const info = await (ctx.apiFor?.(snapTab.tabId) ?? window.solus)
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
    void ctx.refreshThreadGoal(snapTab.tabId)
  }

  await environmentRefresh
}
